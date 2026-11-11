import { z } from 'zod';
import { prisma } from '../../../utils/server/prisma';
import { authorizeLocalApi } from '../../../utils/server/local-api-auth';
import { EmulatedMailProvider } from '../../../utils/mail-provider/emulated-provider';
import { runRules } from '../../../utils/ai/choose-rule/run-rules';
import { undoExecutedRule } from '../../../utils/ai/choose-rule/execute';
import { refreshSenderAnalytics, unsubscribeSender } from '../../../utils/unsubscribe';
import { createCleanupJob, runCleanupJob } from '../../../utils/cleanup/cleanup-jobs';
import { recordLabelRemovalLearning } from '../../../utils/rule/ai-sender-pattern-learning';
import { senderAddress } from '../../../utils/rule/static-from-risk';

const id = z.string().min(1).max(256);
const input = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('archive'), accountId: id, threadId: id }),
  z.object({ operation: z.literal('read'), accountId: id, threadId: id }),
  z.object({ operation: z.literal('run-all'), accountId: id }),
  z.object({ operation: z.literal('bulk-clean'), accountId: id }),
  z.object({ operation: z.literal('undo'), accountId: id, executionId: id }),
  z.object({ operation: z.literal('change-rule'), accountId: id, executionId: id, correctRuleId: id }),
  z.object({ operation: z.literal('run'), accountId: id, messageId: id }),
  z.object({ operation: z.literal('draft'), accountId: id, threadId: id, draftId: id.optional(), to: z.string().email(), subject: z.string().max(998), body: z.string().max(30000) }),
  z.object({ operation: z.literal('rule'), accountId: id, ruleId: id.optional(), name: z.string().trim().min(1).max(120), instructions: z.string().max(10000), from: z.string().max(300), action: z.enum(['LABEL', 'ARCHIVE', 'DRAFT_EMAIL']).optional() }),
  z.object({ operation: z.literal('knowledge'), accountId: id, knowledgeId: id.optional(), title: z.string().trim().min(1).max(120), content: z.string().min(1).max(10000) }),
  z.object({ operation: z.literal('delete-knowledge'), accountId: id, knowledgeId: id }),
  z.object({ operation: z.literal('unsubscribe'), accountId: id, newsletterId: id, messageId: id, method: z.enum(['one_click', 'mailto', 'manual']) }),
  z.object({ operation: z.literal('newsletter-status'), accountId: id, newsletterId: id, status: z.enum(['AUTO_ARCHIVE', 'APPROVED']) }),
  z.object({ operation: z.literal('not-cold'), accountId: id, coldId: id }),
  z.object({ operation: z.literal('cold-prompt'), accountId: id, prompt: z.string().max(10000) }),
]);
const analyticsRefreshes = new Map<string, Promise<void>>();
async function refreshAnalytics(accountId: string) {
  let pending = analyticsRefreshes.get(accountId);
  if (!pending) {
    pending = refreshSenderAnalytics(prisma, accountId).finally(() => { analyticsRefreshes.delete(accountId); });
    analyticsRefreshes.set(accountId, pending);
  }
  await pending;
}
async function accountFor(accountId: string) {
  const account = await prisma.emailAccount.findUnique({ where: { id: accountId } });
  return account?.provider === 'emulator' ? account : null;
}
export async function GET(request: Request): Promise<Response> {
  if (!authorizeLocalApi(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const accounts = await prisma.emailAccount.findMany({ where: { provider: 'emulator' }, select: { id: true, email: true, coldEmailPrompt: true }, orderBy: { email: 'asc' } });
    const account = accounts.find((item) => item.id === new URL(request.url).searchParams.get('account')) ?? accounts[0];
    if (!account) return Response.json({ accounts: [], account: null });
    await refreshAnalytics(account.id);
    const [messages, rules, groups, trackers, executions, newsletters, cold, knowledge] = await Promise.all([
      prisma.emailMessage.findMany({ where: { emailAccountId: account.id }, orderBy: { internalDate: 'desc' }, select: { messageId: true, threadId: true, fromEmail: true, fromName: true, toEmail: true, subject: true, snippet: true, textBody: true, internalDate: true, labels: true, unread: true, archived: true, listUnsubscribe: true, listUnsubscribePost: true } }),
      prisma.rule.findMany({ where: { emailAccountId: account.id }, include: { actions: true }, orderBy: { name: 'asc' } }),
      prisma.group.findMany({ where: { emailAccountId: account.id }, include: { items: true } }),
      prisma.threadTracker.findMany({ where: { emailAccountId: account.id, resolved: false } }),
      prisma.executedRule.findMany({ where: { emailAccountId: account.id }, include: { actionItems: true, rule: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.newsletter.findMany({ where: { emailAccountId: account.id }, orderBy: { messageCount: 'desc' } }),
      prisma.coldEmail.findMany({ where: { emailAccountId: account.id, status: { in: ['AI_LABELED_COLD', 'USER_MARKED_COLD'] } }, orderBy: { createdAt: 'desc' } }),
      prisma.knowledge.findMany({ where: { emailAccountId: account.id }, orderBy: { updatedAt: 'desc' } }),
    ]);
    return Response.json({ accounts, account, messages, rules, groups, trackers, executions, newsletters, cold, knowledge });
  } catch { return Response.json({ error: 'Mailbox could not be loaded' }, { status: 500 }); }
}
export async function POST(request: Request): Promise<Response> {
  if (!authorizeLocalApi(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return Response.json({ error: 'Expected JSON' }, { status: 415 });
  let data: z.infer<typeof input>;
  try { const text = await request.text(); if (text.length > 65536) return Response.json({ error: 'Request too large' }, { status: 413 }); data = input.parse(JSON.parse(text)); }
  catch { return Response.json({ error: 'Invalid request' }, { status: 400 }); }
  try {
    const account = await accountFor(data.accountId);
    if (!account) return Response.json({ error: 'Account not found' }, { status: 404 });
    const provider = new EmulatedMailProvider(prisma, account.id);
    switch (data.operation) {
      case 'archive': await provider.archiveThread(data.threadId); break;
      case 'read': await provider.markRead(data.threadId, true); break;
      case 'run-all': {
        const messages = await prisma.emailMessage.findMany({ where: { emailAccountId: account.id, archived: false, labels: { has: 'INBOX' } }, orderBy: { internalDate: 'asc' }, take: 100 });
        for (const row of messages) await runRules({ prisma, provider, emailAccountId: account.id, message: await provider.getMessage(row.messageId) });
        break;
      }
      case 'bulk-clean': {
        const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const newsletters = await prisma.newsletter.findMany({ where: { emailAccountId: account.id }, select: { fromEmail: true } });
        const messages = await prisma.emailMessage.findMany({ where: { emailAccountId: account.id, fromEmail: { in: newsletters.map((entry) => entry.fromEmail) }, internalDate: { lt: cutoff }, archived: false }, select: { threadId: true }, take: 500 });
        const threadIds = [...new Set(messages.map((message) => message.threadId))];
        if (threadIds.length) { const context = { prisma, provider, emailAccountId: account.id }; const job = await createCleanupJob({ ...context, threadIds, olderThan: cutoff, mode: 'NEWSLETTERS' }); await runCleanupJob({ ...context, cleanupJobId: job.id }); }
        break;
      }
      case 'undo': await undoExecutedRule({ prisma, provider, emailAccountId: account.id, executedRuleId: data.executionId }); break;
      case 'change-rule': {
        const execution = await prisma.executedRule.findFirst({ where: { id: data.executionId, emailAccountId: account.id } });
        if (!execution?.ruleId || execution.ruleId === data.correctRuleId || execution.status === 'REJECTED') throw new Error('Rule correction unavailable');
        const message = await provider.getMessage(execution.messageId);
        if (message.threadId !== execution.threadId) throw new Error('Thread mismatch');
        const sender = senderAddress(message.headers.from); if (!sender) throw new Error('Invalid sender');
        await recordLabelRemovalLearning(prisma, { emailAccountId: account.id, fromEmail: sender, subject: message.headers.subject, wrongRuleId: execution.ruleId, correctRuleId: data.correctRuleId });
        await undoExecutedRule({ prisma, provider, emailAccountId: account.id, executedRuleId: execution.id });
        break;
      }
      case 'run': { const message = await provider.getMessage(data.messageId); await runRules({ prisma, provider, emailAccountId: account.id, message }); break; }
      case 'draft': {
        if (data.draftId) {
          const draft = await prisma.emailMessage.findFirst({ where: { emailAccountId: account.id, messageId: data.draftId, threadId: data.threadId, labels: { has: 'DRAFT' } } });
          if (!draft) throw new Error('Draft not found');
          await prisma.emailMessage.update({ where: { id: draft.id }, data: { toEmail: data.to, subject: data.subject, textBody: data.body, snippet: data.body.slice(0, 160) } });
        } else await provider.createDraft({ threadId: data.threadId, to: data.to, subject: data.subject, body: data.body });
        break;
      }
      case 'rule': {
        if (!data.instructions.trim() && !data.from.trim()) throw new Error('A rule condition is required');
        if (data.ruleId) { const changed = await prisma.rule.updateMany({ where: { id: data.ruleId, emailAccountId: account.id }, data: { name: data.name, instructions: data.instructions || null, from: data.from || null } }); if (!changed.count) throw new Error('Rule not found'); }
        else { const action = data.action ?? 'LABEL'; await prisma.rule.create({ data: { emailAccountId: account.id, name: data.name, instructions: data.instructions || null, from: data.from || null, actions: { create: { type: action, ...(action === 'LABEL' ? { label: data.name } : {}), ...(action === 'DRAFT_EMAIL' ? { content: 'Draft a helpful response.' } : {}) } } } }); }
        break;
      }
      case 'knowledge': {
        if (data.knowledgeId) { const result = await prisma.knowledge.updateMany({ where: { id: data.knowledgeId, emailAccountId: account.id }, data: { title: data.title, content: data.content } }); if (!result.count) throw new Error('Knowledge not found'); }
        else await prisma.knowledge.create({ data: { emailAccountId: account.id, title: data.title, content: data.content } });
        break;
      }
      case 'delete-knowledge': { const result = await prisma.knowledge.deleteMany({ where: { id: data.knowledgeId, emailAccountId: account.id } }); if (!result.count) throw new Error('Knowledge not found'); break; }
      case 'unsubscribe': return Response.json(await unsubscribeSender({ prisma, provider, emailAccountId: account.id, newsletterId: data.newsletterId, messageId: data.messageId, method: data.method, userConfirmed: true }));
      case 'newsletter-status': {
        const sender = await prisma.newsletter.findFirst({ where: { id: data.newsletterId, emailAccountId: account.id } }); if (!sender) throw new Error('Sender not found');
        const name = `Auto-archive: ${sender.fromEmail}`;
        await prisma.$transaction(async (tx) => {
          await tx.newsletter.update({ where: { id: sender.id }, data: { status: data.status } });
          const existing = await tx.rule.findUnique({ where: { name_emailAccountId: { name, emailAccountId: account.id } }, include: { actions: true } });
          if (data.status === 'AUTO_ARCHIVE' && !existing) await tx.rule.create({ data: { emailAccountId: account.id, name, from: sender.fromEmail, actions: { create: { type: 'ARCHIVE' } } } });
          if (data.status === 'APPROVED' && existing && existing.from === sender.fromEmail && existing.actions.length === 1 && existing.actions[0].type === 'ARCHIVE') await tx.rule.delete({ where: { id: existing.id } });
        });
        break;
      }
      case 'cold-prompt': await prisma.emailAccount.update({ where: { id: account.id }, data: { coldEmailPrompt: data.prompt } }); break;
      case 'not-cold': {
        const cold = await prisma.coldEmail.findFirst({ where: { id: data.coldId, emailAccountId: account.id } }); if (!cold) throw new Error('Sender not found');
        const execution = await prisma.executedRule.findUnique({ where: { emailAccountId_threadId_messageId: { emailAccountId: account.id, threadId: cold.threadId, messageId: cold.messageId } } });
        if (execution && execution.status !== 'REJECTED') await undoExecutedRule({ prisma, provider, emailAccountId: account.id, executedRuleId: execution.id });
        await prisma.coldEmail.update({ where: { id: cold.id }, data: { status: 'NOT_COLD' } }); break;
      }
    }
    return Response.json({ ok: true });
  } catch { return Response.json({ error: 'Action could not be completed' }, { status: 400 }); }
}
