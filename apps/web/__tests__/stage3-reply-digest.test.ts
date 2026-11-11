import { PrismaClient, type EmailAccount } from "@prisma/client";
import EmbeddedPostgres from "embedded-postgres";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EmulatedMailProvider } from "../utils/mail-provider/emulated-provider";
import { recordIncomingMessage, recordSentReply } from "../utils/reply-tracker/events";
import { processNextReplyLabelSync } from "../utils/reply-tracker/label-sync";
import { generateDigest } from "../utils/ai/digest/digest";
import { runRules } from "../utils/ai/choose-rule/run-rules";
import { undoExecutedRule } from "../utils/ai/choose-rule/execute";

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let directory = "";
let database: EmbeddedPostgres;
let prisma: PrismaClient;
let started = false;

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local port available");
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  return address.port;
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "open-inbox-stage3-reply-"));
  const port = await availablePort();
  database = new EmbeddedPostgres({ databaseDir: join(directory, "postgres"), user: "postgres", password: "temporary-test-password", port, persistent: true, authMethod: "scram-sha-256", postgresFlags: ["-c", "listen_addresses=127.0.0.1"], autoRehydrateSymlinks: true, onLog: () => undefined });
  await database.initialise(); await database.start(); started = true;
  const url = `postgresql://postgres:temporary-test-password@127.0.0.1:${port}/postgres?schema=public`;
  await promisify(execFile)("pnpm", ["exec", "prisma", "db", "push", "--skip-generate"], { cwd: webDir, env: { ...process.env, DATABASE_URL: url }, timeout: 60_000 });
  prisma = new PrismaClient({ datasources: { db: { url } } });
}, 120_000);
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await prisma?.user.deleteMany(); });
afterAll(async () => { await prisma?.$disconnect(); if (started) await database.stop(); if (directory) await rm(directory, { recursive: true, force: true }); }, 30_000);

async function account() {
  const email = `${randomUUID()}@owner.example`;
  const user = await prisma.user.create({ data: { email } });
  return prisma.emailAccount.create({ data: { userId: user.id, email, provider: "emulator", coldEmailBlocker: "DISABLED" } });
}
async function mail(owner: EmailAccount, input: { threadId: string; id?: string; from: string; to?: string; subject: string; at: Date; sent?: boolean; body?: string; contentType?: string }) {
  const id = input.id ?? randomUUID();
  await prisma.emailMessage.create({ data: { emailAccountId: owner.id, threadId: input.threadId, messageId: id, fromEmail: input.from, toEmail: input.to ?? owner.email, subject: input.subject, textBody: input.body ?? "Hello", snippet: input.body ?? "Hello", internalDate: input.at, contentType: input.contentType, labels: input.sent ? ["SENT"] : ["INBOX", "UNREAD"], unread: !input.sent } });
  return id;
}
async function drainLabels(owner: EmailAccount, provider: EmulatedMailProvider) {
  let count = 0;
  while (await processNextReplyLabelSync({ prisma, resolveProvider: async (id) => {
    if (id !== owner.id) throw new Error("Wrong test account");
    return provider;
  } })) { if (++count > 10) throw new Error("Label worker did not drain"); }
}

