import { PrismaClient } from "@prisma/client";
import EmbeddedPostgres from "embedded-postgres";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import { EmulatedMailProvider } from "../utils/mail-provider/emulated-provider";
import { createCleanupJob, recoverAbandonedCleanupJob, runCleanupJob, undoCleanupJob } from "../utils/cleanup/cleanup-jobs";

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  return address.port;
}

test("cleanup archives only eligible old threads, audits before mutation, and restores state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-inbox-zero-cleanup-"));
  const dbPort = await port();
  const db = new EmbeddedPostgres({ databaseDir: join(dir, "postgres"), user: "postgres", password: "temporary-test-password", port: dbPort, persistent: true, authMethod: "scram-sha-256", postgresFlags: ["-c", "listen_addresses=127.0.0.1"], autoRehydrateSymlinks: true, onLog: () => undefined });
  let started = false;
  let prisma: PrismaClient | undefined;
  try {
    await db.initialise(); await db.start(); started = true;
    const url = `postgresql://postgres:temporary-test-password@127.0.0.1:${dbPort}/postgres?schema=public`;
    await promisify(execFile)("pnpm", ["exec", "prisma", "db", "push", "--skip-generate"], { cwd: webDir, env: { ...process.env, DATABASE_URL: url }, timeout: 60_000 });
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.user.create({ data: { email: "owner@example.com", emailAccounts: { create: [{ id: "one", email: "me@example.com", provider: "emulator" }, { id: "two", email: "other@else.test", provider: "emulator" }] } } });
    await prisma.newsletter.create({ data: { emailAccountId: "one", fromEmail: "news@updates.test" } });
    const old = new Date("2024-01-01T00:00:00Z");
    const recent = new Date("2026-01-01T00:00:00Z");
    const createMessage = async (threadId: string, messageId: string, fromEmail: string, options: { date?: Date; labels?: string[]; unread?: boolean; archived?: boolean } = {}) => prisma!.emailMessage.create({ data: { emailAccountId: "one", threadId, messageId, fromEmail, toEmail: "me@example.com", subject: "Update", snippet: "hi", textBody: "hi", labels: options.labels ?? ["INBOX"], unread: options.unread ?? false, archived: options.archived ?? false, internalDate: options.date ?? old } });
    await createMessage("newsletter", "news", "news@updates.test");
    await createMessage("partial", "partial", "news@updates.test");
    await createMessage("old-notice", "notice", "alerts@service.test", { labels: ["INBOX", "Notifications"] });
    await createMessage("unread-notice", "unread", "alerts@service.test", { labels: ["INBOX", "Notifications", "UNREAD"], unread: true });
    await createMessage("recent", "recent", "news@updates.test", { date: recent });
    await createMessage("mixed", "mixed-news", "news@updates.test");
    await createMessage("mixed", "mixed-vip", "colleague@example.com");
    await createMessage("prearchived", "prearchived-one", "news@updates.test");
    await createMessage("prearchived", "prearchived-two", "news@updates.test", { labels: ["Archive"], archived: true });
    const provider = new EmulatedMailProvider(prisma, "one");
    const ctx = { prisma, provider, emailAccountId: "one" };
    await expect(createCleanupJob({ ...ctx, threadIds: ["unknown"], olderThan: new Date("2025-01-01"), mode: "BOTH" })).rejects.toThrow("does not belong");
    const job = await createCleanupJob({ ...ctx, threadIds: ["newsletter", "partial", "old-notice", "unread-notice", "recent", "mixed", "prearchived"], olderThan: new Date("2025-01-01"), mode: "BOTH" });
    const inspect = vi.spyOn(provider, "getThread").mockImplementation(async (threadId) => {
      const persisted = await prisma!.cleanupThread.findUniqueOrThrow({ where: { jobId_threadId: { jobId: job.id, threadId } } });
      expect(persisted.status).toBe("PENDING");
      return EmulatedMailProvider.prototype.getThread.call(provider, threadId);
    });
    const capture = vi.spyOn(provider, "captureUndoSnapshot").mockImplementation(async (threadId) => {
      const persisted = await prisma!.cleanupThread.findUniqueOrThrow({ where: { jobId_threadId: { jobId: job.id, threadId } } });
      expect(persisted.status).toBe("PENDING");
      return EmulatedMailProvider.prototype.captureUndoSnapshot.call(provider, threadId);
    });
    const archive = vi.spyOn(provider, "archiveThread").mockImplementation(async (threadId) => {
      const persisted = await prisma!.cleanupThread.findUniqueOrThrow({ where: { jobId_threadId: { jobId: job.id, threadId } } });
      expect(persisted.status).toBe("STARTED"); expect(persisted.undoSnapshot).toBeTruthy();
      await EmulatedMailProvider.prototype.archiveThread.call(provider, threadId);
      if (threadId === "partial") throw new Error("lost connection after partial provider mutation");
    });
    const outcome = await runCleanupJob({ ...ctx, cleanupJobId: job.id });
    inspect.mockRestore();
    expect(outcome.status).toBe("PARTIAL_ERROR");
    expect(outcome.threads.find((thread) => thread.threadId === "partial")?.status).toBe("FAILED");
    for (const threadId of ["unread-notice", "recent", "mixed"]) expect(outcome.threads.find((thread) => thread.threadId === threadId)?.status).toBe("SKIPPED");
    expect((await provider.getMessage("news")).labelIds).not.toContain("INBOX");
    expect((await provider.getMessage("notice")).labelIds).not.toContain("INBOX");
    expect((await provider.getMessage("partial")).labelIds).not.toContain("INBOX");
    expect((await provider.getMessage("mixed-news")).labelIds).toContain("INBOX");
    capture.mockRestore(); archive.mockRestore();
    await expect(runCleanupJob({ ...ctx, cleanupJobId: job.id })).rejects.toThrow("not available");
    const wrong = { prisma, provider: new EmulatedMailProvider(prisma, "two"), emailAccountId: "two", cleanupJobId: job.id };
    await expect(undoCleanupJob(wrong)).rejects.toThrow("not found for account");
    const undone = await undoCleanupJob({ ...ctx, cleanupJobId: job.id });
    expect(undone.status).toBe("UNDONE");
    expect((await provider.getMessage("news")).labelIds).toContain("INBOX");
    expect((await provider.getMessage("partial")).labelIds).toContain("INBOX");
    const beforeArchived = await prisma.emailMessage.findUniqueOrThrow({ where: { emailAccountId_messageId: { emailAccountId: "one", messageId: "prearchived-two" } } });
    expect(beforeArchived.archived).toBe(true); expect(beforeArchived.labels).toEqual(["Archive"]);
    expect((await undoCleanupJob({ ...ctx, cleanupJobId: job.id })).status).toBe("UNDONE");
    await createMessage("crash", "crash", "news@updates.test");
    await createMessage("never", "never", "news@updates.test");
    const abandoned = await createCleanupJob({ ...ctx, threadIds: ["crash", "never"], olderThan: new Date("2025-01-01"), mode: "NEWSLETTERS" });
    const crashItem = abandoned.threads.find((item) => item.threadId === "crash")!;
    const crashSnapshot = await provider.captureUndoSnapshot("crash");
    await prisma.cleanupJob.update({ where: { id: abandoned.id }, data: { status: "RUNNING" } });
    await prisma.cleanupThread.update({ where: { id: crashItem.id }, data: { status: "STARTED", startedAt: new Date(), undoSnapshot: crashSnapshot } });
    await provider.archiveThread("crash");
    await prisma.threadExecutionLock.create({ data: { emailAccountId: "one", threadId: "crash", ownerCleanupJobId: abandoned.id } });
    await prisma.threadExecutionLock.create({ data: { emailAccountId: "one", threadId: "unrelated", ownerCleanupJobId: "other-job" } });
    const recoveryInput = { prisma, emailAccountId: "one", cleanupJobId: abandoned.id, operator: "Test operator", stoppedEvidence: "Confirmed cleanup process has exited", confirmedStopped: true };
    await expect(recoverAbandonedCleanupJob({ ...recoveryInput, confirmedStopped: false })).rejects.toThrow("confirmation");
    await expect(recoverAbandonedCleanupJob({ ...recoveryInput, emailAccountId: "two" })).rejects.toThrow("not found");
    expect((await recoverAbandonedCleanupJob(recoveryInput)).releasedLocks).toBe(1);
    expect((await prisma.cleanupThread.findUniqueOrThrow({ where: { id: crashItem.id } })).status).toBe("FAILED");
    expect((await prisma.cleanupThread.findUniqueOrThrow({ where: { jobId_threadId: { jobId: abandoned.id, threadId: "never" } } })).status).toBe("SKIPPED");
    expect(await prisma.threadExecutionLock.count({ where: { threadId: "unrelated" } })).toBe(1);
    expect(await prisma.cleanupRecovery.count({ where: { emailAccountId: "one", cleanupJobId: abandoned.id } })).toBe(1);
    expect((await undoCleanupJob({ ...ctx, cleanupJobId: abandoned.id })).status).toBe("UNDONE");
    expect((await provider.getMessage("crash")).labelIds).toContain("INBOX");
  } finally {
    await prisma?.$disconnect(); if (started) await db.stop(); await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
