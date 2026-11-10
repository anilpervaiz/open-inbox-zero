import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Read a base64-encoded 32-byte key; never invent a key for persisted tokens. */
function getKey(): Buffer {
  const value = process.env.TOKEN_ENCRYPTION_KEY;
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}

/** AES-256-GCM encrypts a token using a fresh 96-bit nonce each time. */
export function encryptToken(token: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/** Reject malformed or altered payloads without returning unauthenticated plaintext. */
export function decryptToken(payload: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION || parts.slice(1).some((part) => !/^[A-Za-z0-9_-]*$/.test(part))) {
    throw new Error("Invalid encrypted token");
  }
  const [, ivValue, tagValue, ciphertextValue] = parts as [string, string, string, string];
  const iv = Buffer.from(ivValue, "base64url");
  const tag = Buffer.from(tagValue, "base64url");
  const ciphertext = Buffer.from(ciphertextValue, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || [iv, tag, ciphertext].some((part, index) => part.toString("base64url") !== parts[index + 1])) {
    throw new Error("Invalid encrypted token");
  }
  const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
