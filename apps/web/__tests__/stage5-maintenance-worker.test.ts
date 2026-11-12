import type { PrismaClient } from '@prisma/client';
import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ maintenance: vi.fn(), delayed: vi.fn(), reply: vi.fn(), labels: vi.fn(), learning: vi.fn() }));
vi.mock('../utils/worker/provider-maintenance', () => ({ maintainProviderSubscriptions: mocks.maintenance }));
vi.mock('../utils/worker/delayed-actions', () => ({ processNextDelayedAction: mocks.delayed, processPendingReplyTracking: mocks.reply, processPendingSenderLearning: mocks.learning }));
vi.mock('../utils/reply-tracker/label-sync', () => ({ processNextReplyLabelSync: mocks.labels }));
import { runDelayedWorker, runSubscriptionMaintenance } from '../scripts/delayed-worker';

it('continues delayed work while subscription renewal is waiting on a provider', async () => {
  let finish!: () => void;
  mocks.maintenance.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  mocks.delayed.mockResolvedValue(false); mocks.reply.mockResolvedValue(false); mocks.labels.mockResolvedValue(false); mocks.learning.mockResolvedValue(undefined);
  const stop = new AbortController(); const prisma = {} as PrismaClient;
  const maintenance = runSubscriptionMaintenance({ prisma, signal: stop.signal });
  const delayed = runDelayedWorker({ prisma, signal: stop.signal, resolveProvider: vi.fn(), pollMs: 10 });
  await vi.waitFor(() => expect(mocks.delayed).toHaveBeenCalled());
  expect(mocks.maintenance).toHaveBeenCalledTimes(1);
  stop.abort(); finish();
  await Promise.all([maintenance, delayed]);
});
