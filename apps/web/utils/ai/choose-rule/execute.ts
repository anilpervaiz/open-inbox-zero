import { suppressReplyRequirement, undoTrackerAudit } from "../../reply-tracker/events";
import type { Action, ActionType, ExecutedAction, Prisma, PrismaClient, Rule } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import type { EmailProvider, ParsedMessage } from "../../mail-provider/types";
import { executeWebhook } from "../../secure-webhook";
import { getBlockedLowTrustStaticFromActionTypes, senderAddress, shouldSkipAutomatedArchiveForSender } from "../../rule/static-from-risk";

type MatchStage = "STATIC" | "GROUP" | "COLD" | "AI" | "SYSTEM" | "MANUAL";
export type MatchReason = { type: MatchStage; detail: string; matchedFields?: ("from" | "to" | "subject" | "body")[] };
export type RuleSelectionMetadata = { stage: MatchStage; ruleName: string };
export type ExecuteActInput = {
  prisma: PrismaClient;
  provider: EmailProvider;
  emailAccountId: string;
  message: ParsedMessage;
  rule: (Rule & { actions: Action[] }) | null;
  actions: Action[];
  matchReasons: MatchReason[];
  selectionMetadata: RuleSelectionMetadata;
  hasVerifiedSenderReplyHistory: boolean;
  protectedSenders?: string[];
  correctionId?: string;
};

type DraftArgs = { threadId: string; to: string; subject: string; body: string; cc?: string; inReplyTo?: string };
function actionType(action: Action): ActionType {
  return (["REPLY", "SEND_EMAIL", "FORWARD"] as ActionType[]).includes(action.type) && !action.autoSend ? "DRAFT_EMAIL" : action.type;
}
async function fingerprint(prisma: PrismaClient, action: Action): Promise<string> {
  const rule = await prisma.rule.findUnique({ where: { id: action.ruleId }, include: { group: { include: { items: true } } } });
  if (!rule) throw new Error("Rule no longer exists");
  const groupItems = rule.group?.items.map((item) => [item.type, item.value, item.exclude, item.source]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) ?? null;
  return createHash("sha256").update(JSON.stringify([
    [action.id, action.ruleId, action.type, action.label, action.subject, action.content, action.to, action.cc, action.bcc, action.url, action.delayMinutes, action.autoSend],
    [rule.id, rule.emailAccountId, rule.name, rule.systemType, rule.instructions, rule.automate, rule.runOnThreads, rule.conditionalOperator, rule.from, rule.to, rule.subject, rule.body, rule.groupId, groupItems],
  ])).digest("hex");
}
const supportedActions: ActionType[] = ["ARCHIVE", "LABEL", "MARK_SEEN", "DRAFT_EMAIL", "REPLY", "SEND_EMAIL", "FORWARD", "TRACK_THREAD", "MARK_SPAM", "CALL_WEBHOOK"];
function skipReason(source: Action, effectiveType: ActionType, input: { automate: boolean; protectArchive: boolean; blocked: ActionType[]; stage: MatchStage; verifiedHistory: boolean }): string | undefined {
  if (!input.automate) return "Rule requires manual approval";
  if (["ARCHIVE", "MARK_SPAM"].includes(effectiveType) && input.protectArchive) return "Protected sender";
  if (source.autoSend && input.blocked.includes(source.type)) return "Unverified static sender";
  if (source.autoSend && ["AI", "GROUP", "SYSTEM", "MANUAL"].includes(input.stage) && !input.verifiedHistory && ["REPLY", "SEND_EMAIL", "FORWARD"].includes(source.type)) return "Selected outbound requires verified sender history";
  // Default to the restricted pilot policy unless an operator explicitly opts out.
  if (process.env.PILOT_MODE !== "false" && ["REPLY", "SEND_EMAIL", "FORWARD"].includes(effectiveType)) return "Automatic sending and forwarding are disabled in pilot mode";
  return undefined;
}

/** Archive/spam affect every message in a thread, so one unknown or protected sender protects all of it. */
async function threadHasProtectedSender(input: { provider: EmailProvider; threadId: string; triggerMessageId: string; accountEmail: string; protectedSenders: string[] }): Promise<boolean> {
  try {
    const thread = await input.provider.getThread(input.threadId);
    if (thread.id !== input.threadId || !thread.messages.length || !thread.messages.some((message) => message.id === input.triggerMessageId)) return true;
    return thread.messages.some((message) => message.threadId !== input.threadId || shouldSkipAutomatedArchiveForSender({ sender: message.headers.from, accountEmail: input.accountEmail, protectedSenders: input.protectedSenders }));
  } catch {
    return true;
  }
}

