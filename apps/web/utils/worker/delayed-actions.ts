import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { EmailProvider } from "../mail-provider/types";
import { analyzeSenderPattern } from "../rule/ai-sender-pattern-learning";

const DEFAULT_LEASE_MS = 120_000;
export type ProviderResolver = (emailAccountId: string) => Promise<EmailProvider>;
export type DelayedActionExecutor = (input: { prisma: PrismaClient; provider: EmailProvider; emailAccountId: string; executedActionId: string; claimToken: string; markStarted: () => Promise<boolean> }) => Promise<{ status: string }>;

/** Claim one due row atomically; overlapping worker processes never own the same claim. */
export async function claimDueDelayedAction(prisma: PrismaClient, options: { now?: Date; leaseMs?: number } = {}) {
  const now = options.now ?? new Date();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("Lease must be positive");
  const token = randomUUID();
  const leaseUntil = new Date(now.getTime() + leaseMs);
  return prisma.$transaction(async (tx) => {
    // A pre-start skip can commit before its worker releases the thread lock.
    // It cannot perform mail I/O afterward, so clearing only its own token is safe.
    const terminal = await tx.delayedAction.findMany({ where: { status: "COMPLETED", startedAt: null, claimToken: { not: null } }, select: { id: true, claimToken: true }, take: 100 });
    for (const item of terminal) {
      if (!item.claimToken) continue;
      await tx.threadExecutionLock.deleteMany({ where: { ownerClaimToken: item.claimToken } });
      await tx.delayedAction.updateMany({ where: { id: item.id, status: "COMPLETED", startedAt: null, claimToken: item.claimToken }, data: { claimToken: null, leaseUntil: null } });
    }
    // Once provider work may have begun, an expired lease is never retried.
    await tx.delayedAction.updateMany({ where: { status: "CLAIMED", leaseUntil: { lte: now }, startedAt: { not: null } }, data: { status: "UNCERTAIN", error: "Worker stopped after action execution began; reconcile before retrying" } });
    const rows = await tx.$queryRaw<{ id: string; claimToken: string | null }[]>`
      SELECT "id", "claimToken" FROM "DelayedAction"
      WHERE "dueAt" <= ${now} AND ("status" = 'PENDING' OR ("status" = 'CLAIMED' AND "leaseUntil" <= ${now} AND "startedAt" IS NULL))
      ORDER BY "dueAt", "id" FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!rows.length) return null;
    const claimed = await tx.delayedAction.updateMany({
      where: { id: rows[0].id, dueAt: { lte: now }, OR: [{ status: "PENDING" }, { status: "CLAIMED", leaseUntil: { lte: now }, startedAt: null }] },
      data: { status: "CLAIMED", claimToken: token, leaseUntil, startedAt: null, error: null, attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) return null;
    // The replaced token can no longer mark the job started, so its abandoned
    // scheduled-worker lock can be removed without releasing an active effect.
    if (rows[0].claimToken) await tx.threadExecutionLock.deleteMany({ where: { ownerClaimToken: rows[0].claimToken } });
    return tx.delayedAction.findUniqueOrThrow({ where: { id: rows[0].id }, include: { executedAction: { include: { executedRule: { select: { emailAccountId: true } } } } } });
  });
}

/** The handler must revalidate account ownership, consent and sender safety at execution time. */
export async function processNextDelayedAction(input: { prisma: PrismaClient; resolveProvider: ProviderResolver; execute: DelayedActionExecutor; now?: Date; leaseMs?: number }): Promise<boolean> {
  const { prisma } = input;
  const job = await claimDueDelayedAction(prisma, { now: input.now, leaseMs: input.leaseMs });
  if (!job || !job.claimToken) return false;
  const { claimToken } = job;
  const emailAccountId = job.executedAction.executedRule.emailAccountId;
  const failBeforeStart = async (error: string) => prisma.$transaction(async (tx) => {
    const updated = await tx.delayedAction.updateMany({ where: { id: job.id, status: "CLAIMED", claimToken, startedAt: null, leaseUntil: { gt: new Date() } }, data: { status: "FAILED", error } });
    if (updated.count !== 1) return;
    await tx.executedAction.updateMany({ where: { id: job.executedActionId, status: "PENDING" }, data: { status: "FAILED", error } });
    const actions = await tx.executedAction.findMany({ where: { executedRuleId: job.executedAction.executedRuleId }, select: { status: true } });
    if (!actions.some((action) => action.status === "PENDING")) await tx.executedRule.update({ where: { id: job.executedAction.executedRuleId }, data: { status: "ERROR" } });
  });
  const retryBeforeStart = async (error: string) => {
    if (job.attempts < 5) await prisma.delayedAction.updateMany({ where: { id: job.id, status: "CLAIMED", claimToken, startedAt: null, leaseUntil: { gt: new Date() } }, data: { status: "PENDING", claimToken: null, leaseUntil: null, dueAt: new Date(Date.now() + Math.min(60_000, 1000 * 2 ** (job.attempts - 1))), error } });
    else await failBeforeStart(error);
  };
  let provider: EmailProvider;
  try {
    provider = await input.resolveProvider(emailAccountId);
    if (provider.emailAccountId !== emailAccountId) throw new Error("Provider does not belong to account");
  } catch {
    await retryBeforeStart("Could not resolve provider for delayed action");
    return true;
  }
  let didStart = false;
  const markStarted = async () => {
    const start = await prisma.delayedAction.updateMany({ where: { id: job.id, status: "CLAIMED", claimToken, startedAt: null, leaseUntil: { gt: new Date() } }, data: { startedAt: new Date() } });
    didStart = start.count === 1;
    return didStart;
  };
  try {
    const result = await input.execute({ prisma, provider, emailAccountId, executedActionId: job.executedActionId, claimToken, markStarted });
    const successful = (result.status === "COMPLETED" && didStart) || result.status === "SKIPPED";
    await prisma.delayedAction.updateMany({ where: { id: job.id, claimToken, status: { in: ["CLAIMED", "UNCERTAIN"] } }, data: { status: successful ? "COMPLETED" : "UNCERTAIN", error: successful ? null : "Action outcome needs reconciliation" } });
  } catch (error) {
    if (!didStart && error instanceof Error && error.message === "Another action is in progress for this thread") {
      await prisma.delayedAction.updateMany({ where: { id: job.id, claimToken, status: "CLAIMED", startedAt: null, leaseUntil: { gt: new Date() } }, data: { status: "PENDING", claimToken: null, leaseUntil: null, dueAt: new Date(Date.now() + 1000), attempts: { decrement: 1 }, error: null } });
    } else if (!didStart) {
      await retryBeforeStart("Delayed action failed before execution");
    } else {
      await prisma.delayedAction.updateMany({ where: { id: job.id, claimToken, status: { in: ["CLAIMED", "UNCERTAIN"] } }, data: { status: didStart ? "UNCERTAIN" : "FAILED", error: didStart ? "Action outcome needs reconciliation" : "Delayed action failed before execution" } });
    }
  }
  return true;
}

/** Retry learning without ever replaying the mail action. */
export async function processPendingSenderLearning(prisma: PrismaClient): Promise<boolean> {
  const job = await prisma.delayedAction.findFirst({ where: { learningPending: true, OR: [{ learningNextAttemptAt: null }, { learningNextAttemptAt: { lte: new Date() } }] }, include: { executedAction: { include: { executedRule: true } } }, orderBy: { createdAt: "asc" } });
  if (!job) return false;
  const execution = job.executedAction.executedRule;
  const message = await prisma.emailMessage.findUnique({ where: { emailAccountId_messageId: { emailAccountId: execution.emailAccountId, messageId: execution.messageId } } });
  if (!message || !execution.ruleId || execution.status !== "APPLIED") {
    await prisma.delayedAction.updateMany({ where: { id: job.id, learningPending: true }, data: { learningPending: false, learningNextAttemptAt: null } });
    return true;
  }
  try {
    await analyzeSenderPattern(prisma, { emailAccountId: execution.emailAccountId, fromEmail: message.fromEmail, ruleId: execution.ruleId });
    await prisma.delayedAction.updateMany({ where: { id: job.id, learningPending: true }, data: { learningPending: false, learningNextAttemptAt: null } });
  } catch {
    await prisma.delayedAction.updateMany({ where: { id: job.id, learningPending: true }, data: { learningNextAttemptAt: new Date(Date.now() + 60_000) } });
  }
  return true;
}
