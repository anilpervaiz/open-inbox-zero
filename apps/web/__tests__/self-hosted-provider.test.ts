import { PrismaClient } from '@prisma/client';
import EmbeddedPostgres from 'embedded-postgres';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImapFlow } from 'imapflow';

vi.mock('../utils/mail-provider/self-hosted-credentials', () => ({
  getSelfHostedCredential: vi.fn(async () => ({ username: 'alice@example.test', password: 'secret-password' })),
}));

import { SelfHostedMailProvider } from '../utils/mail-provider/self-hosted-provider';

const exec = promisify(execFile);
const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
  return address.port;
}

describe('SelfHostedMailProvider', () => {
  let tempDir: string;
  let database: EmbeddedPostgres;
  let prisma: PrismaClient;
  let nextMoveUid = 500;
  let nextDraftUid = 600;

  const mockFolders = [
    { path: 'INBOX' },
    { path: 'Archive', specialUse: '\\Archive' },
    { path: 'Junk', specialUse: '\\Junk' },
    { path: 'Drafts', specialUse: '\\Drafts' },
    { path: 'Sent', specialUse: '\\Sent' },
  ];

  function createSimulatedClient() {
    let currentFolder = 'INBOX';
    const folderUidValidity: Record<string, bigint> = {
      INBOX: 100n,
      Archive: 200n,
      Junk: 300n,
      Drafts: 400n,
      Sent: 500n,
    };

    const client = {
      on: vi.fn(),
      connect: vi.fn(async () => {}),
      close: vi.fn(),
      mailbox: { uidValidity: 100n },
      list: vi.fn(async () => mockFolders),
      getMailboxLock: vi.fn(async (folder: string) => {
        currentFolder = folder;
        client.mailbox.uidValidity = folderUidValidity[folder] ?? 100n;
        return {
          release: vi.fn(() => {}),
        };
      }),
      fetchOne: vi.fn(async (uid: number) => {
        if (uid === 90) {
          return {
            uid,
            source: Buffer.from(
              'From: sender@example.test\r\n' +
              'To: alice@example.test\r\n' +
              'Subject: With file\r\n' +
              'Date: Mon, 1 Jan 2026 00:00:00 +0000\r\n' +
              'MIME-Version: 1.0\r\n' +
              'Content-Type: multipart/mixed; boundary="boundary42"\r\n\r\n' +
              '--boundary42\r\n' +
              'Content-Type: text/plain\r\n\r\n' +
              'Here is file\r\n' +
              '--boundary42\r\n' +
              'Content-Type: application/pdf; name="report.pdf"\r\n' +
              'Content-Disposition: attachment; filename="report.pdf"\r\n\r\n' +
              'PDFDATA\r\n' +
              '--boundary42--'
            ),
          };
        }
        return {
          uid,
          source: Buffer.from(
            `From: sender@example.test\r\nTo: alice@example.test\r\nSubject: Test Subject\r\nMessage-ID: <msg-${uid}@example.test>\r\nDate: Mon, 1 Jan 2026 00:00:00 +0000\r\n\r\nTest email body`
          ),
        };
      }),
      messageMove: vi.fn(async (uid: number, dest: string) => {
        const destUid = nextMoveUid++;
        return {
          path: currentFolder,
          destination: dest,
          uidValidity: folderUidValidity[dest] ?? 200n,
          uidMap: new Map([[uid, destUid]]),
        };
      }),
      messageFlagsAdd: vi.fn(async () => true),
      messageFlagsRemove: vi.fn(async () => true),
      messageDelete: vi.fn(async () => true),
      append: vi.fn(async (folder: string) => {
        const uid = nextDraftUid++;
        return {
          destination: folder,
          uidValidity: folderUidValidity[folder] ?? 400n,
          uid,
        };
      }),
      search: vi.fn(async () => [nextDraftUid]),
    };
    return client as unknown as ImapFlow;
  }

  const simulatedClientFactory = () => createSimulatedClient();

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'oiz-selfhosted-provider-test-'));
    const dbPort = await getAvailablePort();
    database = new EmbeddedPostgres({
      databaseDir: join(tempDir, 'postgres'),
      user: 'postgres',
      password: 'temporary-test-password',
      port: dbPort,
      persistent: true,
      authMethod: 'scram-sha-256',
      postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
      autoRehydrateSymlinks: true,
      onLog: () => undefined,
    });
    await database.initialise();
    await database.start();
    const url = `postgresql://postgres:temporary-test-password@127.0.0.1:${dbPort}/postgres?schema=public`;
    await exec('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate'], {
      cwd: webDir,
      env: { ...process.env, DATABASE_URL: url },
      timeout: 60_000,
    });
    prisma = new PrismaClient({ datasources: { db: { url } } });
  }, 90_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await database?.stop();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    await prisma.executedAction.deleteMany();
    await prisma.executedRule.deleteMany();
    await prisma.emailMessage.deleteMany();
    await prisma.emailAccount.deleteMany();
    await prisma.user.deleteMany();

    await prisma.user.create({
      data: {
        id: 'user-1',
        email: 'user1@example.test',
        emailAccounts: {
          create: [
            {
              id: 'account-selfhosted',
              email: 'alice@example.test',
              provider: 'selfhosted',
            },
            {
              id: 'account-other-user',
              email: 'other@example.test',
              provider: 'selfhosted',
            },
            {
              id: 'account-emulator',
              email: 'emu@example.test',
              provider: 'emulator',
            },
          ],
        },
      },
    });
  });

  it('validates provider constructor arguments and providerName', () => {
    expect(() => new SelfHostedMailProvider(prisma, '')).toThrow('Provider account ID is required');
    expect(() => new SelfHostedMailProvider(prisma, '   ')).toThrow('Provider account ID is required');
    const provider = new SelfHostedMailProvider(prisma, 'account-selfhosted');
    expect(provider.providerName).toBe('selfhosted');
    expect(provider.emailAccountId).toBe('account-selfhosted');
  });

  it('fails closed when the account does not exist or has a different provider', async () => {
    const wrongProvider = new SelfHostedMailProvider(prisma, 'account-emulator');
    await expect(wrongProvider.listThreads({})).rejects.toThrow('Self-hosted account not found');

    const missingProvider = new SelfHostedMailProvider(prisma, 'non-existent-account');
    await expect(missingProvider.listThreads({})).rejects.toThrow('Self-hosted account not found');
  });

  it('lists threads and iterates thread IDs with query and limit filters', async () => {
    const now = new Date();
    await prisma.emailMessage.createMany({
      data: [
        {
          emailAccountId: 'account-selfhosted',
          threadId: 'thread-1',
          messageId: 'msg-1',
          fromEmail: 'bob@example.test',
          toEmail: 'alice@example.test',
          subject: 'Alpha project update',
          snippet: 'Alpha status is good',
          textBody: 'Alpha status is good',
          internalDate: new Date(now.getTime() - 2000),
          labels: ['INBOX'],
          imapFolder: 'INBOX',
          imapUid: 101n,
          imapUidValidity: 100n,
        },
        {
          emailAccountId: 'account-selfhosted',
          threadId: 'thread-2',
          messageId: 'msg-2',
          fromEmail: 'carol@example.test',
          toEmail: 'alice@example.test',
          subject: 'Beta testing notice',
          snippet: 'Beta is ready',
          textBody: 'Beta is ready',
          internalDate: new Date(now.getTime() - 1000),
          labels: ['INBOX', 'IMPORTANT'],
          imapFolder: 'INBOX',
          imapUid: 102n,
          imapUidValidity: 100n,
        },
      ],
    });

    const provider = new SelfHostedMailProvider(prisma, 'account-selfhosted');
    const all = await provider.listThreads({});
    expect(all.threadIds).toHaveLength(2);

    const filtered = await provider.listThreads({ query: 'Alpha' });
    expect(filtered.threadIds).toEqual(['thread-1']);

    const labeled = await provider.listThreads({ labelIds: ['IMPORTANT'] });
    expect(labeled.threadIds).toEqual(['thread-2']);

    const iterated: string[] = [];
    for await (const id of provider.iterateThreadIds()) {
      iterated.push(id);
    }
    expect(iterated).toEqual(all.threadIds);

    // Streams past the interactive listThreads 100-thread default limit across batches.
    const bulkMessages = Array.from({ length: 205 }, (_, i) => ({
      emailAccountId: 'account-selfhosted',
      threadId: `bulk-thread-${i}`,
      messageId: `bulk-msg-${i}`,
      fromEmail: 'bob@example.test',
      toEmail: 'alice@example.test',
      subject: `Bulk ${i}`,
      snippet: 'Bulk',
      textBody: 'Bulk',
      internalDate: new Date(now.getTime() - (5000 + i * 10)),
      labels: ['INBOX'],
      imapFolder: 'INBOX',
      imapUid: BigInt(1000 + i),
      imapUidValidity: 100n,
    }));
    await prisma.emailMessage.createMany({ data: bulkMessages });
    const allStreamed: string[] = [];
    for await (const id of provider.iterateThreadIds()) {
      allStreamed.push(id);
    }
    expect(allStreamed).toHaveLength(207);
  });

  it('reads thread, message, raw message, and detects replies', async () => {
    await prisma.emailMessage.create({
      data: {
        emailAccountId: 'account-selfhosted',
        threadId: 'thread-reply',
        messageId: 'msg-reply',
        fromEmail: 'bob@example.test',
        toEmail: 'alice@example.test',
        subject: 'Re: Question',
        snippet: 'Here is the answer',
        textBody: 'Here is the answer',
        inReplyTo: '<orig@example.test>',
        references: '<orig@example.test>',
        internalDate: new Date(),
        labels: ['INBOX'],
        imapFolder: 'INBOX',
        imapUid: 42n,
        imapUidValidity: 100n,
      },
    });

    const provider = new SelfHostedMailProvider(prisma, 'account-selfhosted', {
      env: { SELF_HOSTED_IMAP_HOST: 'mail.example.test' },
      createClient: simulatedClientFactory,
    });

    const message = await provider.getMessage('msg-reply');
    expect(message.id).toBe('msg-reply');
    expect(message.headers.subject).toBe('Test Subject');
    expect(provider.isReplyInThread(message)).toBe(false);

    const thread = await provider.getThread('thread-reply');
    expect(thread.id).toBe('thread-reply');
    expect(thread.messages).toHaveLength(1);

    const raw = await provider.getRawMessage('msg-reply');
    expect(Buffer.from(raw).toString()).toContain('Test Subject');

    expect(
      provider.isReplyInThread({
        ...message,
        headers: { ...message.headers, inReplyTo: '<parent@test>' },
      })
    ).toBe(true);
  });

  it('captures undo snapshots safely without BigInt serialization failures', async () => {
    await prisma.emailMessage.create({
      data: {
        emailAccountId: 'account-selfhosted',
        threadId: 'thread-snap',
        messageId: 'msg-snap',
        fromEmail: 'sender@example.test',
        toEmail: 'alice@example.test',
        subject: 'Snapshot test',
        snippet: 'Snapshot',
        textBody: 'Snapshot',
        internalDate: new Date(),
        labels: ['INBOX', 'UNREAD'],
        imapFolder: 'INBOX',
        imapUid: 42n,
        imapUidValidity: 100n,
      },
    });

    const provider = new SelfHostedMailProvider(prisma, 'account-selfhosted');
    const snapshot = await provider.captureUndoSnapshot('thread-snap');

    expect(snapshot.provider).toBe('selfhosted');
    expect(snapshot.threadId).toBe('thread-snap');
    expect(Array.isArray(snapshot.messages)).toBe(true);
    const snapMsg = (snapshot.messages as Array<Record<string, unknown>>)[0];
    expect(typeof snapMsg.imapUid).toBe('string');
    expect(typeof snapMsg.imapUidValidity).toBe('string');
    expect(snapMsg.imapUid).toBe('42');
    expect(snapMsg.imapUidValidity).toBe('100');

    // BigInt serialization check: JSON.stringify must succeed without throwing TypeError: Do not know how to serialize a BigInt
    expect(() => JSON.stringify(snapshot)).not.toThrow();
  });

  it('rejects captureUndoSnapshot if message location is invalid or missing', async () => {
    await prisma.emailMessage.create({
      data: {
        emailAccountId: 'account-selfhosted',
        threadId: 'thread-invalid',
        messageId: 'msg-invalid',
        fromEmail: 'sender@example.test',
        toEmail: 'alice@example.test',
        subject: 'Invalid loc',
        snippet: 'Bad',
        textBody: 'Bad',
        internalDate: new Date(),
        labels: ['INBOX'],
        imapFolder: 'INBOX',
        imapUid: null,
        imapUidValidity: 100n,
      },
    });

    const provider = new SelfHostedMailProvider(prisma, 'account-selfhosted');
    await expect(provider.captureUndoSnapshot('thread-invalid')).rejects.toThrow('Mailbox message location unavailable');
  });

  it('performs archiveThread and tracks destination UID / validity in PostgreSQL', async () => {
    await prisma.emailMessage.create({
      data: {
        emailAccountId: 'account-selfhosted',
        threadId: 'thread-archive',
        messageId: 'msg-archive',
        fromEmail: 'sender@example.test',
        toEmail: 'alice@example.test',
        subject: 'Archive me',
        snippet: 'Archive',
        textBody: 'Archive',
        internalDate: new Date(),
        labels: ['INBOX'],
        imapFolder: 'INBOX',
        imapUid: 50n,
        imapUidValidity: 100n,
      },
    });

    const provider = new SelfHostedMailProvider(prisma, 'account-selfhosted', {
      env: { SELF_HOSTED_IMAP_HOST: 'mail.example.test' },
      createClient: simulatedClientFactory,
    });

    await provider.archiveThread('thread-archive');

    const updated = await prisma.emailMessage.findFirstOrThrow({
      where: { messageId: 'msg-archive' },
    });
    expect(updated.archived).toBe(true);
    expect(updated.labels).not.toContain('INBOX');
    expect(updated.imapFolder).toBe('Archive');
    expect(updated.imapUidValidity).toBe(200n);
    expect(updated.imapUid).toBeGreaterThan(0n);
  });

  it('performs markSpam and tracks moved message in Junk folder', async () => {
    await prisma.emailMessage.create({
      data: {
        emailAccountId: 'account-selfhosted',
        threadId: 'thread-spam',
        messageId: 'msg-spam',
        fromEmail: 'spammer@example.test',
        toEmail: 'alice@example.test',
        subject: 'Buy cheap watches',
        snippet: 'Watches',
        textBody: 'Watches',
        internalDate: new Date(),
        labels: ['INBOX'],
        imapFolder: 'INBOX',
        imapUid: 60n,
        imapUidValidity: 100n,
      },
    });

    const provider = new SelfHostedMailProvider(prisma, 'account-selfhosted', {
      env: { SELF_HOSTED_IMAP_HOST: 'mail.example.test' },
      createClient: simulatedClientFactory,
    });

    await provider.markSpam('thread-spam');

    const updated = await prisma.emailMessage.findFirstOrThrow({
      where: { messageId: 'msg-spam' },
    });
    expect(updated.archived).toBe(true);
    expect(updated.labels).toContain('SPAM');
    expect(updated.labels).not.toContain('INBOX');
    expect(updated.imapFolder).toBe('Junk');
    expect(updated.imapUidValidity).toBe(300n);
  });

  it('toggles read and unread flags via markRead', async () => {
    await prisma.emailMessage.create({
      data: {
        emailAccountId: 'account-selfhosted',
        threadId: 'thread-read',
        messageId: 'msg-read',
        fromEmail: 'sender@example.test',
        toEmail: 'alice@example.test',
        subject: 'Read me',
        snippet: 'Read',
        textBody: 'Read',
        internalDate: new Date(),
        labels: ['INBOX', 'UNREAD'],
        unread: true,
        imapFolder: 'INBOX',
        imapUid: 70n,
        imapUidValidity: 100n,
      },
    });

    const provider = new SelfHostedMailProvider(prisma, 'account-selfhosted', {
      env: { SELF_HOSTED_IMAP_HOST: 'mail.example.test' },
      createClient: simulatedClientFactory,
    });

    await provider.markRead('thread-read', true);
    let msg = await prisma.emailMessage.findFirstOrThrow({ where: { messageId: 'msg-read' } });
    expect(msg.unread).toBe(false);
    expect(msg.labels).not.toContain('UNREAD');

    await provider.markRead('thread-read', false);
    msg = await prisma.emailMessage.findFirstOrThrow({ where: { messageId: 'msg-read' } });
    expect(msg.unread).toBe(true);
    expect(msg.labels).toContain('UNREAD');
  });

  it('adds and removes valid labels and rejects invalid label names', async () => {
    await prisma.emailMessage.create({
      data: {
        emailAccountId: 'account-selfhosted',
        threadId: 'thread-label',
        messageId: 'msg-label',
        fromEmail: 'sender@example.test',
        toEmail: 'alice@example.test',
        subject: 'Label me',
        snippet: 'Label',
        textBody: 'Label',
        internalDate: new Date(),
        labels: ['INBOX'],
        imapFolder: 'INBOX',
        imapUid: 80n,
        imapUidValidity: 100n,
      },
    });

    const provider = new SelfHostedMailProvider(prisma, 'account-selfhosted', {
      env: { SELF_HOSTED_IMAP_HOST: 'mail.example.test' },
      createClient: simulatedClientFactory,
    });

    await expect(provider.addLabel('thread-label', 'label"with"quotes')).rejects.toThrow('Invalid label name');
    await expect(provider.addLabel('thread-label', 'label*wildcard')).rejects.toThrow('Invalid label name');
    await expect(provider.addLabel('thread-label', 'a'.repeat(65))).rejects.toThrow('Invalid label name');

    await provider.addLabel('thread-label', 'Project.Alpha-1');
    let msg = await prisma.emailMessage.findFirstOrThrow({ where: { messageId: 'msg-label' } });
    expect(msg.labels).toContain('Project.Alpha-1');

    await provider.addLabel('thread-label', 'Cold Emails');
    msg = await prisma.emailMessage.findFirstOrThrow({ where: { messageId: 'msg-label' } });
    expect(msg.labels).toContain('Cold Emails');

    await provider.removeLabel('thread-label', 'Project.Alpha-1');
    await provider.removeLabel('thread-label', 'Cold Emails');
    msg = await prisma.emailMessage.findFirstOrThrow({ where: { messageId: 'msg-label' } });
    expect(msg.labels).not.toContain('Project.Alpha-1');
    expect(msg.labels).not.toContain('Cold Emails');
  });

  it('creates and updates drafts and rejects recipient header injections', async () => {
    const provider = new SelfHostedMailProvider(prisma, 'account-selfhosted', {
      env: { SELF_HOSTED_IMAP_HOST: 'mail.example.test' },
      createClient: simulatedClientFactory,
    });

    await expect(
      provider.createDraft({
        to: 'victim@example.test\r\nBcc: evil@example.test',
        subject: 'Hello',
        body: 'Draft body',
      })
    ).rejects.toThrow('Invalid email recipient header');

    await expect(
      provider.createDraft({
        to: 'not-an-email',
        subject: 'Hello',
        body: 'Draft body',
      })
    ).rejects.toThrow('Invalid recipient address');

    const created = await provider.createDraft({
      to: 'bob@example.test',
      cc: 'carol@example.test',
      subject: 'Draft proposal',
      body: 'Proposal details',
    });
    expect(created.draftId).toBeDefined();

    const draftMsg = await prisma.emailMessage.findFirstOrThrow({
      where: { messageId: created.draftId },
    });
    expect(draftMsg.labels).toEqual(['DRAFT']);
    expect(draftMsg.imapFolder).toBe('Drafts');
    expect(draftMsg.imapUid).toBeGreaterThan(0n);
    expect(draftMsg.headerMessageId).toContain('@example.test');

    const updated = await provider.updateDraft({
      draftId: created.draftId,
      threadId: draftMsg.threadId,
      to: 'bob@example.test',
      subject: 'Updated proposal',
      body: 'Updated body',
    });
    expect(updated.draftId).toBe(created.draftId);

    const updatedMsg = await prisma.emailMessage.findFirstOrThrow({
      where: { messageId: created.draftId },
    });
    expect(updatedMsg.subject).toBe('Updated proposal');
    expect(updatedMsg.textBody).toBe('Updated body');
  });

  it('createForwardDraft throws on messages with attachments and succeeds on plain messages', async () => {
    await prisma.emailMessage.create({
      data: {
        emailAccountId: 'account-selfhosted',
        threadId: 'thread-fwd-att',
        messageId: 'msg-fwd-att',
        fromEmail: 'sender@example.test',
        toEmail: 'alice@example.test',
        subject: 'With file',
        snippet: 'Here is file',
        textBody: 'Here is file',
        attachmentNames: ['report.pdf'],
        internalDate: new Date(),
        labels: ['INBOX'],
        imapFolder: 'INBOX',
        imapUid: 90n,
        imapUidValidity: 100n,
      },
    });

    const provider = new SelfHostedMailProvider(prisma, 'account-selfhosted', {
      env: { SELF_HOSTED_IMAP_HOST: 'mail.example.test' },
      createClient: simulatedClientFactory,
    });

    await expect(
      provider.createForwardDraft({
        threadId: 'thread-fwd-att',
        messageId: 'msg-fwd-att',
        to: 'recipient@example.test',
      })
    ).rejects.toThrow('Forwarding attachments is not supported');

    await prisma.emailMessage.create({
      data: {
        emailAccountId: 'account-selfhosted',
        threadId: 'thread-fwd-plain',
        messageId: 'msg-fwd-plain',
        fromEmail: 'sender@example.test',
        toEmail: 'alice@example.test',
        subject: 'Plain message',
        snippet: 'Plain content',
        textBody: 'Plain content',
        internalDate: new Date(),
        labels: ['INBOX'],
        imapFolder: 'INBOX',
        imapUid: 91n,
        imapUidValidity: 100n,
      },
    });

    const forwardDraft = await provider.createForwardDraft({
      threadId: 'thread-fwd-plain',
      messageId: 'msg-fwd-plain',
      to: 'recipient@example.test',
      comment: 'FYI',
    });
    expect(forwardDraft.draftId).toBeDefined();
    expect(forwardDraft.draftThreadId).toBe('thread-fwd-plain');
  });

  it('restores archived thread via restoreArchive and snapshot', async () => {
    await prisma.emailMessage.create({
      data: {
        emailAccountId: 'account-selfhosted',
        threadId: 'thread-restore',
        messageId: 'msg-restore',
        fromEmail: 'sender@example.test',
        toEmail: 'alice@example.test',
        subject: 'Restore test',
        snippet: 'Content',
        textBody: 'Content',
        internalDate: new Date(),
        labels: ['INBOX'],
        archived: false,
        imapFolder: 'INBOX',
        imapUid: 92n,
        imapUidValidity: 100n,
      },
    });

    const provider = new SelfHostedMailProvider(prisma, 'account-selfhosted', {
      env: { SELF_HOSTED_IMAP_HOST: 'mail.example.test' },
      createClient: simulatedClientFactory,
    });

    const snapshot = await provider.captureUndoSnapshot('thread-restore');
    await provider.archiveThread('thread-restore');

    let msg = await prisma.emailMessage.findFirstOrThrow({ where: { messageId: 'msg-restore' } });
    expect(msg.archived).toBe(true);
    expect(msg.imapFolder).toBe('Archive');

    await provider.restoreArchive('thread-restore', snapshot);
    msg = await prisma.emailMessage.findFirstOrThrow({ where: { messageId: 'msg-restore' } });
    expect(msg.archived).toBe(false);
    expect(msg.labels).toContain('INBOX');
    expect(msg.imapFolder).toBe('INBOX');
  });

  it('undoAction reverses ARCHIVE, MARK_SPAM, LABEL, MARK_SEEN, and DRAFT_EMAIL with strict ownership checks', async () => {
    const provider = new SelfHostedMailProvider(prisma, 'account-selfhosted', {
      env: { SELF_HOSTED_IMAP_HOST: 'mail.example.test' },
      createClient: simulatedClientFactory,
    });

    await prisma.emailMessage.create({
      data: {
        emailAccountId: 'account-selfhosted',
        threadId: 'thread-undo',
        messageId: 'msg-undo',
        fromEmail: 'sender@example.test',
        toEmail: 'alice@example.test',
        subject: 'Undo target',
        snippet: 'Undo target',
        textBody: 'Undo target',
        internalDate: new Date(),
        labels: ['INBOX', 'UNREAD'],
        unread: true,
        archived: false,
        imapFolder: 'INBOX',
        imapUid: 93n,
        imapUidValidity: 100n,
      },
    });

    const rule = await prisma.rule.create({
      data: {
        emailAccountId: 'account-selfhosted',
        name: 'Undo Test Rule',
        actions: { create: [{ type: 'ARCHIVE' }] },
      },
    });

    const execRule = await prisma.executedRule.create({
      data: {
        emailAccountId: 'account-selfhosted',
        threadId: 'thread-undo',
        messageId: 'msg-undo',
        ruleId: rule.id,
      },
    });

    const snap = await provider.captureUndoSnapshot('thread-undo');

    // Test ARCHIVE undo
    await provider.archiveThread('thread-undo');
    const archiveAction = await prisma.executedAction.create({
      data: {
        executedRuleId: execRule.id,
        type: 'ARCHIVE',
        status: 'COMPLETED',
        undoSnapshot: snap,
      },
    });
    await provider.undoAction(archiveAction, 'thread-undo');
    let current = await prisma.emailMessage.findFirstOrThrow({ where: { messageId: 'msg-undo' } });
    expect(current.archived).toBe(false);
    expect(current.labels).toContain('INBOX');

    // Test MARK_SPAM undo
    await provider.markSpam('thread-undo');
    const spamAction = await prisma.executedAction.create({
      data: {
        executedRuleId: execRule.id,
        type: 'MARK_SPAM',
        status: 'COMPLETED',
        undoSnapshot: snap,
      },
    });
    await provider.undoAction(spamAction, 'thread-undo');
    current = await prisma.emailMessage.findFirstOrThrow({ where: { messageId: 'msg-undo' } });
    expect(current.labels).not.toContain('SPAM');
    expect(current.labels).toContain('INBOX');

    // Test LABEL undo
    await provider.addLabel('thread-undo', 'Tagged');
    const labelAction = await prisma.executedAction.create({
      data: {
        executedRuleId: execRule.id,
        type: 'LABEL',
        label: 'Tagged',
        status: 'COMPLETED',
        undoSnapshot: snap,
      },
    });
    await provider.undoAction(labelAction, 'thread-undo');
    current = await prisma.emailMessage.findFirstOrThrow({ where: { messageId: 'msg-undo' } });
    expect(current.labels).not.toContain('Tagged');

    // Test MARK_SEEN undo
    await provider.markRead('thread-undo', true);
    const seenAction = await prisma.executedAction.create({
      data: {
        executedRuleId: execRule.id,
        type: 'MARK_SEEN',
        status: 'COMPLETED',
        undoSnapshot: snap,
      },
    });
    await provider.undoAction(seenAction, 'thread-undo');
    current = await prisma.emailMessage.findFirstOrThrow({ where: { messageId: 'msg-undo' } });
    expect(current.unread).toBe(true);
    expect(current.labels).toContain('UNREAD');

    // Test DRAFT_EMAIL undo
    const draft = await provider.createDraft({
      threadId: 'thread-undo',
      to: 'bob@example.test',
      subject: 'Draft to delete',
      body: 'Will be deleted',
    });
    const draftAction = await prisma.executedAction.create({
      data: {
        executedRuleId: execRule.id,
        type: 'DRAFT_EMAIL',
        draftId: draft.draftId,
        draftThreadId: 'thread-undo',
        status: 'COMPLETED',
      },
    });
    await provider.undoAction(draftAction, 'thread-undo');
    const draftDeleted = await prisma.emailMessage.findFirst({
      where: { messageId: draft.draftId },
    });
    expect(draftDeleted).toBeNull();

    // Test cross-account undo rejection
    const otherProvider = new SelfHostedMailProvider(prisma, 'account-other-user');
    await expect(otherProvider.undoAction(archiveAction, 'thread-undo')).rejects.toThrow('Reversible action not found');
  });

  it('sendEmail and forwardEmail enforce pilot mode and disabled sending', async () => {
    const provider = new SelfHostedMailProvider(prisma, 'account-selfhosted');

    vi.stubEnv('PILOT_MODE', 'true');
    await expect(
      provider.sendEmail({
        to: 'bob@example.test',
        subject: 'Hello',
        body: 'Body',
      })
    ).rejects.toThrow('Automatic sending and forwarding are disabled in pilot mode');

    await expect(
      provider.forwardEmail({
        threadId: 't1',
        messageId: 'm1',
        to: 'bob@example.test',
      })
    ).rejects.toThrow('Automatic sending and forwarding are disabled in pilot mode');

    vi.stubEnv('PILOT_MODE', 'false');
    await expect(
      provider.sendEmail({
        to: 'bob@example.test',
        subject: 'Hello',
        body: 'Body',
      })
    ).rejects.toThrow('Self-hosted SMTP sending is not enabled');

    await expect(
      provider.forwardEmail({
        threadId: 't1',
        messageId: 'm1',
        to: 'bob@example.test',
      })
    ).rejects.toThrow('Self-hosted SMTP sending is not enabled');

    vi.unstubAllEnvs();
  });
});
