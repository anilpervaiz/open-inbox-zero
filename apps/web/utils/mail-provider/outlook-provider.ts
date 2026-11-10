import type { ExecutedAction } from "@prisma/client";
import type { EmailProvider, ParsedMessage } from "./types";
import type { ForwardInput } from "./forward";

type Recipient = { emailAddress?: { name?: string; address?: string } };
type GraphAttachment = { name?: string; contentType?: string };
type GraphMessage = {
  id: string; conversationId: string; bodyPreview?: string; receivedDateTime?: string; sentDateTime?: string;
  parentFolderId?: string; isRead?: boolean; isDraft?: boolean; categories?: string[]; subject?: string; from?: Recipient;
  toRecipients?: Recipient[]; ccRecipients?: Recipient[]; internetMessageId?: string;
  internetMessageHeaders?: { name: string; value: string }[];
  body?: { contentType?: string; content?: string };
  hasAttachments?: boolean;
  attachments?: GraphAttachment[];
};
type Page<T> = { value: T[]; "@odata.nextLink"?: string };
type DraftInput = Parameters<EmailProvider["createDraft"]>[0];
type OutlookSnapshot = { provider: "microsoft"; threadId: string; messages: { id: string; parentFolderId: string; isRead: boolean; categories: string[] }[] };
const base = "https://graph.microsoft.com/v1.0";
const select = "id,conversationId,bodyPreview,receivedDateTime,sentDateTime,parentFolderId,isRead,isDraft,categories,subject,from,toRecipients,ccRecipients,internetMessageId,internetMessageHeaders,body,hasAttachments";

function address(recipient: Recipient | undefined): string {
  const email = recipient?.emailAddress;
  if (!email?.address) return "";
  return email.name ? `${email.name} <${email.address}>` : email.address;
}
function toRecipient(addressValue: string): Recipient {
  if (/[\r\n]/.test(addressValue)) throw new Error("Invalid newline in email address");
  const value = addressValue.trim();
  const address = value.includes("<") ? value.match(/<([^<>]+)>\s*$/)?.[1] : value;
  if (!address || !/^[^\s@<>]+@[^\s@<>]+$/.test(address)) throw new Error("Invalid email address");
  return { emailAddress: { address } };
}
function recipients(value?: string): Recipient[] {
  if (!value) return [];
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let bracket = false;
  for (let i = 0; i < value.length; i++) {
    const character = value[i];
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quoted) { escaped = true; continue; }
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === "<") bracket = true;
    else if (!quoted && character === ">") bracket = false;
    else if (!quoted && !bracket && character === ",") { parts.push(value.slice(start, i)); start = i + 1; }
  }
  if (quoted || bracket) throw new Error("Invalid email address list");
  parts.push(value.slice(start));
  return parts.map(toRecipient);
}
function readSnapshot(value: unknown, threadId: string): OutlookSnapshot {
  if (!value || typeof value !== "object") throw new Error("Outlook undo requires a prior snapshot");
  const snapshot = value as Partial<OutlookSnapshot>;
  if (snapshot.provider !== "microsoft" || snapshot.threadId !== threadId || !Array.isArray(snapshot.messages) ||
      !snapshot.messages.every((item) => typeof item.id === "string" && typeof item.parentFolderId === "string" && typeof item.isRead === "boolean" && Array.isArray(item.categories) && item.categories.every((category) => typeof category === "string"))) {
    throw new Error("Invalid Outlook undo snapshot");
  }
  return snapshot as OutlookSnapshot;
}

/** Microsoft Graph adapter. Supply an access-token callback so expired tokens can be refreshed by the caller. */
export class OutlookProvider implements EmailProvider {
  readonly providerName = "microsoft" as const;
  private folderIds?: Promise<Record<string, string>>;
  constructor(private readonly accessToken: () => Promise<string>, readonly emailAccountId: string, private readonly requestFetch: typeof fetch = fetch) {
    if (!emailAccountId.trim()) throw new Error("Provider account ID is required");
  }

  private async request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    const url = new URL(path.startsWith("https://") ? path : `${base}${path}`);
    if (url.origin !== "https://graph.microsoft.com" || !url.pathname.startsWith("/v1.0/")) throw new Error("Untrusted Microsoft Graph pagination URL");
    let response: Response;
    try {
      const token = await this.accessToken();
      response = await this.requestFetch(url, {
        method: options.method ?? "GET",
        headers: { Authorization: `Bearer ${token}`, Prefer: 'IdType="ImmutableId"', ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        redirect: "error",
      });
    } catch { throw new Error("Microsoft Graph request failed"); }
    if (!response.ok) throw new Error(`Microsoft Graph request failed (${response.status})`);
    if (response.status === 204 || response.status === 202) return undefined as T;
    try { return await response.json() as T; } catch { throw new Error("Microsoft Graph returned an invalid response"); }
  }

