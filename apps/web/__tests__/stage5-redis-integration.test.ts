import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueEvents, Worker } from 'bullmq';
import { expect, it } from 'vitest';
import { createProviderSyncQueue, enqueueProviderSync, providerSyncQueueName, redisConnection, type ProviderSyncJob } from '../utils/worker/provider-sync-queue';

it.skipIf(!process.env.REDIS_TEST_BINARY)('deduplicates and processes a queued notification using real Redis', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'open-inbox-redis-test-'));
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve Redis port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  let server: ChildProcess | undefined;
  const url = `redis://127.0.0.1:${port}`;
  const queue = createProviderSyncQueue(url);
  const events = new QueueEvents(providerSyncQueueName, { connection: redisConnection(url, true) });
  queue.on('error', () => {}); events.on('error', () => {});
  let worker: Worker<ProviderSyncJob> | undefined;
  try {
    server = spawn(process.env.REDIS_TEST_BINARY!, ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no', '--dir', directory], { stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); setTimeout(resolve, 500); });
    await Promise.all([queue.waitUntilReady(), events.waitUntilReady()]);
    const job = { provider: 'google' as const, emailAccountId: 'account', historyId: '123' };
    const coldQueue = createProviderSyncQueue(url); coldQueue.on('error', () => {});
    try { const coldJob = await enqueueProviderSync(coldQueue, job, 'cold-start'); await coldJob.remove(); }
    finally { await coldQueue.close(); }
    const first = await enqueueProviderSync(queue, job, 'delivery');
    const duplicate = await enqueueProviderSync(queue, job, 'delivery');
    expect(first.id).toBe(duplicate.id);
    expect(await queue.count()).toBe(1);
    const received: ProviderSyncJob[] = [];
    worker = new Worker<ProviderSyncJob>(providerSyncQueueName, async item => { received.push(item.data); }, { connection: redisConnection(url, true) });
    await first.waitUntilFinished(events, 10_000);
    expect(received).toEqual([job]);
  } finally {
    await worker?.close(); await events.close(); await queue.close();
    if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise<void>(resolve => server!.once('exit', () => resolve())); }
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
