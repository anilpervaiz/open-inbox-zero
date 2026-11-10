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
import { recoverAbandonedImmediateExecution } from "../utils/ai/choose-rule/recover-execution";
import { undoExecutedRule } from "../utils/ai/choose-rule/execute";
import { EmulatedMailProvider } from "../utils/mail-provider/emulated-provider";

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  return address.port;
}

test("operator recovery cancels unstarted work and preserves started outcomes for reconciliation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-inbox-zero-recovery-"));
  const dbPort = await port();
  const db = new EmbeddedPostgres({ databaseDir: join(dir, "postgres"), user: "postgres", password: "temporary-test-password", port: dbPort, persistent: true, authMethod: "scram-sha-256", postgresFlags: ["-c", "listen_addresses=127.0.0.1"], autoRehydrateSymlinks: true, onLog: () => undefined });
  let started = false;
  let prisma: PrismaClient | undefined;
  try {
    await db.initialise(); await db.start(); started = true;
    const url = `postgresql://postgres:temporary-test-password@127.0.0.1:${dbPort}/postgres?schema=public`;
    await promisify(execFile)("pnpm", ["exec", "prisma", "db", "push", "--skip-generate"], { cwd: webDir, env: { ...process.env, DATABASE_URL: url }, timeout: 60_000 });
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.user.create({ data: { email: "owner@example.com", emailAccounts: { create: { id: "account", email: "me@example.com", provider: "emulator" } } } });
    for (const id of ["before", "partial", "send", "draft"]) {
      await prisma.emailMessage.create({ data: { emailAccountId: "account", threadId: id, messageId: id, fromEmail: "outside@external.test", toEmail: "me@example.com", subject: "hello", snippet: "hi", textBody: "hi", internalDate: new Date(), labels: ["INBOX"] } });
    }
    const provider = new EmulatedMailProvider(prisma, "account");
    const base = { prisma, emailAccountId: "account", operator: "Test operator", stoppedEvidence: "Verified test worker PID exited", confirmedStopped: true };
    await prisma.threadExecutionLock.create({ data: { emailAccountId: "account", threadId: "before" } });
    const before = await prisma.executedRule.create({ data: { emailAccountId: "account", threadId: "before", messageId: "before", actionItems: { create: { type: "ARCHIVE" } } }, include: { actionItems: true } });
    await expect(recoverAbandonedImmediateExecution({ ...base, threadId: "before", confirmedStopped: false })).rejects.toThrow("confirmation");
    expect(await prisma.threadExecutionLock.count({ where: { threadId: "before" } })).toBe(1);
    const recovered = await recoverAbandonedImmediateExecution({ ...base, threadId: "before" });
    expect(recovered.affectedExecutions).toBe(1);
    expect((await prisma.executedRule.findUniqueOrThrow({ where: { id: before.id }, include: { actionItems: true } }))).toMatchObject({ status: "SKIPPED", actionItems: [{ status: "SKIPPED", executionStartedAt: null }] });
    expect(await prisma.threadExecutionLock.count({ where: { threadId: "before" } })).toBe(0);
    expect(await prisma.executionRecovery.count({ where: { emailAccountId: "account", threadId: "before", operator: "Test operator" } })).toBe(1);

    const snapshot = await provider.captureUndoSnapshot("partial");
    await prisma.threadExecutionLock.create({ data: { emailAccountId: "account", threadId: "partial" } });
    const partial = await prisma.executedRule.create({ data: { emailAccountId: "account", threadId: "partial", messageId: "partial", actionItems: { create: { type: "LABEL", label: "Applied", executionStartedAt: new Date(), undoSnapshot: snapshot as Prisma.InputJsonValue } } }, include: { actionItems: true } });
    await provider.addLabel("partial", "Applied");
    await recoverAbandonedImmediateExecution({ ...base, threadId: "partial" });
    expect((await prisma.executedAction.findUniqueOrThrow({ where: { id: partial.actionItems[0].id } })).status).toBe("FAILED");
    expect((await prisma.executedRule.findUniqueOrThrow({ where: { id: partial.id } })).status).toBe("ERROR");
    await undoExecutedRule({ prisma, provider, emailAccountId: "account", executedRuleId: partial.id });
    expect((await provider.getMessage("partial")).labelIds).toEqual(["INBOX"]);

    for (const [threadId, type] of [["send", "SEND_EMAIL"], ["draft", "DRAFT_EMAIL"]] as const) {
      const snapshot = await provider.captureUndoSnapshot(threadId);
      await prisma.threadExecutionLock.create({ data: { emailAccountId: "account", threadId } });
      const execution = await prisma.executedRule.create({ data: { emailAccountId: "account", threadId, messageId: threadId, actionItems: { create: { type, executionStartedAt: new Date(), undoSnapshot: snapshot as Prisma.InputJsonValue } } }, include: { actionItems: true } });
      await recoverAbandonedImmediateExecution({ ...base, threadId });
      expect((await prisma.executedAction.findUniqueOrThrow({ where: { id: execution.actionItems[0].id } })).status).toBe("FAILED");
      await expect(undoExecutedRule({ prisma, provider, emailAccountId: "account", executedRuleId: execution.id })).rejects.toThrow(type === "SEND_EMAIL" ? /indeterminate outbound/ : /Draft creation outcome is unknown/);
      expect((await prisma.executedRule.findUniqueOrThrow({ where: { id: execution.id } })).status).toBe("ERROR");
    }
    await prisma.threadExecutionLock.create({ data: { emailAccountId: "account", threadId: "delayed", ownerClaimToken: "delayed-claim" } });
    await expect(recoverAbandonedImmediateExecution({ ...base, threadId: "delayed" })).rejects.toThrow("Delayed worker locks");
    expect(await prisma.threadExecutionLock.count({ where: { threadId: "delayed" } })).toBe(1);
    await prisma.threadExecutionLock.create({ data: { emailAccountId: "account", threadId: "before-insert" } });
    const empty = await recoverAbandonedImmediateExecution({ ...base, threadId: "before-insert" });
    expect(empty.affectedExecutions).toBe(0);
    expect(await prisma.executionRecovery.count({ where: { emailAccountId: "account", threadId: "before-insert" } })).toBe(1);
  } finally {
    await prisma?.$disconnect();
    if (started) await db.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
