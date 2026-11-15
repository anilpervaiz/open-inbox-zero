import type { PrismaClient } from '@prisma/client';
import { expect, it, vi } from 'vitest';

const fetchRaw = vi.hoisted(() => vi.fn());
vi.mock('../utils/mail-provider/self-hosted-imap', () => ({ fetchSelfHostedRawMessage: fetchRaw }));
import { listSelfHostedCachedThreads, readSelfHostedMessage, readSelfHostedThread } from '../utils/mail-provider/self-hosted-message';

it('normalizes real MIME, sanitizes HTML, and scopes the message lookup to its owner', async () => {
  const raw = ['From: alice@example.test', 'To: bob@example.test', 'Subject: Hello', 'Message-ID: <id@example.test>', 'In-Reply-To: <earlier@example.test>', 'Content-Type: text/html; charset=utf-8', '', '<p>Hello</p><script>alert(1)</script><img src="https://tracker.example/x">'].join('\r\n');
  fetchRaw.mockResolvedValueOnce(Buffer.from(raw));
  const findFirst = vi.fn(async () => ({ threadId: 'thread', internalDate: new Date('2026-01-01T00:00:00Z'), labels: ['INBOX'] }));
  const prisma = { emailMessage: { findFirst } } as unknown as PrismaClient;
  const message = await readSelfHostedMessage({ prisma, userId: 'owner', accountId: 'mailbox', messageId: 'message' });
  expect(message).toMatchObject({ id: 'message', threadId: 'thread', headers: { from: 'alice@example.test', subject: 'Hello', messageId: '<id@example.test>', inReplyTo: '<earlier@example.test>' }, hasAttachments: false });
  expect(message.textHtml).toContain('<p>Hello</p>');
  expect(message.textHtml).not.toMatch(/script|tracker/);
  expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { emailAccountId: 'mailbox', messageId: 'message', emailAccount: { userId: 'owner', provider: 'selfhosted' } } }));
});

it('does not fetch content when the mailbox-scoped message does not exist', async () => {
  fetchRaw.mockClear();
  const prisma = { emailMessage: { findFirst: async () => null } } as unknown as PrismaClient;
  await expect(readSelfHostedMessage({ prisma, userId: 'intruder', accountId: 'mailbox', messageId: 'message' })).rejects.toThrow('Mailbox message unavailable');
  expect(fetchRaw).not.toHaveBeenCalled();
});

it('scopes cached thread listing and rejects invalid limits', async () => {
  const findMany = vi.fn(async () => [{ threadId: 'thread' }]);
  const prisma = { emailMessage: { findMany } } as unknown as PrismaClient;
  expect(await listSelfHostedCachedThreads({ prisma, userId: 'owner', accountId: 'mailbox', query: 'hello', labelIds: ['INBOX'], maxResults: 5 })).toEqual(['thread']);
  expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ emailAccountId: 'mailbox', emailAccount: { userId: 'owner', provider: 'selfhosted' }, labels: { hasEvery: ['INBOX'] } }), take: 5 }));
  await expect(listSelfHostedCachedThreads({ prisma, userId: 'owner', accountId: 'mailbox', maxResults: 501 })).rejects.toThrow('Invalid thread limit');
});

it('does not read a thread that is not owned by the caller', async () => {
  fetchRaw.mockClear();
  const findMany = vi.fn(async () => []);
  const prisma = { emailMessage: { findMany } } as unknown as PrismaClient;
  await expect(readSelfHostedThread({ prisma, userId: 'intruder', accountId: 'mailbox', threadId: 'thread' })).rejects.toThrow('Mailbox thread unavailable');
  expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { emailAccountId: 'mailbox', threadId: 'thread', emailAccount: { userId: 'intruder', provider: 'selfhosted' } } }));
  expect(fetchRaw).not.toHaveBeenCalled();
});
