import { createHash } from 'node:crypto';
import { Queue, type ConnectionOptions } from 'bullmq';
import { z } from 'zod';

const id = z.string().min(1).max(512);
export const providerSyncJobSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('bootstrap'), emailAccountId: id }).strict(),
  z.object({ provider: z.literal('refresh'), emailAccountId: id, threadId: id }).strict(),
  z.object({ provider: z.literal('google'), emailAccountId: id, historyId: z.string().regex(/^\d+$/).max(32) }).strict(),
  z.object({ provider: z.literal('microsoft'), emailAccountId: id, messageId: id, changeType: z.enum(['created', 'updated', 'deleted']) }).strict(),
]);
export type ProviderSyncJob = z.infer<typeof providerSyncJobSchema>;
export const providerSyncQueueName = 'open-inbox-zero-provider-sync';

/** Only explicit Redis connection settings are accepted; credentials are never logged. */
export function redisConnection(url: string, worker = false): ConnectionOptions {
  const parsed = new URL(url);
  if (!['redis:', 'rediss:'].includes(parsed.protocol) || !parsed.hostname || parsed.search || parsed.hash) throw new Error('Invalid Redis URL');
  const database = parsed.pathname === '' || parsed.pathname === '/' ? 0 : Number(parsed.pathname.slice(1));
  if (!Number.isSafeInteger(database) || database < 0 || database > 65535) throw new Error('Invalid Redis database');
  const port = parsed.port ? Number(parsed.port) : 6379;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Redis port');
  return { host: parsed.hostname, port, db: database, ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}), ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}), ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}), connectTimeout: 3000, commandTimeout: 5000, enableOfflineQueue: worker, maxRetriesPerRequest: worker ? null : 1 };
}

export function createProviderSyncQueue(url: string) {
  return new Queue<ProviderSyncJob>(providerSyncQueueName, { connection: redisConnection(url), defaultJobOptions: { attempts: 8, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: { age: 86_400, count: 10_000 }, removeOnFail: false } });
}

/** Google Pub/Sub may retry the same delivery. Outlook changes are not coalesced. */
export async function enqueueProviderSync(queue: Pick<Queue<ProviderSyncJob>, 'add'>, input: ProviderSyncJob, deliveryId?: string) {
  const data = providerSyncJobSchema.parse(input);
  const jobId = deliveryId && data.provider === 'google' ? `google-${createHash('sha256').update(deliveryId).digest('hex')}` : undefined;
  return queue.add('sync', data, jobId ? { jobId } : {});
}

const shared = globalThis as typeof globalThis & { providerSyncQueue?: Queue<ProviderSyncJob>; providerSyncRedisUrl?: string };
export function getProviderSyncQueue(): Queue<ProviderSyncJob> {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('Provider synchronization queue is not configured');
  if (!shared.providerSyncQueue || shared.providerSyncRedisUrl !== url) {
    if (shared.providerSyncQueue) void shared.providerSyncQueue.close();
    shared.providerSyncQueue = createProviderSyncQueue(url);
    shared.providerSyncQueue.on('error', () => {});
    shared.providerSyncRedisUrl = url;
  }
  return shared.providerSyncQueue;
}
