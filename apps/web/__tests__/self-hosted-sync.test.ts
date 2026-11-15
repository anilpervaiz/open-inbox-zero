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
import { parseSafeModSeq, syncSelfHostedAccount } from '../utils/worker/self-hosted-sync';
import { providerSyncJobSchema } from '../utils/worker/provider-sync-queue';
import { syncProviderJob } from '../utils/worker/provider-sync';
import { maintainProviderSubscriptions } from '../utils/worker/provider-maintenance';
import { GET as healthRoute } from '../app/api/health/route';
import * as selfHostedImap from '../utils/mail-provider/self-hosted-imap';

const execFileAsync = promisify(execFile);
const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let prisma: PrismaClient;

vi.mock('../utils/server/prisma', () => ({
  get prisma() {
    return prisma;
  },
}));

vi.mock('../utils/mail-provider/self-hosted-credentials', () => ({
  getSelfHostedCredential: vi.fn(async () => ({ username: 'alice@example.test', password: 'secret-password' })),
}));

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

type MockImapMessage = {
  uid: number;
  flags: Set<string>;
  internalDate: Date;
  source: Buffer;
};

type SimulatedMailbox = {
  uidValidity: bigint;
  highestModSeq?: bigint;
  messages: MockImapMessage[];
};

function makeMimeMessage(input: {
  from: string;
  to: string;
  subject: string;
  body: string;
  messageId: string;
  date?: string;
  inReplyTo?: string;
  references?: string;
}): Buffer {
  const dateStr = input.date ?? 'Mon, 1 Jan 2026 12:00:00 +0000';
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Date: ${dateStr}`,
    `Message-ID: ${input.messageId}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references ? [`References: ${input.references}`] : []),
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
  ];
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${input.body}`);
}

describe('self-hosted sync engine', () => {
  let tempDir: string;
  let database: EmbeddedPostgres;
  let savedDbUrl: string | undefined;
  const testUserId = 'test-sync-user';
  let accountId: string;

  beforeAll(async () => {
    savedDbUrl = process.env.DATABASE_URL;
    tempDir = await mkdtemp(join(tmpdir(), 'oiz-selfhosted-sync-test-'));
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

    const dbUrl = `postgresql://postgres:temporary-test-password@127.0.0.1:${dbPort}/postgres?schema=public`;
    process.env.DATABASE_URL = dbUrl;
    await execFileAsync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate'], {
      cwd: webDir,
      env: { ...process.env, DATABASE_URL: dbUrl },
      timeout: 60_000,
    });

    prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

    await prisma.user.create({
      data: { id: testUserId, name: 'Alice Sync', email: 'alice@example.test' },
    });

    const account = await prisma.emailAccount.create({
      data: {
        userId: testUserId,
        email: 'alice@example.test',
        provider: 'selfhosted',
      },
    });
    accountId = account.id;
  }, 120_000);

  afterAll(async () => {
    try {
      if (savedDbUrl !== undefined) process.env.DATABASE_URL = savedDbUrl;
      else delete process.env.DATABASE_URL;
      if (prisma) await prisma.$disconnect();
      if (database) await database.stop();
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  beforeEach(async () => {
    await prisma.threadExecutionLock.deleteMany({});
    await prisma.executedAction.deleteMany({});
    await prisma.executedRule.deleteMany({});
    await prisma.emailMessage.deleteMany({});
    await prisma.selfHostedFolderState.deleteMany({});
    await prisma.emailAccount.update({
      where: { id: accountId },
      data: { initialSyncStatus: 'NOT_STARTED' },
    });
  });

  function createSimulatedClient(
    mailboxes: Record<string, SimulatedMailbox>,
    options?: {
      failOnFetchUid?: number;
      onOpenChange?: (open: boolean) => void;
    }
  ) {
    let open = false;
    let currentFolder = 'INBOX';

    const mockFolders = [
      { path: 'INBOX', specialUse: null, flags: new Set(['\\HasNoChildren']) },
      { path: 'Archive', specialUse: '\\Archive', flags: new Set(['\\HasNoChildren']) },
      { path: 'Sent', specialUse: '\\Sent', flags: new Set(['\\HasNoChildren']) },
      { path: 'Drafts', specialUse: '\\Drafts', flags: new Set(['\\HasNoChildren']) },
      { path: 'Junk', specialUse: '\\Junk', flags: new Set(['\\HasNoChildren']) },
    ];

    const client = {
      get isOpen() {
        return open;
      },
      on: vi.fn(),
      connect: vi.fn(async () => {
        open = true;
        options?.onOpenChange?.(true);
      }),
      close: vi.fn(() => {
        open = false;
        options?.onOpenChange?.(false);
      }),
      list: vi.fn(async () => mockFolders),
      getMailboxLock: vi.fn(async (folder: string) => {
        currentFolder = folder;
        return {
          release: vi.fn(() => {}),
        };
      }),
      search: vi.fn(async () => {
        const mb = mailboxes[currentFolder];
        return (mb?.messages ?? []).map((m) => m.uid);
      }),
      fetchOne: vi.fn(async (uidStr: string | number) => {
        const uid = Number(uidStr);
        if (options?.failOnFetchUid && uid === options.failOnFetchUid) {
          throw new Error('Simulated network disconnect during message fetch');
        }
        const mb = mailboxes[currentFolder];
        const found = mb?.messages.find((m) => m.uid === uid);
        if (!found) return null;
        return {
          uid: found.uid,
          flags: found.flags,
          internalDate: found.internalDate,
          source: found.source,
        };
      }),
      get mailbox() {
        const mb = mailboxes[currentFolder] ?? { uidValidity: 100n, highestModSeq: 1n, messages: [] };
        return {
          uidValidity: mb.uidValidity,
          highestModSeq: mb.highestModSeq ?? 1n,
        };
      },
    };

    return client;
  }

  it('1. Bootstrap sync across folders sets initialSyncStatus = COMPLETED, records SelfHostedFolderState, zero runRules calls', async () => {
    const mailboxes: Record<string, SimulatedMailbox> = {
      INBOX: {
        uidValidity: 100n,
        highestModSeq: 5n,
        messages: [
          {
            uid: 1,
            flags: new Set(['\\Seen']),
            internalDate: new Date('2026-01-01T10:00:00Z'),
            source: makeMimeMessage({
              from: 'sender1@example.test',
              to: 'alice@example.test',
              subject: 'Inbox 1',
              body: 'Hello Inbox',
              messageId: '<inbox-1@example.test>',
            }),
          },
        ],
      },
      Archive: {
        uidValidity: 200n,
        highestModSeq: 2n,
        messages: [
          {
            uid: 10,
            flags: new Set(['\\Seen']),
            internalDate: new Date('2026-01-01T09:00:00Z'),
            source: makeMimeMessage({
              from: 'sender2@example.test',
              to: 'alice@example.test',
              subject: 'Archive 1',
              body: 'Old mail',
              messageId: '<archive-1@example.test>',
            }),
          },
        ],
      },
      Sent: { uidValidity: 300n, messages: [] },
      Drafts: { uidValidity: 400n, messages: [] },
      Junk: { uidValidity: 500n, messages: [] },
    };

    const client = createSimulatedClient(mailboxes);
    const runRulesFn = vi.fn(async () => {});

    await syncSelfHostedAccount({
      prisma,
      emailAccountId: accountId,
      mode: 'bootstrap',
      env: { SELF_HOSTED_IMAP_HOST: 'mail.example.test' },
      createClient: () => client as unknown as ImapFlow,
      runRulesFn,
    });

    const updatedAccount = await prisma.emailAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(updatedAccount.initialSyncStatus).toBe('COMPLETED');
    expect(runRulesFn).toHaveBeenCalledTimes(0);

    const states = await prisma.selfHostedFolderState.findMany({ where: { emailAccountId: accountId } });
    expect(states.length).toBeGreaterThanOrEqual(2);

    const inboxState = states.find((s) => s.folderPath === 'INBOX');
    expect(inboxState).toBeDefined();
    expect(inboxState?.uidValidity).toBe(100n);
    expect(inboxState?.lastSyncedUid).toBe(1n);

    const archiveState = states.find((s) => s.folderPath === 'Archive');
    expect(archiveState).toBeDefined();
    expect(archiveState?.uidValidity).toBe(200n);
    expect(archiveState?.lastSyncedUid).toBe(10n);

    const messages = await prisma.emailMessage.findMany({ where: { emailAccountId: accountId } });
    expect(messages).toHaveLength(2);
    expect(messages.find((m) => m.subject === 'Inbox 1')?.labels).toContain('INBOX');
    expect(messages.find((m) => m.subject === 'Archive 1')?.archived).toBe(true);
  });

  it('2. Incremental sync runs runRules only on genuinely new INBOX messages and closes scan IMAP connection before runRules starts', async () => {
    const mailboxes: Record<string, SimulatedMailbox> = {
      INBOX: {
        uidValidity: 100n,
        highestModSeq: 10n,
        messages: [
          {
            uid: 5,
            flags: new Set(),
            internalDate: new Date('2026-01-02T10:00:00Z'),
            source: makeMimeMessage({
              from: 'fresh@example.test',
              to: 'alice@example.test',
              subject: 'Fresh Incoming',
              body: 'Requires rule evaluation',
              messageId: '<fresh-1@example.test>',
            }),
          },
        ],
      },
      Archive: {
        uidValidity: 200n,
        messages: [
          {
            uid: 20,
            flags: new Set(['\\Seen']),
            internalDate: new Date('2026-01-02T08:00:00Z'),
            source: makeMimeMessage({
              from: 'newsletter@example.test',
              to: 'alice@example.test',
              subject: 'Archive Only',
              body: 'Directly in archive',
              messageId: '<archive-direct@example.test>',
            }),
          },
        ],
      },
      Sent: { uidValidity: 300n, messages: [] },
      Drafts: { uidValidity: 400n, messages: [] },
      Junk: { uidValidity: 500n, messages: [] },
    };

    let wasConnectionOpenDuringRules: boolean | null = null;
    const client = createSimulatedClient(mailboxes);

    const runRulesFn = vi.fn(async () => {
      wasConnectionOpenDuringRules = client.isOpen;
    });

    await syncSelfHostedAccount({
      prisma,
      emailAccountId: accountId,
      mode: 'incremental',
      env: { SELF_HOSTED_IMAP_HOST: 'mail.example.test' },
      createClient: () => client as unknown as ImapFlow,
      runRulesFn,
    });

    expect(runRulesFn).toHaveBeenCalledTimes(1);
    expect(wasConnectionOpenDuringRules).toBe(false);
    expect(client.close).toHaveBeenCalled();

    const messages = await prisma.emailMessage.findMany({ where: { emailAccountId: accountId } });
    expect(messages).toHaveLength(2);
    expect(messages.find((m) => m.subject === 'Fresh Incoming')?.labels).toContain('INBOX');
  });

  it('3. INBOX -> Archive folder move reconciliation updates EmailMessage folder/UID in place with zero duplicate rows and zero duplicate runRules', async () => {
    const rawMime = makeMimeMessage({
      from: 'partner@example.test',
      to: 'alice@example.test',
      subject: 'Agreement Doc',
      body: 'Review this contract please',
      messageId: '<contract-99@example.test>',
    });

    const mailboxes: Record<string, SimulatedMailbox> = {
      INBOX: {
        uidValidity: 100n,
        messages: [{ uid: 1, flags: new Set(['\\Seen']), internalDate: new Date(), source: rawMime }],
      },
      Archive: { uidValidity: 200n, messages: [] },
      Sent: { uidValidity: 300n, messages: [] },
      Drafts: { uidValidity: 400n, messages: [] },
      Junk: { uidValidity: 500n, messages: [] },
    };

    const client1 = createSimulatedClient(mailboxes);
    await syncSelfHostedAccount({
      prisma,
      emailAccountId: accountId,
      mode: 'bootstrap',
      env: { SELF_HOSTED_IMAP_HOST: 'mail.example.test' },
      createClient: () => client1 as unknown as ImapFlow,
    });

    const initialMsgs = await prisma.emailMessage.findMany({ where: { emailAccountId: accountId } });
    expect(initialMsgs).toHaveLength(1);
    expect(initialMsgs[0].imapFolder).toBe('INBOX');
    expect(initialMsgs[0].imapUid).toBe(1n);

    // Simulate moving message from INBOX to Archive on IMAP server
    mailboxes.INBOX.messages = [];
    mailboxes.Archive.messages = [
      { uid: 77, flags: new Set(['\\Seen']), internalDate: new Date(), source: rawMime },
    ];

    const runRulesFn = vi.fn(async () => {});
    const client2 = createSimulatedClient(mailboxes);

    await syncSelfHostedAccount({
      prisma,
      emailAccountId: accountId,
      mode: 'incremental',
      env: { SELF_HOSTED_IMAP_HOST: 'mail.example.test' },
      createClient: () => client2 as unknown as ImapFlow,
      runRulesFn,
    });

    const msgs = await prisma.emailMessage.findMany({ where: { emailAccountId: accountId } });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe(initialMsgs[0].id);
    expect(msgs[0].messageId).toBe(initialMsgs[0].messageId);
    expect(msgs[0].threadId).toBe(initialMsgs[0].threadId);
    expect(msgs[0].imapFolder).toBe('Archive');
    expect(msgs[0].imapUid).toBe(77n);
    expect(msgs[0].archived).toBe(true);
    expect(runRulesFn).toHaveBeenCalledTimes(0);
  });

  it('4. Spoofed Header-Message-ID with different sender/body does NOT overwrite or hijack an existing EmailMessage', async () => {
    const originalMime = makeMimeMessage({
      from: 'bank@example.test',
      to: 'alice@example.test',
      subject: 'Official Bank Statement',
      body: 'Your statement for March is ready',
      messageId: '<stmt-2026@example.test>',
    });

    const spoofedMime = makeMimeMessage({
      from: 'attacker@evil.test',
      to: 'alice@example.test',
      subject: 'Phishing Attempt',
      body: 'Click here to claim your prize immediately',
      messageId: '<stmt-2026@example.test>', // Spoofed duplicate Message-ID!
    });

    const mailboxes: Record<string, SimulatedMailbox> = {
      INBOX: {
        uidValidity: 100n,
        messages: [
          { uid: 1, flags: new Set(['\\Seen']), internalDate: new Date('2026-03-01T12:00:00Z'), source: originalMime },
          { uid: 2, flags: new Set(), internalDate: new Date('2026-03-02T12:00:00Z'), source: spoofedMime },
        ],
      },
      Archive: { uidValidity: 200n, messages: [] },
      Sent: { uidValidity: 300n, messages: [] },
      Drafts: { uidValidity: 400n, messages: [] },
      Junk: { uidValidity: 500n, messages: [] },
    };

    const client = createSimulatedClient(mailboxes);
    const runRulesFn = vi.fn(async () => {});
    await syncSelfHostedAccount({
      prisma,
      emailAccountId: accountId,
      mode: 'incremental',
      env: { SELF_HOSTED_IMAP_HOST: 'mail.example.test' },
      createClient: () => client as unknown as ImapFlow,
      runRulesFn,
    });

    const msgs = await prisma.emailMessage.findMany({
      where: { emailAccountId: accountId, headerMessageId: '<stmt-2026@example.test>' },
    });

    expect(msgs).toHaveLength(2);
    const bankMsg = msgs.find((m) => m.fromEmail === 'bank@example.test');
    const attackerMsg = msgs.find((m) => m.fromEmail === 'attacker@evil.test');

    expect(bankMsg).toBeDefined();
    expect(bankMsg?.subject).toBe('Official Bank Statement');
    expect(attackerMsg).toBeDefined();
    expect(attackerMsg?.subject).toBe('Phishing Attempt');
    expect(bankMsg?.id).not.toBe(attackerMsg?.id);
  });

  it('5. UIDVALIDITY reset reconciles existing messages cleanly without losing ExecutedRule audit rows or re-running rules', async () => {
    const rawMime = makeMimeMessage({
      from: 'alerts@service.test',
      to: 'alice@example.test',
      subject: 'Critical Alert',
      body: 'Service operational status normal',
      messageId: '<alert-404@example.test>',
    });

    const mailboxes: Record<string, SimulatedMailbox> = {
      INBOX: {
        uidValidity: 100n,
        messages: [{ uid: 1, flags: new Set(['\\Seen']), internalDate: new Date(), source: rawMime }],
      },
      Archive: { uidValidity: 200n, messages: [] },
      Sent: { uidValidity: 300n, messages: [] },
      Drafts: { uidValidity: 400n, messages: [] },
      Junk: { uidValidity: 500n, messages: [] },
    };

    const client1 = createSimulatedClient(mailboxes);
    await syncSelfHostedAccount({
      prisma,
      emailAccountId: accountId,
      mode: 'bootstrap',
      env: { SELF_HOSTED_IMAP_HOST: 'mail.example.test' },
      createClient: () => client1 as unknown as ImapFlow,
    });

    const initialMessage = await prisma.emailMessage.findFirstOrThrow({ where: { emailAccountId: accountId } });

    // Record an ExecutedRule referencing this message
    await prisma.executedRule.create({
      data: {
        emailAccountId: accountId,
        threadId: initialMessage.threadId,
        messageId: initialMessage.messageId,
        status: 'APPLIED',
        automated: true,
        reason: 'Auto-categorized',
      },
    });

    // Server UIDVALIDITY reset on INBOX:
    mailboxes.INBOX.uidValidity = 999n;
    mailboxes.INBOX.messages = [
      { uid: 42, flags: new Set(['\\Seen']), internalDate: new Date(), source: rawMime },
    ];

    const runRulesFn = vi.fn(async () => {});
    const client2 = createSimulatedClient(mailboxes);

    await syncSelfHostedAccount({
      prisma,
      emailAccountId: accountId,
      mode: 'incremental',
      env: { SELF_HOSTED_IMAP_HOST: 'mail.example.test' },
      createClient: () => client2 as unknown as ImapFlow,
      runRulesFn,
    });

    const reconciled = await prisma.emailMessage.findFirstOrThrow({ where: { emailAccountId: accountId } });
    expect(reconciled.id).toBe(initialMessage.id);
    expect(reconciled.messageId).toBe(initialMessage.messageId);
    expect(reconciled.threadId).toBe(initialMessage.threadId);
    expect(reconciled.imapUidValidity).toBe(999n);
    expect(reconciled.imapUid).toBe(42n);

    const executedRule = await prisma.executedRule.findFirst({
      where: { emailAccountId: accountId, messageId: initialMessage.messageId },
    });
    expect(executedRule).toBeDefined();
    expect(executedRule?.status).toBe('APPLIED');
    expect(runRulesFn).toHaveBeenCalledTimes(0);
  });

  it('6. Mid-scan IMAP disconnect leaves lastSyncedUid unchanged and does not delete cached messages', async () => {
    const rawMime1 = makeMimeMessage({
      from: 'a@example.test',
      to: 'alice@example.test',
      subject: 'Msg 1',
      body: 'Body 1',
      messageId: '<m1@example.test>',
    });

    const rawMime2 = makeMimeMessage({
      from: 'b@example.test',
      to: 'alice@example.test',
      subject: 'Msg 2',
      body: 'Body 2',
      messageId: '<m2@example.test>',
    });

    const mailboxes: Record<string, SimulatedMailbox> = {
      INBOX: {
        uidValidity: 100n,
        messages: [{ uid: 1, flags: new Set(['\\Seen']), internalDate: new Date(), source: rawMime1 }],
      },
      Archive: { uidValidity: 200n, messages: [] },
      Sent: { uidValidity: 300n, messages: [] },
      Drafts: { uidValidity: 400n, messages: [] },
      Junk: { uidValidity: 500n, messages: [] },
    };

    const client1 = createSimulatedClient(mailboxes);
    await syncSelfHostedAccount({
      prisma,
      emailAccountId: accountId,
      mode: 'bootstrap',
      env: { SELF_HOSTED_IMAP_HOST: 'mail.example.test' },
      createClient: () => client1 as unknown as ImapFlow,
    });

    const inboxStateBefore = await prisma.selfHostedFolderState.findUniqueOrThrow({
      where: { emailAccountId_folderPath: { emailAccountId: accountId, folderPath: 'INBOX' } },
    });
    expect(inboxStateBefore.lastSyncedUid).toBe(1n);

    // New messages arrive: UID 2 and UID 3, but fetching UID 3 will disconnect mid-scan!
    mailboxes.INBOX.messages.push(
      { uid: 2, flags: new Set(), internalDate: new Date(), source: rawMime2 },
      { uid: 3, flags: new Set(), internalDate: new Date(), source: rawMime2 }
    );

    const client2 = createSimulatedClient(mailboxes, { failOnFetchUid: 3 });
    const runRulesFn = vi.fn(async () => {});

    await expect(
      syncSelfHostedAccount({
        prisma,
        emailAccountId: accountId,
        mode: 'incremental',
        env: { SELF_HOSTED_IMAP_HOST: 'mail.example.test' },
        createClient: () => client2 as unknown as ImapFlow,
        runRulesFn,
      })
    ).rejects.toThrow();

    const inboxStateAfter = await prisma.selfHostedFolderState.findUniqueOrThrow({
      where: { emailAccountId_folderPath: { emailAccountId: accountId, folderPath: 'INBOX' } },
    });
    expect(inboxStateAfter.lastSyncedUid).toBe(1n);

    const originalMsg = await prisma.emailMessage.findFirst({
      where: { emailAccountId: accountId, headerMessageId: '<m1@example.test>' },
    });
    expect(originalMsg).toBeDefined();
  });

  it('7. parseSafeModSeq handles unsigned 64-bit > 2^63 - 1, <= 0, and non-numeric inputs safely', () => {
    expect(parseSafeModSeq(9223372036854775807n)).toBe(9223372036854775807n);
    expect(parseSafeModSeq(9223372036854775808n)).toBeNull();
    expect(parseSafeModSeq('9223372036854775808')).toBeNull();
    expect(parseSafeModSeq(0n)).toBeNull();
    expect(parseSafeModSeq(0)).toBeNull();
    expect(parseSafeModSeq(-1n)).toBeNull();
    expect(parseSafeModSeq('-5')).toBeNull();
    expect(parseSafeModSeq(null)).toBeNull();
    expect(parseSafeModSeq(undefined)).toBeNull();
    expect(parseSafeModSeq('')).toBeNull();
    expect(parseSafeModSeq('not-a-number')).toBeNull();
    expect(parseSafeModSeq('12345')).toBe(12345n);
    expect(parseSafeModSeq(54321)).toBe(54321n);
    expect(parseSafeModSeq(100n)).toBe(100n);
  });

  it('8. providerSyncJobSchema, syncProviderJob, maintainProviderSubscriptions, and /api/health self-hosted folder-list probe', async () => {
    // A. providerSyncJobSchema validation
    const validJob1 = providerSyncJobSchema.parse({
      provider: 'selfhosted',
      emailAccountId: accountId,
    });
    expect(validJob1).toMatchObject({ provider: 'selfhosted', emailAccountId: accountId });

    const validJob2 = providerSyncJobSchema.parse({
      provider: 'selfhosted',
      emailAccountId: accountId,
      folderPath: 'INBOX',
    });
    expect(validJob2).toMatchObject({ provider: 'selfhosted', emailAccountId: accountId, folderPath: 'INBOX' });

    expect(() =>
      providerSyncJobSchema.parse({ provider: 'selfhosted', emailAccountId: '' })
    ).toThrow();
    expect(() =>
      providerSyncJobSchema.parse({ provider: 'selfhosted', emailAccountId: accountId, unknownProp: 123 })
    ).toThrow();

    // B. syncProviderJob accepts selfhosted provider
    await prisma.emailAccount.update({
      where: { id: accountId },
      data: { initialSyncStatus: 'NOT_STARTED' },
    });

    const savedHost = process.env.SELF_HOSTED_IMAP_HOST;
    process.env.SELF_HOSTED_IMAP_HOST = 'mail.example.test';

    try {
      await expect(
        syncProviderJob({
          prisma,
          job: { provider: 'bootstrap', emailAccountId: accountId },
        })
      ).rejects.toThrow(/Self-hosted/);

      await expect(
        syncProviderJob({
          prisma,
          job: { provider: 'selfhosted', emailAccountId: accountId, folderPath: 'INBOX' },
        })
      ).rejects.toThrow(/Self-hosted/);
    } finally {
      if (savedHost === undefined) delete process.env.SELF_HOSTED_IMAP_HOST;
      else process.env.SELF_HOSTED_IMAP_HOST = savedHost;
    }

    // C. maintainProviderSubscriptions queries active selfhosted accounts
    const catchup = vi.fn(async () => {});
    await prisma.emailAccount.update({
      where: { id: accountId },
      data: { initialSyncStatus: 'COMPLETED' },
    });

    await maintainProviderSubscriptions({
      prisma,
      enqueueCatchup: catchup,
    });

    expect(catchup).toHaveBeenCalledWith({
      provider: 'selfhosted',
      emailAccountId: accountId,
    });

    // When NOT_STARTED or RUNNING, should enqueue bootstrap
    await prisma.emailAccount.update({
      where: { id: accountId },
      data: { initialSyncStatus: 'NOT_STARTED' },
    });

    const catchupBootstrap = vi.fn(async () => {});
    await maintainProviderSubscriptions({
      prisma,
      enqueueCatchup: catchupBootstrap,
    });

    expect(catchupBootstrap).toHaveBeenCalledWith({
      provider: 'bootstrap',
      emailAccountId: accountId,
    });

    // D. /api/health folder probe
    const savedHealthToken = process.env.HEALTH_TOKEN;
    process.env.HEALTH_TOKEN = 'secret-health-token';

    try {
      // 1. Success probe: listSelfHostedFolders succeeds -> checks.provider is 'ok'
      const probeSpy = vi
        .spyOn(selfHostedImap, 'listSelfHostedFolders')
        .mockResolvedValueOnce([{ path: 'INBOX', specialUse: null }]);

      const resOk = await healthRoute(
        new Request('http://localhost/api/health', {
          headers: { authorization: 'Bearer secret-health-token' },
        })
      );
      const jsonOk = await resOk.json();
      expect(jsonOk.checks.provider).toBe('ok');
      expect(probeSpy).toHaveBeenCalled();
      probeSpy.mockRestore();

      // 2. Failure probe: listSelfHostedFolders fails -> checks.provider is 'unavailable'
      const resBad = await healthRoute(
        new Request('http://localhost/api/health', {
          headers: { authorization: 'Bearer secret-health-token' },
        })
      );
      const jsonBad = await resBad.json();
      expect(jsonBad.checks.provider).toBe('unavailable');
    } finally {
      if (savedHealthToken === undefined) delete process.env.HEALTH_TOKEN;
      else process.env.HEALTH_TOKEN = savedHealthToken;
    }
  });
});