/** The persistent lock has no automatic expiry: a crash requires operator recovery.
 * It serializes cooperating executions only; direct provider changes are outside its scope. */
async function withThreadLock<T>(prisma: PrismaClient, emailAccountId: string, threadId: string, task: () => Promise<T>, ownerClaimToken?: string): Promise<T> {
  let lock;
  try {
    lock = await prisma.threadExecutionLock.create({ data: { emailAccountId, threadId, ownerClaimToken } });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") throw new Error("Another action is in progress for this thread");
    throw error;
  }
  try { return await task(); }
  finally { await prisma.threadExecutionLock.deleteMany({ where: { id: lock.id, emailAccountId, threadId } }); }
}

/** Create the audit and every PENDING action before any mail-provider call. */
export async function executeAct(input: ExecuteActInput) {
  if (input.provider.emailAccountId !== input.emailAccountId) throw new Error("Provider does not belong to account");
  return withThreadLock(input.prisma, input.emailAccountId, input.message.threadId, () => executeActUnlocked(input));
}

async function executeActUnlocked(input: ExecuteActInput) {
  const { prisma, provider, emailAccountId, message, selectionMetadata, matchReasons } = input;
  if (provider.emailAccountId !== emailAccountId) throw new Error("Provider does not belong to account");
  const account = await prisma.emailAccount.findUnique({ where: { id: emailAccountId } });
  if (!account || account.provider !== provider.providerName) throw new Error("Email account or provider mismatch");
  const sender = senderAddress(message.headers.from);
  if (!sender) throw new Error("Invalid sender address");
  const storedMessage = await prisma.emailMessage.findUnique({ where: { emailAccountId_messageId: { emailAccountId, messageId: message.id } } });
  if (!storedMessage || storedMessage.threadId !== message.threadId || senderAddress(storedMessage.fromEmail) !== sender) throw new Error("Message does not belong to account and thread");
  let rule: (Rule & { actions: Action[] }) | null = null;
  if (input.rule) {
    rule = await prisma.rule.findFirst({ where: { id: input.rule.id, emailAccountId }, include: { actions: true } });
    if (!rule) throw new Error("Rule does not belong to account");
    if (rule.name !== selectionMetadata.ruleName) throw new Error("Selected rule does not match persisted rule");
  } else if (selectionMetadata.stage !== "COLD") {
    throw new Error("Only a cold-email decision may use a synthetic rule");
  }
  const incomingById = new Map(input.actions.map((action) => [action.id, action]));
  if (rule && (rule.actions.length !== input.actions.length || rule.actions.some((action) => !incomingById.has(action.id)))) throw new Error("Action list does not match persisted rule");
  if (!rule) {
    if (account.coldEmailBlocker === "DISABLED") throw new Error("Cold email blocker is disabled");
    if (input.actions.length === 0 || input.actions.some((action) =>
      !["ARCHIVE", "LABEL"].includes(action.type) || (action.type === "LABEL" && action.label !== "Cold Emails") ||
      (action.type === "ARCHIVE" && account.coldEmailBlocker !== "LABEL_AND_ARCHIVE"))) throw new Error("Synthetic rule has unsupported action");
  }
  const configured = rule?.actions ?? input.actions;
  const planned = configured.map((action) => {
    if (action.delayMinutes !== null && (!Number.isInteger(action.delayMinutes) || action.delayMinutes < 0)) throw new Error("Invalid action delay");
    const generated = incomingById.get(action.id);
    // Generated output may fill draft content, never change execution type, recipients, or sending consent.
    const dynamic = action.type === "DRAFT_EMAIL" || action.type === "REPLY";
    return { ...action, type: actionType(action), content: dynamic ? (generated?.content ?? action.content) : action.content };
  });
  const history = await prisma.emailMessage.findFirst({ where: {
    emailAccountId, fromEmail: { equals: account.email, mode: "insensitive" }, toEmail: { equals: sender, mode: "insensitive" }, labels: { has: "SENT" },
  }, select: { id: true } });
  // A caller assertion alone is not evidence: sender history must also exist in the mailbox.
  const verifiedHistory = input.hasVerifiedSenderReplyHistory && Boolean(history);
  const blocked = getBlockedLowTrustStaticFromActionTypes({ rule, stage: selectionMetadata.stage, hasVerifiedSenderReplyHistory: verifiedHistory, matchedFields: matchReasons.find((reason) => reason.type === "STATIC")?.matchedFields });
  const vipGroups = await prisma.group.findMany({ where: { emailAccountId, OR: [{ name: { contains: "vip", mode: "insensitive" } }, { rules: { some: { name: { contains: "vip", mode: "insensitive" } } } }] }, include: { items: true } });
  const vipRules = await prisma.rule.findMany({ where: { emailAccountId, name: { contains: "vip", mode: "insensitive" }, from: { not: null } }, select: { from: true } });
  const protectedSenders = [...(input.protectedSenders ?? []), ...vipRules.flatMap((item) => item.from ? [item.from] : []), ...vipGroups.flatMap((group) => group.items.filter((item) => item.type === "FROM" && !item.exclude).map((item) => item.value))];
  const protectArchive = shouldSkipAutomatedArchiveForSender({ sender, accountEmail: account.email, protectedSenders });
  const safety = { automate: selectionMetadata.stage === "MANUAL" || (rule?.automate ?? true), protectArchive, blocked, stage: selectionMetadata.stage, verifiedHistory };
  if (input.correctionId && !/^correction:[0-9a-f-]{36}$/i.test(input.correctionId)) throw new Error("Invalid correction identifier");
  const auditMessageId = input.correctionId ?? message.id;
  const existing = await prisma.executedRule.findUnique({ where: { emailAccountId_threadId_messageId: { emailAccountId, threadId: message.threadId, messageId: auditMessageId } }, include: { actionItems: true } });
  if (existing) return existing;
  const actionIds = planned.map((_, index) => `${String(index).padStart(8, "0")}-${randomUUID()}`);
  const fingerprints = await Promise.all(configured.map((action) => action.delayMinutes ? fingerprint(prisma, action) : Promise.resolve("")));
  let execution;
  try {
    execution = await prisma.executedRule.create({ data: {
      emailAccountId, ruleId: rule?.id, threadId: message.threadId, messageId: auditMessageId, sourceMessageId: input.correctionId ? message.id : undefined,
      status: "PENDING", automated: selectionMetadata.stage !== "MANUAL" && (rule?.automate ?? true),
      matchReasons: matchReasons as Prisma.InputJsonValue, selectionMetadata: selectionMetadata as Prisma.InputJsonValue,
      actionItems: { create: planned.map((action, index) => ({
        id: actionIds[index], type: action.type, label: action.label, subject: action.subject, content: action.content, to: action.to, cc: action.cc, bcc: action.bcc, url: action.url,
        ...(action.delayMinutes && !skipReason(configured[index], action.type, safety) && supportedActions.includes(action.type)
          ? { delayedAction: { create: { dueAt: new Date(Date.now() + action.delayMinutes * 60_000), sourceActionId: configured[index].id, sourceFingerprint: fingerprints[index], protectedSenders: input.protectedSenders ?? [] } } }
          : {}),
      })) },
    }, include: { actionItems: true } });
  } catch (error) {
    const duplicate = await prisma.executedRule.findUnique({ where: { emailAccountId_threadId_messageId: { emailAccountId, threadId: message.threadId, messageId: auditMessageId } }, include: { actionItems: true } });
    if (duplicate) return duplicate;
    throw error;
  }
  let anyCompleted = false;
  let anyFailed = false;
  let anyScheduled = false;
  for (let index = 0; index < actionIds.length; index++) {
    const action = execution.actionItems.find((item) => item.id === actionIds[index]);
    const source = configured[index];
    if (!action || !source) throw new Error("Execution action mapping is invalid");
    const skip = skipReason(source, action.type, safety);
    if (!supportedActions.includes(action.type)) {
      anyFailed = true;
      await prisma.executedAction.update({ where: { id: action.id }, data: { status: "FAILED", error: "Unsupported action" } });
      continue;
    }
    if (skip) {
      await prisma.executedAction.update({ where: { id: action.id }, data: { status: "SKIPPED", error: skip } });
      continue;
    }
    if (source.delayMinutes) { anyScheduled = true; continue; }
    if (["ARCHIVE", "MARK_SPAM"].includes(action.type) && await threadHasProtectedSender({ provider, threadId: message.threadId, triggerMessageId: message.id, accountEmail: account.email, protectedSenders })) {
      await prisma.executedAction.update({ where: { id: action.id }, data: { status: "SKIPPED", error: "Protected or unverifiable thread" } });
      continue;
    }
    if (await executeActionEffect({ prisma, provider, emailAccountId, message, sender, action, source, executionId: execution.id })) anyCompleted = true;
    else anyFailed = true;
  }
  return prisma.executedRule.update({ where: { id: execution.id }, data: { status: anyScheduled ? "PENDING" : anyFailed ? "ERROR" : anyCompleted ? "APPLIED" : "SKIPPED" }, include: { actionItems: true } });
}

