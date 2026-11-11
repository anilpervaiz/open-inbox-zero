import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

type KeyStore = Pick<PrismaClient, 'userApiKey'>;
const digest = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
const tokenPattern = /^oiz_[0-9a-f]{64}$/;

/** The returned secret must be shown once; only its hash is persisted. */
export async function createUserApiKey(prisma: KeyStore, input: { userId: string; name: string; expiresAt?: Date }) {
  const name = input.name.trim();
  if (!input.userId || !name || name.length > 120) throw new Error('Invalid API key details');
  if (input.expiresAt && (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt.getTime() <= Date.now())) throw new Error('Invalid API key expiry');
  const token = `oiz_${randomBytes(32).toString('hex')}`;
  const key = await prisma.userApiKey.create({ data: { userId: input.userId, name, keyHash: digest(token), expiresAt: input.expiresAt }, select: { id: true, name: true, createdAt: true, expiresAt: true } });
  return { key, token };
}

/** Callers must separately check that the returned user owns the selected mailbox. */
export async function authenticateUserApiKey(prisma: KeyStore, token: string, now = new Date()): Promise<{ userId: string; keyId: string } | null> {
  if (!tokenPattern.test(token) || !Number.isFinite(now.getTime())) return null;
  const key = await prisma.userApiKey.findUnique({ where: { keyHash: digest(token) }, select: { id: true, userId: true, revokedAt: true, expiresAt: true } });
  if (!key || key.revokedAt || (key.expiresAt && key.expiresAt <= now)) return null;
  return { userId: key.userId, keyId: key.id };
}

export async function revokeUserApiKey(prisma: KeyStore, input: { userId: string; keyId: string }) {
  if (!input.userId || !input.keyId) throw new Error('Invalid API key details');
  const result = await prisma.userApiKey.updateMany({ where: { id: input.keyId, userId: input.userId, revokedAt: null }, data: { revokedAt: new Date() } });
  return result.count === 1;
}
