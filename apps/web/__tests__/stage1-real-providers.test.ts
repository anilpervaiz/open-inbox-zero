import type { ExecutedAction } from "@prisma/client";
import type { gmail_v1 } from "@googleapis/gmail";
import { describe, expect, it, vi } from "vitest";
import { GmailProvider } from "../utils/mail-provider/gmail-provider";
import { OutlookProvider } from "../utils/mail-provider/outlook-provider";

function action(type: ExecutedAction["type"], undoSnapshot: unknown, extra: Partial<ExecutedAction> = {}): ExecutedAction {
  return { type, undoSnapshot, ...extra } as ExecutedAction;
}

describe("Gmail provider", () => {
  it("requires and exposes the account bound to the Gmail client", () => {
    const api = {} as gmail_v1.Gmail;
    expect(new GmailProvider(api, "gmail-account").emailAccountId).toBe("gmail-account");
    expect(() => new GmailProvider(api, " ")).toThrow("Provider account ID is required");
  });
  it("exposes nested calendar MIME parts and attachment filenames", async () => {
    const api = { users: { messages: { get: vi.fn(async () => ({ data: {
      id: "calendar", threadId: "thread", internalDate: "1760000000000", labelIds: ["INBOX"],
      payload: { mimeType: "multipart/mixed", headers: [{ name: "Content-Type", value: 'multipart/mixed; boundary="x"' }], parts: [
        { mimeType: "text/plain", body: { data: Buffer.from("Please join").toString("base64url") } },
        { mimeType: "text/calendar", filename: "invite.ICS", body: { attachmentId: "attachment" } },
      ] },
    } })) } } } as unknown as gmail_v1.Gmail;
    const parsed = await new GmailProvider(api, "gmail-account").getMessage("calendar");
    expect(parsed.contentType).toMatch(/multipart\/mixed/i);
    expect(parsed.mimeTypes).toContain("text/calendar");
    expect(parsed.attachmentNames).toContain("invite.ICS");
  });
  it("parses full messages, archives a thread, and restores only messages originally in Inbox", async () => {
    const original = { id: "t1", messages: [
      { id: "m1", threadId: "t1", internalDate: "1760000000000", labelIds: ["INBOX", "UNREAD"], payload: { headers: [{ name: "From", value: "a@example.com" }, { name: "Subject", value: "Hello" }], mimeType: "text/plain", body: { data: Buffer.from("Hello world").toString("base64url") } } },
      { id: "m2", threadId: "t1", internalDate: "1760000000000", labelIds: ["SENT"] },
    ] };
    const archived = { ...original, messages: original.messages.map((message) => ({ ...message, labelIds: message.labelIds.filter((label) => label !== "INBOX") })) };
    let current = original;
    const threadModify = vi.fn(async () => { current = archived; return { data: {} }; });
    const messageModify = vi.fn(async () => ({ data: {} }));
    const api = { users: { threads: { get: vi.fn(async () => ({ data: current })), modify: threadModify }, messages: { modify: messageModify } } } as unknown as gmail_v1.Gmail;
    const provider = new GmailProvider(api, "gmail-account");
    const thread = await provider.getThread("t1");
    expect(thread.messages[0].textPlain).toBe("Hello world");
    expect(thread.messages[0].headers.from).toBe("a@example.com");
    const snapshot = await provider.captureUndoSnapshot("t1");
    await provider.archiveThread("t1");
    await provider.undoAction(action("ARCHIVE", snapshot), "t1");
    expect(threadModify).toHaveBeenCalledWith(expect.objectContaining({ requestBody: { addLabelIds: [], removeLabelIds: ["INBOX"] } }));
    expect(messageModify).toHaveBeenCalledTimes(1);
    expect(messageModify).toHaveBeenCalledWith(expect.objectContaining({ id: "m1", requestBody: { addLabelIds: ["INBOX"], removeLabelIds: [] } }));
    await expect(provider.undoAction(action("ARCHIVE", null), "t1")).rejects.toThrow(/snapshot/);
  });

  it("creates a threaded MIME draft and rejects injected headers before an API call", async () => {
    const create = vi.fn(async (request: { requestBody: { message: { raw: string; threadId: string } } }) => ({ data: { id: request.requestBody.message.raw ? "d1" : "" } }));
    const provider = new GmailProvider({ users: { drafts: { create } } } as unknown as gmail_v1.Gmail, "gmail-account");
    await expect(provider.createDraft({ threadId: "t1", to: "a@example.com", subject: "Hello", body: "Draft", inReplyTo: "<original@example.com>" })).resolves.toEqual({ draftId: "d1" });
    const call = create.mock.calls[0][0];
    const mime = Buffer.from(call.requestBody.message.raw, "base64url").toString();
    expect(mime).toContain("In-Reply-To: <original@example.com>");
    expect(call.requestBody.message.threadId).toBe("t1");
    await expect(provider.createDraft({ to: "a@example.com\r\nBcc: attacker@example.com", subject: "Hello", body: "Draft" })).rejects.toThrow(/newline/);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("refuses to delete a draft belonging to a different thread", async () => {
    const draftDelete = vi.fn(async () => ({ data: {} }));
    const api = { users: {
      threads: { get: vi.fn(async () => ({ data: { id: "t1", messages: [{ id: "m1", labelIds: ["INBOX"] }] } })) },
      drafts: { get: vi.fn(async () => ({ data: { id: "d1", message: { threadId: "other" } } })), delete: draftDelete },
    } } as unknown as gmail_v1.Gmail;
    const provider = new GmailProvider(api, "gmail-account");
    const snapshot = await provider.captureUndoSnapshot("t1");
    await expect(provider.undoAction(action("DRAFT_EMAIL", snapshot, { draftId: "d1" }), "t1")).rejects.toThrow(/no longer in this thread/);
    expect(draftDelete).not.toHaveBeenCalled();
  });
});

describe("Outlook provider", () => {
  it("requires and exposes the account bound to its credentials", () => {
    const token = vi.fn(async () => "token");
    expect(new OutlookProvider(token, "outlook-account").emailAccountId).toBe("outlook-account");
    expect(() => new OutlookProvider(token, "")).toThrow("Provider account ID is required");
    expect(token).not.toHaveBeenCalled();
  });
  it("loads calendar attachment metadata and the original content-type header", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const folder = url.pathname.match(/\/mailFolders\/([^/]+)$/)?.[1];
      if (folder) return Response.json({ id: `${folder}-id` });
      if (url.pathname.endsWith("/messages/m1/attachments")) {
        return url.searchParams.has("$skiptoken")
          ? Response.json({ value: [{ name: "meeting.ics", contentType: "text/calendar; method=REQUEST" }] })
          : Response.json({ value: [], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages/m1/attachments?$skiptoken=next" });
      }
      if (url.pathname.endsWith("/messages/m1")) return Response.json({ id: "m1", conversationId: "thread", receivedDateTime: "2026-01-01T00:00:00Z", parentFolderId: "inbox-id", isRead: false, hasAttachments: false, internetMessageHeaders: [{ name: "Content-Type", value: "multipart/mixed" }], body: { contentType: "text", content: "Please join" } });
      throw new Error("unexpected Graph endpoint");
    });
    const parsed = await new OutlookProvider(async () => "token", "outlook-account", request as typeof fetch).getMessage("m1");
    expect(parsed.contentType).toBe("multipart/mixed");
    expect(parsed.mimeTypes).toEqual(["text/calendar; method=REQUEST"]);
    expect(parsed.attachmentNames).toEqual(["meeting.ics"]);
  });
  it("archives only Inbox messages and restores the same messages using an immutable-ID snapshot", async () => {
    const messages = [
      { id: "inbox-message", conversationId: "thread", parentFolderId: "inbox-id", isRead: false, categories: ["VIP"], receivedDateTime: "2026-01-01T00:00:00Z" },
      { id: "already-archived", conversationId: "thread", parentFolderId: "archive-id", isRead: true, categories: [], receivedDateTime: "2026-01-01T00:00:00Z" },
      { id: "sent-message", conversationId: "thread", parentFolderId: "sentitems-id", isRead: true, categories: [], receivedDateTime: "2026-01-01T00:00:00Z" },
    ];
    const moves: { id: string; destination: string }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(new Headers(init?.headers).get("Prefer")).toBe('IdType="ImmutableId"');
      const folder = url.pathname.match(/\/mailFolders\/([^/]+)$/)?.[1];
      if (folder) return Response.json({ id: `${folder}-id` });
      const moved = url.pathname.match(/\/messages\/([^/]+)\/move$/)?.[1];
      if (moved) {
        const body = JSON.parse(String(init?.body)) as { destinationId: string };
        const message = messages.find((item) => item.id === moved);
        if (!message) throw new Error("unexpected move");
        message.parentFolderId = body.destinationId;
        moves.push({ id: moved, destination: body.destinationId });
        return Response.json(message);
      }
      if (url.pathname.endsWith("/messages")) return Response.json({ value: messages });
      throw new Error(`unexpected endpoint ${url.pathname}`);
    });
    const provider = new OutlookProvider(async () => "test-token", "outlook-account", fetchMock as typeof fetch);
    const snapshot = await provider.captureUndoSnapshot("thread");
    await provider.archiveThread("thread");
    expect(moves).toEqual([{ id: "inbox-message", destination: "archive-id" }]);
    await provider.undoAction(action("ARCHIVE", snapshot), "thread");
    expect(moves).toEqual([{ id: "inbox-message", destination: "archive-id" }, { id: "inbox-message", destination: "inbox-id" }]);
    expect(messages.find((message) => message.id === "already-archived")?.parentFolderId).toBe("archive-id");
  });

  it("does not expose Graph response bodies or credentials in errors", async () => {
    const provider = new OutlookProvider(async () => "secret-token", "outlook-account", vi.fn(async () => new Response("secret-token", { status: 401 })) as typeof fetch);
    await expect(provider.listThreads({})).rejects.toThrow("Microsoft Graph request failed (401)");
    try { await provider.listThreads({}); } catch (error) { expect(String(error)).not.toContain("secret-token"); }
  });

  it("refuses to delete a draft after it has been sent or moved to another conversation", async () => {
    let isDraft = false;
    let conversationId = "thread";
    const methods: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      methods.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname.endsWith("/messages")) return Response.json({ value: [{ id: "m1", conversationId: "thread", parentFolderId: "inbox-id", isRead: false }] });
      if (url.pathname.endsWith("/messages/d1")) {
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        return Response.json({ id: "d1", isDraft, conversationId });
      }
      throw new Error("unexpected endpoint");
    });
    const provider = new OutlookProvider(async () => "token", "outlook-account", fetchMock as typeof fetch);
    const snapshot = await provider.captureUndoSnapshot("thread");
    await expect(provider.undoAction(action("DRAFT_EMAIL", snapshot, { draftId: "d1" }), "thread")).rejects.toThrow(/no longer a draft/);
    isDraft = true;
    conversationId = "different-thread";
    await expect(provider.undoAction(action("DRAFT_EMAIL", snapshot, { draftId: "d1" }), "thread")).rejects.toThrow(/no longer a draft/);
    expect(methods.some((method) => method.startsWith("DELETE"))).toBe(false);
    conversationId = "thread";
    await provider.undoAction(action("DRAFT_EMAIL", snapshot, { draftId: "d1" }), "thread");
    expect(methods.filter((method) => method.startsWith("DELETE"))).toHaveLength(1);
  });

  it("fails closed for missing explicit reply targets and chooses the newest non-draft message otherwise", async () => {
    const messages = [
      { id: "old", conversationId: "thread", internetMessageId: "<old@example.com>", receivedDateTime: "2026-01-01T00:00:00Z" },
      { id: "new", conversationId: "thread", internetMessageId: "<new@example.com>", receivedDateTime: "2026-01-02T00:00:00Z" },
      { id: "draft", conversationId: "thread", isDraft: true, receivedDateTime: "2026-01-03T00:00:00Z" },
    ];
    const requests: { path: string; method: string; body?: unknown }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ path: url.pathname, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.pathname.endsWith("/messages")) return Response.json({ value: messages });
      if (url.pathname.endsWith("/messages/new/createReply")) return Response.json({ id: "reply-draft" }, { status: 201 });
      if (url.pathname.endsWith("/messages/reply-draft") && init?.method === "PATCH") return Response.json({ id: "reply-draft" });
      throw new Error("unexpected endpoint");
    });
    const provider = new OutlookProvider(async () => "token", "outlook-account", fetchMock as typeof fetch);
    await expect(provider.createDraft({ threadId: "thread", to: "a@example.com", subject: "Reply", body: "Hi", inReplyTo: "<missing@example.com>" })).rejects.toThrow(/requested message was not found/);
    expect(requests.some((request) => request.path.endsWith("createReply"))).toBe(false);
    await expect(provider.createDraft({ threadId: "thread", to: '"Doe, Jane" <jane@example.com>', subject: "Reply", body: "Hi" })).resolves.toEqual({ draftId: "reply-draft" });
    expect(requests.find((request) => request.method === "PATCH")?.body).toMatchObject({ toRecipients: [{ emailAddress: { address: "jane@example.com" } }] });
  });
});
