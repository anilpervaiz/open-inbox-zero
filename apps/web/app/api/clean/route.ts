import { z } from 'zod';
import { EmulatedMailProvider } from '../../../utils/mail-provider/emulated-provider';
import { createCleanupJob, runCleanupJob, undoCleanupJob } from '../../../utils/cleanup/cleanup-jobs';
import { refreshSenderAnalytics, unsubscribeSender } from '../../../utils/unsubscribe';
import { workspacePrincipal, workspaceRateLimit } from '../../../utils/server/workspace-auth';
import { resolveMailProvider } from '../../../utils/mail-provider/provider-resolver';
import { enqueueProviderSync, getProviderSyncQueue } from '../../../utils/worker/provider-sync-queue';
import { prisma } from '../../../utils/server/prisma';

const id = z.string().trim().min(1).max(256);
const command = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('refresh'), accountId: id }).strict(),
  z.object({ operation: z.literal('archive'), accountId: id, threadIds: z.array(id).min(1).max(500), olderThan: z.iso.datetime(), mode: z.enum(['NEWSLETTERS', 'NOTIFICATIONS', 'BOTH']) }).strict(),
  z.object({ operation: z.literal('undo'), accountId: id, jobId: id }).strict(),
  z.object({ operation: z.literal('unsubscribe'), accountId: id, newsletterId: id, messageId: id, method: z.enum(['one_click', 'mailto', 'manual']), userConfirmed: z.literal(true) }).strict(),
]);

/** The local demo and signed-in users may only manage their own mailboxes. */
export async function POST(request: Request): Promise<Response> {
  let principal;
  try { principal = await workspacePrincipal(request); } catch { return Response.json({ error: 'Service unavailable' }, { status: 503 }); }
  if (!principal) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return Response.json({ error: 'Expected JSON' }, { status: 415 });
  let input: z.infer<typeof command>;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text) > 65_536) return Response.json({ error: 'Request too large' }, { status: 413 });
    input = command.parse(JSON.parse(text));
  } catch { return Response.json({ error: 'Invalid request' }, { status: 400 }); }
  const limit = await workspaceRateLimit(principal, input.accountId);
  if (limit) return limit;
  try {
    const account = principal.kind === 'local' ? await prisma.emailAccount.findUnique({ where: { id: input.accountId } }) : await prisma.emailAccount.findFirst({ where: { id: input.accountId, userId: principal.userId } });
    if (!account || (principal.kind === 'local' && account.provider !== 'emulator')) return Response.json({ error: 'Account not found' }, { status: 404 });
    const provider = account.provider === 'emulator' ? new EmulatedMailProvider(prisma, account.id) : await resolveMailProvider(prisma, account.id);
    const context = { prisma, provider, emailAccountId: account.id };
    async function refreshThreads(threadIds: string[]) {
      if (account!.provider === 'emulator') return {};
      let failed = false;
      for (const threadId of [...new Set(threadIds)]) {
        try { await enqueueProviderSync(getProviderSyncQueue(), { provider: 'refresh', emailAccountId: account!.id, threadId }); } catch { failed = true; break; }
      }
      return failed ? { refreshUnscheduled: true } : { refreshPending: threadIds.length > 0 };
    }
    switch (input.operation) {
      case 'refresh':
        await refreshSenderAnalytics(prisma, account.id);
        return Response.json({ ok: true });
      case 'archive': {
        const job = await createCleanupJob({ ...context, threadIds: input.threadIds, olderThan: new Date(input.olderThan), mode: input.mode });
        const result = await runCleanupJob({ ...context, cleanupJobId: job.id });
        return Response.json({ ...result, ...await refreshThreads(result.threads.filter(item => item.startedAt).map(item => item.threadId)) });
      }
      case 'undo': { const result = await undoCleanupJob({ ...context, cleanupJobId: input.jobId }); return Response.json({ ...result, ...await refreshThreads(result.threads.filter(item => item.startedAt).map(item => item.threadId)) }); }
      case 'unsubscribe': return Response.json(await unsubscribeSender({ ...context, newsletterId: input.newsletterId, messageId: input.messageId, method: input.method, userConfirmed: input.userConfirmed }));
    }
  } catch {
    // Never expose provider details, tokens, or database errors to API clients.
    return Response.json({ error: 'Cleanup request could not be completed' }, { status: 400 });
  }
}
