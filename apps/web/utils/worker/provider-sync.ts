import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { getProviderAccessToken } from '../auth/provider-tokens';
import { resolveMailProvider } from '../mail-provider/provider-resolver';
import type { EmailProvider, ParsedMessage } from '../mail-provider/types';
import { senderAddress } from '../rule/static-from-risk';
import { runRules } from '../ai/choose-rule/run-rules';
import { providerSyncJobSchema, type ProviderSyncJob } from './provider-sync-queue';

const gmailHistory = z.object({
  historyId: z.string().regex(/^\d+$/), nextPageToken: z.string().optional(),
  history: z.array(z.object({
    messagesAdded: z.array(z.object({ message: z.object({ id: z.string().min(1) }) })).optional(),
    messagesDeleted: z.array(z.object({ message: z.object({ id: z.string().min(1) }) })).optional(),
    labelsAdded: z.array(z.object({ message: z.object({ id: z.string().min(1) }) })).optional(),
    labelsRemoved: z.array(z.object({ message: z.object({ id: z.string().min(1) }) })).optional(),
  })).optional(),
});

async function saveAndProcess(prisma: PrismaClient, provider: EmailProvider, emailAccountId: string, message: ParsedMessage) {
  const from = senderAddress(message.headers.from);
  if (!from || !message.id || !message.threadId || !Number.isFinite(message.internalDate.getTime())) throw new Error('Provider message is invalid');
  const fields = {
    threadId: message.threadId, fromEmail: from, toEmail: message.headers.to, ccEmail: message.headers.cc ?? null,
    headerMessageId: message.headers.messageId ?? null, inReplyTo: message.headers.inReplyTo ?? null, references: message.headers.references ?? null,
    subject: message.headers.subject, snippet: message.snippet, textBody: message.textPlain, htmlBody: message.textHtml ?? null,
    contentType: message.contentType ?? null, attachmentNames: message.attachmentNames ?? [], mimeTypes: message.mimeTypes ?? [],
    labels: message.labelIds, unread: message.labelIds.includes('UNREAD'), archived: !message.labelIds.includes('INBOX'),
    listUnsubscribe: message.headers.listUnsubscribe ?? null, listUnsubscribePost: message.headers.listUnsubscribePost ?? null, internalDate: message.internalDate,
  };
  await prisma.emailMessage.upsert({ where: { emailAccountId_messageId: { emailAccountId, messageId: message.id } }, create: { emailAccountId, messageId: message.id, ...fields }, update: fields });
  await runRules({ prisma, provider, emailAccountId, message });
}

/** A fail-closed mailbox lock prevents overlapping jobs from advancing cursors out of order. */
export async function syncProviderJob(input: { prisma: PrismaClient; job: ProviderSyncJob; resolveProvider?: typeof resolveMailProvider; requestFetch?: typeof fetch }) {
  const job = providerSyncJobSchema.parse(input.job);
  const { prisma } = input;
  const account = await prisma.emailAccount.findUnique({ where: { id: job.emailAccountId } });
  if (!account || account.provider !== job.provider) throw new Error('Provider account unavailable');
  let lock;
  try { lock = await prisma.threadExecutionLock.create({ data: { emailAccountId: account.id, threadId: 'provider-sync:account' } }); }
  catch { throw new Error('Provider synchronization is already running or requires recovery'); }
  try {
    const provider = await (input.resolveProvider ?? resolveMailProvider)(prisma, account.id);
    if (provider.emailAccountId !== account.id || provider.providerName !== account.provider) throw new Error('Provider account mismatch');
    if (job.provider === 'microsoft') {
      if (job.changeType === 'deleted') {
        // A folder notification can mean a move, not permanent deletion.
        const stored = await prisma.emailMessage.findUnique({ where: { emailAccountId_messageId: { emailAccountId: account.id, messageId: job.messageId } } });
        if (stored) await prisma.emailMessage.update({ where: { id: stored.id }, data: { labels: stored.labels.filter(label => label !== 'INBOX'), archived: true } });
      } else await saveAndProcess(prisma, provider, account.id, await provider.getMessage(job.messageId));
      return;
    }
    if (!account.lastSyncedHistoryId || !/^\d+$/.test(account.lastSyncedHistoryId)) throw new Error('Gmail synchronization needs an initialized history cursor');
    const access = await getProviderAccessToken({ prisma, emailAccountId: account.id, requestFetch: input.requestFetch });
    const changed = new Set<string>(); const deleted = new Set<string>();
    let pageToken: string | undefined; let latest = account.lastSyncedHistoryId; let pages = 0;
    do {
      if (++pages > 100) throw new Error('Gmail history exceeds sync page limit');
      const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history');
      url.searchParams.set('startHistoryId', account.lastSyncedHistoryId);
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      let response: Response;
      try { response = await (input.requestFetch ?? fetch)(url, { headers: { authorization: `Bearer ${access}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
      catch { throw new Error('Gmail history request failed'); }
      if (response.status === 404) throw new Error('Gmail history expired; a full resynchronization is required');
      if (!response.ok) throw new Error('Gmail history request failed');
      const parsed = gmailHistory.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new Error('Gmail history response invalid');
      if (BigInt(parsed.data.historyId) > BigInt(latest)) latest = parsed.data.historyId;
      for (const event of parsed.data.history ?? []) {
        for (const item of [...(event.messagesAdded ?? []), ...(event.labelsAdded ?? []), ...(event.labelsRemoved ?? [])]) changed.add(item.message.id);
        for (const item of event.messagesDeleted ?? []) deleted.add(item.message.id);
      }
      pageToken = parsed.data.nextPageToken;
    } while (pageToken);
    for (const messageId of deleted) await prisma.emailMessage.deleteMany({ where: { emailAccountId: account.id, messageId } });
    for (const messageId of changed) if (!deleted.has(messageId)) await saveAndProcess(prisma, provider, account.id, await provider.getMessage(messageId));
    // A notification's history ID is a safe lower bound; never skip a later event
    // just because the provider reported a newer mailbox position during paging.
    const notified = BigInt(job.historyId);
    const safe = BigInt(latest) < notified ? BigInt(latest) : notified;
    const cursor = safe > BigInt(account.lastSyncedHistoryId) ? safe.toString() : account.lastSyncedHistoryId;
    await prisma.emailAccount.update({ where: { id: account.id }, data: { lastSyncedHistoryId: cursor } });
  } finally { await prisma.threadExecutionLock.deleteMany({ where: { id: lock.id, emailAccountId: account.id } }); }
}
