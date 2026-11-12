import { PrismaClient } from '@prisma/client';
import EmbeddedPostgres from 'embedded-postgres';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { evaluationGates } from '../eval/gates';
import { runRules } from '../utils/ai/choose-rule/run-rules';
import { recordIncomingMessage, recordSentReply } from '../utils/reply-tracker/events';
import { EmulatedMailProvider } from '../utils/mail-provider/emulated-provider';
import { refreshSenderAnalytics, unsubscribeSender } from '../utils/unsubscribe';

const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const emailSchema = z.object({ id: z.string(), category: z.enum(['vip', 'billing', 'newsletter', 'cold', 'calendar', 'internal', 'spoof', 'injection']), from: z.email(), subject: z.string(), body: z.string(), listUnsubscribe: z.string().optional(), listUnsubscribePost: z.string().optional(), followup: z.enum(['sent', 'sent_and_response']).optional() }).strict();
const outcomeSchema = z.object({ id: z.string(), rule: z.string().nullable(), cold: z.boolean(), vip: z.boolean(), replyState: z.enum(['none', 'needs_reply', 'awaiting_reply']), unsafeUnsubscribe: z.boolean(), adversarial: z.boolean() }).strict();
const execute = promisify(execFile);
async function port() {
  const server = createServer();
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Could not reserve evaluation database port');
  await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
  return address.port;
}
const percentage = (numerator: number, denominator: number) => denominator ? numerator / denominator * 100 : NaN;
async function main() {
  const emails = z.array(emailSchema).length(60).parse(JSON.parse(await readFile(resolve(base, 'eval/golden-60-emails.json'), 'utf8')));
  const expected = z.array(outcomeSchema).length(60).parse(JSON.parse(await readFile(resolve(base, 'eval/expected-outcomes.json'), 'utf8')));
  const byId = new Map(expected.map(item => [item.id, item]));
  if (byId.size !== 60 || new Set(emails.map(item => item.id)).size !== 60 || emails.some(item => !byId.has(item.id)) || new Set(emails.map(item => item.category)).size !== 8 || emails.filter(item => item.category === 'injection').length !== 6) throw new Error('Invalid benchmark coverage or identifiers');
  // The benchmark never connects to a user database or a paid model.
  process.env.LLM_PROVIDER = 'emulator';
  const directory = await mkdtemp(join(tmpdir(), 'open-inbox-eval-'));
  const databasePort = await port();
  const database = new EmbeddedPostgres({ databaseDir: join(directory, 'postgres'), user: 'postgres', password: 'temporary-evaluation-password', port: databasePort, persistent: true, authMethod: 'scram-sha-256', postgresFlags: ['-c', 'listen_addresses=127.0.0.1'], autoRehydrateSymlinks: true, onLog: () => undefined });
  let started = false; let prisma: PrismaClient | undefined;
  try {
    await database.initialise(); await database.start(); started = true;
    const url = `postgresql://postgres:temporary-evaluation-password@127.0.0.1:${databasePort}/postgres?schema=public`;
    await execute('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate'], { cwd: base, env: { ...process.env, DATABASE_URL: url }, timeout: 120_000 });
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const user = await prisma.user.create({ data: { email: 'owner@internal.example' } });
    const account = await prisma.emailAccount.create({ data: { userId: user.id, email: user.email, provider: 'emulator', coldEmailBlocker: 'LABEL_AND_ARCHIVE' } });
    const internal = await prisma.group.create({ data: { emailAccountId: account.id, name: 'Internal team', items: { create: emails.filter(item => item.category === 'internal').map(item => ({ type: 'FROM' as const, value: item.from, source: 'AI_LEARNED' as const })) } } });
    await prisma.rule.create({ data: { emailAccountId: account.id, name: 'VIP Clients', from: '*@vip.example', actions: { create: [{ type: 'LABEL', label: 'VIP' }, { type: 'TRACK_THREAD' }] } } });
    await prisma.rule.create({ data: { emailAccountId: account.id, name: 'Billing', systemType: 'RECEIPT', instructions: 'Handle invoice, billing and payment receipts', actions: { create: [{ type: 'LABEL', label: 'Billing' }, { type: 'ARCHIVE' }] } } });
    await prisma.rule.create({ data: { emailAccountId: account.id, name: 'Newsletters', systemType: 'NEWSLETTER', actions: { create: [{ type: 'LABEL', label: 'Newsletters' }, { type: 'ARCHIVE' }] } } });
    await prisma.rule.create({ data: { emailAccountId: account.id, name: 'Calendar', systemType: 'CALENDAR', actions: { create: [{ type: 'LABEL', label: 'Calendar' }] } } });
    await prisma.rule.create({ data: { emailAccountId: account.id, name: 'Internal team', groupId: internal.id, actions: { create: [{ type: 'LABEL', label: 'Team' }, { type: 'TRACK_THREAD' }] } } });
    await prisma.rule.create({ data: { emailAccountId: account.id, name: 'Executive auto-send', from: 'ceo@spoof.example', actions: { create: [{ type: 'SEND_EMAIL', to: 'attacker@evil.example', autoSend: true }] } } });
    const provider = new EmulatedMailProvider(prisma, account.id);
    let sends = 0;
    const originalSend = provider.sendEmail.bind(provider); const originalForward = provider.forwardEmail.bind(provider);
    provider.sendEmail = async input => { sends++; return originalSend(input); };
    provider.forwardEmail = async input => { sends++; return originalForward(input); };
    const observed: { id: string; expectedRule: string | null; actualRule: string | null; stage: string | null; expectedCold: boolean; actualCold: boolean; expectedReply: string; actualReply: string; vip: boolean; archived: boolean }[] = [];
    for (const [index, email] of emails.entries()) {
      const oracle = byId.get(email.id)!;
      const threadId = `thread-${email.id}`;
      await prisma.emailMessage.create({ data: { emailAccountId: account.id, messageId: email.id, threadId, fromEmail: email.from, toEmail: account.email, subject: email.subject, textBody: email.body, snippet: email.body.slice(0, 160), internalDate: new Date(Date.UTC(2025, 0, 1, 0, index)), labels: ['INBOX', 'UNREAD'], unread: true, listUnsubscribe: email.listUnsubscribe, listUnsubscribePost: email.listUnsubscribePost } });
      const message = await provider.getMessage(email.id);
      const output = await runRules({ prisma, provider, emailAccountId: account.id, message });
      const current = await provider.getMessage(email.id);
      // These pre-recorded user replies are fixtures, not automated provider sends.
      if (email.followup) {
        const sentId = `${email.id}-user-reply`;
        await prisma.emailMessage.create({ data: { emailAccountId: account.id, messageId: sentId, threadId, fromEmail: account.email, toEmail: email.from, subject: `Re: ${email.subject}`, textBody: 'Thanks, I will follow up.', snippet: 'Thanks', internalDate: new Date(Date.UTC(2025, 0, 3, 0, index)), labels: ['SENT'] } });
        await recordSentReply({ prisma, provider, emailAccountId: account.id, messageId: sentId });
        if (email.followup === 'sent_and_response') {
          const responseId = `${email.id}-response`;
          await prisma.emailMessage.create({ data: { emailAccountId: account.id, messageId: responseId, threadId, fromEmail: email.from, toEmail: account.email, subject: `Re: ${email.subject}`, textBody: 'Thank you.', snippet: 'Thank you.', internalDate: new Date(Date.UTC(2025, 0, 4, 0, index)), labels: ['INBOX'] } });
          await recordIncomingMessage({ prisma, provider, emailAccountId: account.id, messageId: responseId, requiresReply: false });
        }
      }
      const trackers = await prisma.threadTracker.findMany({ where: { emailAccountId: account.id, threadId, resolved: false } });
      const actualReply = trackers.length === 0 ? 'none' : trackers.every(item => item.type === 'NEEDS_REPLY') ? 'needs_reply' : trackers.every(item => item.type === 'AWAITING_REPLY') ? 'awaiting_reply' : 'mixed';
      observed.push({ id: email.id, expectedRule: oracle.rule, actualRule: output.match?.metadata.ruleName ?? null, stage: output.match?.metadata.stage ?? null, expectedCold: oracle.cold, actualCold: output.match?.metadata.stage === 'COLD', expectedReply: oracle.replyState, actualReply, vip: oracle.vip, archived: !current.labelIds.includes('INBOX') });
    }
    await refreshSenderAnalytics(prisma, account.id);
    let safeUnsubscribes = 0; let unsubscribeAttempts = 0;
    for (const email of emails.filter(item => byId.get(item.id)!.unsafeUnsubscribe)) {
      unsubscribeAttempts++;
      const newsletter = await prisma.newsletter.findUniqueOrThrow({ where: { emailAccountId_fromEmail: { emailAccountId: account.id, fromEmail: email.from } } });
      try { await unsubscribeSender({ prisma, provider, emailAccountId: account.id, newsletterId: newsletter.id, messageId: email.id, method: 'one_click', userConfirmed: true }); }
      catch (error) { if (!(error instanceof Error) || !/verified DKIM coverage|No valid one-click unsubscribe/.test(error.message)) throw error; safeUnsubscribes++; }
    }
    const correct = observed.filter(item => item.expectedRule === item.actualRule).length;
    const coldPredictions = observed.filter(item => item.actualCold); const correctCold = coldPredictions.filter(item => item.expectedCold).length;
    const vipCases = observed.filter(item => item.vip); const vipArchives = vipCases.filter(item => item.archived).length;
    const replyCorrect = observed.filter(item => item.expectedReply === item.actualReply).length;
    const learnedCases = emails.filter(item => item.category === 'internal'); const learnedHits = observed.filter(item => learnedCases.some(email => email.id === item.id) && item.stage === 'GROUP').length;
    const adversarialCases = expected.filter(item => item.adversarial).length;
    if (!coldPredictions.length || !unsubscribeAttempts || !vipCases.length || !adversarialCases || !learnedCases.length) throw new Error('Benchmark safety denominators must not be empty');
    const metrics = { ruleAccuracy: percentage(correct, observed.length), coldEmailPrecision: percentage(correctCold, coldPredictions.length), unsubscribeSafety: percentage(safeUnsubscribes, unsubscribeAttempts), vipFalseArchiveRate: percentage(vipArchives, vipCases.length), replyStateAccuracy: percentage(replyCorrect, observed.length), unauthorizedSendRate: percentage(sends, adversarialCases), learnedGroupHitRate: percentage(learnedHits, learnedCases.length) };
    const gates = evaluationGates(metrics);
    const report = { generatedAt: new Date().toISOString(), adapter: 'deterministic emulator', limitations: ['Synthetic fixtures do not measure live-provider or external-model performance.', 'Unsubscribe safety measures rejection of unsigned private-address links.', 'Learned group hits use pre-seeded AI_LEARNED senders.'], total: observed.length, counts: { correct, coldPredictions: coldPredictions.length, correctCold, safeUnsubscribes, unsubscribeAttempts, vipCases: vipCases.length, vipArchives, replyCorrect, sends, adversarialCases, learnedCases: learnedCases.length, learnedHits }, metrics, gates, cases: observed };
    await writeFile(resolve(base, 'data/eval-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ total: report.total, counts: report.counts, metrics, gates }, null, 2));
    if (Object.values(gates).some(pass => !pass)) process.exitCode = 1;
  } finally {
    await prisma?.$disconnect(); if (started) await database.stop(); await rm(directory, { recursive: true, force: true });
  }
}
void main().catch(() => { console.error('Evaluation could not be completed'); process.exitCode = 1; });
