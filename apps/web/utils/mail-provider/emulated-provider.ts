import { randomUUID } from "node:crypto";
import type { EmailMessage, ExecutedAction, PrismaClient } from "@prisma/client";
import type { EmailProvider, ParsedMessage } from "./types";

type MailInput = { threadId?: string; to: string; cc?: string; subject: string; body: string; inReplyTo?: string };
type MessageSnapshot = { messageId: string; archived: boolean; unread: boolean; labels: string[] };
export type EmulatorUndoSnapshot = { provider: "emulator"; threadId: string; messages: MessageSnapshot[] };

function parseMessage(message: EmailMessage): ParsedMessage {
  return {
    id: message.messageId, threadId: message.threadId, snippet: message.snippet,
    internalDate: message.internalDate, labelIds: message.labels,
    headers: {
      from: message.fromEmail, to: message.toEmail, subject: message.subject,
      date: message.internalDate.toISOString(),
      ...(message.ccEmail ? { cc: message.ccEmail } : {}),
      ...(message.headerMessageId ? { messageId: message.headerMessageId } : {}),
      ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
      ...(message.references ? { references: message.references } : {}),
      ...(message.listUnsubscribe ? { listUnsubscribe: message.listUnsubscribe } : {}),
      ...(message.listUnsubscribePost ? { listUnsubscribePost: message.listUnsubscribePost } : {}),
    },
    textPlain: message.textBody,
    ...(message.htmlBody ? { textHtml: message.htmlBody } : {}),
  };
}

function readSnapshot(value: unknown, threadId: string): EmulatorUndoSnapshot {
  if (typeof value !== "object" || value === null || !("provider" in value) || value.provider !== "emulator" || !("threadId" in value) || value.threadId !== threadId || !("messages" in value) || !Array.isArray(value.messages)) throw new Error("Missing undo snapshot");
  const messages: MessageSnapshot[] = value.messages.map((item: unknown) => {
    if (typeof item !== "object" || item === null || !("messageId" in item) || typeof item.messageId !== "string" || !("archived" in item) || typeof item.archived !== "boolean" || !("unread" in item) || typeof item.unread !== "boolean" || !("labels" in item) || !Array.isArray(item.labels) || !item.labels.every((label: unknown) => typeof label === "string")) throw new Error("Invalid undo snapshot");
    return { messageId: item.messageId, archived: item.archived, unread: item.unread, labels: item.labels };
  });
  return { provider: "emulator", threadId, messages };
}

/** Offline provider backed by the selected account's database rows. */
export class EmulatedMailProvider implements EmailProvider {
  readonly providerName = "emulator" as const;
  constructor(private readonly prisma: PrismaClient, private readonly emailAccountId: string) {}

  private async messages(threadId: string): Promise<EmailMessage[]> {
    const messages = await this.prisma.emailMessage.findMany({ where: { emailAccountId: this.emailAccountId, threadId }, orderBy: { internalDate: "asc" } });
    if (!messages.length) throw new Error("Thread not found");
    return messages;
  }

  async listThreads(options: { query?: string; labelIds?: string[]; maxResults?: number }): Promise<{ threadIds: string[] }> {
    const rows = await this.prisma.emailMessage.findMany({
      where: { emailAccountId: this.emailAccountId }, orderBy: { internalDate: "desc" },
    });
    const query = options.query?.trim().toLocaleLowerCase();
    const matching = rows.filter((message) => (!query || [message.fromEmail, message.fromName, message.toEmail, message.subject, message.textBody].some((part) => part?.toLocaleLowerCase().includes(query))) && (!options.labelIds?.length || options.labelIds.every((label) => message.labels.includes(label))));
    const ids = [...new Set(matching.map((message) => message.threadId))];
    return { threadIds: options.maxResults === undefined ? ids : ids.slice(0, Math.max(0, options.maxResults)) };
  }

  async getThread(threadId: string): Promise<{ id: string; messages: ParsedMessage[] }> {
    return { id: threadId, messages: (await this.messages(threadId)).map(parseMessage) };
  }

  async getMessage(messageId: string): Promise<ParsedMessage> {
    const message = await this.prisma.emailMessage.findUnique({ where: { emailAccountId_messageId: { emailAccountId: this.emailAccountId, messageId } } });
    if (!message) throw new Error("Message not found");
    return parseMessage(message);
  }

  isReplyInThread(message: ParsedMessage): boolean { return Boolean(message.headers.inReplyTo || message.headers.references); }

  /** Persist this snapshot on the executed action before applying a reversible mutation. */
  async captureUndoSnapshot(threadId: string): Promise<EmulatorUndoSnapshot> {
    return { provider: "emulator", threadId, messages: (await this.messages(threadId)).map(({ messageId, archived, unread, labels }) => ({ messageId, archived, unread, labels })) };
  }

