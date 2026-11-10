import { PrismaClient } from "@prisma/client";
import EmbeddedPostgres from "embedded-postgres";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { ParsedMessage } from "../utils/mail-provider/types";
import { findMatchingGroup } from "../utils/group/find-matching-group";
import { getStaticMatchDetails, globToRegexSource, matchesPattern, matchesStaticRule } from "../utils/rule/email-from-pattern";
import { analyzeSenderPattern, recordLabelRemovalLearning } from "../utils/rule/ai-sender-pattern-learning";

const message: ParsedMessage = {
  id: "one", threadId: "one", internalDate: new Date(), snippet: "", labelIds: ["INBOX"],
  headers: { from: '"Alice" <billing@stripe.com>', to: "Demo <me@example.com>", subject: "Receipt for November", date: "2026-11-01" },
  textPlain: "Your card was charged $20.",
};
const emptyRule = { from: null, to: null, subject: null, body: null, conditionalOperator: "AND" as const };

describe("static and group matching", () => {
  it("matches wildcard mailbox domains, text substrings, regex and AND/OR conditions", () => {
    expect(globToRegexSource("billing+*@stripe.com")).toBe("billing\\+.*@stripe\\.com");
    expect(matchesStaticRule({ ...emptyRule, from: "*@stripe.com", subject: "receipt*", body: "/charged \\$[0-9]+/i" }, message)).toBe(true);
    expect(matchesStaticRule({ ...emptyRule, from: "billing@*", to: "other@example.com" }, message)).toBe(false);
    expect(matchesStaticRule({ ...emptyRule, from: "*" }, { ...message, headers: { ...message.headers, from: "" } })).toBe(false);
    expect(getStaticMatchDetails({ ...emptyRule, from: "*@stripe.com", subject: "missing", conditionalOperator: "OR" }, message)).toEqual({ matches: true, configuredFields: ["from", "subject"], matchedFields: ["from"] });
    expect(matchesStaticRule(emptyRule, message)).toBe(false);
    expect(matchesPattern("/(a+)+$/", `${"a".repeat(1000)}!`)).toBe(false);
    expect(() => matchesPattern("/(a)\\1/", "aa")).toThrow("Invalid or unsupported rule pattern");
  });
  it("gives exclusions priority over any matching USER or AI_LEARNED item", () => {
    const allow = { type: "FROM" as const, value: "*@stripe.com", exclude: false, source: "AI_LEARNED" as const };
    const exclude = { type: "FROM" as const, value: "billing@stripe.com", exclude: true, source: "USER" as const };
    expect(findMatchingGroup({ items: [allow] }, message)).toBe(true);
    expect(findMatchingGroup({ items: [allow, exclude] }, message)).toBe(false);
    expect(findMatchingGroup({ items: [exclude, allow] }, message)).toBe(false);
    expect(findMatchingGroup({ items: [{ type: "SUBJECT", value: "Receipt", exclude: false, source: "USER" }] }, message)).toBe(true);
  });
});

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port available");
  await new Promise<void>((yes, no) => server.close((error) => error ? no(error) : yes()));
  return address.port;
}

it("promotes two consistent persisted AI outcomes, unlearns corrections, and rejects conflicting classifications", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-inbox-zero-learning-"));
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
    const firstRule = await prisma.rule.create({ data: { id: "rule-1", name: "Invoices", emailAccountId: "account" } });
    const secondRule = await prisma.rule.create({ data: { id: "rule-2", name: "Other", emailAccountId: "account" } });
    for (const [sender, prefix] of [["invoices@acme.io", "good"], ["conflict@acme.io", "conflict"]]) {
      for (const n of [1, 2]) {
        const messageId = `${prefix}-${n}`;
        await prisma.emailMessage.create({ data: { emailAccountId: "account", threadId: messageId, messageId, fromEmail: sender, toEmail: "demo@example.com", subject: "Invoice", snippet: "Invoice", textBody: "Invoice", labels: ["INBOX"], internalDate: new Date() } });
        await prisma.executedRule.create({ data: { emailAccountId: "account", threadId: messageId, messageId, ruleId: prefix === "conflict" && n === 2 ? secondRule.id : firstRule.id, status: "APPLIED", selectionMetadata: { stage: "AI", ruleName: prefix === "conflict" && n === 2 ? "Other" : "Invoices" } } });
      }
    }
    const input = { emailAccountId: "account", fromEmail: "Invoices@Acme.io", ruleId: firstRule.id };
    expect(await analyzeSenderPattern(prisma, input)).toBe(true);
    const learned = await prisma.groupItem.findFirstOrThrow({ where: { source: "AI_LEARNED" } });
    expect(learned).toMatchObject({ type: "FROM", value: "invoices@acme.io", exclude: false });
    const learnedGroup = await prisma.group.findUniqueOrThrow({ where: { id: learned.groupId }, include: { items: true } });
    expect(findMatchingGroup(learnedGroup, { ...message, headers: { ...message.headers, from: "Invoices@Acme.io" } })).toBe(true);
    expect(await analyzeSenderPattern(prisma, { ...input, fromEmail: "conflict@acme.io" })).toBe(false);
    await recordLabelRemovalLearning(prisma, { emailAccountId: "account", fromEmail: input.fromEmail, subject: "Invoice", wrongRuleId: firstRule.id, correctRuleId: secondRule.id });
    expect(await prisma.groupItem.count({ where: { source: "AI_LEARNED" } })).toBe(0);
    expect(await prisma.classificationFeedback.findFirstOrThrow()).toMatchObject({ fromEmail: "invoices@acme.io", wrongRuleId: firstRule.id, correctRuleId: secondRule.id });
    expect(await analyzeSenderPattern(prisma, input)).toBe(false);
  } finally {
    await prisma?.$disconnect();
    if (started) await database.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
