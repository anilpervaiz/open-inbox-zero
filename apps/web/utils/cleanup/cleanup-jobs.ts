import type { Prisma, PrismaClient } from "@prisma/client";
import type { EmailProvider } from "../mail-provider/types";
import { senderAddress, shouldSkipAutomatedArchiveForSender } from "../rule/static-from-risk";

export type CleanupMode = "NEWSLETTERS" | "NOTIFICATIONS" | "BOTH";
type Context = { prisma: PrismaClient; provider: EmailProvider; emailAccountId: string };

function assertBinding(context: Context) {
  if (context.provider.emailAccountId !== context.emailAccountId) throw new Error("Provider does not belong to account");
}

/** Explicit thread selection avoids turning a cleanup job into a mailbox-wide mutation. */
export async function createCleanupJob(input: Context & { threadIds: string[]; olderThan: Date; mode: CleanupMode }) {
  assertBinding(input);
  const { prisma, emailAccountId, provider, olderThan, mode } = input;
  const account = await prisma.emailAccount.findUnique({ where: { id: emailAccountId } });
  if (!account || account.provider !== provider.providerName) throw new Error("Account or provider mismatch");
  if (!(olderThan instanceof Date) || !Number.isFinite(olderThan.getTime()) || olderThan.getTime() > Date.now()) throw new Error("A valid past cutoff is required");
  if (!["NEWSLETTERS", "NOTIFICATIONS", "BOTH"].includes(mode)) throw new Error("Invalid cleanup mode");
  const threadIds = [...new Set(input.threadIds)];
  if (!threadIds.length || threadIds.length > 500 || threadIds.some((id) => !id.trim())) throw new Error("Select between 1 and 500 threads");
  const messages = await prisma.emailMessage.findMany({ where: { emailAccountId, threadId: { in: threadIds } }, select: { threadId: true } });
  if (threadIds.some((id) => !messages.some((message) => message.threadId === id))) throw new Error("A selected thread does not belong to account");
  return prisma.cleanupJob.create({ data: { emailAccountId, olderThan, mode, threads: { create: threadIds.map((threadId) => ({ threadId })) } }, include: { threads: true } });
}

async function withThreadLock<T>(context: Context, threadId: string, cleanupJobId: string, task: () => Promise<T>): Promise<T> {
  let lock;
  try { lock = await context.prisma.threadExecutionLock.create({ data: { emailAccountId: context.emailAccountId, threadId, ownerCleanupJobId: cleanupJobId } }); }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") throw new Error("Another action is in progress for this thread");
    throw error;
  }
  try { return await task(); }
  finally { await context.prisma.threadExecutionLock.deleteMany({ where: { id: lock.id, emailAccountId: context.emailAccountId, threadId } }); }
}

