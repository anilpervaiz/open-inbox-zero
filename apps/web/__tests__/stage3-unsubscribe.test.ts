import dns from "node:dns/promises";
import { Resolver } from "node:dns/promises";
import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import https, { type RequestOptions } from "node:https";
import { PassThrough } from "node:stream";
import { PrismaClient } from "@prisma/client";
import EmbeddedPostgres from "embedded-postgres";
import { dkimSign } from "mailauth";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoSeed } from "../scripts/seed-data";
import { EmulatedMailProvider } from "../utils/mail-provider/emulated-provider";
import type { EmailProvider, ParsedMessage } from "../utils/mail-provider/types";
import { parseUnsubscribeOptions, refreshSenderAnalytics, unsubscribeSender } from "../utils/unsubscribe";
import { executeOneClickPost } from "../utils/secure-webhook";

afterEach(() => { vi.restoreAllMocks(); });

describe("unsubscribe option parsing", () => {
  it("extracts a one-click URL, a safe mailto draft and explicit HTML links", () => {
    expect(parseUnsubscribeOptions({ listUnsubscribe: "<https://lists.example/unsub?id=1>, <mailto:leave@example.com?subject=Unsubscribe>", listUnsubscribePost: "List-Unsubscribe=One-Click", html: '<a href="https://lists.example/preferences">Unsubscribe</a><a href="javascript:alert(1)">Unsubscribe</a>' })).toEqual({
      oneClickUrl: "https://lists.example/unsub?id=1", mailto: { to: "leave@example.com", subject: "Unsubscribe", body: "Please unsubscribe me from this mailing list." }, manualLinks: ["https://lists.example/preferences"],
    });
  });
  it.each(["http://127.0.0.1:8080/unsub", "https://127.0.0.1/", "https://169.254.169.254/", "https://192.168.1.1/", "https://localhost/", "https://[::1]/", "file:///etc/passwd", "javascript:alert(1)", "https://user:pass@example.com/"])("rejects unsafe destination %s", (url) => {
    expect(parseUnsubscribeOptions({ listUnsubscribe: `<${url}>`, listUnsubscribePost: "List-Unsubscribe=One-Click", html: `<a href="${url}">Unsubscribe</a>` })).toEqual({ oneClickUrl: null, mailto: null, manualLinks: [] });
  });
  it("rejects header injection and requires the one-click marker", () => {
    expect(parseUnsubscribeOptions({ listUnsubscribe: "<mailto:leave@example.com?subject=Hi%0ABcc:attacker@example.com>" }).mailto).toBeNull();
    expect(parseUnsubscribeOptions({ listUnsubscribe: "<mailto:leave@example.com?bcc=attacker@example.com>" }).mailto).toBeNull();
    expect(parseUnsubscribeOptions({ listUnsubscribe: "<https://public.example/leave>" }).oneClickUrl).toBeNull();
    expect(parseUnsubscribeOptions({ listUnsubscribe: "<https://public.example/leave>, <https://127.0.0.1/leave>", listUnsubscribePost: "List-Unsubscribe=One-Click" }).oneClickUrl).toBeNull();
  });
});

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port available");
  await new Promise<void>((yes, no) => server.close((error) => error ? no(error) : yes()));
  return address.port;
}
function fakePost(status: number, inspect: (options: RequestOptions, body: string) => void) {
  return vi.spyOn(https, "request").mockImplementation(((...args: unknown[]) => {
    const options = args[1] as RequestOptions;
    const callback = args[2] as (response: PassThrough & { statusCode: number }) => void;
    const request = new EventEmitter() as EventEmitter & { end(body: string): void };
    request.end = (body: string) => {
      inspect(options, body);
      const response = new PassThrough() as PassThrough & { statusCode: number };
      response.statusCode = status;
      process.nextTick(() => { callback(response); if (status >= 200 && status < 300) response.end("ok"); });
    };
    return request;
  }) as typeof https.request);
}

it("blocks one-click POST before connection when DNS includes a private address", async () => {
  vi.spyOn(dns, "lookup").mockImplementation((async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]) as unknown as typeof dns.lookup);
  const request = fakePost(200, () => undefined);
  await expect(executeOneClickPost("https://lists.example/leave")).rejects.toThrow(/not public/);
  expect(request).not.toHaveBeenCalled();
});