describe("Reply Zero and digest", () => {
  it("tracks incoming question, outgoing reply, and recipient response with audited label changes", async () => {
    vi.stubEnv("LLM_PROVIDER", "emulator");
    const owner = await account();
    const provider = new EmulatedMailProvider(prisma, owner.id);
    await prisma.rule.create({ data: { emailAccountId: owner.id, name: "Questions", subject: "Question", actions: { create: { type: "TRACK_THREAD" } } } });
    const threadId = randomUUID();
    const incomingId = await mail(owner, { threadId, from: "alice@client.example", subject: "Question", at: new Date(Date.now() - 60_000) });
    const received = await runRules({ prisma, emailAccountId: owner.id, provider, message: await provider.getMessage(incomingId) });
    expect(received.execution?.status).toBe("APPLIED");
    expect(await prisma.threadTracker.count({ where: { emailAccountId: owner.id, threadId, type: "NEEDS_REPLY", resolved: false } })).toBe(1);
    const pending = await prisma.replyLabelSync.findFirstOrThrow({ where: { emailAccountId: owner.id, threadId }, include: { executedRule: { include: { actionItems: true } } } });
    expect(pending.executedRule.sourceMessageId).toBe(incomingId);
    expect(pending.executedRule.status).toBe("PENDING");
    expect(pending.executedRule.actionItems).toHaveLength(2);
    await drainLabels(owner, provider);
    expect((await provider.getMessage(incomingId)).labelIds).toContain("To Reply");
    const { messageId: sentId } = await provider.sendEmail({ threadId, to: "alice@client.example", subject: "Re: Question", body: "Here is the answer" });
    await runRules({ prisma, emailAccountId: owner.id, provider, message: await provider.getMessage(sentId) });
    const followUpAt = new Date(Date.now() - 10_000);
    await recordSentReply({ prisma, emailAccountId: owner.id, provider, messageId: sentId, followUpAt });
    expect(await prisma.threadTracker.count({ where: { emailAccountId: owner.id, threadId, type: "NEEDS_REPLY", resolved: false } })).toBe(0);
    expect(await prisma.threadTracker.count({ where: { emailAccountId: owner.id, threadId, type: "AWAITING_REPLY", resolved: false } })).toBe(1);
    await drainLabels(owner, provider);
    expect((await provider.getMessage(incomingId)).labelIds).not.toContain("To Reply");
    expect((await provider.getMessage(incomingId)).labelIds).toContain("Awaiting Reply");
    expect((await generateDigest({ prisma, emailAccountId: owner.id })).overdueAwaitingReply.count).toBe(1);
    const responseId = await mail(owner, { threadId, from: "alice@client.example", subject: "Thanks", at: new Date(Date.now() + 1_000) });
    await runRules({ prisma, emailAccountId: owner.id, provider, message: await provider.getMessage(responseId) });
    expect(await prisma.threadTracker.count({ where: { emailAccountId: owner.id, threadId, type: "AWAITING_REPLY", resolved: false } })).toBe(0);
    await drainLabels(owner, provider);
    expect((await provider.getMessage(incomingId)).labelIds).not.toContain("Awaiting Reply");
    const all = await prisma.replyTrackingEvent.count({ where: { emailAccountId: owner.id, threadId } });
    await runRules({ prisma, emailAccountId: owner.id, provider, message: await provider.getMessage(responseId) });
    expect(await prisma.replyTrackingEvent.count({ where: { emailAccountId: owner.id, threadId } })).toBe(all);
  });

  it("handles late notifications and does not resolve a reply when an unrelated participant speaks", async () => {
    const owner = await account();
    const provider = new EmulatedMailProvider(prisma, owner.id);
    const threadId = randomUUID();
    const start = Date.now() - 60_000;
    const inId = await mail(owner, { threadId, from: "alice@client.example", subject: "Question", at: new Date(start) });
    const sentId = await mail(owner, { threadId, from: owner.email, to: "alice@client.example", subject: "Re: Question", at: new Date(start + 1_000), sent: true });
    await recordSentReply({ prisma, provider, emailAccountId: owner.id, messageId: sentId });
    await recordIncomingMessage({ prisma, provider, emailAccountId: owner.id, messageId: inId, requiresReply: true });
    const otherId = await mail(owner, { threadId, from: "other@client.example", subject: "FYI", at: new Date(start + 2_000) });
    await recordIncomingMessage({ prisma, provider, emailAccountId: owner.id, messageId: otherId, requiresReply: false });
    expect(await prisma.threadTracker.count({ where: { emailAccountId: owner.id, threadId, type: "AWAITING_REPLY", resolved: false } })).toBe(1);
    expect(await prisma.threadTracker.count({ where: { emailAccountId: owner.id, threadId, type: "NEEDS_REPLY", resolved: false } })).toBe(0);
    const senderReply = await mail(owner, { threadId, from: "alice@client.example", subject: "Thanks", at: new Date(start + 3_000) });
    await recordIncomingMessage({ prisma, provider, emailAccountId: owner.id, messageId: senderReply, requiresReply: false });
    expect(await prisma.threadTracker.count({ where: { emailAccountId: owner.id, threadId, type: "AWAITING_REPLY", resolved: false } })).toBe(0);
  });

  it("rejects wrong-account providers and spoofed sent-message direction", async () => {
    const owner = await account(); const other = await account();
    const threadId = randomUUID();
    const id = await mail(owner, { threadId, from: "spoof@evil.example", to: "alice@client.example", subject: "spoof", at: new Date(), sent: true });
    await expect(recordSentReply({ prisma, emailAccountId: owner.id, provider: new EmulatedMailProvider(prisma, owner.id), messageId: id })).rejects.toThrow(/direction/);
    await expect(recordSentReply({ prisma, emailAccountId: owner.id, provider: new EmulatedMailProvider(prisma, other.id), messageId: id })).rejects.toThrow(/different account/);
  });

  it("keeps uncertain label changes audited and undoable without retrying the provider mutation", async () => {
    const owner = await account(); const provider = new EmulatedMailProvider(prisma, owner.id);
    const threadId = randomUUID();
    const id = await mail(owner, { threadId, from: "alice@client.example", subject: "Question", at: new Date() });
    const transition = await recordIncomingMessage({ prisma, provider, emailAccountId: owner.id, messageId: id, requiresReply: true });
    const original = provider.addLabel.bind(provider);
    const add = vi.spyOn(provider, "addLabel").mockImplementationOnce(async (...args) => { await original(...args); throw new Error("connection lost after mutation"); });
    expect(await processNextReplyLabelSync({ prisma, resolveProvider: async () => provider })).toBe(true);
    const sync = await prisma.replyLabelSync.findUniqueOrThrow({ where: { id: transition.labelSyncId! }, include: { executedRule: { include: { actionItems: true } } } });
    expect(sync.status).toBe("UNCERTAIN");
    expect(sync.executedRule.status).toBe("ERROR");
    expect((await provider.getMessage(id)).labelIds).toContain("To Reply");
    expect(await processNextReplyLabelSync({ prisma, resolveProvider: async () => provider })).toBe(false);
    expect(add).toHaveBeenCalledTimes(1);
    await undoExecutedRule({ prisma, provider, emailAccountId: owner.id, executedRuleId: sync.executedRuleId });
    expect((await provider.getMessage(id)).labelIds).not.toContain("To Reply");
  });

  it("counts per-account completed cold and newsletter actions in the requested period and cites email-derived invites", async () => {
    const owner = await account(); const other = await account();
    const now = new Date(); const start = new Date(now.getTime() - 60_000);
    const createExecution = async (selected: EmailAccount, stage: string, newsletter: boolean, at: Date, completed: boolean) => {
      const threadId = randomUUID();
      const id = await mail(selected, { threadId, from: "newsletter@outside.example", subject: "Update", at });
      const rule = newsletter ? await prisma.rule.create({ data: { emailAccountId: selected.id, name: randomUUID(), systemType: "NEWSLETTER" } }) : null;
      await prisma.executedRule.create({ data: { emailAccountId: selected.id, threadId, messageId: id, ruleId: rule?.id, status: "APPLIED", selectionMetadata: { stage }, actionItems: { create: { type: newsletter ? "ARCHIVE" : "LABEL", label: newsletter ? null : "Cold Emails", status: completed ? "COMPLETED" : "SKIPPED", executedAt: at } } } });
    };
    await createExecution(owner, "COLD", false, new Date(now.getTime() - 10_000), true);
    await createExecution(owner, "AI", true, new Date(now.getTime() - 9_000), true);
    await createExecution(owner, "AI", true, new Date(now.getTime() - 8_000), false);
    await createExecution(other, "COLD", false, new Date(now.getTime() - 7_000), true);
    await mail(owner, { threadId: randomUUID(), from: "calendar@outside.example", subject: "Project meeting", at: new Date(now.getTime() - 6_000), contentType: "text/calendar", body: "BEGIN:VCALENDAR\nSUMMARY:Project meeting" });
    const digest = await generateDigest({ prisma, emailAccountId: owner.id, now, windowStart: start, windowEnd: now });
    expect(digest.coldEmailsBlocked.count).toBe(1);
    expect(digest.newslettersAutoArchived.count).toBe(1);
    expect(digest.meetingBriefs).toHaveLength(1);
    expect(digest.meetingBriefs[0].source).toBe("email");
  });
});
