import { describe, expect, it, vi } from "vitest";
import { normalizeGmailLabels, normalizeOutlookLabels } from "./canonical";
import { OptimisticMailClient } from "./optimistic-client";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const initial = () => [{ id: "thread", labels: ["INBOX", "UNREAD"], drafts: [] }];

describe("canonical provider labels", () => {
  it("normalizes Gmail archive while preserving custom labels and sent/trash status", () => {
    expect(normalizeGmailLabels(["INBOX", "UNREAD", "Label_42"])).toEqual(["INBOX", "UNREAD", "Label_42"]);
    expect(normalizeGmailLabels(["Label_42"])).toEqual(["Label_42", "ARCHIVED"]);
    expect(normalizeGmailLabels(["TRASH"])).toEqual(["TRASH"]);
    expect(normalizeGmailLabels(["SENT"])).toEqual(["SENT"]);
  });
  it("maps Outlook folder IDs and message state, preserving categories", () => {
    expect(normalizeOutlookLabels({ folderId: "opaque", folderNames: { opaque: "Deleted Items" }, isRead: false, isFlagged: true, categories: ["Clients"] }))
      .toEqual(["TRASH", "Clients", "UNREAD", "STARRED"]);
    expect(normalizeOutlookLabels({ folderId: "archive", isRead: true })).toEqual(["ARCHIVED"]);
  });
});

describe("optimistic mail operations", () => {
  it("shows archive immediately and rolls it back on a server rejection", async () => {
    const request = deferred();
    const client = new OptimisticMailClient(initial(), () => request.promise);
    const result = client.archive("thread");
    expect(client.getThread("thread").labels).toContain("ARCHIVED");
    expect(client.getThread("thread").labels).not.toContain("INBOX");
    request.reject(new Error("offline"));
    await expect(result).rejects.toThrow("offline");
    expect(client.getThread("thread").labels).toEqual(["INBOX", "UNREAD"]);
    expect(client.getPendingCount("thread")).toBe(0);
  });
  it("keeps later optimistic changes when an earlier write fails, and sends writes in order", async () => {
    const first = deferred();
    const second = deferred();
    const send = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const client = new OptimisticMailClient(initial(), send);
    const archive = client.archive("thread");
    const label = client.addLabel("thread", "Clients");
    expect(send).toHaveBeenCalledTimes(1);
    expect(client.getThread("thread").labels).toEqual(["UNREAD", "ARCHIVED", "Clients"]);
    first.reject(new Error("archive failed"));
    await expect(archive).rejects.toThrow("archive failed");
    expect(send).toHaveBeenCalledTimes(2);
    expect(client.getThread("thread").labels).toEqual(["INBOX", "UNREAD", "Clients"]);
    second.resolve();
    await label;
    expect(client.getThread("thread").labels).toEqual(["INBOX", "UNREAD", "Clients"]);
  });
  it("applies read and draft changes immediately and restores a failed draft", async () => {
    const draftRequest = deferred();
    const send = vi.fn().mockResolvedValueOnce(undefined).mockReturnValueOnce(draftRequest.promise);
    const client = new OptimisticMailClient(initial(), send);
    const read = client.markRead("thread");
    const draft = client.createDraft("thread", { id: "draft-1", to: "a@example.com", subject: "Hi", body: "Hello" });
    expect(client.getThread("thread").labels).not.toContain("UNREAD");
    expect(client.getThread("thread").drafts).toHaveLength(1);
    await read;
    draftRequest.reject(new Error("draft failed"));
    await expect(draft).rejects.toThrow("draft failed");
    expect(client.getThread("thread")).toEqual({ id: "thread", labels: ["INBOX"], drafts: [] });
  });
  it("does not discard pending writes when a subscriber throws", async () => {
    const first = deferred();
    const second = deferred();
    const send = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const client = new OptimisticMailClient(initial(), send);
      client.subscribe(() => { throw new Error("bad listener"); });
      const archive = client.archive("thread");
      const label = client.addLabel("thread", "Clients");
      first.resolve();
      await archive;
      expect(client.getPendingCount("thread")).toBe(1);
      expect(send).toHaveBeenCalledTimes(2);
      second.resolve();
      await label;
      expect(client.getThread("thread").labels).toEqual(["UNREAD", "ARCHIVED", "Clients"]);
    } finally {
      log.mockRestore();
    }
  });
});
