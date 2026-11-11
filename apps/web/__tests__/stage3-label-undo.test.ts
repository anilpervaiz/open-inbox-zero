import type { ExecutedAction } from "@prisma/client";
import type { gmail_v1 } from "@googleapis/gmail";
import { expect, test, vi } from "vitest";
import { GmailProvider } from "../utils/mail-provider/gmail-provider";
import { OutlookProvider } from "../utils/mail-provider/outlook-provider";

test("Gmail restores a removed label only on messages that originally had it", async () => {
  const thread = { id: "thread", messages: [{ id: "one", labelIds: ["INBOX"] }, { id: "two", labelIds: ["INBOX"] }] };
  const modify = vi.fn(async () => ({ data: {} }));
  const provider = new GmailProvider({ users: {
    threads: { get: vi.fn(async () => ({ data: thread })) },
    labels: { list: vi.fn(async () => ({ data: { labels: [{ id: "label-id", name: "To Reply" }] } })) },
    messages: { modify },
  } } as unknown as gmail_v1.Gmail, "account");
  const snapshot = { provider: "google", threadId: "thread", messages: [{ id: "one", labelIds: ["INBOX", "label-id"] }, { id: "two", labelIds: ["INBOX"] }] };
  await provider.undoAction({ type: "LABEL", label: "To Reply", labelOperation: "REMOVE", undoSnapshot: snapshot } as unknown as ExecutedAction, "thread");
  expect(modify).toHaveBeenCalledTimes(1);
  expect(modify).toHaveBeenCalledWith(expect.objectContaining({ id: "one", requestBody: { addLabelIds: ["label-id"], removeLabelIds: [] } }));
});

test("Outlook restores removed categories only where previously present, preserving concurrent categories", async () => {
  const patches: { id: string; categories: string[] }[] = [];
  const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const id = url.pathname.match(/\/messages\/([^/]+)$/)?.[1];
    if (id && init?.method === "PATCH") { patches.push({ id, ...(JSON.parse(String(init.body)) as { categories: string[] }) }); return new Response(null, { status: 204 }); }
    if (url.pathname.endsWith("/me/messages")) return Response.json({ value: [
      { id: "one", conversationId: "thread", parentFolderId: "inbox", isRead: true, categories: ["Other"] },
      { id: "two", conversationId: "thread", parentFolderId: "inbox", isRead: true, categories: ["Other"] },
    ] });
    throw new Error("Unexpected request");
  });
  const provider = new OutlookProvider(async () => "token", "account", request as typeof fetch);
  const snapshot = { provider: "microsoft", threadId: "thread", messages: [
    { id: "one", parentFolderId: "inbox", isRead: true, categories: ["To Reply"] },
    { id: "two", parentFolderId: "inbox", isRead: true, categories: [] },
  ] };
  await provider.undoAction({ type: "LABEL", label: "To Reply", labelOperation: "REMOVE", undoSnapshot: snapshot } as unknown as ExecutedAction, "thread");
  expect(patches).toEqual([{ id: "one", categories: ["Other", "To Reply"] }]);
});
