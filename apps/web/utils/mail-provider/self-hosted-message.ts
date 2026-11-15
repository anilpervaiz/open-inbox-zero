import type { PrismaClient } from '@prisma/client';
import { parseRawEmail } from '../../../../packages/mail-core/src/raw-email';
import { sanitizeEmailHtml } from '../../../../packages/mail-ui/src/index';
import { fetchSelfHostedRawMessage } from './self-hosted-imap';
import type { ParsedMessage } from './types';

type MailboxOwner = { prisma: PrismaClient; userId: string; accountId: string };

/** List cached threads without crossing the signed-in owner's mailbox boundary. */
export async function listSelfHostedCachedThreads(input: MailboxOwner & { query?: string; labelIds?: string[]; maxResults?: number }): Promise<string[]> {
  const limit = input.maxResults ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 500) throw new Error('Invalid thread limit');
  if (!limit) return [];
  const query = input.query?.trim();
  const rows = await input.prisma.emailMessage.findMany({
    where: {
      emailAccountId: input.accountId, emailAccount: { userId: input.userId, provider: 'selfhosted' },
      ...(input.labelIds?.length ? { labels: { hasEvery: input.labelIds } } : {}),
      ...(query ? { OR: [{ fromEmail: { contains: query, mode: 'insensitive' } }, { toEmail: { contains: query, mode: 'insensitive' } }, { subject: { contains: query, mode: 'insensitive' } }, { textBody: { contains: query, mode: 'insensitive' } }] } : {}),
    },
    distinct: ['threadId'], orderBy: { internalDate: 'desc' }, take: limit, select: { threadId: true },
  });
  return rows.map(row => row.threadId);
}

/** Read every cached message in a thread, never returning a partial thread on failure. */
export async function readSelfHostedThread(input: MailboxOwner & { threadId: string }): Promise<{ id: string; messages: ParsedMessage[] }> {
  const rows = await input.prisma.emailMessage.findMany({
    where: { emailAccountId: input.accountId, threadId: input.threadId, emailAccount: { userId: input.userId, provider: 'selfhosted' } },
    orderBy: { internalDate: 'asc' }, select: { messageId: true },
  });
  if (!rows.length) throw new Error('Mailbox thread unavailable');
  const messages: ParsedMessage[] = [];
  for (const row of rows) {
    const message = await readSelfHostedMessage({ ...input, messageId: row.messageId });
    if (message.threadId !== input.threadId) throw new Error('Mailbox thread changed');
    messages.push(message);
  }
  return { id: input.threadId, messages };
}

/** Read an owned message from the server and normalize its untrusted MIME. */
export async function readSelfHostedMessage(input: { prisma: PrismaClient; userId: string; accountId: string; messageId: string }): Promise<ParsedMessage> {
  const row = await input.prisma.emailMessage.findFirst({
    where: { emailAccountId: input.accountId, messageId: input.messageId, emailAccount: { userId: input.userId, provider: 'selfhosted' } },
    select: { threadId: true, internalDate: true, labels: true },
  });
  if (!row) throw new Error('Mailbox message unavailable');
  const raw = await fetchSelfHostedRawMessage(input);
  const parsed = await parseRawEmail(raw);
  return {
    id: input.messageId, threadId: row.threadId, internalDate: row.internalDate, labelIds: row.labels,
    snippet: parsed.text.slice(0, 240),
    headers: { from: parsed.from, to: parsed.to, subject: parsed.subject, date: (parsed.date ?? row.internalDate).toISOString(), ...(parsed.cc ? { cc: parsed.cc } : {}), ...(parsed.messageId ? { messageId: parsed.messageId } : {}), ...(parsed.inReplyTo ? { inReplyTo: parsed.inReplyTo } : {}), ...(parsed.references ? { references: parsed.references } : {}) },
    textPlain: parsed.text, ...(parsed.html ? { textHtml: sanitizeEmailHtml(parsed.html) } : {}),
    mimeTypes: parsed.attachments.map(item => item.contentType), attachmentNames: parsed.attachments.map(item => item.name).filter(Boolean), hasAttachments: parsed.attachments.length > 0,
  };
}