/** Execute one audited action. A failure after I/O is retained for reconciliation. */
async function executeActionEffect(input: { prisma: PrismaClient; provider: EmailProvider; emailAccountId: string; message: ParsedMessage; sender: string; action: ExecutedAction; source: Action; executionId: string; delayedJobId?: string }): Promise<boolean> {
  const { prisma, provider, emailAccountId, message, sender, action, source, executionId, delayedJobId } = input;
    try {
      if (process.env.PILOT_MODE !== "false" && ["REPLY", "SEND_EMAIL", "FORWARD"].includes(action.type)) throw new Error("Automatic sending and forwarding are disabled in pilot mode");
      if (action.type === "TRACK_THREAD") {
        await prisma.$transaction(async (tx) => {
          const existingTracker = await tx.threadTracker.findUnique({ where: { emailAccountId_threadId_messageId: { emailAccountId, threadId: message.threadId, messageId: message.id } } });
          const created = existingTracker ?? await tx.threadTracker.create({ data: { emailAccountId, threadId: message.threadId, messageId: message.id, type: "NEEDS_REPLY", sentAt: message.internalDate } });
          await tx.executedAction.update({ where: { id: action.id }, data: { status: "COMPLETED", executedAt: new Date(), undoSnapshot: { provider: "internal", threadId: message.threadId, createdTrackerId: existingTracker ? null : created.id } } });
          if (delayedJobId) await tx.delayedAction.update({ where: { id: delayedJobId }, data: { trackerPending: true, trackerNextAttemptAt: null } });
        });
        return true;
      }
      const snapshot = await provider.captureUndoSnapshot(message.threadId);
      await prisma.executedAction.update({ where: { id: action.id }, data: { undoSnapshot: snapshot, executionStartedAt: new Date() } });
      let draftId: string | undefined;
      let draftThreadId: string | undefined;
      let sentMessageId: string | undefined;
      if (action.type === "CALL_WEBHOOK") {
        if (!source.url) throw new Error("Webhook URL is required");
        await executeWebhook({ url: source.url, payload: { event: "rule.executed", emailAccountId, threadId: message.threadId, messageId: message.id, executedRuleId: executionId, executedActionId: action.id } });
      } else if (action.type === "ARCHIVE") await provider.archiveThread(message.threadId);
      else if (action.type === "MARK_SPAM") await provider.markSpam(message.threadId);
      else if (action.type === "LABEL") {
        if (!action.label) throw new Error("Label is required");
        await provider.addLabel(message.threadId, action.label);
      } else if (action.type === "MARK_SEEN") await provider.markRead(message.threadId, true);
      else {
        const args: DraftArgs = { threadId: message.threadId, to: source.to ?? sender, subject: action.subject ?? `Re: ${message.headers.subject}`, body: action.content ?? "", ...(source.cc ? { cc: source.cc } : {}), ...(message.headers.messageId ? { inReplyTo: message.headers.messageId } : {}) };
        if (source.type === "FORWARD") {
          if (!source.to) throw new Error("Forwarding requires an explicit recipient");
          if (action.type === "DRAFT_EMAIL") {
            const result = await provider.createForwardDraft({ threadId: message.threadId, messageId: message.id, to: source.to, cc: source.cc ?? undefined, comment: action.content ?? undefined });
            draftId = result.draftId;
            draftThreadId = result.draftThreadId;
          } else {
            if (!source.autoSend) throw new Error("Automated forwarding requires consent");
            sentMessageId = (await provider.forwardEmail({ threadId: message.threadId, messageId: message.id, to: source.to, cc: source.cc ?? undefined, comment: action.content ?? undefined })).messageId;
          }
        } else if (action.type === "DRAFT_EMAIL") draftId = (await provider.createDraft(args)).draftId;
        else {
          if (!source.autoSend || !source.to) throw new Error("Automated sending requires an explicit recipient and auto-send consent");
          sentMessageId = (await provider.sendEmail(args)).messageId;
        }
      }
      await prisma.$transaction(async (tx) => {
        await tx.executedAction.update({ where: { id: action.id }, data: { status: "COMPLETED", draftId, draftThreadId, sentMessageId, executedAt: new Date() } });
        if (delayedJobId && source.type === "REPLY" && action.type === "REPLY" && sentMessageId) await tx.delayedAction.update({ where: { id: delayedJobId }, data: { trackerPending: true, trackerNextAttemptAt: null } });
      });
      return true;
    } catch {
      await prisma.executedAction.update({ where: { id: action.id }, data: { status: "FAILED", error: "Action failed" } });
      return false;
    }
}

