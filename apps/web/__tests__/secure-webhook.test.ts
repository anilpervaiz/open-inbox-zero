import dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import https, { type RequestOptions } from "node:https";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeWebhook, isPublicAddress } from "../utils/secure-webhook";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function fakeRequest(status: number, inspect?: (options: RequestOptions, body: string) => void, responseBody = "ok") {
  return vi.spyOn(https, "request").mockImplementation(((...args: unknown[]) => {
    const options = args[1] as RequestOptions;
    const callback = args[2] as (response: PassThrough & { statusCode: number }) => void;
    const request = new EventEmitter() as EventEmitter & { end(body: string): void };
    request.end = (body: string) => {
      inspect?.(options, body);
      const response = new PassThrough() as PassThrough & { statusCode: number };
      response.statusCode = status;
      process.nextTick(() => { callback(response); if (status >= 200 && status < 300) response.end(responseBody); });
    };
    return request;
  }) as typeof https.request);
}

describe("secure outbound webhook", () => {
  it.each([
    "127.0.0.1", "10.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1",
    "0.0.0.0", "192.0.2.1", "198.18.0.1", "224.0.0.1", "240.0.0.1", "::1", "fc00::1", "fe80::1",
    "::ffff:127.0.0.1", "64:ff9b::a00:1", "2001:db8::1", "2002:7f00:1::1", "::2",
  ])("rejects non-public IP %s", (address) => expect(isPublicAddress(address)).toBe(false));

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("accepts a global unicast IP %s", (address) => expect(isPublicAddress(address)).toBe(true));

  it.each([
    "http://example.com/hook", "https://127.0.0.1/hook", "https://169.254.169.254/hook", "https://[::1]/hook",
    "https://localhost/hook", "https://private.localhost/hook", "file:///etc/passwd", "javascript:alert(1)", "https://user:secret@example.com/", "https://example.com/#fragment",
  ])("rejects unsafe destination %s without making a request", async (url) => {
    const request = fakeRequest(200);
    await expect(executeWebhook({ url, payload: { event: "test" } })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects mixed public/private DNS answers before opening a connection", async () => {
    vi.spyOn(dns, "lookup").mockImplementation((async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.1.2.3", family: 4 }]) as unknown as typeof dns.lookup);
    const request = fakeRequest(200);
    await expect(executeWebhook({ url: "https://hook.example/receive", payload: { event: "test" } })).rejects.toThrow(/not public/);
    expect(request).not.toHaveBeenCalled();
  });

  it("pins the validated DNS address for the request, preserving TLS hostname", async () => {
    const lookup = vi.spyOn(dns, "lookup").mockImplementation((async () => [{ address: "8.8.8.8", family: 4 }]) as unknown as typeof dns.lookup);
    const request = fakeRequest(200, (options, body) => {
      expect(options.family).toBe(4);
      expect(options.agent).toBe(false);
      expect(JSON.parse(body)).toEqual({ event: "rule.executed", messageId: "m1" });
      const pinned = options.lookup;
      expect(pinned).toBeDefined();
      pinned!("hook.example", {}, (error, address, family) => {
        expect(error).toBeNull();
        expect(address).toBe("8.8.8.8");
        expect(family).toBe(4);
      });
    });
    await executeWebhook({ url: "https://hook.example/receive", payload: { event: "rule.executed", messageId: "m1" } });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0][0])).toBe("https://hook.example/receive");
  });

  it("rejects redirects without following them", async () => {
    vi.spyOn(dns, "lookup").mockImplementation((async () => [{ address: "8.8.8.8", family: 4 }]) as unknown as typeof dns.lookup);
    const request = fakeRequest(302);
    await expect(executeWebhook({ url: "https://hook.example/redirect", payload: { event: "test" } })).rejects.toThrow(/HTTP 302/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized or unserializable payloads before DNS lookup", async () => {
    const lookup = vi.spyOn(dns, "lookup");
    await expect(executeWebhook({ url: "https://hook.example/", payload: "a".repeat(20_000) })).rejects.toThrow(/payload size/);
    await expect(executeWebhook({ url: "https://hook.example/", payload: { value: 1n } })).rejects.toThrow(/payload/);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("stops reading oversized responses", async () => {
    vi.spyOn(dns, "lookup").mockImplementation((async () => [{ address: "8.8.8.8", family: 4 }]) as unknown as typeof dns.lookup);
    fakeRequest(200, undefined, "x".repeat(65_537));
    await expect(executeWebhook({ url: "https://hook.example/", payload: { event: "test" } })).rejects.toThrow(/response failed/);
  });

  it("times out when DNS never resolves", async () => {
    vi.useFakeTimers();
    vi.spyOn(dns, "lookup").mockImplementation((() => new Promise(() => undefined)) as typeof dns.lookup);
    const operation = executeWebhook({ url: "https://hook.example/", payload: { event: "test" } });
    const result = expect(operation).rejects.toThrow(/could not be resolved/);
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
  });
});