  private async folders(): Promise<Record<string, string>> {
    this.folderIds ??= Promise.all(["inbox", "archive", "deleteditems", "junkemail", "sentitems", "drafts"].map(async (folder) => {
      const data = await this.request<{ id: string }>(`/me/mailFolders/${folder}?$select=id`);
      if (!data.id) throw new Error(`Microsoft Graph response missing ${folder} folder id`);
      return [folder, data.id] as const;
    })).then((entries) => Object.fromEntries(entries));
    try { return await this.folderIds; } catch (error) { this.folderIds = undefined; throw error; }
  }

  private async pageMessages(path: string): Promise<GraphMessage[]> {
    const messages: GraphMessage[] = [];
    let next: string | undefined = path;
    while (next) {
      const page: Page<GraphMessage> = await this.request<Page<GraphMessage>>(next);
      messages.push(...page.value);
      next = page["@odata.nextLink"];
    }
    return messages;
  }

  private async conversation(threadId: string): Promise<GraphMessage[]> {
    const filter = `conversationId eq '${threadId.replace(/'/g, "''")}'`;
    return this.pageMessages(`/me/messages?${new URLSearchParams({ "$filter": filter, "$select": select, "$top": "100" })}`);
  }

  private async parse(message: GraphMessage): Promise<ParsedMessage> {
    const folders = await this.folders();
    const labels = [...(message.categories ?? [])];
    const folderMap: Record<string, string> = { inbox: "INBOX", archive: "ARCHIVED", deleteditems: "TRASH", junkemail: "SPAM", sentitems: "SENT", drafts: "DRAFT" };
    for (const [name, id] of Object.entries(folders)) if (message.parentFolderId === id) labels.push(folderMap[name]);
    if (!message.isRead) labels.push("UNREAD");
    const headers = Object.fromEntries((message.internetMessageHeaders ?? []).map((header) => [header.name.toLowerCase(), header.value]));
    const attachments: GraphAttachment[] = [...(message.attachments ?? [])];
    // Graph can report hasAttachments=false for inline-only attachments, so that
    // flag cannot prove that a message has no calendar file.
    if (!message.attachments) {
      let next: string | undefined = `/me/messages/${encodeURIComponent(message.id)}/attachments?$select=name,contentType`;
      while (next) {
        const page: Page<GraphAttachment> = await this.request<Page<GraphAttachment>>(next);
        attachments.push(...page.value);
        next = page["@odata.nextLink"];
      }
    }
    const date = message.receivedDateTime ?? message.sentDateTime ?? "";
    if (!message.id || !message.conversationId || !date || Number.isNaN(Date.parse(date))) throw new Error("Microsoft Graph response missing message identity or date");
    const isHtml = message.body?.contentType?.toLowerCase() === "html";
    return {
      id: message.id, threadId: message.conversationId, snippet: message.bodyPreview ?? "", internalDate: new Date(date), labelIds: labels,
      headers: {
        from: address(message.from), to: (message.toRecipients ?? []).map(address).join(", "), cc: (message.ccRecipients ?? []).map(address).join(", "),
        subject: message.subject ?? "", date, messageId: message.internetMessageId ?? headers["message-id"], inReplyTo: headers["in-reply-to"],
        references: headers.references, listUnsubscribe: headers["list-unsubscribe"], listUnsubscribePost: headers["list-unsubscribe-post"],
      },
      textPlain: isHtml ? "" : message.body?.content ?? "", textHtml: isHtml ? message.body?.content : undefined,
      contentType: headers["content-type"],
      mimeTypes: attachments.flatMap((attachment) => attachment.contentType ? [attachment.contentType] : []),
      attachmentNames: attachments.flatMap((attachment) => attachment.name ? [attachment.name] : []),
      hasAttachments: attachments.length > 0,
    };
  }

  async listThreads(options: { query?: string; labelIds?: string[]; maxResults?: number }): Promise<{ threadIds: string[] }> {
    const limit = Math.max(0, options.maxResults ?? 100);
    if (!limit) return { threadIds: [] };
    const params = new URLSearchParams({ "$select": select, "$top": "100" });
    if (options.query) params.set("$search", `"${options.query.replace(/["\\]/g, "\\$&")}"`);
    const ids = new Set<string>();
    let next: string | undefined = `/me/messages?${params}`;
    while (next && ids.size < limit) {
      const page: Page<GraphMessage> = await this.request<Page<GraphMessage>>(next);
      for (const message of page.value) {
        if (options.labelIds?.length) {
          const parsed = await this.parse(message);
          if (!options.labelIds.every((label) => parsed.labelIds.includes(label))) continue;
        }
        if (message.conversationId) ids.add(message.conversationId);
        if (ids.size >= limit) break;
      }
      next = page["@odata.nextLink"];
    }
    return { threadIds: [...ids] };
  }

