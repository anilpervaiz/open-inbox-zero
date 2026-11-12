import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { getProviderAccessToken } from '../auth/provider-tokens';
import { enqueueProviderSync, getProviderSyncQueue } from './provider-sync-queue';

/** Renew before expiry. A new Gmail watch never advances the saved history cursor. */
export async function maintainProviderSubscriptions(input: { prisma: PrismaClient; topic?: string; requestFetch?: typeof fetch; now?: () => number; enqueueCatchup?: (accountId: string, historyId: string) => Promise<unknown>; getToken?: (accountId: string) => Promise<string>; signal?: AbortSignal }) {
  const now = (input.now ?? Date.now)();
  const request = input.requestFetch ?? fetch;
  const token = input.getToken ?? ((emailAccountId: string) => getProviderAccessToken({ prisma: input.prisma, emailAccountId }));
  let failed = 0;
  if (input.topic) {
    if (!/^projects\/[^/]+\/topics\/[^/]+$/.test(input.topic)) throw new Error('Gmail notification topic is invalid');
    const accounts = await input.prisma.emailAccount.findMany({ where: { provider: 'google', lastSyncedHistoryId: { not: null }, OR: [{ googleWatchExpiresAt: null }, { googleWatchExpiresAt: { lte: new Date(now + 2 * 24 * 3600_000) } }] }, select: { id: true }, take: 100, orderBy: { googleWatchExpiresAt: 'asc' } });
    for (const account of accounts) {
      if (input.signal?.aborted) return;
      try {
        const access = await token(account.id);
        const response = await request('https://gmail.googleapis.com/gmail/v1/users/me/watch', { method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' }, body: JSON.stringify({ topicName: input.topic }), redirect: 'error', signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error('Watch renewal failed');
        const watch = z.object({ historyId: z.string().regex(/^\d+$/).max(32), expiration: z.string().regex(/^\d+$/).max(16) }).parse(await response.json());
        const expiresAt = Number(watch.expiration);
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new Error('Watch expiration invalid');
        // Queue a history catch-up before recording success, including changes that arrived while the watch was down.
        const enqueue = input.enqueueCatchup ?? ((accountId: string, historyId: string) => enqueueProviderSync(getProviderSyncQueue(), { provider: 'google', emailAccountId: accountId, historyId }));
        await enqueue(account.id, watch.historyId);
        await input.prisma.emailAccount.update({ where: { id: account.id }, data: { googleWatchExpiresAt: new Date(expiresAt) } });
      } catch { failed++; }
    }
  }
  const subscriptions = await input.prisma.providerSubscription.findMany({ where: { status: 'ACTIVE', expiresAt: { gt: new Date(now), lte: new Date(now + 12 * 3600_000) }, emailAccount: { provider: 'microsoft' } }, select: { id: true, emailAccountId: true, subscriptionId: true, expiresAt: true }, take: 100, orderBy: { expiresAt: 'asc' } });
  for (const subscription of subscriptions) {
    if (input.signal?.aborted) return;
    try {
      const access = await token(subscription.emailAccountId);
      const expiresAt = new Date(now + 2 * 24 * 3600_000);
      const response = await request(`https://graph.microsoft.com/v1.0/subscriptions/${encodeURIComponent(subscription.subscriptionId)}`, { method: 'PATCH', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' }, body: JSON.stringify({ expirationDateTime: expiresAt.toISOString() }), redirect: 'error', signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error('Subscription renewal failed');
      const result = z.object({ id: z.string(), expirationDateTime: z.iso.datetime() }).parse(await response.json());
      const actual = new Date(result.expirationDateTime);
      if (result.id !== subscription.subscriptionId || actual.getTime() <= now) throw new Error('Subscription response invalid');
      await input.prisma.providerSubscription.updateMany({ where: { id: subscription.id, status: 'ACTIVE', expiresAt: subscription.expiresAt }, data: { expiresAt: actual } });
    } catch { failed++; }
  }
  if (failed) throw new Error(`${failed} provider subscription renewal(s) failed`);
}