/** Execute only a claimed, originally authorized delayed action under the same thread lock. */
export async function executeScheduledAction(input: { prisma: PrismaClient; provider: EmailProvider; emailAccountId: string; executedActionId: string; claimToken: string; markStarted: () => Promise<boolean> }) {
  const { prisma, provider, emailAccountId, executedActionId, claimToken, markStarted } = input;
  if (provider.emailAccountId !== emailAccountId) throw new Error("Provider does not belong to account");
  const initial = await prisma.executedAction.findFirst({ where: { id: executedActionId, executedRule: { emailAccountId } }, include: { executedRule: true } });
  if (!initial) throw new Error("Scheduled action does not belong to account");
  return withThreadLock(prisma, emailAccountId, initial.executedRule.threadId, async () => {
    const job = await prisma.delayedAction.findFirst({ where: { executedActionId, status: "CLAIMED", claimToken, startedAt: null, leaseUntil: { gt: new Date() } }, include: { executedAction: { include: { executedRule: { include: { emailAccount: true, rule: true } } } } } });
    if (!job) throw new Error("Delayed action is not actively claimed");
    const action = job.executedAction;
    const execution = action.executedRule;
    if (execution.emailAccountId !== emailAccountId || execution.emailAccount.provider !== provider.providerName || execution.status !== "PENDING" || action.status !== "PENDING") throw new Error("Delayed action is no longer eligible");
    const source = await prisma.action.findFirst({ where: { id: job.sourceActionId, ruleId: execution.ruleId ?? "", rule: { emailAccountId } } });
    const updateExecutionTx = async (tx: Prisma.TransactionClient) => {
      const actions = await tx.executedAction.findMany({ where: { executedRuleId: execution.id } });
      const status = actions.some((item) => item.status === "PENDING") ? "PENDING" : actions.some((item) => item.status === "FAILED") ? "ERROR" : actions.some((item) => item.status === "COMPLETED") ? "APPLIED" : "SKIPPED";
      await tx.executedRule.update({ where: { id: execution.id }, data: { status } });
      const metadata = execution.selectionMetadata;
      if (status === "APPLIED" && execution.ruleId && metadata && typeof metadata === "object" && !Array.isArray(metadata) && metadata.stage === "AI") await tx.delayedAction.update({ where: { id: job.id }, data: { learningPending: true } });
    };
    const updateExecution = () => prisma.$transaction(updateExecutionTx);
    const skipScheduled = (reason: string) => prisma.$transaction(async (tx) => {
      // Fence all pre-start terminal writes against a replaced or expired claim.
      const claimed = await tx.delayedAction.updateMany({ where: { id: job.id, status: "CLAIMED", claimToken, startedAt: null, leaseUntil: { gt: new Date() } }, data: { status: "COMPLETED" } });
      if (claimed.count !== 1) throw new Error("Delayed action claim expired before cancellation");
      const skipped = await tx.executedAction.update({ where: { id: action.id }, data: { status: "SKIPPED", error: reason } });
      await updateExecutionTx(tx);
      return skipped;
    });
    if (!source || !execution.rule?.automate || await fingerprint(prisma, source) !== job.sourceFingerprint) {
      return skipScheduled("Rule changed or no longer permits automation");
    }
    const message = await provider.getMessage(execution.sourceMessageId ?? execution.messageId);
    const sender = senderAddress(message.headers.from);
    const stored = await prisma.emailMessage.findUnique({ where: { emailAccountId_messageId: { emailAccountId, messageId: execution.sourceMessageId ?? execution.messageId } } });
    if (!sender || !stored || stored.threadId !== execution.threadId || message.threadId !== execution.threadId || senderAddress(stored.fromEmail) !== sender) throw new Error("Scheduled message does not belong to account and thread");
    const metadata = execution.selectionMetadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || typeof metadata.stage !== "string" || !["STATIC", "GROUP", "COLD", "AI", "SYSTEM"].includes(metadata.stage)) throw new Error("Invalid saved rule selection");
    const stage = metadata.stage as MatchStage;
    const reasons = Array.isArray(execution.matchReasons) ? execution.matchReasons : [];
    const staticReason = reasons.find((reason) => reason && typeof reason === "object" && !Array.isArray(reason) && reason.type === "STATIC");
    const matchedFields = staticReason && typeof staticReason === "object" && !Array.isArray(staticReason) && Array.isArray(staticReason.matchedFields) ? staticReason.matchedFields.filter((field): field is "from" | "to" | "subject" | "body" => typeof field === "string" && ["from", "to", "subject", "body"].includes(field)) : undefined;
    const sent = await prisma.emailMessage.findMany({ where: { emailAccountId, fromEmail: { equals: execution.emailAccount.email, mode: "insensitive" }, labels: { has: "SENT" }, internalDate: { lt: message.internalDate } }, select: { toEmail: true } });
    const verifiedHistory = sent.some((item) => item.toEmail.split(",").some((recipient) => senderAddress(recipient) === sender));
    const blocked = getBlockedLowTrustStaticFromActionTypes({ rule: execution.rule, stage, hasVerifiedSenderReplyHistory: verifiedHistory, matchedFields });
    const vipGroups = await prisma.group.findMany({ where: { emailAccountId, OR: [{ name: { contains: "vip", mode: "insensitive" } }, { rules: { some: { name: { contains: "vip", mode: "insensitive" } } } }] }, include: { items: true } });
    const vipRules = await prisma.rule.findMany({ where: { emailAccountId, name: { contains: "vip", mode: "insensitive" }, from: { not: null } }, select: { from: true } });
    const protectedSenders = [...job.protectedSenders, ...vipRules.flatMap((item) => item.from ? [item.from] : []), ...vipGroups.flatMap((group) => group.items.filter((item) => item.type === "FROM" && !item.exclude).map((item) => item.value))];
    const protectArchive = shouldSkipAutomatedArchiveForSender({ sender, accountEmail: execution.emailAccount.email, protectedSenders });
    const skip = skipReason(source, action.type, { automate: execution.rule.automate, protectArchive, blocked, stage, verifiedHistory });
    if (skip) {
      return skipScheduled(skip);
    }
    if (["ARCHIVE", "MARK_SPAM"].includes(action.type) && await threadHasProtectedSender({ provider, threadId: execution.threadId, triggerMessageId: message.id, accountEmail: execution.emailAccount.email, protectedSenders })) {
      return skipScheduled("Protected or unverifiable thread");
    }
    if (!await markStarted()) throw new Error("Delayed action claim expired before execution");
    await executeActionEffect({ prisma, provider, emailAccountId, message, sender, action, source, executionId: execution.id, delayedJobId: job.id });
    await updateExecution();
    return prisma.executedAction.findUniqueOrThrow({ where: { id: action.id } });
  }, claimToken);
}

