import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptToken, encryptToken } from "../utils/encryption";

describe("OAuth token encryption", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("round-trips Unicode tokens while using a different IV for each encryption", () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    const first = encryptToken("secret-🔐-token");
    const second = encryptToken("secret-🔐-token");
    expect(first).not.toEqual(second);
    expect(decryptToken(first)).toBe("secret-🔐-token");
    expect(decryptToken(second)).toBe("secret-🔐-token");
  });

  it("rejects tampering and decryption with a different key", () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    const payload = encryptToken("secret");
    const parts = payload.split(".");
    const ciphertext = Buffer.from(parts[3]!, "base64url");
    ciphertext[0] = ciphertext[0]! ^ 1;
    parts[3] = ciphertext.toString("base64url");
    expect(() => decryptToken(parts.join("."))).toThrow();
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    expect(() => decryptToken(payload)).toThrow();
  });

  it("fails closed for missing or malformed keys and payloads", () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", "too-short");
    expect(() => encryptToken("secret")).toThrow(/TOKEN_ENCRYPTION_KEY/);
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    expect(() => decryptToken("v1.bad.bad.bad")).toThrow(/Invalid encrypted token/);
    expect(() => decryptToken("v2.bad.bad.bad")).toThrow(/Invalid encrypted token/);
  });
});
