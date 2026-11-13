import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterEach, expect, it, vi } from 'vitest';
import { getSelfHostedCredential, saveSelfHostedCredential } from '../utils/mail-provider/self-hosted-credentials';

afterEach(() => vi.unstubAllEnvs());

it('encrypts mailbox secrets, scopes access to the owner, and rejects credential substitution', async () => {
  vi.stubEnv('TOKEN_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  const accounts = [{ id: 'one', userId: 'alice', email: 'alice@example.test', provider: 'selfhosted' }, { id: 'two', userId: 'bob', email: 'bob@example.test', provider: 'selfhosted' }];
  const secrets = new Map<string, string>();
  const db = {
    emailAccount: { findFirst: async ({ where }: { where: { id: string; userId: string; provider: string } }) => {
      const account = accounts.find(item => item.id === where.id && item.userId === where.userId && item.provider === where.provider);
      return account ? { ...account, selfHostedCredential: secrets.has(account.id) ? { encryptedSecret: secrets.get(account.id) } : null } : null;
    } },
    selfHostedCredential: { upsert: async ({ where, create }: { where: { emailAccountId: string }; create: { encryptedSecret: string } }) => { secrets.set(where.emailAccountId, create.encryptedSecret); } },
  };
  const prisma = { ...db, $transaction: async (work: (tx: typeof db) => unknown) => work(db) } as unknown as PrismaClient;
  await saveSelfHostedCredential({ prisma, userId: 'alice', accountId: 'one', password: 'private password' });
  const first = secrets.get('one')!;
  expect(first).not.toContain('private password');
  expect(await getSelfHostedCredential({ prisma, userId: 'alice', accountId: 'one' })).toEqual({ username: 'alice@example.test', password: 'private password' });
  await expect(getSelfHostedCredential({ prisma, userId: 'bob', accountId: 'one' })).rejects.toThrow('Mailbox unavailable');
  await expect(saveSelfHostedCredential({ prisma, userId: 'bob', accountId: 'one', password: 'replacement' })).rejects.toThrow('Mailbox unavailable');
  await saveSelfHostedCredential({ prisma, userId: 'alice', accountId: 'one', password: 'private password' });
  expect(secrets.get('one')).not.toBe(first);
  secrets.set('two', first);
  await expect(getSelfHostedCredential({ prisma, userId: 'bob', accountId: 'two' })).rejects.toThrow('Mailbox credentials unavailable');
  vi.stubEnv('TOKEN_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  await expect(getSelfHostedCredential({ prisma, userId: 'alice', accountId: 'one' })).rejects.toThrow('Mailbox credentials unavailable');
});