async function inspectThread(context: Context, threadId: string, cutoff: Date, mode: CleanupMode): Promise<boolean> {
  const { prisma, emailAccountId, provider } = context;
  const [account, stored, newsletters, groups, rules] = await Promise.all([
    prisma.emailAccount.findUniqueOrThrow({ where: { id: emailAccountId } }),
    prisma.emailMessage.findMany({ where: { emailAccountId, threadId } }),
    prisma.newsletter.findMany({ where: { emailAccountId }, select: { fromEmail: true } }),
    prisma.group.findMany({ where: { emailAccountId, OR: [{ name: { contains: "vip", mode: "insensitive" } }, { rules: { some: { name: { contains: "vip", mode: "insensitive" } } } }] }, include: { items: true } }),
    prisma.rule.findMany({ where: { emailAccountId, name: { contains: "vip", mode: "insensitive" }, from: { not: null } }, select: { from: true } }),
  ]);
  const protectedSenders = [...rules.flatMap((rule) => rule.from ? [rule.from] : []), ...groups.flatMap((group) => group.items.filter((item) => item.type === "FROM" && !item.exclude).map((item) => item.value))];
  const thread = await provider.getThread(threadId);
  const liveIds = new Set(thread.messages.map((message) => message.id));
  if (thread.id !== threadId || !stored.length || thread.messages.length !== stored.length || liveIds.size !== stored.length || stored.some((message) => !liveIds.has(message.messageId))) return false;
  const senderSet = new Set(newsletters.map((item) => item.fromEmail.toLowerCase()));
  return thread.messages.every((message) => {
    const row = stored.find((item) => item.messageId === message.id);
    const sender = senderAddress(message.headers.from);
    if (!row || !sender || message.threadId !== threadId || senderAddress(row.fromEmail) !== sender || !Number.isFinite(message.internalDate.getTime()) || message.internalDate > cutoff || row.internalDate > cutoff) return false;
    if (shouldSkipAutomatedArchiveForSender({ sender, accountEmail: account.email, protectedSenders })) return false;
    const newsletter = (mode === "NEWSLETTERS" || mode === "BOTH") && senderSet.has(sender);
    const notification = (mode === "NOTIFICATIONS" || mode === "BOTH") && row.labels.some((label) => /^notifications?$/i.test(label)) && !row.unread && !message.labelIds.includes("UNREAD");
    return newsletter || notification;
  });
}

/** Audited rows precede provider calls; a partial provider failure remains undoable. */
export async function runCleanupJob(input: Context & { cleanupJobId: string }) {
  assertBinding(input);
  const { prisma, provider, emailAccountId, cleanupJobId } = input;
  const job = await prisma.cleanupJob.findFirst({ where: { id: cleanupJobId, emailAccountId }, include: { threads: true } });
  if (!job) throw new Error("Cleanup job not found for account");
  const account = await prisma.emailAccount.findUniqueOrThrow({ where: { id: emailAccountId } });
  if (account.provider !== provider.providerName) throw new Error("Account or provider mismatch");
  if (!["NEWSLETTERS", "NOTIFICATIONS", "BOTH"].includes(job.mode)) throw new Error("Invalid persisted cleanup mode");
  const claim = await prisma.cleanupJob.updateMany({ where: { id: job.id, emailAccountId, status: "PENDING" }, data: { status: "RUNNING" } });
  if (claim.count !== 1) throw new Error("Cleanup job is not available to run");
  let failed = false;
  for (const item of job.threads) {
    try {
      await withThreadLock(input, item.threadId, job.id, async () => {
        if (!await inspectThread(input, item.threadId, job.olderThan, job.mode as CleanupMode)) {
          await prisma.cleanupThread.update({ where: { id: item.id }, data: { status: "SKIPPED", error: "Thread is protected, changed, or not eligible" } });
          return;
        }
        const snapshot = await provider.captureUndoSnapshot(item.threadId);
        await prisma.cleanupThread.update({ where: { id: item.id }, data: { status: "STARTED", startedAt: new Date(), undoSnapshot: snapshot } });
        await provider.archiveThread(item.threadId);
        await prisma.cleanupThread.update({ where: { id: item.id }, data: { status: "COMPLETED", finishedAt: new Date() } });
      });
    } catch {
      failed = true;
      await prisma.cleanupThread.update({ where: { id: item.id }, data: { status: "FAILED", error: "Cleanup failed; reconcile started provider actions before retrying" } });
    }
  }
  return prisma.cleanupJob.update({ where: { id: job.id }, data: { status: failed ? "PARTIAL_ERROR" : "COMPLETED" }, include: { threads: true } });
}