type UndoInput = { prisma: PrismaClient; provider: EmailProvider; emailAccountId: string; executedRuleId: string };
/** Undo only persisted actions belonging to the requested account, in reverse order. */
export async function undoExecutedRule(input: UndoInput) {
  if (input.provider.emailAccountId !== input.emailAccountId) throw new Error("Provider does not belong to account");
  const execution = await input.prisma.executedRule.findFirst({ where: { id: input.executedRuleId, emailAccountId: input.emailAccountId }, select: { threadId: true } });
  if (!execution) throw new Error("Execution not found for account");
  return withThreadLock(input.prisma, input.emailAccountId, execution.threadId, () => undoExecutedRuleUnlocked(input));
}

async function undoExecutedRuleUnlocked(input: UndoInput) {
  const { prisma, provider, emailAccountId, executedRuleId } = input;
  if (provider.emailAccountId !== emailAccountId) throw new Error("Provider does not belong to account");
  const execution = await prisma.executedRule.findFirst({ where: { id: executedRuleId, emailAccountId }, include: { actionItems: { include: { delayedAction: true } }, emailAccount: true } });
  if (!execution || execution.emailAccount.provider !== provider.providerName) throw new Error("Execution not found for account");
  const metadata = execution.selectionMetadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata) && metadata.stage === "TRACKER") {
    const sync = await prisma.replyLabelSync.findUnique({ where: { executedRuleId } });
    if (sync?.status === "UNCERTAIN") {
      const uncertain = execution.actionItems.filter((action) => action.status === "FAILED" && action.executionStartedAt);
      if (!uncertain.length || uncertain.some((action) => !action.undoSnapshot)) throw new Error("Tracker label outcome requires manual reconciliation");
      for (const action of uncertain) {
        await provider.undoAction(action, execution.threadId);
        await prisma.executedAction.update({ where: { id: action.id }, data: { status: "SKIPPED", error: "Reconciled after provider failure" } });
      }
      await prisma.replyLabelSync.updateMany({ where: { id: sync.id, status: "UNCERTAIN" }, data: { status: "CANCELLED", error: "Reconciled before undo" } });
    }
    return undoTrackerAudit({ prisma, emailAccountId, executedRuleId });
  }
  if (execution.status === "REJECTED") return execution;
  const pending = execution.actionItems.filter((action) => action.status === "PENDING");
  if (execution.status === "PENDING" && (pending.length === 0 || pending.some((action) => !action.delayedAction || !["PENDING", "CLAIMED"].includes(action.delayedAction.status) || action.delayedAction.startedAt !== null))) throw new Error("Execution is still in progress or requires reconciliation");
  // A provider can fail after changing part of a thread. A started failure must
  // be reconciled from its pre-mutation snapshot, not treated as unexecuted.
  const recoverable = execution.actionItems.filter((action) => action.status === "COMPLETED" || (action.status === "FAILED" && action.executionStartedAt !== null)).sort((a, b) => a.id.localeCompare(b.id));
  if (recoverable.some((action) => !["ARCHIVE", "LABEL", "MARK_SEEN", "MARK_SPAM", "DRAFT_EMAIL", "TRACK_THREAD"].includes(action.type))) throw new Error("Execution contains an irreversible or indeterminate outbound action");
  if (recoverable.some((action) => action.type === "DRAFT_EMAIL" && !action.draftId)) throw new Error("Draft creation outcome is unknown and requires manual reconciliation");
  if (recoverable.some((action) => action.type !== "TRACK_THREAD" && !action.undoSnapshot)) throw new Error("A started action has no undo snapshot and requires manual reconciliation");
  if (pending.length) await prisma.$transaction(async (tx) => {
    for (const action of pending) {
      if (!action.delayedAction) throw new Error("Execution is still in progress");
      const cancelled = await tx.delayedAction.updateMany({ where: { id: action.delayedAction.id, status: { in: ["PENDING", "CLAIMED"] }, startedAt: null }, data: { status: "CANCELLED", error: "Cancelled by undo" } });
      if (cancelled.count !== 1) throw new Error("Delayed action started while undo was requested");
      await tx.executedAction.update({ where: { id: action.id }, data: { status: "SKIPPED", error: "Cancelled by undo" } });
    }
  });
  const claimed = await prisma.executedRule.updateMany({ where: { id: executedRuleId, emailAccountId, status: execution.status }, data: { status: "PENDING" } });
  if (claimed.count !== 1) throw new Error("Execution is already being changed");
  try {
  for (const action of [...recoverable].reverse()) {
    if (action.type === "TRACK_THREAD") {
      const snapshot = action.undoSnapshot;
      if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== "object" || snapshot.provider !== "internal" || snapshot.threadId !== execution.threadId || !(typeof snapshot.createdTrackerId === "string" || snapshot.createdTrackerId === null)) throw new Error("Invalid tracker undo snapshot");
      await suppressReplyRequirement({ prisma, emailAccountId, threadId: execution.threadId, messageId: execution.sourceMessageId ?? execution.messageId });
    } else await provider.undoAction(action, execution.threadId);
    await prisma.executedAction.update({ where: { id: action.id }, data: { status: "SKIPPED", error: action.status === "FAILED" ? "Reverted after provider failure" : "Reverted" } });
  }
  return await prisma.executedRule.update({ where: { id: executedRuleId }, data: { status: "REJECTED" }, include: { actionItems: true, emailAccount: true } });
  } catch (error) {
    await prisma.executedRule.update({ where: { id: executedRuleId }, data: { status: "ERROR" } });
    throw error;
  }
}
