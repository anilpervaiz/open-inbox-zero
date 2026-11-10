import { PrismaClient, type Prisma } from "@prisma/client";
import EmbeddedPostgres from "embedded-postgres";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { EmulatedMailProvider } from "../utils/mail-provider/emulated-provider";

const execFileAsync = promisify(execFile);
const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port available");
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

test("emulator persists lifecycle changes, undoes only its effects, and isolates accounts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-inbox-zero-provider-"));
  const port = await availablePort();
  const database = new EmbeddedPostgres({ databaseDir: join(dir, "postgres"), user: "postgres", password: "temporary-test-password", port, persistent: true, authMethod: "scram-sha-256", postgresFlags: ["-c", "listen_addresses=127.0.0.1"], autoRehydrateSymlinks: true, onLog: () => undefined });
  let started = false;
  let prisma: PrismaClient | undefined;
  try {
    await database.initialise();
    await database.start();
    started = true;
    const url = `postgresql://postgres:temporary-test-password@127.0.0.1:${port}/postgres?schema=public`;
    await execFileAsync("pnpm", ["exec", "prisma", "db", "push", "--skip-generate"], { cwd: webDir, env: { ...process.env, DATABASE_URL: url }, timeout: 60_000 });
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.user.create({ data: { id: "user", email: "owner@example.com", emailAccounts: { create: [
      { id: "one", email: "one@example.com", provider: "emulator" }, { id: "two", email: "two@example.com", provider: "emulator" },
    ] } } });
    await prisma.emailMessage.createMany({ data: [
      { emailAccountId: "one", threadId: "thread", messageId: "first", fromEmail: "sender@example.com", toEmail: "one@example.com", subject: "Hello", snippet: "hello", textBody: "hello", contentType: "multipart/mixed", mimeTypes: ["text/calendar"], attachmentNames: ["invite.ics"], internalDate: new Date(), labels: ["INBOX", "VIP"], unread: true },
      { emailAccountId: "one", threadId: "thread", messageId: "second", fromEmail: "sender@example.com", toEmail: "one@example.com", subject: "Re: Hello", snippet: "again", textBody: "again", internalDate: new Date(), labels: ["VIP"], archived: true, unread: false },
      { emailAccountId: "two", threadId: "thread", messageId: "other", fromEmail: "someone@example.com", toEmail: "two@example.com", subject: "Private", snippet: "private", textBody: "private", internalDate: new Date(), labels: ["INBOX"] },
    ] });
    const provider = new EmulatedMailProvider(prisma, "one");
    expect(provider.emailAccountId).toBe("one");
    expect(await provider.getMessage("first")).toMatchObject({ contentType: "multipart/mixed", mimeTypes: ["text/calendar"], attachmentNames: ["invite.ics"] });
    expect((await provider.listThreads({ query: "hello" })).threadIds).toEqual(["thread"]);
    expect((await provider.getThread("thread")).messages).toHaveLength(2);
    await expect(provider.getMessage("other")).rejects.toThrow("Message not found");
    const execution = await prisma.executedRule.create({ data: { emailAccountId: "one", threadId: "thread", messageId: "first" } });
    const snapshot = await provider.captureUndoSnapshot("thread");
    const archive = await prisma.executedAction.create({ data: { executedRuleId: execution.id, type: "ARCHIVE", status: "COMPLETED", undoSnapshot: snapshot as Prisma.InputJsonValue } });
    await provider.archiveThread("thread");
    expect((await provider.getMessage("first")).labelIds).not.toContain("INBOX");
    await provider.undoAction(archive, "thread");
    const restored = await prisma.emailMessage.findMany({ where: { emailAccountId: "one", threadId: "thread" }, orderBy: { messageId: "asc" } });
    expect(restored[0]).toMatchObject({ archived: false, labels: ["VIP", "INBOX"] });
    expect(restored[1]).toMatchObject({ archived: true, labels: ["VIP"] });
    const labelSnapshot = await provider.captureUndoSnapshot("thread");
    const label = await prisma.executedAction.create({ data: { executedRuleId: execution.id, type: "LABEL", status: "COMPLETED", label: "VIP", undoSnapshot: labelSnapshot as Prisma.InputJsonValue } });
    await provider.addLabel("thread", "VIP");
    await provider.undoAction(label, "thread");
    expect((await provider.getThread("thread")).messages.every((message) => message.labelIds.includes("VIP"))).toBe(true);
    const newLabelSnapshot = await provider.captureUndoSnapshot("thread");
    const newLabel = await prisma.executedAction.create({ data: { executedRuleId: execution.id, type: "LABEL", status: "COMPLETED", label: "Follow up", undoSnapshot: newLabelSnapshot as Prisma.InputJsonValue } });
    await provider.addLabel("thread", "Follow up");
    expect((await provider.listThreads({ labelIds: ["Follow up"] })).threadIds).toEqual(["thread"]);
    await provider.undoAction(newLabel, "thread");
    expect((await provider.listThreads({ labelIds: ["Follow up"] })).threadIds).toEqual([]);
    const readSnapshot = await provider.captureUndoSnapshot("thread");
    const read = await prisma.executedAction.create({ data: { executedRuleId: execution.id, type: "MARK_SEEN", status: "COMPLETED", undoSnapshot: readSnapshot as Prisma.InputJsonValue } });
    await provider.markRead("thread", true);
    await provider.undoAction(read, "thread");
    expect((await prisma.emailMessage.findUniqueOrThrow({ where: { emailAccountId_messageId: { emailAccountId: "one", messageId: "first" } } })).unread).toBe(true);
    expect((await prisma.emailMessage.findUniqueOrThrow({ where: { emailAccountId_messageId: { emailAccountId: "one", messageId: "second" } } })).unread).toBe(false);
    const { draftId } = await provider.createDraft({ threadId: "thread", to: "sender@example.com", cc: "cc@example.com", subject: "Re: Hello", body: "Thanks", inReplyTo: "<first@example.com>" });
    expect((await provider.getMessage(draftId)).headers).toMatchObject({ cc: "cc@example.com", inReplyTo: "<first@example.com>" });
    const draftAction = await prisma.executedAction.create({ data: { executedRuleId: execution.id, type: "DRAFT_EMAIL", status: "COMPLETED", draftId } });
    await prisma.emailMessage.update({ where: { emailAccountId_messageId: { emailAccountId: "one", messageId: draftId } }, data: { labels: ["SENT"] } });
    await expect(provider.undoAction(draftAction, "thread")).rejects.toThrow("no longer a draft");
    expect((await provider.getMessage(draftId)).labelIds).toContain("SENT");
    await prisma.emailMessage.update({ where: { emailAccountId_messageId: { emailAccountId: "one", messageId: draftId } }, data: { labels: ["DRAFT"] } });
    await provider.undoAction(draftAction, "thread");
    await expect(provider.getMessage(draftId)).rejects.toThrow("Message not found");
    const forward = await provider.createForwardDraft({ threadId: "thread", messageId: "second", to: "friend@example.com" });
    expect(forward.draftThreadId).toBe("thread");
    expect((await provider.getMessage(forward.draftId)).textPlain).toContain("again");
    const forwardAction = await prisma.executedAction.create({ data: { executedRuleId: execution.id, type: "DRAFT_EMAIL", status: "COMPLETED", ...forward } });
    await provider.undoAction(forwardAction, "thread");
    await expect(provider.createForwardDraft({ threadId: "thread", messageId: "first", to: "friend@example.com" })).rejects.toThrow("Attachment content is unavailable");
    const source = await prisma.emailMessage.findUniqueOrThrow({ where: { emailAccountId_messageId: { emailAccountId: "one", messageId: "first" } } });
    const bytes = new Uint8Array([0, 255, 1, 2, 13, 10, 200, 42]);
    await prisma.emailAttachment.create({ data: { emailMessageId: source.id, name: "invite.ics", contentType: "text/calendar", content: bytes } });
    const attachedDraft = await provider.createForwardDraft({ threadId: "thread", messageId: "first", to: "friend@example.com" });
    const draftRow = await prisma.emailMessage.findUniqueOrThrow({ where: { emailAccountId_messageId: { emailAccountId: "one", messageId: attachedDraft.draftId } }, include: { attachments: true } });
    expect(draftRow.attachments).toHaveLength(1);
    expect(draftRow.attachments[0]).toMatchObject({ name: "invite.ics", contentType: "text/calendar" });
    expect([...draftRow.attachments[0]!.content]).toEqual([...bytes]);
    const attachedAction = await prisma.executedAction.create({ data: { executedRuleId: execution.id, type: "DRAFT_EMAIL", status: "COMPLETED", ...attachedDraft } });
    await provider.undoAction(attachedAction, "thread");
    expect(await prisma.emailAttachment.count({ where: { emailMessageId: draftRow.id } })).toBe(0);
    expect(await prisma.emailAttachment.count({ where: { emailMessageId: source.id } })).toBe(1);
    const sent = await provider.forwardEmail({ threadId: "thread", messageId: "first", to: "friend@example.com" });
    const sentRow = await prisma.emailMessage.findUniqueOrThrow({ where: { emailAccountId_messageId: { emailAccountId: "one", messageId: sent.messageId } }, include: { attachments: true } });
    expect([...sentRow.attachments[0]!.content]).toEqual([...bytes]);
    const other = new EmulatedMailProvider(prisma, "two");
    await expect(other.createForwardDraft({ threadId: "thread", messageId: "first", to: "friend@example.com" })).rejects.toThrow("not in account");
    await expect(other.undoAction(archive, "thread")).rejects.toThrow("Reversible action not found");
    expect((await other.getMessage("other")).labelIds).toEqual(["INBOX"]);
    const missingSnapshot = await prisma.executedAction.create({ data: { executedRuleId: execution.id, type: "ARCHIVE", status: "COMPLETED" } });
    await expect(provider.undoAction(missingSnapshot, "thread")).rejects.toThrow("Missing undo snapshot");
    const wrongThread = await prisma.executedAction.create({ data: { executedRuleId: execution.id, type: "ARCHIVE", status: "COMPLETED", undoSnapshot: { ...snapshot, threadId: "other-thread" } as Prisma.InputJsonValue } });
    await expect(provider.undoAction(wrongThread, "thread")).rejects.toThrow("Missing undo snapshot");
  } finally {
    await prisma?.$disconnect();
    if (started) await database.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
