import type { PrismaClient } from "@prisma/client";
import { convertEmailHtmlToText } from "../../get-email-from-message";

export type DigestThread = { threadId: string; messageId: string; from: string; subject: string; snippet: string; at: Date };
export type DailyDigest = {
  asOf: Date;
  period: { start: Date; end: Date };
  needsReply: { count: number; threads: DigestThread[] };
  overdueAwaitingReply: { count: number; threads: DigestThread[] };
  coldEmailsBlocked: { count: number; threads: DigestThread[] };
  newslettersAutoArchived: { count: number; threads: DigestThread[] };
  meetingBriefs: { source: "email"; threadId: string; messageId: string; subject: string; from: string; receivedAt: Date; excerpt: string }[];
};

/** Counts are derived from persisted state and completed actions, never from generated text. */
export async function generateDigest(input: { prisma: PrismaClient; emailAccountId: string; now?: Date; windowStart?: Date; windowEnd?: Date }): Promise<DailyDigest> {
  const { prisma, emailAccountId } = input;
  const now = input.now ?? new Date();
  const end = input.windowEnd ?? now;
  const start = input.windowStart ?? new Date(end.getTime() - 24 * 60 * 60 * 1000);
  if ([now, start, end].some((date) => !(date instanceof Date) || !Number.isFinite(date.getTime())) || start >= end || end > now) throw new Error("Invalid digest period");
  const account = await prisma.emailAccount.findUnique({ where: { id: emailAccountId }, select: { id: true } });
  if (!account) throw new Error("Email account not found");
  const [trackers, executions, mail] = await prisma.$transaction([
    prisma.threadTracker.findMany({ where: { emailAccountId, resolved: false, OR: [{ type: "NEEDS_REPLY" }, { type: "AWAITING_REPLY", followUpAt: { lte: now } }] }, orderBy: { sentAt: "asc" } }),
    prisma.executedRule.findMany({ where: { emailAccountId, automated: true, actionItems: { some: { status: "COMPLETED", executedAt: { gte: start, lt: end }, OR: [{ type: "LABEL", label: "Cold Emails" }, { type: "ARCHIVE" }] } } }, include: { rule: { select: { systemType: true } }, actionItems: true } }),
    prisma.emailMessage.findMany({ where: { emailAccountId }, orderBy: { internalDate: "desc" } }),
  ]);
  const byMessage = new Map(mail.map((message) => [message.messageId, message]));
  const byThread = new Map<string, (typeof mail)[number]>();
  for (const message of mail) if (!byThread.has(message.threadId)) byThread.set(message.threadId, message);
  const detail = (threadId: string, messageId: string, at: Date): DigestThread => {
    const row = byMessage.get(messageId) ?? byThread.get(threadId);
    return { threadId, messageId, from: row?.fromEmail ?? "", subject: row?.subject ?? "", snippet: (row?.snippet ?? "").slice(0, 300), at };
  };
  const needs = trackers.filter((tracker) => tracker.type === "NEEDS_REPLY").map((tracker) => detail(tracker.threadId, tracker.messageId, tracker.sentAt));
  const overdue = trackers.filter((tracker) => tracker.type === "AWAITING_REPLY").map((tracker) => detail(tracker.threadId, tracker.messageId, tracker.followUpAt ?? tracker.sentAt));
  const within = (date: Date | null) => Boolean(date && date >= start && date < end);
  const cold = executions.filter((execution) => {
    const metadata = execution.selectionMetadata;
    return metadata && typeof metadata === "object" && !Array.isArray(metadata) && metadata.stage === "COLD" && execution.actionItems.some((action) => action.status === "COMPLETED" && action.type === "LABEL" && action.label === "Cold Emails" && within(action.executedAt));
  }).map((execution) => detail(execution.threadId, execution.messageId, execution.createdAt));
  const newsletters = executions.filter((execution) => execution.rule?.systemType === "NEWSLETTER" && execution.actionItems.some((action) => action.status === "COMPLETED" && action.type === "ARCHIVE" && within(action.executedAt)))
    .map((execution) => detail(execution.threadId, execution.messageId, execution.createdAt));
  const meetingBriefs: DailyDigest["meetingBriefs"] = mail.filter((message) => message.internalDate >= start && message.internalDate < end && (
    message.contentType?.toLowerCase().includes("text/calendar") || message.mimeTypes.some((type) => type.toLowerCase().startsWith("text/calendar")) || message.attachmentNames.some((name) => /\.ics$/i.test(name)) || /BEGIN:VCALENDAR/i.test(message.textBody)
  )).slice(0, 20).map((message) => ({
    source: "email", threadId: message.threadId, messageId: message.messageId, subject: message.subject,
    from: message.fromEmail, receivedAt: message.internalDate,
    excerpt: (message.textBody || convertEmailHtmlToText(message.htmlBody ?? "")).slice(0, 400),
  }));
  return {
    asOf: now, period: { start, end },
    needsReply: { count: needs.length, threads: needs }, overdueAwaitingReply: { count: overdue.length, threads: overdue },
    coldEmailsBlocked: { count: cold.length, threads: cold }, newslettersAutoArchived: { count: newsletters.length, threads: newsletters },
    meetingBriefs,
  };
}
