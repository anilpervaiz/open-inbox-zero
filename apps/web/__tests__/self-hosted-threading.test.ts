import type { PrismaClient } from '@prisma/client';
import { expect, it, vi } from 'vitest';
import { resolveSelfHostedThreadId } from '../utils/mail-provider/self-hosted-threading';

it('links unambiguous references only within the owned mailbox', async () => {
  const findMany = vi.fn(async () => [{ threadId: 'existing-thread' }, { threadId: 'existing-thread' }]);
  const prisma = { emailMessage: { findMany } } as unknown as PrismaClient;
  const result = await resolveSelfHostedThreadId({ prisma, userId: 'owner', accountId: 'account', inReplyTo: '<parent@example.test>', references: '<root@example.test> <parent@example.test>' });
  expect(result).toBe('existing-thread');
  expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { emailAccountId: 'account', emailAccount: { userId: 'owner', provider: 'selfhosted' }, headerMessageId: { in: ['<parent@example.test>', '<root@example.test>'] } } }));
});

it('fails closed for conflicting references and creates fresh opaque IDs for new threads', async () => {
  const findMany = vi.fn(async () => [{ threadId: 'one' }, { threadId: 'two' }]);
  const prisma = { emailMessage: { findMany } } as unknown as PrismaClient;
  await expect(resolveSelfHostedThreadId({ prisma, userId: 'owner', accountId: 'account', inReplyTo: '<ambiguous@example.test>' })).rejects.toThrow('Ambiguous');
  const first = await resolveSelfHostedThreadId({ prisma, userId: 'owner', accountId: 'account' });
  const second = await resolveSelfHostedThreadId({ prisma, userId: 'owner', accountId: 'account' });
  expect(first).toMatch(/^imap-thread-/);
  expect(first).not.toBe(second);
});