it("uses verified headers and an SSRF-pinned form POST, preserves mailto drafts, and computes account-scoped sender analytics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-inbox-zero-unsubscribe-"));
  const port = await availablePort();
  const database = new EmbeddedPostgres({ databaseDir: join(dir, "postgres"), user: "postgres", password: "temporary-test-password", port, persistent: true, authMethod: "scram-sha-256", postgresFlags: ["-c", "listen_addresses=127.0.0.1"], autoRehydrateSymlinks: true, onLog: () => undefined });
  let started = false;
  let prisma: PrismaClient | undefined;
  try {
    await database.initialise(); await database.start(); started = true;
    const url = `postgresql://postgres:temporary-test-password@127.0.0.1:${port}/postgres?schema=public`;
    await promisify(execFile)("pnpm", ["exec", "prisma", "db", "push", "--skip-generate"], { cwd: webDir, env: { ...process.env, DATABASE_URL: url }, timeout: 60_000 });
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.user.create({ data: { id: "user", email: "owner@example.com", emailAccounts: { create: [{ id: "account", email: "demo@example.com", provider: "google" }, { id: "other", email: "other@example.com", provider: "google" }, { id: "demo-gmail", email: "developer@example.com", provider: "emulator" }] } } });
    const createMessage = (id: string, sender: string, header: string, post: string | null, account = "account") => ({ emailAccountId: account, threadId: id, messageId: id, fromEmail: sender, toEmail: account === "other" ? "other@example.com" : "demo@example.com", subject: "Newsletter", snippet: "news", textBody: "news", labels: ["INBOX"], listUnsubscribe: header, listUnsubscribePost: post, internalDate: new Date() });
    await prisma.emailMessage.createMany({ data: [
      createMessage("one", "newsletter@example.com", "<https://public.example/unsub?token=demo>", "List-Unsubscribe=One-Click"),
      { ...createMessage("two", "newsletter@example.com", "<mailto:leave@example.com?subject=Unsubscribe>", null), unread: false, archived: true },
      { ...createMessage("sent", "newsletter@example.com", "<https://public.example/unsub>", null), labels: ["SENT"] },
      createMessage("other", "newsletter@example.com", "<https://public.example/unsub>", null, "other"),
      createMessage("failure", "failure@example.com", "<https://public.example/fail>", "List-Unsubscribe=One-Click"),
    ] });
    await refreshSenderAnalytics(prisma, "account");
    await refreshSenderAnalytics(prisma, "account");
    const newsletter = await prisma.newsletter.findFirstOrThrow({ where: { emailAccountId: "account", fromEmail: "newsletter@example.com" } });
    expect(newsletter).toMatchObject({ messageCount: 2, readCount: 1, archivedCount: 1 });
    expect(await prisma.newsletter.count({ where: { emailAccountId: "account", fromEmail: "newsletter@example.com" } })).toBe(1);
    const getMessage = async (id: string): Promise<ParsedMessage> => {
      const item = await prisma!.emailMessage.findUniqueOrThrow({ where: { emailAccountId_messageId: { emailAccountId: "account", messageId: id } } });
      return { id: item.messageId, threadId: item.threadId, snippet: item.snippet, internalDate: item.internalDate, labelIds: item.labels, headers: { from: item.fromEmail, to: item.toEmail, subject: item.subject, date: item.internalDate.toISOString(), listUnsubscribe: item.listUnsubscribe ?? undefined, listUnsubscribePost: item.listUnsubscribePost ?? undefined }, textPlain: item.textBody };
    };
    const createDraft = vi.fn(async () => ({ draftId: "draft" }));
    const getRawMessage = vi.fn(async (id: string): Promise<Uint8Array> => Buffer.from(`From: newsletter@example.com\r\nX-Message: ${id}\r\n\r\nunsigned`));
    const provider = { providerName: "google", emailAccountId: "account", getMessage, getRawMessage, createDraft } as unknown as EmailProvider;
    const base = { prisma, provider, emailAccountId: "account", newsletterId: newsletter.id, messageId: "one", method: "one_click" as const, userConfirmed: true };
    await expect(unsubscribeSender({ ...base, userConfirmed: false })).rejects.toThrow(/consent/);
    await expect(unsubscribeSender({ ...base, method: "unexpected" as "one_click" })).rejects.toThrow(/Invalid unsubscribe method/);
    await expect(unsubscribeSender(base)).rejects.toThrow(/verified DKIM/);
    await expect(unsubscribeSender({ ...base, emailAccountId: "other" })).rejects.toThrow(/Provider does not belong/);
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rawFor = async (sender: string, header: string, headers = ["From", "List-Unsubscribe", "List-Unsubscribe-Post"]) => {
      const raw = `From: ${sender}\r\nTo: demo@example.com\r\nSubject: Newsletter\r\nList-Unsubscribe: ${header}\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\r\nnews\r\n`;
      const signed = await dkimSign(raw, { strict: true, headerList: headers, signatureData: [{ signingDomain: "example.com", selector: "unit", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) }] });
      return Buffer.from(signed.signatures + raw);
    };
    const signedOne = await rawFor("newsletter@example.com", "<https://public.example/unsub?token=demo>");
    const signedFailure = await rawFor("failure@example.com", "<https://public.example/fail>");
    getRawMessage.mockImplementation(async (id) => id === "one" ? signedOne : signedFailure);
    const publicKeyText = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    vi.spyOn(Resolver.prototype, "resolveTxt").mockResolvedValue([[`v=DKIM1; k=rsa; p=${publicKeyText}`]]);
    const signedPartial = await rawFor("newsletter@example.com", "<https://public.example/unsub?token=demo>", ["From", "List-Unsubscribe"]);
    getRawMessage.mockResolvedValueOnce(signedPartial);
    await expect(unsubscribeSender(base)).rejects.toThrow(/verified DKIM/);
    vi.spyOn(dns, "lookup").mockImplementation((async () => [{ address: "8.8.8.8", family: 4 }]) as unknown as typeof dns.lookup);
    const request = fakePost(200, (options, body) => {
      expect(body).toBe("List-Unsubscribe=One-Click");
      expect(options.headers).toMatchObject({ "content-type": "application/x-www-form-urlencoded" });
      expect(options.headers).not.toHaveProperty("authorization");
      expect(options.headers).not.toHaveProperty("cookie");
      options.lookup!("public.example", {}, (error, address) => { expect(error).toBeNull(); expect(address).toBe("8.8.8.8"); });
    });
    expect(await unsubscribeSender(base)).toEqual({ kind: "unsubscribed", simulated: false });
    expect((await prisma.newsletter.findUniqueOrThrow({ where: { id: newsletter.id } })).status).toBe("UNSUBSCRIBED");
    await unsubscribeSender(base);
    expect(request).toHaveBeenCalledTimes(1);
    const draft = await unsubscribeSender({ ...base, messageId: "two", method: "mailto" });
    expect(draft).toEqual({ kind: "draft_created", draftId: "draft" });
    expect(createDraft).toHaveBeenCalledWith({ to: "leave@example.com", subject: "Unsubscribe", body: "Please unsubscribe me from this mailing list." });
    request.mockRestore();
    fakePost(503, () => undefined);
    const failure = await prisma.newsletter.findFirstOrThrow({ where: { emailAccountId: "account", fromEmail: "failure@example.com" } });
    await expect(unsubscribeSender({ ...base, newsletterId: failure.id, messageId: "failure" })).rejects.toThrow(/HTTP 503/);
    expect((await prisma.newsletter.findUniqueOrThrow({ where: { id: failure.id } })).status).not.toBe("UNSUBSCRIBED");
    await expect(unsubscribeSender({ ...base, newsletterId: failure.id, messageId: "failure" })).rejects.toThrow(/reconciliation/);
    const synthetic = demoSeed.messages.find((item) => item.id === "demo-message-10")!;
    await prisma.emailMessage.create({ data: { emailAccountId: "demo-gmail", threadId: synthetic.threadId, messageId: synthetic.id, fromEmail: synthetic.fromEmail, toEmail: synthetic.toEmail, subject: synthetic.subject, snippet: synthetic.textBody, textBody: synthetic.textBody, labels: synthetic.labels, internalDate: new Date(synthetic.internalDate), listUnsubscribe: synthetic.listUnsubscribe, listUnsubscribePost: synthetic.listUnsubscribePost } });
    await refreshSenderAnalytics(prisma, "demo-gmail");
    const demoNewsletter = await prisma.newsletter.findFirstOrThrow({ where: { emailAccountId: "demo-gmail", fromEmail: synthetic.fromEmail } });
    const demoProvider = new EmulatedMailProvider(prisma, "demo-gmail");
    expect(await unsubscribeSender({ prisma, provider: demoProvider, emailAccountId: "demo-gmail", newsletterId: demoNewsletter.id, messageId: synthetic.id, method: "one_click", userConfirmed: true })).toEqual({ kind: "unsubscribed", simulated: true });
  } finally {
    await prisma?.$disconnect();
    if (started) await database.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