  async archiveThread(threadId: string): Promise<void> {
    const messages = await this.messages(threadId);
    await this.prisma.$transaction(messages.map((message) => this.prisma.emailMessage.update({ where: { id: message.id }, data: { archived: true, labels: message.labels.filter((label) => label !== "INBOX") } })));
  }

  async addLabel(threadId: string, labelName: string): Promise<{ labelId: string }> {
    if (!labelName.trim()) throw new Error("Label name is required");
    const messages = await this.messages(threadId);
    await this.prisma.$transaction(messages.map((message) => this.prisma.emailMessage.update({ where: { id: message.id }, data: { labels: [...new Set([...message.labels, labelName])] } })));
    return { labelId: labelName };
  }

  async removeLabel(threadId: string, labelName: string): Promise<void> {
    const messages = await this.messages(threadId);
    await this.prisma.$transaction(messages.map((message) => this.prisma.emailMessage.update({ where: { id: message.id }, data: { labels: message.labels.filter((label) => label !== labelName) } })));
  }

  async markRead(threadId: string, read: boolean): Promise<void> {
    const messages = await this.messages(threadId);
    await this.prisma.$transaction(messages.map((message) => this.prisma.emailMessage.update({ where: { id: message.id }, data: { unread: !read, labels: read ? message.labels.filter((label) => label !== "UNREAD") : [...new Set([...message.labels, "UNREAD"])] } })));
  }

  private async createMessage(input: MailInput, kind: "DRAFT" | "SENT"): Promise<string> {
    const account = await this.prisma.emailAccount.findUnique({ where: { id: this.emailAccountId } });
    if (!account || account.provider !== "emulator") throw new Error("Emulator account not found");
    if (input.threadId) await this.messages(input.threadId);
    const messageId = randomUUID();
    await this.prisma.emailMessage.create({ data: {
      emailAccountId: this.emailAccountId, threadId: input.threadId ?? randomUUID(), messageId,
      fromEmail: account.email, toEmail: input.to, ccEmail: input.cc, inReplyTo: input.inReplyTo,
      subject: input.subject, textBody: input.body, snippet: input.body.slice(0, 160),
      internalDate: new Date(), labels: [kind], unread: false, archived: false,
    } });
    return messageId;
  }

  async createDraft(input: MailInput): Promise<{ draftId: string }> { return { draftId: await this.createMessage(input, "DRAFT") }; }
  async sendEmail(input: MailInput): Promise<{ messageId: string }> { return { messageId: await this.createMessage(input, "SENT") }; }

  async undoAction(action: ExecutedAction, threadId: string): Promise<void> {
    const saved = await this.prisma.executedAction.findFirst({ where: { id: action.id, executedRule: { emailAccountId: this.emailAccountId, threadId } } });
    if (!saved || saved.status !== "COMPLETED") throw new Error("Completed action not found for this account and thread");
    if (saved.type === "DRAFT_EMAIL") {
      if (!saved.draftId) throw new Error("Draft ID is missing");
      const draft = await this.prisma.emailMessage.findUnique({ where: { emailAccountId_messageId: { emailAccountId: this.emailAccountId, messageId: saved.draftId } } });
      if (draft && draft.threadId === threadId && draft.labels.includes("DRAFT")) await this.prisma.emailMessage.delete({ where: { id: draft.id } });
      return;
    }
    if (!["ARCHIVE", "LABEL", "MARK_SEEN"].includes(saved.type)) throw new Error(`Action ${saved.type} cannot be undone`);
    const snapshot = readSnapshot(saved.undoSnapshot, threadId);
    const current = await this.messages(threadId);
    const updates = current.flatMap((message) => {
      const previous = snapshot.messages.find((item) => item.messageId === message.messageId);
      if (!previous) return [];
      if (saved.type === "ARCHIVE" && !previous.archived && message.archived) {
        const labels = previous.labels.includes("INBOX") ? [...new Set([...message.labels, "INBOX"])] : message.labels;
        return [this.prisma.emailMessage.update({ where: { id: message.id }, data: { archived: false, labels } })];
      }
      if (saved.type === "LABEL" && saved.label && !previous.labels.includes(saved.label)) {
        return [this.prisma.emailMessage.update({ where: { id: message.id }, data: { labels: message.labels.filter((label) => label !== saved.label) } })];
      }
      if (saved.type === "MARK_SEEN" && previous.unread && !message.unread) {
        const labels = previous.labels.includes("UNREAD") ? [...new Set([...message.labels, "UNREAD"])] : message.labels;
        return [this.prisma.emailMessage.update({ where: { id: message.id }, data: { unread: true, labels } })];
      }
      return [];
    });
    await this.prisma.$transaction(updates);
  }
}
