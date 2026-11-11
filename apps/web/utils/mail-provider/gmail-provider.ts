import type { ExecutedAction, Prisma } from "@prisma/client";
import type { gmail_v1 } from "@googleapis/gmail";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { EmailProvider, ParsedMessage } from "./types";
import { formatForwardMessage, type ForwardInput } from "./forward";

// The upstream parser is CommonJS and does not publish TypeScript declarations.
const parseGmail = createRequire(import.meta.url)("gmail-api-parse-message") as (message: gmail_v1.Schema$Message) => {
  headers?: Record<string, string>; textPlain?: string; textHtml?: string;
};

const MAX_RAW_MESSAGE_BYTES = 25_000_000;
type DraftInput = Parameters<EmailProvider["createDraft"]>[0];
type GmailSnapshot = { provider: "google"; threadId: string; messages: { id: string; labelIds: string[] }[] };

function readSnapshot(value: unknown, threadId: string): GmailSnapshot {
  if (!value || typeof value !== "object") throw new Error("Gmail undo requires a prior snapshot");
  const snapshot = value as Partial<GmailSnapshot>;
  if (snapshot.provider !== "google" || snapshot.threadId !== threadId || !Array.isArray(snapshot.messages) ||
      !snapshot.messages.every((item) => typeof item.id === "string" && Array.isArray(item.labelIds) && item.labelIds.every((label) => typeof label === "string"))) {
    throw new Error("Invalid Gmail undo snapshot");
  }
  return snapshot as GmailSnapshot;
}

function required(value: string | null | undefined, field: string): string {
  if (!value) throw new Error(`Gmail response missing ${field}`);
  return value;
}

async function safeCall<T>(request: () => Promise<T>): Promise<T> {
  try { return await request(); } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? ` (${error.status})` : "";
    throw new Error(`Gmail request failed${status}`);
  }
}

function parseMessage(message: gmail_v1.Schema$Message): ParsedMessage {
  const parsed = parseGmail(message);
  const headers = parsed.headers ?? {};
  const mimeTypes = new Set<string>();
  const attachmentNames: string[] = [];
  let hasAttachments = false;
  const visit = (part: gmail_v1.Schema$MessagePart | null | undefined): void => {
    if (!part) return;
    if (part.mimeType) mimeTypes.add(part.mimeType);
    if (part.filename) attachmentNames.push(part.filename);
    if (part.filename || part.body?.attachmentId || part.headers?.some((header) => header.name?.toLowerCase() === "content-disposition" && /attachment|inline/i.test(header.value ?? ""))) hasAttachments = true;
    for (const child of part.parts ?? []) visit(child);
  };
  visit(message.payload);
  const timestamp = Number(message.internalDate);
  if (!message.internalDate || !Number.isFinite(timestamp) || Number.isNaN(new Date(timestamp).getTime())) throw new Error("Gmail response has invalid internalDate");
  return {
    id: required(message.id, "message id"),
    threadId: required(message.threadId, "thread id"),
    snippet: message.snippet ?? "",
    internalDate: new Date(timestamp),
    labelIds: message.labelIds ?? [],
    headers: {
      from: headers.from ?? "", to: headers.to ?? "", subject: headers.subject ?? "", date: headers.date ?? "",
      cc: headers.cc, messageId: headers["message-id"], inReplyTo: headers["in-reply-to"],
      references: headers.references, listUnsubscribe: headers["list-unsubscribe"],
      listUnsubscribePost: headers["list-unsubscribe-post"],
    },
    textPlain: parsed.textPlain ?? "",
    textHtml: parsed.textHtml,
    contentType: headers["content-type"] ?? message.payload?.mimeType ?? undefined,
    mimeTypes: [...mimeTypes],
    attachmentNames,
    hasAttachments,
  };
}

function safeHeader(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("Invalid newline in email header");
  return value;
}

