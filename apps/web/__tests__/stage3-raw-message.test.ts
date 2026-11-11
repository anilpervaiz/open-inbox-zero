import type { gmail_v1 } from "@googleapis/gmail";
import type { PrismaClient } from "@prisma/client";
import { expect, test, vi } from "vitest";
import { GmailProvider } from "../utils/mail-provider/gmail-provider";
import { OutlookProvider } from "../utils/mail-provider/outlook-provider";
import { EmulatedMailProvider } from "../utils/mail-provider/emulated-provider";

test("Gmail returns exact raw MIME bytes and bounds the encoded response", async () => {
  const bytes = Buffer.from("From: sender@example.test\r\nDKIM-Signature: value\r\n\r\nexact\r\n");
  let id = "message";
  let raw = bytes.toString("base64url");
  const get = vi.fn(async () => ({ data: { id, raw } }));
  const provider = new GmailProvider({ users: { messages: { get } } } as unknown as gmail_v1.Gmail, "account");
  expect(Buffer.from(await provider.getRawMessage("message"))).toEqual(bytes);
  expect(get).toHaveBeenCalledWith(expect.objectContaining({ id: "message", userId: "me", format: "raw" }), expect.objectContaining({ maxContentLength: expect.any(Number) }));
  id = "different";
  await expect(provider.getRawMessage("message")).rejects.toThrow("unavailable");
  id = "message"; raw = "bad%data";
  await expect(provider.getRawMessage("message")).rejects.toThrow("unavailable");
});

test("Outlook streams exact MIME, rejects oversize responses, and sanitizes fetch failures", async () => {
  const bytes = new Uint8Array([0, 13, 10, 255, 12, 7]);
  let mode: "ok" | "header" | "stream" | "failure" = "ok";
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input; void init;
    if (mode === "failure") throw new Error("secret-token");
    if (mode === "header") return new Response(bytes, { headers: { "content-length": "25000001" } });
    if (mode === "stream") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(25_000_001)); controller.close(); } }));
    return new Response(bytes);
  });
  const provider = new OutlookProvider(async () => "secret-token", "account", fetchMock as typeof fetch);
  expect([...await provider.getRawMessage("message")]).toEqual([...bytes]);
  expect(String(fetchMock.mock.calls[0][0])).toBe("https://graph.microsoft.com/v1.0/me/messages/message/$value");
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error", headers: { Authorization: "Bearer secret-token" } });
  mode = "header"; await expect(provider.getRawMessage("message")).rejects.toThrow("too large");
  mode = "stream"; await expect(provider.getRawMessage("message")).rejects.toThrow("too large");
  mode = "failure"; await expect(provider.getRawMessage("message")).rejects.toThrow("Microsoft Graph request failed");
});

test("the synthetic emulator never claims authenticated raw MIME", async () => {
  const provider = new EmulatedMailProvider({} as PrismaClient, "account");
  await expect(provider.getRawMessage("message")).rejects.toThrow("does not have authenticated raw MIME");
});
