import { describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import { enqueueProviderSync, redisConnection, type ProviderSyncJob } from '../utils/worker/provider-sync-queue';

describe('provider synchronization queue', () => {
  it('validates Redis endpoints and requires TLS for rediss', () => {
    expect(redisConnection('rediss://user:pass@redis.example:6380/2', true)).toMatchObject({ host: 'redis.example', port: 6380, db: 2, username: 'user', password: 'pass', tls: {}, maxRetriesPerRequest: null });
    expect(() => redisConnection('https://redis.example')).toThrow();
    expect(() => redisConnection('redis://redis.example/not-a-database')).toThrow();
  });
  it('deduplicates Google deliveries without merging separate Outlook notifications', async () => {
    const add = vi.fn(async (...args: unknown[]) => { void args; return {}; });
    const queue = { add } as unknown as Pick<Queue<ProviderSyncJob>, 'add'>;
    const google = { provider: 'google' as const, emailAccountId: 'a', historyId: '123' };
    await enqueueProviderSync(queue, google, 'delivery');
    await enqueueProviderSync(queue, google, 'delivery');
    expect(add.mock.calls[0][2]).toEqual(add.mock.calls[1][2]);
    await enqueueProviderSync(queue, { provider: 'microsoft', emailAccountId: 'a', messageId: 'm', changeType: 'created' }, 'delivery');
    expect(add.mock.calls[2][2]).toEqual({});
    await expect(enqueueProviderSync(queue, { ...google, historyId: 'not-numeric' })).rejects.toThrow();
  });
});
