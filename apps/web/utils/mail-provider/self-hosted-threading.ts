import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

/** Resolve only unambiguous, already-cached references inside the owner's mailbox. */
export async function resolveSelfHostedThreadId(input: {
  prisma: PrismaClient; userId: string; accountId: string; inReplyTo?: string; references?: string;
}): Promise<string> {
  const headers = [input.inReplyTo ?? '', input.references ?? ''];
  if (headers.some(value => value.length > 16_384)) throw new Error('Message references are too large');
  const references = [...new Set(headers.flatMap(value => value.match(/<[^<>\s]{1,998}>/g) ?? []))];
  if (references.length > 100) throw new Error('Too many message references');
  if (!references.length) return `imap-thread-${randomUUID()}`;
  const rows = await input.prisma.emailMessage.findMany({
    where: { emailAccountId: input.accountId, emailAccount: { userId: input.userId, provider: 'selfhosted' }, headerMessageId: { in: references } },
    select: { threadId: true }, take: 101,
  });
  if (rows.length > 100) throw new Error('Ambiguous message references');
  const threads = new Set(rows.map(row => row.threadId));
  if (threads.size > 1) throw new Error('Ambiguous message references');
  return threads.values().next().value ?? `imap-thread-${randomUUID()}`;
}
