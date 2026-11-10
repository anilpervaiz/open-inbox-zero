import type { PrismaClient } from "@prisma/client";

export type RecoverAbandonedImmediateInput = {
  prisma: PrismaClient;
  emailAccountId: string;
  threadId: string;
  /** The caller must independently verify the original process and its provider calls have stopped. */
  confirmedStopped: boolean;
  operator: string;
  stoppedEvidence: string;
};

/**
 * Explicit operator recovery. This function cannot verify an external process has stopped.
 * Never call it based only on elapsed time; releasing a live lock permits concurrent effects.
 * Started outbound and draft actions stay indeterminate and must never be retried blindly.
 */
export async function recoverAbandonedImmediateExecution(input: RecoverAbandonedImmediateInput) {
  const { prisma, emailAccountId, threadId } = input;
  const operator = input.operator.trim();
  const stoppedEvidence = input.stoppedEvidence.trim();
  if (!input.confirmedStopped) throw new Error("Operator confirmation that the original process stopped is required");
  const hasControl = [...operator + stoppedEvidence].some((character) => { const code = character.charCodeAt(0); return code < 32 || code === 127; });
  if (!emailAccountId.trim() || !threadId.trim() || !operator || operator.length > 120 || stoppedEvidence.length < 10 || stoppedEvidence.length > 1000 || hasControl) throw new Error("Account, thread, operator and specific stop evidence are required");
  return prisma.$transaction(async (tx) => {
    const account = await tx.emailAccount.findUnique({ where: { id: emailAccountId }, select: { id: true } });
    if (!account) throw new Error("Account not found");
    const lock = await tx.threadExecutionLock.findUnique({ where: { emailAccountId_threadId: { emailAccountId, threadId } } });
    if (!lock) throw new Error("Abandoned thread lock not found");
    if (lock.ownerClaimToken !== null) throw new Error("Delayed worker locks require the delayed-job recovery procedure");
    const pending = await tx.executedRule.findMany({ where: { emailAccountId, threadId, status: "PENDING" }, include: { actionItems: { include: { delayedAction: true } } } });
    if (pending.some((execution) => execution.actionItems.some((action) => action.delayedAction))) throw new Error("Execution has delayed jobs and requires the delayed-job recovery procedure");
    for (const execution of pending) {
      for (const action of execution.actionItems) {
        if (action.status !== "PENDING") continue;
        if (action.executionStartedAt) {
          await tx.executedAction.update({ where: { id: action.id }, data: { status: "FAILED", error: "Interrupted after provider operation started; outcome requires reconciliation" } });
        } else {
          await tx.executedAction.update({ where: { id: action.id }, data: { status: "SKIPPED", error: "Cancelled during abandoned execution recovery before provider operation" } });
        }
      }
      const actions = await tx.executedAction.findMany({ where: { executedRuleId: execution.id } });
      const status = actions.some((action) => action.status === "FAILED") ? "ERROR" : actions.some((action) => action.status === "COMPLETED") ? "APPLIED" : "SKIPPED";
      await tx.executedRule.update({ where: { id: execution.id }, data: { status, reason: [execution.reason, `Recovered by ${operator}; evidence: ${stoppedEvidence}`].filter(Boolean).join("\n") } });
    }
    const recovery = await tx.executionRecovery.create({ data: { emailAccountId, threadId, abandonedLockId: lock.id, operator, stoppedEvidence, affectedExecutions: pending.length } });
    const deleted = await tx.threadExecutionLock.deleteMany({ where: { id: lock.id, emailAccountId, threadId, ownerClaimToken: null } });
    if (deleted.count !== 1) throw new Error("Abandoned lock changed during recovery");
    return { recoveryId: recovery.id, affectedExecutions: pending.length };
  }, { isolationLevel: "Serializable" });
}
