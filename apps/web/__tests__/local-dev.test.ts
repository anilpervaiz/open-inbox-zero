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
import { refreshSenderAnalytics } from "../utils/unsubscribe";
import { seedDemo } from "../scripts/local-dev";
import { authenticateUserApiKey, createUserApiKey, revokeUserApiKey } from "../utils/server/api-keys";

const execFileAsync = promisify(execFile);
const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port available");
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

test("seeds a real PostgreSQL database once without resetting user changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-inbox-zero-test-"));
  const port = await availablePort();
  const database = new EmbeddedPostgres({
    databaseDir: join(dir, "postgres"), user: "postgres", password: "temporary-test-password",
    port, persistent: true, authMethod: "scram-sha-256", postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
    autoRehydrateSymlinks: true, onLog: () => undefined,
  });
  let started = false;
  let prisma: PrismaClient | undefined;
  try {
    await database.initialise();
    await database.start();
    started = true;
    const url = `postgresql://postgres:temporary-test-password@127.0.0.1:${port}/postgres?schema=public`;
    await execFileAsync("pnpm", ["exec", "prisma", "db", "push", "--skip-generate"], {
      cwd: webDir, env: { ...process.env, DATABASE_URL: url }, timeout: 60_000,
    });
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await seedDemo(prisma);
    expect(await prisma.emailAccount.count()).toBe(2);
    const demo = await prisma.emailAccount.findUniqueOrThrow({ where: { id: "demo-gmail" } });
    const issued = await createUserApiKey(prisma, { userId: demo.userId, name: "Integration test" });
    const stored = await prisma.userApiKey.findUniqueOrThrow({ where: { id: issued.key.id } });
    expect(stored.keyHash).not.toContain(issued.token);
    expect(await authenticateUserApiKey(prisma, issued.token)).toEqual({ userId: demo.userId, keyId: issued.key.id });
    expect(await revokeUserApiKey(prisma, { userId: "other-user", keyId: issued.key.id })).toBe(false);
    expect(await revokeUserApiKey(prisma, { userId: demo.userId, keyId: issued.key.id })).toBe(true);
    expect(await authenticateUserApiKey(prisma, issued.token)).toBeNull();
    const mcpKey = await createUserApiKey(prisma, { userId: demo.userId, name: "MCP test" });
    vi.stubEnv("LOCAL_EMULATOR_MODE", "1"); vi.stubEnv("REDIS_URL", ""); vi.stubEnv("LLM_PROVIDER", "emulator");
    const client = prisma;
    vi.doMock("../utils/server/prisma", () => ({ prisma: client }));
    const { POST } = await import("../app/api/mcp/route");
    const call = async (method: string, params: unknown, token = mcpKey.token) => {
      const response = await POST(new Request("http://localhost/api/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
      expect(response.status).toBe(200);
      return response.json();
    };
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const data = await call("tools/call", { name, arguments: args });
      expect(data.result?.isError).not.toBe(true);
      return JSON.parse(data.result.content[0].text);
    };
    const initialized = await call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(initialized.result.serverInfo.name).toBe("open-inbox-zero");
    const listed = await call("tools/list", {});
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toHaveLength(6);
    const threads = await invoke("list_threads", { accountId: demo.id, tab: "all" });
    expect(threads.threads.length).toBeGreaterThan(0);
    const crossAccount = await call("tools/call", { name: "get_thread", arguments: { accountId: "demo-outlook", threadId: "proposal" } });
    expect(crossAccount.result.isError).toBe(true);
    const thread = await invoke("get_thread", { accountId: demo.id, threadId: "launch" });
    expect(thread.messages).toHaveLength(2);
    const draft = await invoke("create_reply_draft", { accountId: demo.id, threadId: "launch" });
    expect(draft.draftId).toBeTruthy();
    const run = await invoke("run_rules_on_thread", { accountId: demo.id, threadId: "demo-thread-07" });
    expect(run.execution.id).toBeTruthy();
    const undone = await invoke("undo_executed_rule", { accountId: demo.id, executionId: run.execution.id });
    expect(undone.status).toBe("REJECTED");
    await refreshSenderAnalytics(prisma, demo.id);
    const newsletter = await prisma.newsletter.findUniqueOrThrow({ where: { emailAccountId_fromEmail: { emailAccountId: demo.id, fromEmail: "hello@newsletter.example" } } });
    const unsubscribed = await invoke("unsubscribe_sender", { accountId: demo.id, newsletterId: newsletter.id, messageId: "demo-message-10", method: "one_click", userConfirmed: true });
    expect(unsubscribed).toMatchObject({ kind: "unsubscribed", simulated: true });
    expect((await POST(new Request("http://localhost/api/mcp", { method: "POST", headers: { authorization: "Bearer bad" } }))).status).toBe(401);
    await prisma.emailMessage.deleteMany({ where: { emailAccountId: demo.id, messageId: draft.draftId } });
    vi.doUnmock("../utils/server/prisma"); vi.unstubAllEnvs();
    expect(await prisma.rule.count()).toBe(12);
    expect(await prisma.knowledge.count()).toBe(6);
    expect(await prisma.replyMemory.count()).toBe(6);
    expect(await prisma.emailMessage.count()).toBe(25);
    await prisma.emailMessage.update({
      where: { emailAccountId_messageId: { emailAccountId: "demo-gmail", messageId: "demo-message-01" } },
      data: { archived: true },
    });
    await seedDemo(prisma);
    expect(await prisma.emailMessage.count()).toBe(25);
    expect((await prisma.emailMessage.findUniqueOrThrow({
      where: { emailAccountId_messageId: { emailAccountId: "demo-gmail", messageId: "demo-message-01" } },
    })).archived).toBe(true);
  } finally {
    await prisma?.$disconnect();
    if (started) await database.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
