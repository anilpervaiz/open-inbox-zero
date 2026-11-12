import { PrismaClient } from "@prisma/client";
import EmbeddedPostgres from "embedded-postgres";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import { refreshSenderAnalytics } from "../utils/unsubscribe";
import { getProviderAccessToken } from "../utils/auth/provider-tokens";
import { encryptToken, decryptToken } from "../utils/encryption";
import { syncProviderJob } from "../utils/worker/provider-sync";
import { ensureMicrosoftSubscription } from "../utils/worker/provider-subscriptions";
import { EmulatedMailProvider } from "../utils/mail-provider/emulated-provider";
import { authConfiguration, createSessionAuth } from "../utils/auth/session-auth";
import * as sessionAuth from "../utils/auth/session-auth";
import { makeSignature, symmetricEncrypt } from "better-auth/crypto";
import { connectOAuthMailbox } from "../utils/auth/connect-mailbox";
import { prepareSafeOAuthIndex, seedDemo } from "../scripts/local-dev";
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
    await prisma.$executeRaw`DROP INDEX "EmailAccount_authAccountId_key"`;
    await prepareSafeOAuthIndex(prisma);
    const restoredIndex = await prisma.$queryRaw<{ present: boolean }[]>`SELECT to_regclass('"EmailAccount_authAccountId_key"') IS NOT NULL AS present`;
    expect(restoredIndex[0].present).toBe(true);
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
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 11).toString("base64"));
    const remote = await prisma.emailAccount.create({ data: { userId: demo.userId, email: "remote@example.test", provider: "microsoft", encryptedRefreshToken: encryptToken("old-refresh") } });
    const fetchToken = vi.fn(async () => Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, token_type: "Bearer" }));
    const refreshInput = { prisma, emailAccountId: remote.id, requestFetch: fetchToken as unknown as typeof fetch, env: { MICROSOFT_CLIENT_ID: "client", MICROSOFT_CLIENT_SECRET: "secret" } };
    expect(await Promise.all([getProviderAccessToken(refreshInput), getProviderAccessToken(refreshInput)])).toEqual(["new-access", "new-access"]);
    expect(fetchToken).toHaveBeenCalledTimes(1);
    const refreshed = await prisma.emailAccount.findUniqueOrThrow({ where: { id: remote.id } });
    expect(decryptToken(refreshed.encryptedRefreshToken!)).toBe("new-refresh");
    expect(decryptToken(refreshed.encryptedAccessToken!)).toBe("new-access");
    let sentState = "";
    const subscribeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe("https://graph.microsoft.com/v1.0/subscriptions");
      const pending = await prisma!.providerSubscription.findFirstOrThrow({ where: { emailAccountId: remote.id, status: "PENDING" } });
      const payload = JSON.parse(String(init?.body)); sentState = payload.clientState;
      expect(pending.clientStateHash).toBe(createHash("sha256").update(sentState).digest("hex"));
      return Response.json({ id: "graph-subscription", expirationDateTime: new Date(Date.now() + 24 * 3600_000).toISOString() });
    });
    const subscriptionInput = { prisma, emailAccountId: remote.id, callbackBaseUrl: "https://inbox.example", requestFetch: subscribeFetch as typeof fetch };
    const subscription = await ensureMicrosoftSubscription(subscriptionInput);
    expect(subscription?.status).toBe("ACTIVE"); expect(subscription?.clientStateHash).not.toContain(sentState);
    expect((await ensureMicrosoftSubscription(subscriptionInput))?.id).toBe(subscription?.id);
    expect(subscribeFetch).toHaveBeenCalledTimes(1);
    await prisma.providerSubscription.delete({ where: { id: subscription!.id } });
    const failingFetch = vi.fn(async () => { throw new Error("provider failed"); });
    await expect(ensureMicrosoftSubscription({ ...subscriptionInput, requestFetch: failingFetch })).rejects.toThrow("requires reconciliation");
    expect(await prisma.providerSubscription.count({ where: { emailAccountId: remote.id, status: "UNCERTAIN" } })).toBe(1);
    await expect(ensureMicrosoftSubscription({ ...subscriptionInput, requestFetch: failingFetch })).rejects.toThrow("requires reconciliation");
    expect(failingFetch).toHaveBeenCalledTimes(1);
    await prisma.providerSubscription.deleteMany({ where: { emailAccountId: remote.id } });
    await prisma.emailAccount.update({ where: { id: remote.id }, data: { provider: "google", lastSyncedHistoryId: "100", coldEmailBlocker: "DISABLED" } });
    const fakeProvider = new EmulatedMailProvider(prisma, remote.id);
    Object.defineProperty(fakeProvider, "providerName", { value: "google" });
    const parsed = { id: "remote-message", threadId: "remote-thread", snippet: "Hello", internalDate: new Date(), labelIds: ["INBOX", "UNREAD"], headers: { from: "sender@example.test", to: remote.email, subject: "Hello", date: new Date().toISOString() }, textPlain: "Hello" };
    const oldMessage = { ...parsed, id: "old-message", threadId: "old-thread" };
    vi.spyOn(fakeProvider, "listThreads").mockResolvedValue({ threadIds: [oldMessage.threadId] });
    vi.spyOn(fakeProvider, "getThread").mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValue({ id: oldMessage.threadId, messages: [oldMessage] });
    const initialSync = { prisma, job: { provider: "bootstrap" as const, emailAccountId: remote.id }, resolveProvider: async () => fakeProvider };
    await expect(syncProviderJob(initialSync)).rejects.toThrow("temporary failure");
    expect((await prisma.emailAccount.findUniqueOrThrow({ where: { id: remote.id } })).initialSyncStatus).toBe("FAILED");
    await syncProviderJob(initialSync);
    expect((await prisma.emailAccount.findUniqueOrThrow({ where: { id: remote.id } })).initialSyncStatus).toBe("COMPLETED");
    expect(await prisma.emailMessage.findUnique({ where: { emailAccountId_messageId: { emailAccountId: remote.id, messageId: oldMessage.id } } })).not.toBeNull();
    await syncProviderJob({ prisma, job: { provider: "refresh", emailAccountId: remote.id, threadId: oldMessage.threadId }, resolveProvider: async () => fakeProvider });
    expect(await prisma.executedRule.count({ where: { emailAccountId: remote.id, messageId: oldMessage.id } })).toBe(0);
    const fetchMessage = vi.spyOn(fakeProvider, "getMessage").mockRejectedValueOnce(new Error("provider unavailable")).mockResolvedValue(parsed);
    const historyFetch = vi.fn(async () => Response.json({ historyId: "105", history: [{ messagesAdded: [{ message: { id: parsed.id } }] }] }));
    const syncInput = { prisma, job: { provider: "google" as const, emailAccountId: remote.id, historyId: "101" }, resolveProvider: async () => fakeProvider, requestFetch: historyFetch as unknown as typeof fetch };
    await expect(syncProviderJob(syncInput)).rejects.toThrow("provider unavailable");
    expect((await prisma.emailAccount.findUniqueOrThrow({ where: { id: remote.id } })).lastSyncedHistoryId).toBe("100");
    await syncProviderJob(syncInput);
    expect((await prisma.emailAccount.findUniqueOrThrow({ where: { id: remote.id } })).lastSyncedHistoryId).toBe("101");
    expect(await prisma.emailMessage.findUnique({ where: { emailAccountId_messageId: { emailAccountId: remote.id, messageId: parsed.id } } })).not.toBeNull();
    fetchMessage.mockRestore();
    await prisma.emailAccount.update({ where: { id: remote.id }, data: { provider: "microsoft" } });
    const outlookProvider = new EmulatedMailProvider(prisma, remote.id);
    Object.defineProperty(outlookProvider, "providerName", { value: "microsoft" });
    await syncProviderJob({ prisma, job: { provider: "microsoft", emailAccountId: remote.id, messageId: parsed.id, changeType: "deleted" }, resolveProvider: async () => outlookProvider });
    const moved = await prisma.emailMessage.findUniqueOrThrow({ where: { emailAccountId_messageId: { emailAccountId: remote.id, messageId: parsed.id } } });
    expect(moved.archived).toBe(true); expect(moved.labels).not.toContain("INBOX");
    await prisma.emailAccount.delete({ where: { id: remote.id } });
    vi.unstubAllEnvs();
    const sessionSecret = "local-session-test-secret-which-is-long-enough";
    const auth = createSessionAuth(authConfiguration({ BETTER_AUTH_SECRET: sessionSecret, BETTER_AUTH_URL: "http://localhost:3000", GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret" })!, prisma);
    const authSession = await prisma.authSession.create({ data: { id: "test-session", userId: demo.userId, token: "test-token", expiresAt: new Date(Date.now() + 60_000) } });
    const signed = `test-token.${await makeSignature("test-token", sessionSecret)}`;
    const session = await auth.api.getSession({ headers: new Headers({ cookie: `better-auth.session_token=${encodeURIComponent(signed)}` }) });
    expect(session?.user.id).toBe(demo.userId);
    vi.stubEnv("LOCAL_EMULATOR_MODE", "1"); vi.stubEnv("REDIS_URL", "");
    vi.spyOn(sessionAuth, "getSessionAuth").mockReturnValue(auth);
    const sessionMcp = await POST(new Request("http://localhost/api/mcp", { method: "POST", headers: { cookie: `better-auth.session_token=${encodeURIComponent(signed)}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }));
    expect(sessionMcp.status).toBe(200);
    expect((await sessionMcp.json()).result.tools).toHaveLength(6);
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    expect(await auth.api.getSession({ headers: new Headers({ cookie: "better-auth.session_token=forged" }) })).toBeNull();
    await prisma.authSession.delete({ where: { id: authSession.id } });
    const signIn = await auth.handler(new Request("http://localhost:3000/api/auth/sign-in/social", { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ provider: "google", callbackURL: "/" }) }));
    expect(signIn.status).toBe(200);
    const signInBody = await signIn.json();
    expect(new URL(signInBody.url).hostname).toBe("accounts.google.com");
    expect(new URL(signInBody.url).searchParams.get("scope")).toContain("https://www.googleapis.com/auth/gmail.modify");
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 11).toString("base64"));
    const authContext = await auth.$context;
    const oauthIdentity = await prisma.authAccount.create({ data: { id: "test-google-identity", accountId: "provider-subject", providerId: "google", userId: demo.userId, accessToken: await symmetricEncrypt({ key: authContext.secretConfig, data: "linked-access" }), accessTokenExpiresAt: new Date(Date.now() + 3600_000), refreshToken: await symmetricEncrypt({ key: authContext.secretConfig, data: "test-refresh" }), scope: "https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/gmail.compose,https://www.googleapis.com/auth/gmail.send" } });
    const profileFetch = vi.fn(async () => Response.json({ emailAddress: "Linked@Example.test" }));
    const connectInput = { prisma, userId: demo.userId, authAccountId: oauthIdentity.id, getAccessToken: async (accountId: string, userId: string) => (await auth.api.getAccessToken({ body: { accountId, userId } })).accessToken, requestFetch: profileFetch as unknown as typeof fetch };
    await expect(connectOAuthMailbox({ ...connectInput, userId: "another-user" })).rejects.toThrow("authorization is incomplete");
    expect(profileFetch).not.toHaveBeenCalled();
    const linkedMailbox = await connectOAuthMailbox(connectInput);
    expect(linkedMailbox.email).toBe("linked@example.test");
    expect((await connectOAuthMailbox(connectInput)).id).toBe(linkedMailbox.id);
    const linkedToken = await getProviderAccessToken({ prisma, emailAccountId: linkedMailbox.id, getOAuthToken: async (accountId, userId) => auth.api.getAccessToken({ body: { accountId, userId } }) });
    expect(linkedToken).toBe("linked-access");
    const linkedStored = await prisma.emailAccount.findUniqueOrThrow({ where: { id: linkedMailbox.id } });
    expect(decryptToken(linkedStored.encryptedAccessToken!)).toBe("linked-access");
    await prisma.emailAccount.delete({ where: { id: linkedMailbox.id } });
    await prisma.authAccount.delete({ where: { id: oauthIdentity.id } });
    vi.unstubAllEnvs();
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
