import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type ReplyTrackingEvent } from "@prisma/client";
import type { EmailProvider, ParsedMessage } from "../mail-provider/types";
import { senderAddress } from "../rule/static-from-risk";

type EventInput = { prisma: PrismaClient; provider: EmailProvider; emailAccountId: string; messageId: string };
export type ReplyTrackerResult = { threadId: string; needsReply: number; awaitingReply: number; labelSyncId: string | null };

function recipients(message: ParsedMessage): string[] {
  const all = `${message.headers.to},${message.headers.cc ?? ""}`.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?/gi) ?? [];
  return [...new Set(all.map((address) => address.toLowerCase()))];
}

async function verified(input: EventInput, kind: "INCOMING" | "SENT") {
  if (input.provider.emailAccountId !== input.emailAccountId) throw new Error("Provider is bound to a different account");
  const account = await input.prisma.emailAccount.findUnique({ where: { id: input.emailAccountId } });
  if (!account || account.provider !== input.provider.providerName) throw new Error("Email account or provider mismatch");
  const [message, stored] = await Promise.all([
    input.provider.getMessage(input.messageId),
    input.prisma.emailMessage.findUnique({ where: { emailAccountId_messageId: { emailAccountId: input.emailAccountId, messageId: input.messageId } } }),
  ]);
  const sender = senderAddress(message.headers.from);
  if (!stored || message.id !== input.messageId || message.threadId !== stored.threadId || !sender || senderAddress(stored.fromEmail) !== sender) throw new Error("Message does not belong to account and thread");
  if (message.labelIds.includes("SENT") !== stored.labels.includes("SENT")) throw new Error("Message direction differs from persisted mail");
  const isSent = message.labelIds.includes("SENT");
  if ((kind === "SENT") !== isSent || (kind === "SENT" && sender !== senderAddress(account.email))) throw new Error("Message direction is not verified");
  const to = recipients(message);
  if (kind === "SENT" && !to.length) throw new Error("Sent message has no verified recipients");
  if (Number.isNaN(message.internalDate.getTime()) || message.internalDate.getTime() !== stored.internalDate.getTime()) throw new Error("Message timestamp does not match persisted mail");
  return { account, message, sender, recipients: to };
}

type ReplayItem = { event: ReplyTrackingEvent; resolved: boolean };

/** Replay in provider-time order, without using an inbound From header to infer a sent message. */
function replay(events: ReplyTrackingEvent[]): ReplayItem[] {
  const needs: ReplayItem[] = [];
  const awaiting: ReplayItem[] = [];
  for (const event of events) {
    if (event.kind === "INCOMING") {
      for (const item of awaiting) if (!item.resolved && item.event.recipients.includes(event.sender)) item.resolved = true;
      if (event.requiresReply) needs.push({ event, resolved: false });
    } else {
      const respondingTo = needs.filter((item) => !item.resolved && event.recipients.includes(item.event.sender));
      if (respondingTo.length) {
        for (const item of respondingTo) item.resolved = true;
        awaiting.push({ event, resolved: false });
      }
    }
  }
  return [...needs, ...awaiting];
}

async function withSerializableRetry<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await work(); } catch (error) {
      if (attempt >= 2 || !(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2034") throw error;
    }
  }
}

