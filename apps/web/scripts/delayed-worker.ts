import { PrismaClient } from "@prisma/client";
import type { EmailProvider } from "../utils/mail-provider/types";
import { EmulatedMailProvider } from "../utils/mail-provider/emulated-provider";
import { resolveMailProvider } from "../utils/mail-provider/provider-resolver";
import { createProviderSyncWorker } from "../utils/worker/provider-sync-worker";
import { maintainProviderSubscriptions } from "../utils/worker/provider-maintenance";
import { processNextReplyLabelSync } from "../utils/reply-tracker/label-sync";
import { executeScheduledAction } from "../utils/ai/choose-rule/execute";
import { processNextDelayedAction, processPendingReplyTracking, processPendingSenderLearning, type ProviderResolver } from "../utils/worker/delayed-actions";

/** The local worker supports emulator mailboxes; deployments may inject a real OAuth resolver. */
export function emulatorProviderResolver(prisma: PrismaClient): ProviderResolver {
  return async (emailAccountId: string): Promise<EmailProvider> => {
    const account = await prisma.emailAccount.findUnique({ where: { id: emailAccountId }, select: { provider: true } });
    if (account?.provider !== "emulator") throw new Error("No provider resolver configured for this account");
    return new EmulatedMailProvider(prisma, emailAccountId);
  };
}

export async function runDelayedWorker(input: { prisma: PrismaClient; resolveProvider: ProviderResolver; signal: AbortSignal; pollMs?: number }): Promise<void> {
  const pollMs = input.pollMs ?? 1000;
  while (!input.signal.aborted) {
    try {
      const processed = await processNextDelayedAction({ prisma: input.prisma, resolveProvider: input.resolveProvider, execute: executeScheduledAction });
      const tracked = await processPendingReplyTracking({ prisma: input.prisma, resolveProvider: input.resolveProvider });
      const synced = await processNextReplyLabelSync({ prisma: input.prisma, resolveProvider: input.resolveProvider });
      await processPendingSenderLearning(input.prisma);
      if (processed || tracked || synced) continue;
    } catch {
      // The job remains persisted; a subsequent iteration may retry safe pre-execution work.
      console.error("Delayed worker iteration failed");
    }
    if (!input.signal.aborted) await new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); input.signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, pollMs);
      input.signal.addEventListener("abort", finish, { once: true });
      if (input.signal.aborted) finish();
    });
  }
}

/** Renewal runs separately so slow providers cannot stall delayed actions. */
export async function runSubscriptionMaintenance(input: { prisma: PrismaClient; signal: AbortSignal; pollMs?: number }): Promise<void> {
  while (!input.signal.aborted) {
    try { await maintainProviderSubscriptions({ prisma: input.prisma, topic: process.env.GOOGLE_PUBSUB_TOPIC, signal: input.signal }); }
    catch { if (!input.signal.aborted) console.error("Provider subscription maintenance failed"); }
    if (!input.signal.aborted) await new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); input.signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, input.pollMs ?? 30 * 60_000);
      input.signal.addEventListener("abort", finish, { once: true });
      if (input.signal.aborted) finish();
    });
  }
}

export async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const syncWorker = process.env.REDIS_URL ? createProviderSyncWorker(prisma, process.env.REDIS_URL) : undefined;
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try { await Promise.all([runDelayedWorker({ prisma, resolveProvider: (accountId) => resolveMailProvider(prisma, accountId), signal: abort.signal }), ...(process.env.REDIS_URL ? [runSubscriptionMaintenance({ prisma, signal: abort.signal })] : [])]); }
  finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await syncWorker?.close();
    await prisma.$disconnect();
  }
}