/** Restore only snapshots recorded for this account and job, in reverse action order. */
export async function undoCleanupJob(input: Context & { cleanupJobId: string }) {
  assertBinding(input);
  const { prisma, provider, emailAccountId, cleanupJobId } = input;
  const job = await prisma.cleanupJob.findFirst({ where: { id: cleanupJobId, emailAccountId }, include: { threads: true } });
  if (!job) throw new Error("Cleanup job not found for account");
  const account = await prisma.emailAccount.findUniqueOrThrow({ where: { id: emailAccountId } });
  if (account.provider !== provider.providerName) throw new Error("Account or provider mismatch");
  if (job.status === "UNDONE") return job;
  const claim = await prisma.cleanupJob.updateMany({ where: { id: job.id, emailAccountId, status: { in: ["COMPLETED", "PARTIAL_ERROR"] } }, data: { status: "RUNNING" } });
  if (claim.count !== 1) throw new Error("Cleanup job is still running or unavailable for undo");
  let failed = false;
  for (const item of [...job.threads].reverse()) {
    if (!(item.status === "COMPLETED" || (item.status === "FAILED" && item.startedAt))) continue;
    try {
      if (!item.undoSnapshot) throw new Error("Missing cleanup snapshot");
      await withThreadLock(input, item.threadId, job.id, async () => {
        await provider.restoreArchive(item.threadId, item.undoSnapshot as Prisma.JsonValue);
        await prisma.cleanupThread.update({ where: { id: item.id }, data: { status: "UNDONE", error: null, finishedAt: new Date() } });
      });
    } catch {
      failed = true;
      await prisma.cleanupThread.update({ where: { id: item.id }, data: { error: "Undo failed; manual reconciliation required" } });
    }
  }
  return prisma.cleanupJob.update({ where: { id: job.id }, data: { status: failed ? "PARTIAL_ERROR" : "UNDONE" }, include: { threads: true } });
}

/**
 * Operator-only recovery after independently stopping the original cleanup process.
 * No timeout can prove the worker is dead, so stale jobs are never reset automatically.
 */
export async function recoverAbandonedCleanupJob(input: { prisma: PrismaClient; emailAccountId: string; cleanupJobId: string; confirmedStopped: boolean; operator: string; stoppedEvidence: string }) {
  const operator = input.operator.trim();
  const stoppedEvidence = input.stoppedEvidence.trim();
  const hasControl = [...operator + stoppedEvidence].some((character) => { const code = character.charCodeAt(0); return code < 32 || code === 127; });
  if (!input.confirmedStopped) throw new Error("Operator confirmation that the cleanup process stopped is required");
  if (!operator || operator.length > 120 || stoppedEvidence.length < 10 || stoppedEvidence.length > 1000 || hasControl) throw new Error("Operator and specific stop evidence are required");
  return input.prisma.$transaction(async (tx) => {
    const job = await tx.cleanupJob.findFirst({ where: { id: input.cleanupJobId, emailAccountId: input.emailAccountId, status: "RUNNING" }, include: { threads: true } });
    if (!job) throw new Error("Running cleanup job not found for account");
    for (const thread of job.threads) {
      if (thread.status === "PENDING") await tx.cleanupThread.update({ where: { id: thread.id }, data: { status: "SKIPPED", error: "Cancelled during operator recovery before provider operation" } });
      else if (thread.status === "STARTED") await tx.cleanupThread.update({ where: { id: thread.id }, data: { status: "FAILED", error: "Interrupted after provider operation started; restore snapshot or reconcile" } });
    }
    const released = await tx.threadExecutionLock.deleteMany({ where: { emailAccountId: input.emailAccountId, ownerCleanupJobId: job.id, ownerClaimToken: null } });
    const audit = await tx.cleanupRecovery.create({ data: { emailAccountId: input.emailAccountId, cleanupJobId: job.id, operator, stoppedEvidence, releasedLocks: released.count } });
    const claimed = await tx.cleanupJob.updateMany({ where: { id: job.id, emailAccountId: input.emailAccountId, status: "RUNNING" }, data: { status: "PARTIAL_ERROR" } });
    if (claimed.count !== 1) throw new Error("Cleanup job changed during recovery");
    return { recoveryId: audit.id, releasedLocks: released.count };
  }, { isolationLevel: "Serializable" });
}
