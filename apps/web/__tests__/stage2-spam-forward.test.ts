import type { gmail_v1 } from "@googleapis/gmail";
import type { ExecutedAction } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { GmailProvider } from "../utils/mail-provider/gmail-provider";
import { OutlookProvider } from "../utils/mail-provider/outlook-provider";

describe("spam and forward providers", () => {
  it("Gmail marks spam and forwards full original MIME including attachments", async () => {
    const modify = vi.fn(async () => ({ data: {} }));
    const send = vi.fn(async () => ({ data: { id: "sent" } }));
    const create = vi.fn(async () => ({ data: { id: "draft", message: { threadId: "new-thread" } } }));
    let rawAvailable = true;
    const originalMime = "Content-Type: multipart/mixed; boundary=original\r\n\r\n--original\r\nContent-Type: application/pdf\r\n\r\nPDF bytes\r\n--original--\r\n";
    const get = vi.fn(async (request: { format: string }) => request.format === "raw" ? { data: { id: "m", threadId: "t", raw: rawAvailable ? Buffer.from(originalMime).toString("base64url") : undefined } } : { data: { id: "m", threadId: "t", internalDate: "1760000000000", payload: { mimeType: "multipart/mixed", headers: [{ name: "From", value: "sender@example.com" }, { name: "Subject", value: "Original" }], parts: [{ mimeType: "text/plain", body: { data: Buffer.from("Original content").toString("base64url") } }, { mimeType: "application/pdf", filename: "file.pdf", body: { attachmentId: "a" } }] } } });
    const provider = new GmailProvider({ users: { threads: { modify }, messages: { get, send }, drafts: { create } } } as unknown as gmail_v1.Gmail, "account");
    await provider.markSpam("t");
    expect(modify).toHaveBeenCalledWith(expect.objectContaining({ requestBody: { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] } }));
    await provider.forwardEmail({ threadId: "t", messageId: "m", to: "target@example.com" });
    const mime = Buffer.from((send.mock.calls[0] as unknown as [{ requestBody: { raw: string } }])[0].requestBody.raw, "base64url").toString();
    const textPart = mime.match(/Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)--open-inbox-zero-/)?.[1];
    expect(Buffer.from(textPart!, "base64").toString()).toContain("Original content");
    expect(mime).toContain("Content-Type: message/rfc822");
    const encodedOriginal = mime.match(/Content-Type: message\/rfc822[\s\S]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+?)--open-inbox-zero-/)?.[1];
    expect(Buffer.from(encodedOriginal!, "base64").toString()).toBe(originalMime);
    await expect(provider.createForwardDraft({ threadId: "t", messageId: "m", to: "target@example.com" })).resolves.toEqual({ draftId: "draft", draftThreadId: "new-thread" });
    const draftMime = Buffer.from((create.mock.calls[0] as unknown as [{ requestBody: { message: { raw: string } } }])[0].requestBody.message.raw, "base64url").toString();
    const draftOriginal = draftMime.match(/Content-Type: message\/rfc822[\s\S]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+?)--open-inbox-zero-/)?.[1];
    expect(Buffer.from(draftOriginal!, "base64").toString()).toBe(originalMime);
    rawAvailable = false;
    await expect(provider.forwardEmail({ threadId: "t", messageId: "m", to: "target@example.com" })).rejects.toThrow(/MIME/);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("Gmail restores only labels changed by spam marking", async () => {
    const initial = { id: "t", messages: [{ id: "m1", labelIds: ["INBOX"] }, { id: "m2", labelIds: ["SPAM"] }] };
    const changed = { id: "t", messages: [{ id: "m1", labelIds: ["SPAM"] }, { id: "m2", labelIds: ["SPAM"] }] };
    const threadGet = vi.fn().mockResolvedValueOnce({ data: initial }).mockResolvedValueOnce({ data: changed });
    const modify = vi.fn(async () => ({ data: {} }));
    const provider = new GmailProvider({ users: { threads: { get: threadGet }, messages: { modify } } } as unknown as gmail_v1.Gmail, "account");
    const snapshot = await provider.captureUndoSnapshot("t");
    await provider.undoAction({ type: "MARK_SPAM", undoSnapshot: snapshot } as unknown as ExecutedAction, "t");
    expect(modify).toHaveBeenCalledTimes(1);
    expect(modify).toHaveBeenCalledWith(expect.objectContaining({ id: "m1", requestBody: { addLabelIds: ["INBOX"], removeLabelIds: ["SPAM"] } }));
  });
  it("Outlook moves only inbox messages to junk and restores their original folder", async () => {
    const locations: Record<string, string> = { m1: "inbox-id", m2: "archive-id" };
    const moves: { id: string; destinationId: string }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const folder = url.pathname.match(/\/mailFolders\/([^/]+)$/)?.[1];
      if (folder) return Response.json({ id: `${folder}-id` });
      const move = url.pathname.match(/\/messages\/([^/]+)\/move$/)?.[1];
      if (move) { const body = JSON.parse(String(init?.body)) as { destinationId: string }; locations[move] = body.destinationId; moves.push({ id: move, ...body }); return Response.json({ id: move }); }
      if (url.pathname.endsWith("/me/messages")) return Response.json({ value: Object.entries(locations).map(([id, parentFolderId]) => ({ id, parentFolderId, conversationId: "t", isRead: true, categories: [] })) });
      throw new Error("Unexpected request");
    });
    const provider = new OutlookProvider(async () => "token", "account", fetchMock as typeof fetch);
    const snapshot = await provider.captureUndoSnapshot("t");
    await provider.markSpam("t");
    await provider.undoAction({ type: "MARK_SPAM", undoSnapshot: snapshot } as unknown as ExecutedAction, "t");
    expect(moves).toEqual([{ id: "m1", destinationId: "junkemail-id" }, { id: "m1", destinationId: "inbox-id" }]);
    expect(locations.m2).toBe("archive-id");
  });
  it("Outlook forwards using native createForward and sends the returned draft", async () => {
    const requests: { path: string; method: string; body?: unknown }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ path: url.pathname, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const folder = url.pathname.match(/\/mailFolders\/([^/]+)$/)?.[1];
      if (folder) return Response.json({ id: `${folder}-id` });
      if (url.pathname.endsWith("/attachments")) return Response.json({ value: [{ name: "original.pdf", contentType: "application/pdf" }] });
      if (url.pathname.endsWith("/messages/m")) return Response.json({ id: "m", conversationId: "t", receivedDateTime: "2026-01-01T00:00:00Z", parentFolderId: "inbox-id", isRead: false, body: { contentType: "text", content: "Original" } });
      if (url.pathname.endsWith("/createForward")) return Response.json({ id: "draft", conversationId: "new-thread" }, { status: 201 });
      if (url.pathname.endsWith("/draft/send")) return new Response(null, { status: 202 });
      throw new Error("Unexpected request");
    });
    const provider = new OutlookProvider(async () => "token", "account", fetchMock as typeof fetch);
    await expect(provider.forwardEmail({ threadId: "t", messageId: "m", to: "target@example.com", comment: "FYI" })).resolves.toEqual({ messageId: "draft" });
    expect(requests.find((entry) => entry.path.endsWith("/createForward"))?.body).toMatchObject({ comment: "FYI", message: { toRecipients: [{ emailAddress: { address: "target@example.com" } }] } });
    expect(requests.some((entry) => entry.path.endsWith("/draft/send"))).toBe(true);
    await expect(provider.createForwardDraft({ threadId: "t", messageId: "m", to: "target@example.com" })).resolves.toEqual({ draftId: "draft", draftThreadId: "new-thread" });
  });
  it("Gmail forward-draft undo verifies the actual provider draft thread", async () => {
    let draftThreadId = "new-thread";
    const remove = vi.fn(async () => ({ data: {} }));
    const api = { users: { threads: { get: vi.fn(async () => ({ data: { id: "t", messages: [{ id: "m", labelIds: ["INBOX"] }] } })) }, drafts: { get: vi.fn(async () => ({ data: { id: "draft", message: { threadId: draftThreadId } } })), delete: remove } } } as unknown as gmail_v1.Gmail;
    const provider = new GmailProvider(api, "account");
    const snapshot = await provider.captureUndoSnapshot("t");
    const action = { type: "DRAFT_EMAIL", draftId: "draft", draftThreadId: "new-thread", undoSnapshot: snapshot } as unknown as ExecutedAction;
    draftThreadId = "different-thread";
    await expect(provider.undoAction(action, "t")).rejects.toThrow("no longer in this thread");
    expect(remove).not.toHaveBeenCalled();
    draftThreadId = "new-thread";
    await provider.undoAction(action, "t");
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it("Outlook forward-draft undo rejects a sent draft or the wrong draft thread", async () => {
    let draft = { id: "draft", isDraft: false, conversationId: "new-thread" };
    const deleted = vi.fn();
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/messages/draft")) {
        if (init?.method === "DELETE") { deleted(); return new Response(null, { status: 204 }); }
        return Response.json(draft);
      }
      if (url.pathname.endsWith("/me/messages")) return Response.json({ value: [{ id: "m", conversationId: "t", parentFolderId: "inbox", isRead: true, categories: [] }] });
      throw new Error("Unexpected request");
    });
    const provider = new OutlookProvider(async () => "token", "account", request as typeof fetch);
    const snapshot = await provider.captureUndoSnapshot("t");
    const action = { type: "DRAFT_EMAIL", draftId: "draft", draftThreadId: "new-thread", undoSnapshot: snapshot } as unknown as ExecutedAction;
    await expect(provider.undoAction(action, "t")).rejects.toThrow("no longer a draft");
    draft = { ...draft, isDraft: true, conversationId: "different-thread" };
    await expect(provider.undoAction(action, "t")).rejects.toThrow("no longer a draft");
    expect(deleted).not.toHaveBeenCalled();
    draft = { ...draft, conversationId: "new-thread" };
    await provider.undoAction(action, "t");
    expect(deleted).toHaveBeenCalledTimes(1);
  });

});