  async getThread(threadId: string): Promise<{ id: string; messages: ParsedMessage[] }> {
    const messages = await this.conversation(threadId);
    return { id: threadId, messages: await Promise.all(messages.map((message) => this.parse(message))) };
  }
  async getMessage(messageId: string): Promise<ParsedMessage> {
    const message = await this.request<GraphMessage>(`/me/messages/${encodeURIComponent(messageId)}?${new URLSearchParams({ "$select": select })}`);
    return this.parse(message);
  }
  isReplyInThread(message: ParsedMessage): boolean { return Boolean(message.headers.inReplyTo || message.headers.references); }

  private async patchMessage(id: string, patch: object): Promise<void> {
    await this.request(`/me/messages/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
  }
  private async moveMessage(id: string, destinationId: string): Promise<void> {
    await this.request(`/me/messages/${encodeURIComponent(id)}/move`, { method: "POST", body: { destinationId } });
  }
  async archiveThread(threadId: string): Promise<void> {
    const [messages, folders] = await Promise.all([this.conversation(threadId), this.folders()]);
    for (const message of messages) if (message.parentFolderId === folders.inbox) await this.moveMessage(message.id, folders.archive);
  }
  async markSpam(threadId: string): Promise<void> {
    const [messages, folders] = await Promise.all([this.conversation(threadId), this.folders()]);
    for (const message of messages) if (message.parentFolderId === folders.inbox) await this.moveMessage(message.id, folders.junkemail);
  }
  async createForwardDraft(input: ForwardInput): Promise<{ draftId: string; draftThreadId: string }> {
    const message = await this.getMessage(input.messageId);
    if (message.threadId !== input.threadId) throw new Error("Forward message is not in thread");
    const created = await this.request<{ id: string; conversationId?: string }>(`/me/messages/${encodeURIComponent(input.messageId)}/createForward`, { method: "POST", body: { message: { toRecipients: recipients(input.to), ccRecipients: recipients(input.cc) }, ...(input.comment ? { comment: input.comment } : {}) } });
    if (!created.id) throw new Error("Microsoft Graph response missing forward draft id");
    let draftThreadId = created.conversationId;
    if (!draftThreadId) {
      const draft = await this.request<{ id: string; isDraft: boolean; conversationId?: string }>(`/me/messages/${encodeURIComponent(created.id)}?$select=id,isDraft,conversationId`);
      if (draft.id !== created.id || !draft.isDraft || !draft.conversationId) throw new Error("Microsoft Graph forward draft identity unavailable");
      draftThreadId = draft.conversationId;
    }
    return { draftId: created.id, draftThreadId };
  }
  async forwardEmail(input: ForwardInput): Promise<{ messageId: string }> {
    const { draftId } = await this.createForwardDraft(input);
    await this.request(`/me/messages/${encodeURIComponent(draftId)}/send`, { method: "POST" });
    return { messageId: draftId };
  }
  async addLabel(threadId: string, labelName: string): Promise<{ labelId: string }> {
    const messages = await this.conversation(threadId);
    for (const message of messages) if (!message.categories?.includes(labelName)) await this.patchMessage(message.id, { categories: [...(message.categories ?? []), labelName] });
    return { labelId: labelName };
  }
  async removeLabel(threadId: string, labelName: string): Promise<void> {
    const messages = await this.conversation(threadId);
    for (const message of messages) if (message.categories?.includes(labelName)) await this.patchMessage(message.id, { categories: message.categories.filter((label) => label !== labelName) });
  }
  async markRead(threadId: string, read: boolean): Promise<void> {
    for (const message of await this.conversation(threadId)) if (message.isRead !== read) await this.patchMessage(message.id, { isRead: read });
  }

  async createDraft(input: DraftInput): Promise<{ draftId: string }> {
    const draft = { subject: input.subject, body: { contentType: "Text", content: input.body }, toRecipients: recipients(input.to), ccRecipients: recipients(input.cc) };
    if (input.threadId) {
      const messages = await this.conversation(input.threadId);
      const candidates = messages.filter((message) => !message.isDraft);
      const target = input.inReplyTo
        ? candidates.find((message) => message.internetMessageId === input.inReplyTo)
        : [...candidates].sort((a, b) => Date.parse(a.receivedDateTime ?? a.sentDateTime ?? "1970-01-01") - Date.parse(b.receivedDateTime ?? b.sentDateTime ?? "1970-01-01")).at(-1);
      if (!target) throw new Error(input.inReplyTo ? "Cannot create a reply: requested message was not found in this conversation" : "Cannot create a reply for an empty conversation");
      const created = await this.request<{ id: string }>(`/me/messages/${encodeURIComponent(target.id)}/createReply`, { method: "POST", body: {} });
      if (!created.id) throw new Error("Microsoft Graph response missing draft id");
      try { await this.patchMessage(created.id, draft); } catch (error) {
        await this.request(`/me/messages/${encodeURIComponent(created.id)}`, { method: "DELETE" }).catch(() => undefined);
        throw error;
      }
      return { draftId: created.id };
    }
    const created = await this.request<{ id: string }>("/me/messages", { method: "POST", body: draft });
    if (!created.id) throw new Error("Microsoft Graph response missing draft id");
    return { draftId: created.id };
  }
  async sendEmail(input: DraftInput): Promise<{ messageId: string }> {
    const { draftId } = await this.createDraft(input);
    await this.request(`/me/messages/${encodeURIComponent(draftId)}/send`, { method: "POST" });
    return { messageId: draftId };
  }
  async captureUndoSnapshot(threadId: string): Promise<OutlookSnapshot> {
    const messages = await this.conversation(threadId);
    if (!messages.length || messages.some((message) => message.conversationId !== threadId || !message.parentFolderId || typeof message.isRead !== "boolean")) {
      throw new Error("Cannot snapshot an empty or incomplete Outlook conversation");
    }
    return {
      provider: "microsoft", threadId,
      messages: messages.map((message) => ({ id: message.id, parentFolderId: message.parentFolderId!, isRead: message.isRead!, categories: message.categories ?? [] })),
    };
  }
  async undoAction(action: ExecutedAction, threadId: string): Promise<void> {
    const snapshot = readSnapshot(action.undoSnapshot, threadId);
    const current = await this.captureUndoSnapshot(threadId);
    if (snapshot.messages.some((message) => !current.messages.some((item) => item.id === message.id))) throw new Error("Cannot undo: original Outlook messages are no longer in this conversation");
    switch (action.type) {
      case "ARCHIVE":
      case "MARK_SPAM": {
        const folders = await this.folders();
        const target = action.type === "ARCHIVE" ? folders.archive : folders.junkemail;
        const originallyInInbox = snapshot.messages.filter((message) => message.parentFolderId === folders.inbox);
        if (originallyInInbox.some((message) => {
          const currentFolder = current.messages.find((item) => item.id === message.id)!.parentFolderId;
          return currentFolder !== folders.inbox && currentFolder !== target;
        })) throw new Error("Cannot undo: an Outlook message was moved to another folder");
        for (const message of originallyInInbox) {
          if (current.messages.find((item) => item.id === message.id)!.parentFolderId === target) await this.moveMessage(message.id, folders.inbox);
        }
        return;
      }
      case "LABEL": {
        if (!action.label) throw new Error("Cannot undo Outlook label action without a label");
        for (const original of snapshot.messages) {
          const now = current.messages.find((item) => item.id === original.id)!;
          if (!original.categories.includes(action.label) && now.categories.includes(action.label)) {
            await this.patchMessage(original.id, { categories: now.categories.filter((category) => category !== action.label) });
          }
        }
        return;
      }
      case "MARK_SEEN": {
        for (const original of snapshot.messages) {
          const now = current.messages.find((item) => item.id === original.id)!;
          if (!original.isRead && now.isRead) await this.patchMessage(original.id, { isRead: false });
        }
        return;
      }
      case "DRAFT_EMAIL": {
        if (!action.draftId) throw new Error("Cannot undo Outlook draft action without a draft id");
        const draft = await this.request<{ id: string; isDraft: boolean; conversationId: string }>(`/me/messages/${encodeURIComponent(action.draftId)}?$select=id,isDraft,conversationId`);
        if (draft.id !== action.draftId || !draft.isDraft || draft.conversationId !== (action.draftThreadId ?? threadId)) throw new Error("Cannot undo: the Outlook message is no longer a draft in this conversation");
        await this.request(`/me/messages/${encodeURIComponent(action.draftId)}`, { method: "DELETE" });
        return;
      }
      default: throw new Error(`Microsoft Graph cannot undo action ${action.type}`);
    }
  }
}
