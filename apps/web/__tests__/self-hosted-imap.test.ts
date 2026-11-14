import type { PrismaClient } from '@prisma/client';
import type { ImapFlow } from 'imapflow';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';

const credential = vi.hoisted(() => vi.fn());
vi.mock('../utils/mail-provider/self-hosted-credentials', () => ({ getSelfHostedCredential: credential }));
import { listSelfHostedFolders, withSelfHostedImapClient } from '../utils/mail-provider/self-hosted-imap';

beforeEach(() => { credential.mockReset(); credential.mockResolvedValue({ username: 'alice@example.test', password: 'private-secret' }); });

it('uses owner-scoped credentials and verified TLS to list folders without exposing secrets', async () => {
  const client = { on: vi.fn(), connect: vi.fn(async () => {}), list: vi.fn(async () => [{ path: 'INBOX' }, { path: 'Sent', specialUse: '\\Sent' }]), close: vi.fn() };
  const createClient = vi.fn(() => client as unknown as ImapFlow);
  const prisma = {} as PrismaClient;
  const result = await listSelfHostedFolders({ prisma, userId: 'owner', accountId: 'mailbox', env: { SELF_HOSTED_IMAP_HOST: 'MAIL.EXAMPLE.TEST' }, createClient });
  expect(result).toEqual([{ path: 'INBOX', specialUse: null }, { path: 'Sent', specialUse: '\\Sent' }]);
  expect(credential).toHaveBeenCalledWith(expect.objectContaining({ prisma, userId: 'owner', accountId: 'mailbox' }));
  expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ host: 'mail.example.test', port: 993, secure: true, tls: { rejectUnauthorized: true }, logger: false, auth: { user: 'alice@example.test', pass: 'private-secret' } }));
  expect(client.close).toHaveBeenCalledOnce();
});

it('uses an operator-provided CA without disabling TLS verification and closes after operation failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oiz-imap-ca-'));
  try {
    const caPath = join(dir, 'ca.pem');
    const ca = '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n';
    await writeFile(caPath, ca);
    const client = { on: vi.fn(), connect: vi.fn(async () => {}), list: vi.fn(), close: vi.fn() };
    const createClient = vi.fn(() => client as unknown as ImapFlow);
    await expect(withSelfHostedImapClient({ prisma: {} as PrismaClient, userId: 'a', accountId: 'b', env: { SELF_HOSTED_IMAP_HOST: 'mail.example.test', SELF_HOSTED_TLS_CA_FILE: caPath }, createClient }, async () => { throw new Error('private-secret'); })).rejects.toThrow('Self-hosted mailbox connection failed');
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ tls: { rejectUnauthorized: true, ca: Buffer.from(ca) } }));
    expect(client.close).toHaveBeenCalledOnce();
    await expect(listSelfHostedFolders({ prisma: {} as PrismaClient, userId: 'a', accountId: 'b', env: { SELF_HOSTED_IMAP_HOST: 'mail.example.test', SELF_HOSTED_TLS_CA_FILE: join(dir, 'missing') }, createClient })).rejects.toThrow('CA is unavailable');
    expect(createClient).toHaveBeenCalledTimes(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('fails closed for invalid configuration, denied credentials, and provider errors', async () => {
  const prisma = {} as PrismaClient;
  const client = { on: vi.fn(), connect: vi.fn(async () => { throw new Error('private-secret'); }), list: vi.fn(), close: vi.fn() };
  const createClient = vi.fn(() => client as unknown as ImapFlow);
  await expect(listSelfHostedFolders({ prisma, userId: 'a', accountId: 'b', env: { SELF_HOSTED_IMAP_HOST: 'https://mail.example.test' }, createClient })).rejects.toThrow('not configured');
  expect(credential).not.toHaveBeenCalled();
  credential.mockRejectedValueOnce(new Error('Mailbox unavailable'));
  await expect(listSelfHostedFolders({ prisma, userId: 'a', accountId: 'b', env: { SELF_HOSTED_IMAP_HOST: 'mail.example.test' }, createClient })).rejects.toThrow('Mailbox unavailable');
  expect(createClient).not.toHaveBeenCalled();
  await expect(listSelfHostedFolders({ prisma, userId: 'a', accountId: 'b', env: { SELF_HOSTED_IMAP_HOST: 'mail.example.test' }, createClient })).rejects.toThrow('Self-hosted mailbox connection failed');
  expect(client.close).toHaveBeenCalledOnce();
});
