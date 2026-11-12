import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../../../utils/server/prisma';
import { enqueueProviderSync, getProviderSyncQueue } from '../../../../utils/worker/provider-sync-queue';
import { readJsonBody } from '../../../../utils/webhooks/request';

const input = z.object({ value: z.array(z.object({ subscriptionId: z.string().min(1).max(512), clientState: z.string().min(1).max(1024), changeType: z.enum(['created', 'updated', 'deleted']), resourceData: z.object({ id: z.string().min(1).max(512) }) })).min(1).max(100) });
export async function POST(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get('validationToken');
  if (token !== null) return token.length <= 4096 ? new Response(token, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } }) : new Response(null, { status: 400 });
  let body: z.infer<typeof input>;
  try { body = input.parse(await readJsonBody(request)); } catch { return Response.json({ error: 'Invalid notification' }, { status: 400 }); }
  try {
    const jobs = [];
    for (const notification of body.value) {
      const subscription = await prisma.providerSubscription.findUnique({ where: { subscriptionId: notification.subscriptionId }, include: { emailAccount: { select: { id: true, provider: true } } } });
      const actual = createHash('sha256').update(notification.clientState).digest();
      if (!subscription) {
        // Graph can deliver a notification before the create-subscription response is stored.
        const pending = await prisma.providerSubscription.findFirst({ where: { clientStateHash: actual.toString('hex'), status: { in: ['PENDING', 'UNCERTAIN'] }, expiresAt: { gt: new Date() }, emailAccount: { provider: 'microsoft' } }, select: { id: true } });
        if (pending) return Response.json({ error: 'Subscription not ready' }, { status: 503 });
      }
      const stored = subscription && /^[a-f0-9]{64}$/.test(subscription.clientStateHash) ? Buffer.from(subscription.clientStateHash, 'hex') : Buffer.alloc(32);
      if (!subscription || subscription.status !== 'ACTIVE' || !timingSafeEqual(actual, stored) || subscription.expiresAt <= new Date() || subscription.emailAccount.provider !== 'microsoft') return Response.json({ error: 'Unauthorized' }, { status: 401 });
      jobs.push({ provider: 'microsoft' as const, emailAccountId: subscription.emailAccount.id, messageId: notification.resourceData.id, changeType: notification.changeType });
    }
    const queue = getProviderSyncQueue();
    for (const job of jobs) await enqueueProviderSync(queue, job);
    return new Response(null, { status: 202 });
  } catch { return Response.json({ error: 'Service unavailable' }, { status: 503 }); }
}