function rawMessage(input: DraftInput): string {
  const headers = [
    `To: ${safeHeader(input.to)}`,
    ...(input.cc ? [`Cc: ${safeHeader(input.cc)}`] : []),
    `Subject: =?UTF-8?B?${Buffer.from(safeHeader(input.subject)).toString("base64")}?=`,
    ...(input.inReplyTo ? [`In-Reply-To: ${safeHeader(input.inReplyTo)}`, `References: ${safeHeader(input.inReplyTo)}`] : []),
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64",
  ];
  const body = Buffer.from(input.body).toString("base64").replace(/.{1,76}/g, "$&\r\n");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`).toString("base64url");
}

/** Gmail API adapter. Callers supply an OAuth-authenticated Gmail client. */
export class GmailProvider implements EmailProvider {
  readonly providerName = "google" as const;
  constructor(private readonly gmail: gmail_v1.Gmail, readonly emailAccountId: string) {
    if (!emailAccountId.trim()) throw new Error("Provider account ID is required");
  }

  async listThreads(options: { query?: string; labelIds?: string[]; maxResults?: number }): Promise<{ threadIds: string[] }> {
    const limit = Math.max(0, options.maxResults ?? 100);
    const threadIds: string[] = [];
    let pageToken: string | undefined;
    while (threadIds.length < limit) {
      const { data } = await safeCall(() => this.gmail.users.threads.list({ userId: "me", q: options.query, labelIds: options.labelIds, maxResults: Math.min(500, limit - threadIds.length), pageToken }));
      threadIds.push(...(data.threads ?? []).flatMap((thread) => thread.id ? [thread.id] : []));
      pageToken = data.nextPageToken ?? undefined;
      if (!pageToken) break;
    }
    return { threadIds: threadIds.slice(0, limit) };
  }

  async getThread(threadId: string): Promise<{ id: string; messages: ParsedMessage[] }> {
    const { data } = await safeCall(() => this.gmail.users.threads.get({ userId: "me", id: threadId, format: "full" }));
    return { id: required(data.id, "thread id"), messages: (data.messages ?? []).map(parseMessage) };
  }

  async getMessage(messageId: string): Promise<ParsedMessage> {
    const { data } = await safeCall(() => this.gmail.users.messages.get({ userId: "me", id: messageId, format: "full" }));
    return parseMessage(data);
  }

  async getRawMessage(messageId: string): Promise<Uint8Array> {
    if (!messageId.trim()) throw new Error("Message ID is required");
    const maxEncodedBytes = Math.ceil(MAX_RAW_MESSAGE_BYTES / 3) * 4;
    const { data } = await safeCall(() => this.gmail.users.messages.get({ userId: "me", id: messageId, format: "raw" }, { maxContentLength: maxEncodedBytes + 65_536 }));
    if (data.id !== messageId || !data.raw || data.raw.length > maxEncodedBytes || !/^[A-Za-z0-9_-]+={0,2}$/.test(data.raw)) throw new Error("Gmail original MIME is unavailable or too large");
    const raw = Buffer.from(data.raw, "base64url");
    if (!raw.length || raw.length > MAX_RAW_MESSAGE_BYTES || raw.toString("base64url") !== data.raw.replace(/=+$/, "")) throw new Error("Gmail original MIME is invalid or too large");
    return raw;
  }

  isReplyInThread(message: ParsedMessage): boolean { return Boolean(message.headers.inReplyTo || message.headers.references); }

  private async modify(threadId: string, addLabelIds: string[], removeLabelIds: string[]): Promise<void> {
    await safeCall(() => this.gmail.users.threads.modify({ userId: "me", id: threadId, requestBody: { addLabelIds, removeLabelIds } }));
  }

  async archiveThread(threadId: string): Promise<void> { await this.modify(threadId, [], ["INBOX"]); }

  async markSpam(threadId: string): Promise<void> { await this.modify(threadId, ["SPAM"], ["INBOX"]); }

  private async buildForwardMime(input: ForwardInput): Promise<string> {
    const message = await this.getMessage(input.messageId);
    if (message.threadId !== input.threadId) throw new Error("Forward message is not in thread");
    const original = Buffer.from(await this.getRawMessage(input.messageId));
    if (original.length > 20_000_000) throw new Error("Gmail original MIME is too large to forward");
    const forward = formatForwardMessage({ ...message, hasAttachments: false, attachmentNames: [] }, input.comment);
    const boundary = `open-inbox-zero-${randomUUID()}`;
    const lines = (body: Buffer) => body.toString("base64").replace(/.{1,76}/g, "$&\r\n");
    const headers = [`To: ${safeHeader(input.to)}`, ...(input.cc ? [`Cc: ${safeHeader(input.cc)}`] : []), `Subject: =?UTF-8?B?${Buffer.from(safeHeader(forward.subject)).toString("base64")}?=`, "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${boundary}"`];
    const raw = Buffer.from(`${headers.join("\r\n")}\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${lines(Buffer.from(forward.body))}--${boundary}\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment; filename="forwarded.eml"\r\nContent-Transfer-Encoding: base64\r\n\r\n${lines(original)}--${boundary}--\r\n`).toString("base64url");
    return raw;
  }

  async createForwardDraft(input: ForwardInput): Promise<{ draftId: string; draftThreadId: string }> {
    const raw = await this.buildForwardMime(input);
    const { data } = await safeCall(() => this.gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw } } }));
    return { draftId: required(data.id, "draft id"), draftThreadId: required(data.message?.threadId, "draft thread id") };
  }

  async forwardEmail(input: ForwardInput): Promise<{ messageId: string }> {
    const raw = await this.buildForwardMime(input);
    const sent = await safeCall(() => this.gmail.users.messages.send({ userId: "me", requestBody: { raw } }));
    return { messageId: required(sent.data.id, "sent message id") };
  }

  private async labelId(name: string, create: boolean): Promise<string | undefined> {
    const { data } = await safeCall(() => this.gmail.users.labels.list({ userId: "me" }));
    const found = data.labels?.find((label) => label.id === name || label.name === name);
    if (found) return required(found.id, "label id");
    if (!create) return undefined;
    const created = await safeCall(() => this.gmail.users.labels.create({ userId: "me", requestBody: { name } }));
    return required(created.data.id, "label id");
  }

  async addLabel(threadId: string, labelName: string): Promise<{ labelId: string }> {
    const labelId = required(await this.labelId(labelName, true), "label id");
    await this.modify(threadId, [labelId], []);
    return { labelId };
  }

  async removeLabel(threadId: string, labelName: string): Promise<void> {
    const labelId = await this.labelId(labelName, false);
    if (labelId) await this.modify(threadId, [], [labelId]);
  }

  async markRead(threadId: string, read: boolean): Promise<void> {
    await this.modify(threadId, read ? [] : ["UNREAD"], read ? ["UNREAD"] : []);
  }

  async createDraft(input: DraftInput): Promise<{ draftId: string }> {
    const raw = rawMessage(input);
    const { data } = await safeCall(() => this.gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw, threadId: input.threadId } } }));
    return { draftId: required(data.id, "draft id") };
  }

  async sendEmail(input: DraftInput): Promise<{ messageId: string }> {
    const raw = rawMessage(input);
    const { data } = await safeCall(() => this.gmail.users.messages.send({ userId: "me", requestBody: { raw, threadId: input.threadId } }));
    return { messageId: required(data.id, "sent message id") };
  }

  async captureUndoSnapshot(threadId: string): Promise<GmailSnapshot> {
    const { data } = await safeCall(() => this.gmail.users.threads.get({ userId: "me", id: threadId, format: "minimal" }));
    if (data.id !== threadId || !data.messages?.length) throw new Error("Cannot snapshot an empty or mismatched Gmail thread");
    return { provider: "google", threadId, messages: data.messages.map((message) => ({ id: required(message.id, "message id"), labelIds: message.labelIds ?? [] })) };
  }

  async restoreArchive(threadId: string, snapshot: Prisma.JsonValue): Promise<void> {
    // undoAction validates provider/thread identity and restores only original Inbox state.
    await this.undoAction({ type: "ARCHIVE", undoSnapshot: snapshot } as ExecutedAction, threadId);
  }

  async undoAction(action: ExecutedAction, threadId: string): Promise<void> {
    const snapshot = readSnapshot(action.undoSnapshot, threadId);
    const current = await this.captureUndoSnapshot(threadId);
    if (snapshot.messages.some((message) => !current.messages.some((item) => item.id === message.id))) throw new Error("Cannot undo: original Gmail messages are no longer in this thread");
    let add = "";
    let remove = "";
    switch (action.type) {
      case "ARCHIVE": add = "INBOX"; break;
      case "MARK_SPAM": add = "INBOX"; remove = "SPAM"; break;
      case "LABEL": {
        if (!action.label) throw new Error("Cannot undo Gmail label action without a label");
        const labelId = required(await this.labelId(action.label, false), "label id");
        if (action.labelOperation === "REMOVE") add = labelId;
        else remove = labelId;
        break;
      }
      case "MARK_SEEN": add = "UNREAD"; break;
      case "DRAFT_EMAIL": {
        if (!action.draftId) throw new Error("Cannot undo Gmail draft action without a draft id");
        const { data } = await safeCall(() => this.gmail.users.drafts.get({ userId: "me", id: action.draftId!, format: "minimal" }));
        if (data.id !== action.draftId || data.message?.threadId !== (action.draftThreadId ?? threadId)) throw new Error("Cannot undo: the Gmail draft is no longer in this thread");
        await safeCall(() => this.gmail.users.drafts.delete({ userId: "me", id: action.draftId! }));
        return;
      }
      default: throw new Error(`Gmail cannot undo action ${action.type}`);
    }
    for (const original of snapshot.messages) {
      const now = current.messages.find((message) => message.id === original.id)!;
      const addLabelIds = add && original.labelIds.includes(add) && !now.labelIds.includes(add) ? [add] : [];
      const removeLabelIds = remove && !original.labelIds.includes(remove) && now.labelIds.includes(remove) ? [remove] : [];
      if (addLabelIds.length || removeLabelIds.length) {
        await safeCall(() => this.gmail.users.messages.modify({ userId: "me", id: original.id, requestBody: { addLabelIds, removeLabelIds } }));
      }
    }
  }
}
