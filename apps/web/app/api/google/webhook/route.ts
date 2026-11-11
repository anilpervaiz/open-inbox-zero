import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { prisma } from '../../../../utils/server/prisma';
import { enqueueProviderSync, getProviderSyncQueue } from '../../../../utils/worker/provider-sync-queue';
import { readJsonBody } from '../../../../utils/webhooks/request';

const outer = z.object({ subscription: z.string().max(1024), message: z.object({ messageId: z.string().min(1).max(512), data: z.string().min(1).max(65_536) }) });
const payload = z.object({ emailAddress: z.string().email().max(320), historyId: z.string().regex(/^\d+$/).max(32) });
const verifier = new OAuth2Client();
export async function POST(request: Request): Promise<Response> {
  const audience = process.env.GOOGLE_PUBSUB_AUDIENCE;
  const serviceAccount = process.env.GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL;
  const subscription = process.env.GOOGLE_PUBSUB_SUBSCRIPTION;
  if (!audience || !serviceAccount || !subscription) return Response.json({ error: 'Service unavailable' }, { status: 503 });
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const ticket = await verifier.verifyIdToken({ idToken: header.slice(7), audience });
    const claims = ticket.getPayload();
    if (!claims?.email_verified || claims.email !== serviceAccount) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  } catch { return Response.json({ error: 'Unauthorized' }, { status: 401 }); }
  let body: z.infer<typeof outer>; let message: z.infer<typeof payload>;
  try {
    body = outer.parse(await readJsonBody(request));
    if (body.subscription !== subscription || !/^[A-Za-z0-9_-]+={0,2}$/.test(body.message.data)) throw new Error('Invalid notification');
    const bytes = Buffer.from(body.message.data, 'base64url');
    if (bytes.toString('base64url') !== body.message.data.replace(/=+$/, '')) throw new Error('Invalid notification');
    message = payload.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch { return Response.json({ error: 'Invalid notification' }, { status: 400 }); }
  try {
    const account = await prisma.emailAccount.findFirst({ where: { email: { equals: message.emailAddress, mode: 'insensitive' }, provider: 'google' }, select: { id: true } });
    if (account) await enqueueProviderSync(getProviderSyncQueue(), { provider: 'google', emailAccountId: account.id, historyId: message.historyId }, `${subscription}:${body.message.messageId}`);
    return new Response(null, { status: 204 });
  } catch { return Response.json({ error: 'Service unavailable' }, { status: 503 }); }
}
