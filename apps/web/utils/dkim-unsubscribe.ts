import { Resolver } from "node:dns/promises";
import { dkimVerify } from "mailauth";
import type { EmailProvider, ParsedMessage } from "./mail-provider/types";
import { senderAddress } from "./rule/static-from-risk";

const MAX_RAW_BYTES = 25_000_000;
const MAX_HEADER_BYTES = 256_000;
type TxtResolver = (name: string, rrtype: string) => Promise<string[][] | string[]>;

function normalized(value: string): string {
  return value.replace(/\r\n[ \t]+/g, " ").replace(/[ \t]+/g, " ").trim();
}
function rawFields(raw: Uint8Array): Map<string, string[]> {
  if (!raw.length || raw.length > MAX_RAW_BYTES) throw new Error("Invalid raw message size");
  const bytes = Buffer.from(raw);
  const boundary = bytes.indexOf("\r\n\r\n");
  if (boundary < 0 || boundary > MAX_HEADER_BYTES) throw new Error("Invalid raw message headers");
  const lines = bytes.subarray(0, boundary).toString("latin1").split("\r\n");
  const fields: { name: string; value: string }[] = [];
  for (const line of lines) {
    if (/[\r\n\0]/.test(line)) throw new Error("Invalid raw message headers");
    if (/^[ \t]/.test(line)) {
      if (!fields.length) throw new Error("Invalid folded header");
      fields[fields.length - 1].value += ` ${line.trim()}`;
      continue;
    }
    const match = /^([A-Za-z0-9-]+):(.*)$/.exec(line);
    if (!match) throw new Error("Invalid raw message header");
    fields.push({ name: match[1].toLowerCase(), value: match[2] });
  }
  const result = new Map<string, string[]>();
  for (const field of fields) result.set(field.name, [...(result.get(field.name) ?? []), normalized(field.value)]);
  return result;
}

/** Verify DKIM against raw MIME, and bind the unique signed unsubscribe headers to the parsed message. */
export async function verifyRawUnsubscribeDkim(input: { raw: Uint8Array; message: ParsedMessage; resolver?: TxtResolver }): Promise<{ valid: boolean; signedHeaders: string[] }> {
  const fields = rawFields(input.raw);
  if ((fields.get("dkim-signature")?.length ?? 0) > 10) return { valid: false, signedHeaders: [] };
  const required = ["from", "list-unsubscribe", "list-unsubscribe-post"] as const;
  if (required.some((name) => fields.get(name)?.length !== 1)) return { valid: false, signedHeaders: [] };
  const from = senderAddress(input.message.headers.from);
  if (!from || senderAddress(fields.get("from")![0]) !== from || fields.get("list-unsubscribe")![0] !== normalized(input.message.headers.listUnsubscribe ?? "") || fields.get("list-unsubscribe-post")![0] !== normalized(input.message.headers.listUnsubscribePost ?? "")) return { valid: false, signedHeaders: [] };
  const dns = new Resolver();
  const timer = setTimeout(() => dns.cancel(), 10_000);
  try {
    const resolver: TxtResolver = input.resolver ?? ((name, rrtype) => {
      if (rrtype !== "TXT") throw new Error("Unsupported DKIM DNS query");
      return dns.resolveTxt(name);
    });
    const verification = await dkimVerify(Buffer.from(input.raw), { strict: true, resolver });
    if (verification.fromFields !== 1 || verification.fromSyntax !== "valid" || verification.headerFrom.length !== 1 || verification.headerFrom[0].toLowerCase() !== from) return { valid: false, signedHeaders: [] };
    const fromDomain = from.split("@")[1];
    for (const result of verification.results) {
      const domain = result.signingDomain?.toLowerCase().replace(/\.$/, "");
      if (result.status.result !== "pass" || !domain || !(domain === fromDomain || domain.endsWith(`.${fromDomain}`))) continue;
      const signed = new Map<string, string[]>();
      for (const header of result.signingHeaders?.headers ?? []) {
        const colon = header.indexOf(":");
        if (colon < 1) continue;
        const name = header.slice(0, colon).toLowerCase();
        signed.set(name, [...(signed.get(name) ?? []), normalized(header.slice(colon + 1))]);
      }
      if (required.every((name) => signed.get(name)?.length === 1 && signed.get(name)![0] === fields.get(name)![0])) return { valid: true, signedHeaders: [...required] };
    }
    return { valid: false, signedHeaders: [] };
  } finally { clearTimeout(timer); }
}

/** Only raw bytes fetched for the selected account/message are trusted; Authentication-Results is ignored. */
export async function verifyProviderUnsubscribeDkim(input: { provider: EmailProvider; message: ParsedMessage }): Promise<{ valid: boolean; signedHeaders: string[] }> {
  const raw = await input.provider.getRawMessage(input.message.id);
  return verifyRawUnsubscribeDkim({ raw, message: input.message });
}