async function rebuild(tx: Prisma.TransactionClient, input: { emailAccountId: string; threadId: string; sourceMessageId: string; forceSync: boolean }): Promise<ReplyTrackerResult> {
  const { emailAccountId, threadId, sourceMessageId } = input;
  const events = await tx.replyTrackingEvent.findMany({ where: { emailAccountId, threadId }, orderBy: [{ occurredAt: "asc" }, { kind: "asc" }, { messageId: "asc" }] });
  const desired = replay(events.filter((event) => !event.ignored));
  const desiredIds = new Set(desired.map(({ event }) => event.messageId));
  const managedIds = events.map((event) => event.messageId);
  await tx.threadTracker.deleteMany({ where: { emailAccountId, threadId, messageId: { in: managedIds.filter((id) => !desiredIds.has(id)) } } });
  for (const item of desired) {
    const trackerKey = { emailAccountId, threadId, messageId: item.event.messageId };
    const type = item.event.kind === "INCOMING" ? "NEEDS_REPLY" : "AWAITING_REPLY";
    await tx.threadTracker.upsert({ where: { emailAccountId_threadId_messageId: trackerKey }, create: { ...trackerKey, type, resolved: item.resolved, sentAt: item.event.occurredAt, followUpAt: item.event.followUpAt }, update: { type, resolved: item.resolved, sentAt: item.event.occurredAt, followUpAt: item.event.followUpAt } });
  }
  const [needsReply, awaitingReply] = await Promise.all([
    tx.threadTracker.count({ where: { emailAccountId, threadId, type: "NEEDS_REPLY", resolved: false } }),
    tx.threadTracker.count({ where: { emailAccountId, threadId, type: "AWAITING_REPLY", resolved: false } }),
  ]);
  const previous = await tx.replyThreadState.findUnique({ where: { emailAccountId_threadId: { emailAccountId, threadId } } });
  const labelsChanged = Boolean(previous?.needsReply) !== Boolean(needsReply) || Boolean(previous?.awaitingReply) !== Boolean(awaitingReply);
  const syncRequired = labelsChanged || (input.forceSync && Boolean(needsReply || awaitingReply));
  const revision = (previous?.revision ?? 0) + (syncRequired ? 1 : 0);
  await tx.replyThreadState.upsert({ where: { emailAccountId_threadId: { emailAccountId, threadId } }, create: { emailAccountId, threadId, revision, needsReply, awaitingReply }, update: { revision, needsReply, awaitingReply } });
  let labelSyncId: string | null = null;
  if (syncRequired) {
    const syncId = randomUUID();
    const audit = await tx.executedRule.create({ data: {
      emailAccountId, threadId, messageId: `__reply_tracker__:${randomUUID()}`, sourceMessageId,
      status: "PENDING", automated: true, reason: "Reply tracker label reconciliation",
      selectionMetadata: { stage: "TRACKER", ruleName: "Reply tracker" },
      actionItems: { create: [
        { id: `0-${randomUUID()}`, type: "LABEL", label: "To Reply", labelOperation: needsReply ? "ADD" : "REMOVE" },
        { id: `1-${randomUUID()}`, type: "LABEL", label: "Awaiting Reply", labelOperation: awaitingReply ? "ADD" : "REMOVE" },
      ] },
    } });
    await tx.replyLabelSync.create({ data: { id: syncId, emailAccountId, threadId, sourceMessageId, revision, executedRuleId: audit.id } });
    labelSyncId = syncId;
  }
  return { threadId, needsReply, awaitingReply, labelSyncId };
}

async function record(input: EventInput & { kind: "INCOMING" | "SENT"; requiresReply?: boolean; followUpAt?: Date }): Promise<ReplyTrackerResult> {
  if (input.followUpAt && Number.isNaN(input.followUpAt.getTime())) throw new Error("Invalid follow-up date");
  const observed = await verified(input, input.kind);
  return withSerializableRetry(() => input.prisma.$transaction(async (tx) => {
    // Serialize all replay and outbox revisions for an account/thread across processes.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${input.emailAccountId}), hashtext(${observed.message.threadId}))::text`;
    const key = { emailAccountId: input.emailAccountId, threadId: observed.message.threadId, messageId: input.messageId };
    const oldEvent = await tx.replyTrackingEvent.findUnique({ where: { emailAccountId_threadId_messageId: key } });
    if (oldEvent && (oldEvent.kind !== input.kind || oldEvent.sender !== observed.sender || oldEvent.occurredAt.getTime() !== observed.message.internalDate.getTime())) throw new Error("Conflicting reply tracking event");
    await tx.replyTrackingEvent.upsert({
      where: { emailAccountId_threadId_messageId: key },
      create: { ...key, kind: input.kind, sender: observed.sender, recipients: observed.recipients, occurredAt: observed.message.internalDate, requiresReply: input.kind === "INCOMING" && Boolean(input.requiresReply), followUpAt: input.followUpAt },
      update: { ...(input.kind === "INCOMING" && input.requiresReply && !oldEvent?.requiresReplySuppressed && !oldEvent?.ignored ? { requiresReply: true } : {}), ...(input.kind === "SENT" && input.followUpAt ? { followUpAt: input.followUpAt } : {}) },
    });
    return rebuild(tx, { emailAccountId: input.emailAccountId, threadId: observed.message.threadId, sourceMessageId: input.messageId, forceSync: !oldEvent });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 }));
}

export function recordIncomingMessage(input: EventInput & { requiresReply: boolean }): Promise<ReplyTrackerResult> {
  return record({ ...input, kind: "INCOMING" });
}
export function recordSentReply(input: EventInput & { followUpAt?: Date }): Promise<ReplyTrackerResult> {
  return record({ ...input, kind: "SENT" });
}

