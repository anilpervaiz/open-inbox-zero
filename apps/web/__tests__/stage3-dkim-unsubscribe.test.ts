import { generateKeyPairSync } from "node:crypto";
import { dkimSign } from "mailauth";
import { describe, expect, it } from "vitest";
import type { ParsedMessage } from "../utils/mail-provider/types";
import { verifyRawUnsubscribeDkim } from "../utils/dkim-unsubscribe";

const base = "From: Sender <newsletter@example.com>\r\nTo: user@example.net\r\nSubject: News\r\nList-Unsubscribe: <https://lists.example.com/leave?token=123>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\r\nHello.\r\n";
const message: ParsedMessage = { id: "one", threadId: "thread", snippet: "", internalDate: new Date(), labelIds: [], headers: { from: "Sender <newsletter@example.com>", to: "user@example.net", subject: "News", date: "", listUnsubscribe: "<https://lists.example.com/leave?token=123>", listUnsubscribePost: "List-Unsubscribe=One-Click" }, textPlain: "Hello." };

async function fixture(options: { headers?: string[]; domain?: string } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const result = await dkimSign(base, { strict: true, headerList: options.headers ?? ["From", "List-Unsubscribe", "List-Unsubscribe-Post"], signatureData: [{ signingDomain: options.domain ?? "example.com", selector: "unit", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) }] });
  if (!result.signatures) throw new Error("Could not sign test fixture");
  const key = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const resolver = async (name: string, type: string) => {
    if (name !== `unit._domainkey.${options.domain ?? "example.com"}` || type !== "TXT") throw new Error("Unknown DNS record");
    return [[`v=DKIM1; k=rsa; p=${key}`]];
  };
  return { raw: Buffer.from(result.signatures + base), resolver };
}

describe("cryptographic one-click verification", () => {
  it("accepts only a passing aligned signature covering both exact unsubscribe headers", async () => {
    const { raw, resolver } = await fixture();
    expect(await verifyRawUnsubscribeDkim({ raw, message, resolver })).toEqual({ valid: true, signedHeaders: ["from", "list-unsubscribe", "list-unsubscribe-post"] });
    const modified = Buffer.from(raw.toString().replace("token=123", "token=456"));
    expect((await verifyRawUnsubscribeDkim({ raw: modified, message: { ...message, headers: { ...message.headers, listUnsubscribe: "<https://lists.example.com/leave?token=456>" } }, resolver })).valid).toBe(false);
    expect((await verifyRawUnsubscribeDkim({ raw, message: { ...message, headers: { ...message.headers, listUnsubscribe: "<https://attacker.example/leave>" } }, resolver })).valid).toBe(false);
  });
  it("rejects duplicate header ambiguity even if a genuine signature verifies", async () => {
    const { raw, resolver } = await fixture();
    const duplicate = Buffer.from(raw.toString().replace("From: Sender", "List-Unsubscribe: <https://attacker.example/leave>\r\nFrom: Sender"));
    expect((await verifyRawUnsubscribeDkim({ raw: duplicate, message, resolver })).valid).toBe(false);
    const duplicateFrom = Buffer.from(raw.toString().replace("From: Sender", "From: attacker@example.com\r\nFrom: Sender"));
    expect((await verifyRawUnsubscribeDkim({ raw: duplicateFrom, message, resolver })).valid).toBe(false);
  });
  it("rejects missing coverage and unrelated signing domains", async () => {
    const partial = await fixture({ headers: ["From", "List-Unsubscribe"] });
    expect((await verifyRawUnsubscribeDkim({ ...partial, message })).valid).toBe(false);
    const unrelated = await fixture({ domain: "attacker.example" });
    expect((await verifyRawUnsubscribeDkim({ ...unrelated, message })).valid).toBe(false);
  });
});
