import { localRateLimit } from '../../../utils/rate-limit';
import { z } from 'zod';
import { EmulatedMailProvider } from '../../../utils/mail-provider/emulated-provider';
import { createCleanupJob, runCleanupJob, undoCleanupJob } from '../../../utils/cleanup/cleanup-jobs';
import { refreshSenderAnalytics, unsubscribeSender } from '../../../utils/unsubscribe';
import { authorizeLocalApi } from '../../../utils/server/local-api-auth';
import { prisma } from '../../../utils/server/prisma';

const id = z.string().trim().min(1).max(256);
const command = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('refresh'), accountId: id }).strict(),
  z.object({ operation: z.literal('archive'), accountId: id, threadIds: z.array(id).min(1).max(500), olderThan: z.iso.datetime(), mode: z.enum(['NEWSLETTERS', 'NOTIFICATIONS', 'BOTH']) }).strict(),
  z.object({ operation: z.literal('undo'), accountId: id, jobId: id }).strict(),
  z.object({ operation: z.literal('unsubscribe'), accountId: id, newsletterId: id, messageId: id, method: z.enum(['one_click', 'mailto', 'manual']), userConfirmed: z.literal(true) }).strict(),
]);

/** Local-only endpoint. Production remains closed until authenticated account sessions are configured. */
export async function POST(request: Request): Promise<Response> {
  if (!authorizeLocalApi(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return Response.json({ error: 'Expected JSON' }, { status: 415 });
  let input: z.infer<typeof command>;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text) > 65_536) return Response.json({ error: 'Request too large' }, { status: 413 });
    input = command.parse(JSON.parse(text));
  } catch { return Response.json({ error: 'Invalid request' }, { status: 400 }); }
  const limit = await localRateLimit(input.accountId);
  if (limit) return limit;
  try {
    const account = await prisma.emailAccount.findUnique({ where: { id: input.accountId } });
    if (!account || account.provider !== 'emulator') return Response.json({ error: 'Account not found' }, { status: 404 });
    const provider = new EmulatedMailProvider(prisma, account.id);
    const context = { prisma, provider, emailAccountId: account.id };
    switch (input.operation) {
      case 'refresh':
        await refreshSenderAnalytics(prisma, account.id);
        return Response.json({ ok: true });
      case 'archive': {
        const job = await createCleanupJob({ ...context, threadIds: input.threadIds, olderThan: new Date(input.olderThan), mode: input.mode });
        return Response.json(await runCleanupJob({ ...context, cleanupJobId: job.id }));
      }
      case 'undo': return Response.json(await undoCleanupJob({ ...context, cleanupJobId: input.jobId }));
      case 'unsubscribe': return Response.json(await unsubscribeSender({ ...context, newsletterId: input.newsletterId, messageId: input.messageId, method: input.method, userConfirmed: input.userConfirmed }));
    }
  } catch {
    // Never expose provider details, tokens, or database errors to API clients.
    return Response.json({ error: 'Cleanup request could not be completed' }, { status: 400 });
  }
}
