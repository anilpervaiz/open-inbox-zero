import { PrismaClient } from "@prisma/client";
import EmbeddedPostgres from "embedded-postgres";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import type { EmailProvider } from "../utils/mail-provider/types";
import { claimDueDelayedAction, processNextDelayedAction, processPendingSenderLearning } from "../utils/worker/delayed-actions";
import { EmulatedMailProvider } from "../utils/mail-provider/emulated-provider";
import { executeAct, executeScheduledAction, undoExecutedRule } from "../utils/ai/choose-rule/execute";
import { emulatorProviderResolver, runDelayedWorker } from "../scripts/delayed-worker";

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port available");
  await new Promise<void>((yes, no) => server.close((error) => error ? no(error) : yes()));
  return address.port;
}

it("claims due work once, recovers only unstarted leases, and never retries uncertain effects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-inbox-zero-delayed-"));
  const port = await availablePort();
  const database = new EmbeddedPostgres({ databaseDir: join(dir, "postgres"), user: "postgres", password: "temporary-test-password", port, persistent: true, authMethod: "scram-sha-256", postgresFlags: ["-c", "listen_addresses=127.0.0.1"], autoRehydrateSymlinks: true, onLog: () => undefined });
  let started = false;
  let prisma: PrismaClient | undefined;
  try {
    await database.initialise();
    await database.start();
    started = true;
    const url = `postgresql://postgres:temporary-test-password@127.0.0.1:${port}/postgres?schema=public`;
    await promisify(execFile)("pnpm", ["exec", "prisma", "db", "push", "--skip-generate"], { cwd: webDir, env: { ...process.env, DATABASE_URL: url }, timeout: 60_000 });
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.user.create({ data: { id: "user", email: "owner@example.com", emailAccounts: { create: { id: "account", email: "demo@example.com", provider: "emulator" } } } });
    const execution = await prisma.executedRule.create({ data: { emailAccountId: "account", threadId: "thread", messageId: "message", actionItems: { create: [{ id: "action-1", type: "ARCHIVE" }, { id: "action-2", type: "LABEL" }, { id: "action-3", type: "DRAFT_EMAIL" }, { id: "action-4", type: "LABEL" }, { id: "action-5", type: "LABEL" }] } } });
    const now = new Date();
    await prisma.delayedAction.createMany({ data: [
      { id: "one", executedActionId: "action-1", sourceActionId: "source-1", sourceFingerprint: "test", dueAt: new Date(now.getTime() - 1000) },
      { id: "two", executedActionId: "action-2", sourceActionId: "source-2", sourceFingerprint: "test", dueAt: new Date(now.getTime() + 60_000) },
      { id: "three", executedActionId: "action-3", sourceActionId: "source-3", sourceFingerprint: "test", dueAt: new Date(now.getTime() + 60_000) },
      { id: "four", executedActionId: "action-4", sourceActionId: "source-4", sourceFingerprint: "test", dueAt: new Date(now.getTime() + 60_000) },
      { id: "five", executedActionId: "action-5", sourceActionId: "source-5", sourceFingerprint: "test", dueAt: new Date(now.getTime() + 60_000), status: "COMPLETED", claimToken: "finished-token" },
    ] });
    const oldLock = await prisma.threadExecutionLock.create({ data: { emailAccountId: "account", threadId: "terminal", ownerClaimToken: "finished-token" } });
    await claimDueDelayedAction(prisma, { now: new Date(now.getTime() - 2000) });
    expect(await prisma.threadExecutionLock.findUnique({ where: { id: oldLock.id } })).toBeNull();
    const replacement = await prisma.threadExecutionLock.create({ data: { emailAccountId: "account", threadId: "terminal" } });
    await prisma.threadExecutionLock.deleteMany({ where: { id: oldLock.id } });
    expect(await prisma.threadExecutionLock.findUnique({ where: { id: replacement.id } })).not.toBeNull();
    await prisma.threadExecutionLock.delete({ where: { id: replacement.id } });
    const claims = await Promise.all([claimDueDelayedAction(prisma), claimDueDelayedAction(prisma)]);
    expect(claims.filter(Boolean).map((claim) => claim!.id)).toEqual(["one"]);
    const first = claims.find((claim) => claim !== null)!;
    expect(first.executedAction.executedRule.emailAccountId).toBe("account");
    await prisma.threadExecutionLock.create({ data: { emailAccountId: "account", threadId: "thread", ownerClaimToken: first.claimToken } });
    await prisma.delayedAction.update({ where: { id: "one" }, data: { leaseUntil: new Date(Date.now() - 1) } });
    const reclaimed = await claimDueDelayedAction(prisma);
    expect(reclaimed?.id).toBe("one");
    expect(reclaimed?.claimToken).not.toBe(first.claimToken);
    expect(await prisma.threadExecutionLock.count({ where: { emailAccountId: "account", threadId: "thread" } })).toBe(0);
    await prisma.delayedAction.update({ where: { id: "one" }, data: { startedAt: new Date(), leaseUntil: new Date(Date.now() - 1) } });
    expect(await claimDueDelayedAction(prisma)).toBeNull();
    expect((await prisma.delayedAction.findUniqueOrThrow({ where: { id: "one" } })).status).toBe("UNCERTAIN");
    await prisma.delayedAction.update({ where: { id: "two" }, data: { dueAt: new Date(Date.now() - 1000) } });
    const execute = vi.fn(async ({ markStarted }: { markStarted: () => Promise<boolean> }) => { await markStarted(); return { status: "COMPLETED" }; });
    const provider = { emailAccountId: "account", providerName: "emulator" } as EmailProvider;
    expect(await processNextDelayedAction({ prisma, resolveProvider: async () => provider, execute })).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect((await prisma.delayedAction.findUniqueOrThrow({ where: { id: "two" } })).status).toBe("COMPLETED");
    expect(await processNextDelayedAction({ prisma, resolveProvider: async () => provider, execute })).toBe(false);
    await prisma.delayedAction.update({ where: { id: "three" }, data: { dueAt: new Date(Date.now() - 1000) } });
    const failing = vi.fn(async ({ markStarted }: { markStarted: () => Promise<boolean> }) => { await markStarted(); throw new Error("provider outcome unknown"); });
    expect(await processNextDelayedAction({ prisma, resolveProvider: async () => provider, execute: failing })).toBe(true);
    expect((await prisma.delayedAction.findUniqueOrThrow({ where: { id: "three" } })).status).toBe("UNCERTAIN");
    expect(await processNextDelayedAction({ prisma, resolveProvider: async () => provider, execute: failing })).toBe(false);
    expect(failing).toHaveBeenCalledOnce();
    await prisma.delayedAction.update({ where: { id: "four" }, data: { dueAt: new Date(Date.now() - 1000) } });
    await processNextDelayedAction({ prisma, resolveProvider: async () => { throw new Error("temporary resolver failure"); }, execute });
    expect((await prisma.delayedAction.findUniqueOrThrow({ where: { id: "four" } })).status).toBe("PENDING");
    await prisma.delayedAction.update({ where: { id: "four" }, data: { dueAt: new Date(Date.now() - 1000) } });
    await processNextDelayedAction({ prisma, resolveProvider: async () => provider, execute: async () => { throw new Error("temporary pre-start failure"); } });
    expect((await prisma.delayedAction.findUniqueOrThrow({ where: { id: "four" } })).status).toBe("PENDING");
    await prisma.delayedAction.update({ where: { id: "four" }, data: { dueAt: new Date(Date.now() - 1000) } });
    await processNextDelayedAction({ prisma, resolveProvider: async () => provider, execute });
    expect((await prisma.delayedAction.findUniqueOrThrow({ where: { id: "four" } })).status).toBe("COMPLETED");
    expect(execution.emailAccountId).toBe("account");

    const rule = await prisma.rule.create({ data: { emailAccountId: "account", name: "Delayed archive", subject: "hello", actions: { create: { type: "ARCHIVE", delayMinutes: 1 } } }, include: { actions: true } });
    for (const id of ["real", "cancelled", "changed", "rule-changed", "locked", "worker-loop", "mixed-delay", "mixed-spam-delay"]) {
      await prisma.emailMessage.create({ data: { emailAccountId: "account", threadId: id, messageId: id, fromEmail: "person@outside.test", toEmail: "demo@example.com", subject: "hello", snippet: "hi", textBody: "hi", labels: ["INBOX"], internalDate: new Date() } });
    }
    const emulator = new EmulatedMailProvider(prisma, "account");
    await prisma.emailMessage.create({ data: { emailAccountId: "account", threadId: "pilot-delayed", messageId: "pilot-delayed", fromEmail: "person@outside.test", toEmail: "demo@example.com", subject: "hello", snippet: "hi", textBody: "hi", labels: ["INBOX"], internalDate: new Date() } });
    const outbound = await prisma.rule.create({ data: { emailAccountId: "account", name: "Delayed send", actions: { create: { type: "SEND_EMAIL", to: "person@outside.test", autoSend: true, delayMinutes: 1 } } }, include: { actions: true } });
    vi.stubEnv("PILOT_MODE", "false");
    const oldJob = await executeAct({ prisma, provider: emulator, emailAccountId: "account", message: await emulator.getMessage("pilot-delayed"), rule: outbound, actions: outbound.actions, matchReasons: [{ type: "STATIC", detail: "subject", matchedFields: ["subject"] }], selectionMetadata: { stage: "STATIC", ruleName: outbound.name }, hasVerifiedSenderReplyHistory: false });
    expect(oldJob.status).toBe("PENDING");
    await prisma.delayedAction.update({ where: { executedActionId: oldJob.actionItems[0].id }, data: { dueAt: new Date(Date.now() - 1000) } });
    vi.stubEnv("PILOT_MODE", "true");
    const sendSpy = vi.spyOn(emulator, "sendEmail");
    await processNextDelayedAction({ prisma, resolveProvider: async () => emulator, execute: executeScheduledAction });
    expect((await prisma.executedAction.findUniqueOrThrow({ where: { id: oldJob.actionItems[0].id } })).status).toBe("SKIPPED");
    expect(sendSpy).not.toHaveBeenCalled();
    sendSpy.mockRestore();
    const schedule = async (id: string) => executeAct({ prisma: prisma!, provider: emulator, emailAccountId: "account", message: await emulator.getMessage(id), rule, actions: rule.actions, matchReasons: [{ type: "STATIC", detail: "subject", matchedFields: ["subject"] }], selectionMetadata: { stage: "STATIC", ruleName: rule.name }, hasVerifiedSenderReplyHistory: false });
    const scheduled = await schedule("real");
    expect(scheduled.status).toBe("PENDING");
    expect((await emulator.getMessage("real")).labelIds).toContain("INBOX");
    await prisma.delayedAction.update({ where: { executedActionId: scheduled.actionItems[0].id }, data: { dueAt: new Date(Date.now() - 1000) } });
    expect(await processNextDelayedAction({ prisma, resolveProvider: async () => emulator, execute: executeScheduledAction })).toBe(true);
    expect((await emulator.getMessage("real")).labelIds).not.toContain("INBOX");
    expect((await prisma.executedRule.findUniqueOrThrow({ where: { id: scheduled.id } })).status).toBe("APPLIED");
    await undoExecutedRule({ prisma, provider: emulator, emailAccountId: "account", executedRuleId: scheduled.id });
    expect((await emulator.getMessage("real")).labelIds).toContain("INBOX");
    const mixedDelay = await schedule("mixed-delay");
    await prisma.emailMessage.create({ data: { emailAccountId: "account", threadId: "mixed-delay", messageId: "mixed-delay-own", fromEmail: "colleague@example.com", toEmail: "demo@example.com", subject: "hello", snippet: "hi", textBody: "hi", labels: ["INBOX"], internalDate: new Date() } });
    await prisma.delayedAction.update({ where: { executedActionId: mixedDelay.actionItems[0].id }, data: { dueAt: new Date(Date.now() - 1000) } });
    await processNextDelayedAction({ prisma, resolveProvider: async () => emulator, execute: executeScheduledAction });
    expect((await prisma.executedAction.findUniqueOrThrow({ where: { id: mixedDelay.actionItems[0].id } })).status).toBe("SKIPPED");
    expect((await emulator.getThread("mixed-delay")).messages.every((message) => message.labelIds.includes("INBOX"))).toBe(true);
    const spamRule = await prisma.rule.create({ data: { emailAccountId: "account", name: "Delayed spam", subject: "hello", actions: { create: { type: "MARK_SPAM", delayMinutes: 1 } } }, include: { actions: true } });
    const delayedSpam = await executeAct({ prisma, provider: emulator, emailAccountId: "account", message: await emulator.getMessage("mixed-spam-delay"), rule: spamRule, actions: spamRule.actions, matchReasons: [{ type: "STATIC", detail: "subject", matchedFields: ["subject"] }], selectionMetadata: { stage: "STATIC", ruleName: spamRule.name }, hasVerifiedSenderReplyHistory: false, protectedSenders: ["vip@client.test"] });
    await prisma.emailMessage.create({ data: { emailAccountId: "account", threadId: "mixed-spam-delay", messageId: "mixed-spam-delay-vip", fromEmail: "vip@client.test", toEmail: "demo@example.com", subject: "hello", snippet: "hi", textBody: "hi", labels: ["INBOX"], internalDate: new Date() } });
    await prisma.delayedAction.update({ where: { executedActionId: delayedSpam.actionItems[0].id }, data: { dueAt: new Date(Date.now() - 1000) } });
    await processNextDelayedAction({ prisma, resolveProvider: async () => emulator, execute: executeScheduledAction });
    expect((await prisma.executedAction.findUniqueOrThrow({ where: { id: delayedSpam.actionItems[0].id } })).status).toBe("SKIPPED");
    expect((await emulator.getThread("mixed-spam-delay")).messages.every((message) => message.labelIds.includes("INBOX") && !message.labelIds.includes("SPAM"))).toBe(true);
    const cancel = await schedule("cancelled");
    await undoExecutedRule({ prisma, provider: emulator, emailAccountId: "account", executedRuleId: cancel.id });
    expect((await prisma.delayedAction.findUniqueOrThrow({ where: { executedActionId: cancel.actionItems[0].id } })).status).toBe("CANCELLED");
    expect((await emulator.getMessage("cancelled")).labelIds).toContain("INBOX");
    const changed = await schedule("changed");
    await prisma.action.update({ where: { id: rule.actions[0].id }, data: { label: "changed after scheduling" } });
    await prisma.delayedAction.update({ where: { executedActionId: changed.actionItems[0].id }, data: { dueAt: new Date(Date.now() - 1000) } });
    expect(await processNextDelayedAction({ prisma, resolveProvider: async () => emulator, execute: executeScheduledAction })).toBe(true);
    expect((await prisma.executedAction.findUniqueOrThrow({ where: { id: changed.actionItems[0].id } })).status).toBe("SKIPPED");
    expect((await emulator.getMessage("changed")).labelIds).toContain("INBOX");
    const changedRule = await schedule("rule-changed");
    await prisma.rule.update({ where: { id: rule.id }, data: { subject: "new condition" } });
    await prisma.delayedAction.update({ where: { executedActionId: changedRule.actionItems[0].id }, data: { dueAt: new Date(Date.now() - 1000) } });
    await processNextDelayedAction({ prisma, resolveProvider: async () => emulator, execute: executeScheduledAction });
    expect((await prisma.executedAction.findUniqueOrThrow({ where: { id: changedRule.actionItems[0].id } })).status).toBe("SKIPPED");
    await prisma.rule.update({ where: { id: rule.id }, data: { subject: "hello" } });
    const locked = await schedule("locked");
    await prisma.threadExecutionLock.create({ data: { emailAccountId: "account", threadId: "locked" } });
    await prisma.delayedAction.update({ where: { executedActionId: locked.actionItems[0].id }, data: { dueAt: new Date(Date.now() - 1000) } });
    await processNextDelayedAction({ prisma, resolveProvider: async () => emulator, execute: executeScheduledAction });
    expect((await prisma.delayedAction.findUniqueOrThrow({ where: { executedActionId: locked.actionItems[0].id } })).status).toBe("PENDING");
    await prisma.threadExecutionLock.deleteMany({ where: { emailAccountId: "account", threadId: "locked" } });
    await prisma.delayedAction.update({ where: { executedActionId: locked.actionItems[0].id }, data: { dueAt: new Date(Date.now() - 1000) } });
    await processNextDelayedAction({ prisma, resolveProvider: async () => emulator, execute: executeScheduledAction });
    expect((await emulator.getMessage("locked")).labelIds).not.toContain("INBOX");

    for (const id of ["learn-first", "learn-second"]) await prisma.emailMessage.create({ data: { emailAccountId: "account", threadId: id, messageId: id, fromEmail: "learner@outside.test", toEmail: "demo@example.com", subject: "hello", snippet: "hi", textBody: "hi", labels: ["INBOX"], internalDate: new Date() } });
    await prisma.executedRule.create({ data: { emailAccountId: "account", ruleId: rule.id, threadId: "learn-first", messageId: "learn-first", status: "APPLIED", selectionMetadata: { stage: "AI", ruleName: rule.name } } });
    const learnedExecution = await executeAct({ prisma, provider: emulator, emailAccountId: "account", message: await emulator.getMessage("learn-second"), rule, actions: rule.actions, matchReasons: [{ type: "AI", detail: "model" }], selectionMetadata: { stage: "AI", ruleName: rule.name }, hasVerifiedSenderReplyHistory: false });
    const learnedJobId = learnedExecution.actionItems[0].id;
    await prisma.delayedAction.update({ where: { executedActionId: learnedJobId }, data: { dueAt: new Date(Date.now() - 1000) } });
    await processNextDelayedAction({ prisma, resolveProvider: async () => emulator, execute: executeScheduledAction });
    expect((await prisma.delayedAction.findUniqueOrThrow({ where: { executedActionId: learnedJobId } })).learningPending).toBe(true);
    expect(await processPendingSenderLearning(prisma)).toBe(true);
    expect(await prisma.groupItem.findFirst({ where: { value: "learner@outside.test", source: "AI_LEARNED" } })).not.toBeNull();
    expect((await prisma.delayedAction.findUniqueOrThrow({ where: { executedActionId: learnedJobId } })).learningPending).toBe(false);

    const loopExecution = await schedule("worker-loop");
    await prisma.delayedAction.update({ where: { executedActionId: loopExecution.actionItems[0].id }, data: { dueAt: new Date(Date.now() - 1000) } });
    const stop = new AbortController();
    const worker = runDelayedWorker({ prisma, resolveProvider: emulatorProviderResolver(prisma), signal: stop.signal, pollMs: 20 });
    try {
      const deadline = Date.now() + 5000;
      while ((await prisma.executedRule.findUniqueOrThrow({ where: { id: loopExecution.id } })).status === "PENDING" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      expect((await prisma.executedRule.findUniqueOrThrow({ where: { id: loopExecution.id } })).status).toBe("APPLIED");
      expect((await emulator.getMessage("worker-loop")).labelIds).not.toContain("INBOX");
    } finally {
      stop.abort();
      await worker;
    }
  } finally {
    vi.unstubAllEnvs();
    await prisma?.$disconnect();
    if (started) await database.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
