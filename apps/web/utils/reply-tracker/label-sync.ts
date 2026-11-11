import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { EmailProvider } from "../mail-provider/types";

type ResolveProvider = (emailAccountId: string) => Promise<EmailProvider>;
const LEASE_MS = 120_000;

/** Process at most one durable, account-bound tracker-label reconciliation. */
export async function processNextReplyLabelSync(input: { prisma: PrismaClient; resolveProvider: ResolveProvider }): Promise<boolean> {
  const { prisma } = input;
  const now = new Date();
  const token = randomUUID();
  const job = await prisma.$transaction(async (tx) => {
    // A terminal pre-start skip has no mail effects; release only that claim's stale lock.
    const terminal = await tx.replyLabelSync.findMany({ where: { status: "CANCELLED", startedAt: null, claimToken: { not: null } }, select: { id: true, claimToken: true }, take: 100 });
    for (const item of terminal) if (item.claimToken) {
      await tx.threadExecutionLock.deleteMany({ where: { ownerClaimToken: item.claimToken } });
      await tx.replyLabelSync.updateMany({ where: { id: item.id, status: "CANCELLED", startedAt: null, claimToken: item.claimToken }, data: { claimToken: null, leaseUntil: null } });
    }
    await tx.replyLabelSync.updateMany({ where: { status: "CLAIMED", leaseUntil: { lte: now }, startedAt: { not: null } }, data: { status: "UNCERTAIN", error: "Label outcome requires reconciliation" } });
    const rows = await tx.$queryRaw<{ id: string; claimToken: string | null }[]>`
      SELECT "id", "claimToken" FROM "ReplyLabelSync"
      WHERE "nextAttemptAt" <= ${now} AND ("status" = 'PENDING' OR ("status" = 'CLAIMED' AND "leaseUntil" <= ${now} AND "startedAt" IS NULL))
      ORDER BY "createdAt", "id" FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!rows.length) return null;
    const updated = await tx.replyLabelSync.updateMany({ where: { id: rows[0].id, OR: [{ status: "PENDING" }, { status: "CLAIMED", leaseUntil: { lte: now }, startedAt: null }] }, data: { status: "CLAIMED", claimToken: token, leaseUntil: new Date(now.getTime() + LEASE_MS), attempts: { increment: 1 }, error: null } });
    if (updated.count !== 1) return null;
    if (rows[0].claimToken) await tx.threadExecutionLock.deleteMany({ where: { ownerClaimToken: rows[0].claimToken } });
    return tx.replyLabelSync.findUniqueOrThrow({ where: { id: rows[0].id }, include: { executedRule: { include: { actionItems: true } } } });
  });
  if (!job) return false;

  const retryBeforeStart = async () => {
    await prisma.replyLabelSync.updateMany({ where: { id: job.id, status: "CLAIMED", claimToken: token, startedAt: null, leaseUntil: { gt: new Date() } }, data: { status: "PENDING", claimToken: null, leaseUntil: null, nextAttemptAt: new Date(Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(job.attempts - 1, 6))), error: "Label sync unavailable; retry scheduled" } });
  };
  let provider: EmailProvider;
  try {
    provider = await input.resolveProvider(job.emailAccountId);
    if (provider.emailAccountId !== job.emailAccountId) throw new Error("Provider account mismatch");
    const account = await prisma.emailAccount.findUnique({ where: { id: job.emailAccountId }, select: { provider: true } });
    if (!account || account.provider !== provider.providerName) throw new Error("Provider account mismatch");
  } catch { await retryBeforeStart(); return true; }

  let lockId: string | undefined;
  let didStart = false;
  try {
    const lock = await prisma.threadExecutionLock.create({ data: { emailAccountId: job.emailAccountId, threadId: job.threadId, ownerClaimToken: token } });
    lockId = lock.id;
    const current = await prisma.replyThreadState.findUnique({ where: { emailAccountId_threadId: { emailAccountId: job.emailAccountId, threadId: job.threadId } } });
    if (!current || current.revision !== job.revision || job.executedRule.status !== "PENDING") {
      await prisma.$transaction(async (tx) => {
        const cancelled = await tx.replyLabelSync.updateMany({ where: { id: job.id, status: "CLAIMED", claimToken: token, startedAt: null, leaseUntil: { gt: new Date() } }, data: { status: "CANCELLED", error: "Superseded by a newer tracker state" } });
        if (cancelled.count !== 1) throw new Error("Label claim expired");
        await tx.executedAction.updateMany({ where: { executedRuleId: job.executedRuleId, status: "PENDING" }, data: { status: "SKIPPED", error: "Superseded by a newer tracker state" } });
        await tx.executedRule.updateMany({ where: { id: job.executedRuleId, status: "PENDING" }, data: { status: "SKIPPED" } });
      });
      return true;
    }
    if (job.executedRule.emailAccountId !== job.emailAccountId || job.executedRule.threadId !== job.threadId || job.executedRule.sourceMessageId !== job.sourceMessageId) throw new Error("Invalid tracker audit ownership");
    const actions = job.executedRule.actionItems.slice().sort((a, b) => a.id.localeCompare(b.id));
    if (actions.length !== 2 || actions.some((action) => action.type !== "LABEL" || !["To Reply", "Awaiting Reply"].includes(action.label ?? "") || !["ADD", "REMOVE"].includes(action.labelOperation ?? ""))) throw new Error("Invalid tracker audit actions");
    for (const action of actions) {
      if (action.status === "SKIPPED") continue;
      if (action.status !== "PENDING") throw new Error("Tracker audit requires reconciliation");
      const state = await prisma.replyThreadState.findUnique({ where: { emailAccountId_threadId: { emailAccountId: job.emailAccountId, threadId: job.threadId } } });
      if (!state || state.revision !== job.revision) break;
      const thread = await provider.getThread(job.threadId);
      if (thread.id !== job.threadId || !thread.messages.length || thread.messages.some((message) => message.threadId !== job.threadId)) throw new Error("Tracker thread could not be verified");
      const label = action.label!;
      const needsMutation = action.labelOperation === "ADD" ? thread.messages.some((message) => !message.labelIds.includes(label)) : thread.messages.some((message) => message.labelIds.includes(label));
      if (!needsMutation) {
        const skipped = await prisma.$transaction(async (tx) => {
          const claim = await tx.replyLabelSync.updateMany({ where: { id: job.id, status: "CLAIMED", claimToken: token, leaseUntil: { gt: new Date() } }, data: { error: null } });
          if (claim.count !== 1) throw new Error("Label claim expired");
          return tx.executedAction.updateMany({ where: { id: action.id, status: "PENDING" }, data: { status: "SKIPPED", error: "Already in desired state" } });
        });
        if (skipped.count !== 1) throw new Error("Label action is not pending");
        continue;
      }
      const snapshot = await provider.captureUndoSnapshot(job.threadId);
      await prisma.$transaction(async (tx) => {
        const latest = await tx.replyThreadState.findUnique({ where: { emailAccountId_threadId: { emailAccountId: job.emailAccountId, threadId: job.threadId } } });
        if (!latest || latest.revision !== job.revision) throw new Error("Tracker state changed");
        const claim = await tx.replyLabelSync.updateMany({ where: { id: job.id, status: "CLAIMED", claimToken: token, leaseUntil: { gt: new Date() } }, data: { startedAt: job.startedAt ?? new Date() } });
        if (claim.count !== 1) throw new Error("Label claim expired");
        const prepared = await tx.executedAction.updateMany({ where: { id: action.id, status: "PENDING" }, data: { undoSnapshot: snapshot, executionStartedAt: new Date() } });
        if (prepared.count !== 1) throw new Error("Label action is not pending");
      });
      didStart = true;
      if (action.labelOperation === "ADD") await provider.addLabel(job.threadId, label);
      else await provider.removeLabel(job.threadId, label);
      await prisma.executedAction.update({ where: { id: action.id }, data: { status: "COMPLETED", executedAt: new Date() } });
    }
    await prisma.$transaction(async (tx) => {
      const claim = await tx.replyLabelSync.updateMany({ where: { id: job.id, status: "CLAIMED", claimToken: token }, data: { status: "COMPLETED" } });
      if (claim.count !== 1) throw new Error("Label claim is no longer active");
      await tx.executedAction.updateMany({ where: { executedRuleId: job.executedRuleId, status: "PENDING" }, data: { status: "SKIPPED", error: "Superseded by a newer tracker state" } });
      const completed = await tx.executedAction.count({ where: { executedRuleId: job.executedRuleId, status: "COMPLETED" } });
      await tx.executedRule.update({ where: { id: job.executedRuleId }, data: { status: completed ? "APPLIED" : "SKIPPED" } });
    });
  } catch {
    if (didStart) {
      await prisma.$transaction(async (tx) => {
        const owned = await tx.replyLabelSync.updateMany({ where: { id: job.id, claimToken: token, status: { in: ["CLAIMED", "UNCERTAIN"] } }, data: { status: "UNCERTAIN", error: "Label outcome requires reconciliation" } });
        if (owned.count !== 1) return;
        await tx.executedAction.updateMany({ where: { executedRuleId: job.executedRuleId, status: "PENDING", executionStartedAt: { not: null } }, data: { status: "FAILED", error: "Label outcome requires reconciliation" } });
        await tx.executedAction.updateMany({ where: { executedRuleId: job.executedRuleId, status: "PENDING", executionStartedAt: null }, data: { status: "SKIPPED", error: "Not attempted after label sync failure" } });
        await tx.executedRule.updateMany({ where: { id: job.executedRuleId, status: "PENDING" }, data: { status: "ERROR" } });
      });
    } else await retryBeforeStart();
  } finally {
    if (lockId) await prisma.threadExecutionLock.deleteMany({ where: { id: lockId, emailAccountId: job.emailAccountId, threadId: job.threadId } });
  }
  return true;
}
