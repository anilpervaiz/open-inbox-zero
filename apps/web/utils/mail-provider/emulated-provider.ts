import { randomUUID } from "node:crypto";
import type { EmailAttachment, EmailMessage, ExecutedAction, Prisma, PrismaClient } from "@prisma/client";
import type { EmailProvider, ParsedMessage } from "./types";
import { formatForwardMessage, type ForwardInput } from "./forward";

type MailInput = { threadId?: string; to: string; cc?: string; subject: string; body: string; inReplyTo?: string };
type MessageSnapshot = { messageId: string; archived: boolean; unread: boolean; labels: string[] };
export type EmulatorUndoSnapshot = { provider: "emulator"; threadId: string; messages: MessageSnapshot[] };

function parseMessage(message: EmailMessage & { attachments: EmailAttachment[] }): ParsedMessage {
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
    ...(message.contentType ? { contentType: message.contentType } : {}),
    mimeTypes: message.mimeTypes,
    attachmentNames: message.attachmentNames,
    hasAttachments: message.attachmentNames.length > 0 || message.attachments.length > 0,
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
  constructor(private readonly prisma: PrismaClient, readonly emailAccountId: string) {
    if (!emailAccountId.trim()) throw new Error("Provider account ID is required");
  }

  private async messages(threadId: string): Promise<(EmailMessage & { attachments: EmailAttachment[] })[]> {
    const messages = await this.prisma.emailMessage.findMany({ where: { emailAccountId: this.emailAccountId, threadId }, include: { attachments: true }, orderBy: { internalDate: "asc" } });
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
    const message = await this.prisma.emailMessage.findUnique({ where: { emailAccountId_messageId: { emailAccountId: this.emailAccountId, messageId } }, include: { attachments: true } });
    if (!message) throw new Error("Message not found");
    return parseMessage(message);
  }

  async getRawMessage(messageId: string): Promise<Uint8Array> {
    void messageId;
    throw new Error("The emulator does not have authenticated raw MIME");
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

  async markSpam(threadId: string): Promise<void> {
    const messages = await this.messages(threadId);
    await this.prisma.$transaction(messages.map((message) => this.prisma.emailMessage.update({ where: { id: message.id }, data: { archived: true, labels: [...new Set([...message.labels.filter((label) => label !== "INBOX"), "SPAM"])] } })));
  }

  private async forwardContent(input: ForwardInput) {
    const source = await this.prisma.emailMessage.findUnique({ where: { emailAccountId_messageId: { emailAccountId: this.emailAccountId, messageId: input.messageId } }, include: { attachments: true } });
    if (!source || source.threadId !== input.threadId) throw new Error("Forward message is not in account and thread");
    // Metadata alone cannot recreate bytes. Never silently omit an attachment.
    const expectedNames = [...source.attachmentNames].sort();
    const storedNames = source.attachments.map((attachment) => attachment.name).sort();
    if (expectedNames.length !== storedNames.length || expectedNames.some((name, index) => name !== storedNames[index])) throw new Error("Attachment content is unavailable");
    if (source.attachments.reduce((sum, attachment) => sum + attachment.content.byteLength, 0) > 20_000_000) throw new Error("Attachments are too large to forward");
    const message = parseMessage(source);
    const content = formatForwardMessage({ ...message, hasAttachments: false, attachmentNames: [] }, input.comment);
    const attachments = source.attachments.map(({ name, contentType, content }) => ({ name, contentType, content }));
    return { content, attachments };
  }

  async createForwardDraft(input: ForwardInput): Promise<{ draftId: string; draftThreadId: string }> {
    const { content, attachments } = await this.forwardContent(input);
    const draftId = await this.createMessage({ threadId: input.threadId, to: input.to, cc: input.cc, ...content }, "DRAFT", attachments);
    return { draftId, draftThreadId: input.threadId };
  }

  async forwardEmail(input: ForwardInput): Promise<{ messageId: string }> {
    const { content, attachments } = await this.forwardContent(input);
    return { messageId: await this.createMessage({ to: input.to, cc: input.cc, ...content }, "SENT", attachments) };
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

  private async createMessage(input: MailInput, kind: "DRAFT" | "SENT", attachments: { name: string; contentType: string; content: Uint8Array }[] = []): Promise<string> {
    const account = await this.prisma.emailAccount.findUnique({ where: { id: this.emailAccountId } });
    if (!account || account.provider !== "emulator") throw new Error("Emulator account not found");
    if (input.threadId) await this.messages(input.threadId);
    const messageId = randomUUID();
    await this.prisma.emailMessage.create({ data: {
      emailAccountId: this.emailAccountId, threadId: input.threadId ?? randomUUID(), messageId,
      fromEmail: account.email, toEmail: input.to, ccEmail: input.cc, inReplyTo: input.inReplyTo,
      subject: input.subject, textBody: input.body, snippet: input.body.slice(0, 160),
      internalDate: new Date(), labels: [kind], unread: false, archived: false,
      attachmentNames: attachments.map((attachment) => attachment.name), mimeTypes: attachments.map((attachment) => attachment.contentType),
      attachments: { create: attachments.map((attachment) => ({ ...attachment, content: new Uint8Array(attachment.content) })) },
    } });
    return messageId;
  }

  async createDraft(input: MailInput): Promise<{ draftId: string }> { return { draftId: await this.createMessage(input, "DRAFT") }; }
  async updateDraft(input: MailInput & { draftId: string; threadId: string }): Promise<{ draftId: string }> {
    const updated = await this.prisma.emailMessage.updateMany({ where: { emailAccountId: this.emailAccountId, messageId: input.draftId, threadId: input.threadId, labels: { has: "DRAFT" } }, data: { toEmail: input.to, ccEmail: input.cc, subject: input.subject, textBody: input.body, snippet: input.body.slice(0, 160), inReplyTo: input.inReplyTo } });
    if (updated.count !== 1) throw new Error("Draft is not in this thread");
    return { draftId: input.draftId };
  }
  async sendEmail(input: MailInput): Promise<{ messageId: string }> { return { messageId: await this.createMessage(input, "SENT") }; }

  async restoreArchive(threadId: string, snapshotValue: Prisma.JsonValue): Promise<void> {
    const snapshot = readSnapshot(snapshotValue, threadId);
    const current = await this.messages(threadId);
    if (snapshot.messages.some((original) => !current.some((message) => message.messageId === original.messageId))) throw new Error("Cannot restore: an original message is missing");
    const updates = current.flatMap((message) => {
      const original = snapshot.messages.find((item) => item.messageId === message.messageId);
      if (!original || original.archived || !message.archived) return [];
      const labels = original.labels.includes("INBOX") ? [...new Set([...message.labels, "INBOX"])] : message.labels;
      return [this.prisma.emailMessage.update({ where: { id: message.id }, data: { archived: false, labels } })];
    });
    await this.prisma.$transaction(updates);
  }

  async undoAction(action: ExecutedAction, threadId: string): Promise<void> {
    const saved = await this.prisma.executedAction.findFirst({ where: { id: action.id, executedRule: { emailAccountId: this.emailAccountId, threadId } } });
    if (!saved || !(saved.status === "COMPLETED" || (saved.status === "FAILED" && saved.executionStartedAt && saved.undoSnapshot))) {
      throw new Error("Reversible action not found for this account and thread");
    }
    if (saved.type === "ARCHIVE") {
      await this.restoreArchive(threadId, saved.undoSnapshot);
      return;
    }
    if (saved.type === "DRAFT_EMAIL") {
      if (!saved.draftId) throw new Error("Draft ID is missing");
      const draft = await this.prisma.emailMessage.findUnique({ where: { emailAccountId_messageId: { emailAccountId: this.emailAccountId, messageId: saved.draftId } } });
      if (!draft || draft.threadId !== (saved.draftThreadId ?? threadId) || !draft.labels.includes("DRAFT")) throw new Error("Cannot undo: the message is no longer a draft in this thread");
      await this.prisma.emailMessage.delete({ where: { id: draft.id } });
      return;
    }
    if (!["ARCHIVE", "LABEL", "MARK_SEEN", "MARK_SPAM"].includes(saved.type)) throw new Error(`Action ${saved.type} cannot be undone`);
    const snapshot = readSnapshot(saved.undoSnapshot, threadId);
    const current = await this.messages(threadId);
    if (snapshot.messages.some((original) => !current.some((message) => message.messageId === original.messageId))) throw new Error("Cannot undo: an original message is missing");
    const updates = current.flatMap((message) => {
      const previous = snapshot.messages.find((item) => item.messageId === message.messageId);
      if (!previous) return [];
      if (saved.type === "MARK_SPAM" && message.labels.includes("SPAM")) {
        const labels = message.labels.filter((label) => label !== "SPAM" || previous.labels.includes("SPAM"));
        if (previous.labels.includes("INBOX") && !labels.includes("INBOX")) labels.push("INBOX");
        return [this.prisma.emailMessage.update({ where: { id: message.id }, data: { archived: previous.archived, labels } })];
      }
      if (saved.type === "LABEL" && saved.label) {
        if (saved.labelOperation === "REMOVE" && previous.labels.includes(saved.label) && !message.labels.includes(saved.label)) {
          return [this.prisma.emailMessage.update({ where: { id: message.id }, data: { labels: [...message.labels, saved.label] } })];
        }
        if (saved.labelOperation !== "REMOVE" && !previous.labels.includes(saved.label) && message.labels.includes(saved.label)) {
          return [this.prisma.emailMessage.update({ where: { id: message.id }, data: { labels: message.labels.filter((label) => label !== saved.label) } })];
        }
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