/** Undo an explicit TRACK_THREAD decision while retaining the underlying incoming mail event. Caller holds the thread lock. */
export async function suppressReplyRequirement(input: { prisma: PrismaClient; emailAccountId: string; threadId: string; messageId: string }): Promise<ReplyTrackerResult> {
  return withSerializableRetry(() => input.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${input.emailAccountId}), hashtext(${input.threadId}))::text`;
    const key = { emailAccountId: input.emailAccountId, threadId: input.threadId, messageId: input.messageId };
    let event = await tx.replyTrackingEvent.findUnique({ where: { emailAccountId_threadId_messageId: key } });
    if (!event) {
      const stored = await tx.emailMessage.findUnique({ where: { emailAccountId_messageId: { emailAccountId: input.emailAccountId, messageId: input.messageId } } });
      const sender = stored && senderAddress(stored.fromEmail);
      if (!stored || stored.threadId !== input.threadId || stored.labels.includes("SENT") || !sender) throw new Error("Cannot suppress an unverified incoming message");
      const to = `${stored.toEmail},${stored.ccEmail ?? ""}`.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?/gi) ?? [];
      event = await tx.replyTrackingEvent.create({ data: { ...key, kind: "INCOMING", sender, recipients: [...new Set(to.map((value) => value.toLowerCase()))], occurredAt: stored.internalDate, requiresReply: false, requiresReplySuppressed: true } });
    } else {
      if (event.kind !== "INCOMING") throw new Error("Cannot suppress a sent reply event");
      if (!event.requiresReplySuppressed || event.requiresReply) event = await tx.replyTrackingEvent.update({ where: { id: event.id }, data: { requiresReply: false, requiresReplySuppressed: true } });
      else return rebuild(tx, { emailAccountId: input.emailAccountId, threadId: input.threadId, sourceMessageId: input.messageId, forceSync: false });
    }
    return rebuild(tx, { emailAccountId: input.emailAccountId, threadId: input.threadId, sourceMessageId: input.messageId, forceSync: true });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 }));
}

/** Reverse the event represented by a dedicated tracker audit, replaying all later events. Caller holds the thread lock. */
export async function undoTrackerAudit(input: { prisma: PrismaClient; emailAccountId: string; executedRuleId: string }) {
  return withSerializableRetry(() => input.prisma.$transaction(async (tx) => {
    const audit = await tx.executedRule.findFirst({ where: { id: input.executedRuleId, emailAccountId: input.emailAccountId }, include: { replyLabelSync: true, actionItems: true, emailAccount: true } });
    if (!audit?.replyLabelSync || !audit.sourceMessageId || audit.replyLabelSync.emailAccountId !== input.emailAccountId || audit.replyLabelSync.threadId !== audit.threadId || audit.replyLabelSync.sourceMessageId !== audit.sourceMessageId) throw new Error("Tracker audit not found for account");
    if (audit.status === "REJECTED") return audit;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${input.emailAccountId}), hashtext(${audit.threadId}))::text`;
    const sync = await tx.replyLabelSync.findUniqueOrThrow({ where: { id: audit.replyLabelSync.id } });
    if (sync.status === "UNCERTAIN" || (sync.status === "CLAIMED" && sync.startedAt)) throw new Error("Tracker label outcome requires reconciliation before undo");
    const event = await tx.replyTrackingEvent.findUnique({ where: { emailAccountId_threadId_messageId: { emailAccountId: input.emailAccountId, threadId: audit.threadId, messageId: audit.sourceMessageId } } });
    if (!event) throw new Error("Tracker event no longer exists");
    await tx.replyTrackingEvent.update({ where: { id: event.id }, data: { ignored: true } });
    await tx.replyLabelSync.updateMany({ where: { id: sync.id, status: { in: ["PENDING", "CLAIMED"] }, startedAt: null }, data: { status: "CANCELLED", error: "Cancelled by tracker undo" } });
    await tx.executedAction.updateMany({ where: { executedRuleId: audit.id, status: { in: ["PENDING", "COMPLETED", "FAILED"] } }, data: { status: "SKIPPED", error: "Tracker event undone; label reconciliation queued" } });
    const updated = await tx.executedRule.update({ where: { id: audit.id }, data: { status: "REJECTED" }, include: { replyLabelSync: true, actionItems: true, emailAccount: true } });
    await rebuild(tx, { emailAccountId: input.emailAccountId, threadId: audit.threadId, sourceMessageId: audit.sourceMessageId, forceSync: true });
    return updated;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 }));
}
