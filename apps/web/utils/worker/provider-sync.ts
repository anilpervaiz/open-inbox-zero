import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { getProviderAccessToken } from '../auth/provider-tokens';
import { resolveMailProvider } from '../mail-provider/provider-resolver';
import type { EmailProvider, ParsedMessage } from '../mail-provider/types';
import { senderAddress } from '../rule/static-from-risk';
import { runRules } from '../ai/choose-rule/run-rules';
import { providerSyncJobSchema, type ProviderSyncJob } from './provider-sync-queue';
import { ensureMicrosoftSubscription } from './provider-subscriptions';
import { syncSelfHostedAccount } from './self-hosted-sync';

const gmailHistory = z.object({
  historyId: z.string().regex(/^\d+$/), nextPageToken: z.string().optional(),
  history: z.array(z.object({
    messagesAdded: z.array(z.object({ message: z.object({ id: z.string().min(1) }) })).optional(),
    messagesDeleted: z.array(z.object({ message: z.object({ id: z.string().min(1) }) })).optional(),
    labelsAdded: z.array(z.object({ message: z.object({ id: z.string().min(1) }) })).optional(),
    labelsRemoved: z.array(z.object({ message: z.object({ id: z.string().min(1) }) })).optional(),
  })).optional(),
});

export async function cacheProviderMessage(prisma: PrismaClient, emailAccountId: string, message: ParsedMessage) {
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
}

async function saveAndProcess(prisma: PrismaClient, provider: EmailProvider, emailAccountId: string, message: ParsedMessage) {
  await cacheProviderMessage(prisma, emailAccountId, message);
  await runRules({ prisma, provider, emailAccountId, message });
}

/** A fail-closed mailbox lock prevents overlapping jobs from advancing cursors out of order. */
export async function syncProviderJob(input: { prisma: PrismaClient; job: ProviderSyncJob; resolveProvider?: typeof resolveMailProvider; requestFetch?: typeof fetch }) {
  const job = providerSyncJobSchema.parse(input.job);
  const { prisma } = input;
  const account = await prisma.emailAccount.findUnique({ where: { id: job.emailAccountId } });
  if (!account || !['google', 'microsoft', 'selfhosted'].includes(account.provider) || (!['bootstrap', 'refresh'].includes(job.provider) && account.provider !== job.provider)) throw new Error('Provider account unavailable');
  let lock;
  try { lock = await prisma.threadExecutionLock.create({ data: { emailAccountId: account.id, threadId: 'provider-sync:account' } }); }
  catch { throw new Error('Provider synchronization is already running or requires recovery'); }
  try {
    if (account.provider === 'selfhosted') {
      if (job.provider === 'bootstrap') {
        await syncSelfHostedAccount({ prisma, emailAccountId: account.id, mode: 'bootstrap' });
        return;
      }
      if (job.provider === 'selfhosted') {
        await syncSelfHostedAccount({ prisma, emailAccountId: account.id, mode: 'incremental', folderPath: job.folderPath });
        return;
      }
    }
    const provider = await (input.resolveProvider ?? resolveMailProvider)(prisma, account.id);
    if (provider.emailAccountId !== account.id || provider.providerName !== account.provider) throw new Error('Provider account mismatch');
    if (job.provider === 'refresh') {
      const thread = await provider.getThread(job.threadId);
      if (thread.id !== job.threadId || thread.messages.some(message => message.threadId !== job.threadId)) throw new Error('Provider thread mismatch');
      for (const message of thread.messages) await cacheProviderMessage(prisma, account.id, message);
      return;
    }
    if (job.provider === 'bootstrap') {
      await prisma.emailAccount.update({ where: { id: account.id }, data: { initialSyncStatus: 'RUNNING' } });
      // Establish the Gmail change cursor before taking the initial snapshot.
      const topic = process.env.GOOGLE_PUBSUB_TOPIC;
      if (account.provider === 'google' && !account.lastSyncedHistoryId && topic) {
        if (!/^projects\/[^/]+\/topics\/[^/]+$/.test(topic)) throw new Error('Gmail notification topic is invalid');
        const access = await getProviderAccessToken({ prisma, emailAccountId: account.id, requestFetch: input.requestFetch });
        let response: Response;
        try { response = await (input.requestFetch ?? fetch)('https://gmail.googleapis.com/gmail/v1/users/me/watch', { method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' }, body: JSON.stringify({ topicName: topic }), redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
        catch { throw new Error('Gmail watch setup failed'); }
        if (!response.ok) throw new Error('Gmail watch setup failed');
        const watch = z.object({ historyId: z.string().regex(/^\d+$/).max(32), expiration: z.string().regex(/^\d+$/).max(16) }).safeParse(await response.json().catch(() => null));
        if (!watch.success || !Number.isSafeInteger(Number(watch.data.expiration)) || Number(watch.data.expiration) <= Date.now()) throw new Error('Gmail watch response invalid');
        await prisma.emailAccount.update({ where: { id: account.id }, data: { lastSyncedHistoryId: watch.data.historyId, googleWatchExpiresAt: new Date(Number(watch.data.expiration)) } });
      }
      if (account.provider === 'microsoft') await ensureMicrosoftSubscription({ prisma, emailAccountId: account.id, callbackBaseUrl: process.env.BETTER_AUTH_URL, requestFetch: input.requestFetch });
      // Snapshot all available threads without applying rules to old mail.
      for await (const threadId of provider.iterateThreadIds()) {
        const thread = await provider.getThread(threadId);
        if (thread.id !== threadId || thread.messages.some(message => message.threadId !== threadId)) throw new Error('Provider thread mismatch');
        for (const message of thread.messages) await cacheProviderMessage(prisma, account.id, message);
      }
      await prisma.emailAccount.update({ where: { id: account.id }, data: { initialSyncStatus: 'COMPLETED' } });
      return;
    }
    if (job.provider === 'microsoft') {
      if (job.changeType === 'deleted') {
        // A folder notification can mean a move, not permanent deletion.
        const stored = await prisma.emailMessage.findUnique({ where: { emailAccountId_messageId: { emailAccountId: account.id, messageId: job.messageId } } });
        if (stored) await prisma.emailMessage.update({ where: { id: stored.id }, data: { labels: stored.labels.filter(label => label !== 'INBOX'), archived: true } });
      } else await saveAndProcess(prisma, provider, account.id, await provider.getMessage(job.messageId));
      return;
    }
    if (job.provider !== 'google') throw new Error('Provider job mismatch');
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
  } catch (error) {
    if (job.provider === 'bootstrap') await prisma.emailAccount.updateMany({ where: { id: account.id }, data: { initialSyncStatus: 'FAILED' } });
    throw error;
  } finally { await prisma.threadExecutionLock.deleteMany({ where: { id: lock.id, emailAccountId: account.id } }); }
}
