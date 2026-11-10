import dns from "node:dns/promises";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";

const DEADLINE_MS = 10_000;
const MAX_PAYLOAD_BYTES = 16_384;
const MAX_RESPONSE_BYTES = 65_536;

type Address = { address: string; family: 4 | 6 };

/** Only globally routed unicast addresses are eligible for outbound webhooks. */
export function isPublicAddress(value: string): boolean {
  if (!ipaddr.isValid(value)) return false;
  const address = ipaddr.parse(value);
  if (address.range() !== "unicast") return false;
  // Restrict IPv6 to globally allocated unicast, excluding mapped, tunnel, and special ranges.
  if (address.kind() === "ipv6") return address.match(ipaddr.IPv6.parse("2000::"), 3);
  return true;
}

function parseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid webhook URL"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) throw new Error("Webhook URL must be HTTPS without credentials or a fragment");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) throw new Error("Webhook destination is not public");
  return url;
}

async function resolveTarget(url: URL, signal: AbortSignal): Promise<Address> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  let addresses: Address[];
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily as 4 | 6 }];
  } else {
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(new Error("Webhook request timed out"));
      else signal.addEventListener("abort", () => reject(new Error("Webhook request timed out")), { once: true });
    });
    try {
      const found = await Promise.race([dns.lookup(hostname, { all: true, verbatim: true }), aborted]);
      addresses = found.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
    } catch { throw new Error("Webhook destination could not be resolved"); }
  }
  if (!addresses.length || addresses.some(({ address, family }) => !isPublicAddress(address) || isIP(address) !== family)) throw new Error("Webhook destination is not public");
  return addresses[0];
}

/** Send one explicit webhook without following redirects or resolving its hostname again. */
export async function executeWebhook(input: { url: string; payload: unknown }): Promise<void> {
  const url = parseUrl(input.url);
  let body: string | undefined;
  try { body = JSON.stringify(input.payload); } catch { throw new Error("Invalid webhook payload"); }
  if (!body || Buffer.byteLength(body) > MAX_PAYLOAD_BYTES) throw new Error("Invalid webhook payload size");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  try {
    const target = await resolveTarget(url, controller.signal);
    const pinnedLookup: LookupFunction = (_hostname, _options, callback) => callback(null, target.address, target.family);
    await new Promise<void>((resolveRequest, reject) => {
      const request = https.request(url, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        lookup: pinnedLookup,
        family: target.family,
        agent: false,
        signal: controller.signal,
      }, (response) => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.destroy();
          reject(new Error(`Webhook returned HTTP ${status}`));
          return;
        }
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_RESPONSE_BYTES) response.destroy(new Error("Webhook response too large"));
        });
        response.once("end", resolveRequest);
        response.once("error", () => reject(new Error("Webhook response failed")));
        response.once("aborted", () => reject(new Error("Webhook response failed")));
        response.resume();
      });
      request.once("error", () => reject(new Error("Webhook request failed")));
      request.end(body);
    });
  } finally {
    clearTimeout(timer);
  }
}
