import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { decryptToken, encryptToken } from '../encryption';

const mailboxSecret = z.object({
  version: z.literal(1), accountId: z.string().min(1), userId: z.string().min(1),
  email: z.string().email().max(320), password: z.string().min(1).max(1024),
}).strict();

/** Caller must have independently authenticated the owner before calling. */
export async function saveSelfHostedCredential(input: { prisma: PrismaClient; userId: string; accountId: string; password: string }) {
  const { prisma, userId, accountId, password } = input;
  if (!userId || !accountId || !password || password.length > 1024) throw new Error('Invalid mailbox credentials');
  return prisma.$transaction(async tx => {
    const account = await tx.emailAccount.findFirst({ where: { id: accountId, userId, provider: 'selfhosted' }, select: { id: true, userId: true, email: true } });
    if (!account) throw new Error('Mailbox unavailable');
    const payload = mailboxSecret.parse({ version: 1, accountId: account.id, userId: account.userId, email: account.email, password });
    const encryptedSecret = encryptToken(JSON.stringify(payload));
    await tx.selfHostedCredential.upsert({ where: { emailAccountId: account.id }, create: { emailAccountId: account.id, encryptedSecret }, update: { encryptedSecret } });
  });
}

/** Decrypt only after ownership lookup; never include a password in an error. */
export async function getSelfHostedCredential(input: { prisma: PrismaClient; userId: string; accountId: string }): Promise<{ username: string; password: string }> {
  const account = await input.prisma.emailAccount.findFirst({ where: { id: input.accountId, userId: input.userId, provider: 'selfhosted' }, select: { id: true, userId: true, email: true, selfHostedCredential: { select: { encryptedSecret: true } } } });
  if (!account?.selfHostedCredential) throw new Error('Mailbox unavailable');
  try {
    const payload = mailboxSecret.parse(JSON.parse(decryptToken(account.selfHostedCredential.encryptedSecret)));
    if (payload.accountId !== account.id || payload.userId !== account.userId || payload.email !== account.email) throw new Error('Credential binding mismatch');
    return { username: payload.email, password: payload.password };
  } catch { throw new Error('Mailbox credentials unavailable'); }
}
