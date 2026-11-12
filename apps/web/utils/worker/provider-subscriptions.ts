import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { getProviderAccessToken } from '../auth/provider-tokens';

/** Record intent before creating a Graph subscription; uncertain outcomes require reconciliation. */
export async function ensureMicrosoftSubscription(input: { prisma: PrismaClient; emailAccountId: string; callbackBaseUrl?: string; requestFetch?: typeof fetch; now?: () => number }) {
  if (!input.callbackBaseUrl) return null;
  let base: URL;
  try { base = new URL(input.callbackBaseUrl); } catch { throw new Error('Invalid public callback URL'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') return null;
  const account = await input.prisma.emailAccount.findUnique({ where: { id: input.emailAccountId }, select: { provider: true } });
  if (account?.provider !== 'microsoft') throw new Error('Microsoft account unavailable');
  const now = input.now ?? Date.now;
  const active = await input.prisma.providerSubscription.findFirst({ where: { emailAccountId: input.emailAccountId, status: 'ACTIVE', expiresAt: { gt: new Date(now()) } } });
  if (active) return active;
  const pending = await input.prisma.providerSubscription.findFirst({ where: { emailAccountId: input.emailAccountId, status: { in: ['PENDING', 'UNCERTAIN'] } } });
  if (pending) throw new Error('Subscription setup requires reconciliation');
  const access = await getProviderAccessToken({ prisma: input.prisma, emailAccountId: input.emailAccountId, requestFetch: input.requestFetch });
  const state = randomBytes(32).toString('hex');
  const expiration = new Date(now() + 2 * 24 * 3600_000);
  const record = await input.prisma.providerSubscription.create({ data: { emailAccountId: input.emailAccountId, subscriptionId: `pending-${randomUUID()}`, clientStateHash: createHash('sha256').update(state).digest('hex'), status: 'PENDING', expiresAt: expiration } });
  try {
    const response = await (input.requestFetch ?? fetch)('https://graph.microsoft.com/v1.0/subscriptions', { method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' }, body: JSON.stringify({ changeType: 'created,updated,deleted', notificationUrl: new URL('/api/outlook/webhook', base).href, resource: '/me/messages', expirationDateTime: expiration.toISOString(), clientState: state }), redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Subscription request failed');
    const result = z.object({ id: z.string().min(1).max(512), expirationDateTime: z.iso.datetime() }).safeParse(await response.json().catch(() => null));
    if (!result.success || new Date(result.data.expirationDateTime).getTime() <= now()) throw new Error('Subscription response invalid');
    return await input.prisma.providerSubscription.update({ where: { id: record.id }, data: { subscriptionId: result.data.id, expiresAt: new Date(result.data.expirationDateTime), status: 'ACTIVE' } });
  } catch {
    await input.prisma.providerSubscription.updateMany({ where: { id: record.id, status: 'PENDING' }, data: { status: 'UNCERTAIN' } });
    throw new Error('Subscription setup failed and requires reconciliation');
  }
}
