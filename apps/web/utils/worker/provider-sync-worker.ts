import { Worker } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import { providerSyncJobSchema, providerSyncQueueName, redisConnection, type ProviderSyncJob } from './provider-sync-queue';
import { syncProviderJob } from './provider-sync';

/** Runs durable provider notifications; failed jobs remain in Redis for investigation. */
export function createProviderSyncWorker(prisma: PrismaClient, redisUrl: string) {
  const worker = new Worker<ProviderSyncJob>(providerSyncQueueName, async job => {
    await syncProviderJob({ prisma, job: providerSyncJobSchema.parse(job.data) });
  }, { connection: redisConnection(redisUrl, true), concurrency: 4 });
  worker.on('error', () => { console.error('Provider synchronization worker error'); });
  worker.on('failed', () => { console.error('Provider synchronization job failed'); });
  return worker;
}
