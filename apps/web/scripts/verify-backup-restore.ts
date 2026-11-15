import { Prisma, PrismaClient } from '@prisma/client';
import EmbeddedPostgres from 'embedded-postgres';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getSelfHostedCredential, saveSelfHostedCredential } from '../utils/mail-provider/self-hosted-credentials';

const execFileAsync = promisify(execFile);
const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface BackupRestoreDrillOptions {
  preferPgDump?: boolean;
  cleanup?: boolean;
  onLog?: (msg: string) => void;
}

export interface BackupRestoreDrillResult {
  backupMode: 'pg_dump' | 'logical_snapshot';
  sourceMigrationApplied: boolean;
  targetMigrationApplied: boolean;
  seededCounts: {
    users: number;
    authAccounts: number;
    emailAccounts: number;
    folderStates: number;
    messages: number;
    executedRules: number;
    executedActions: number;
    invitations: number;
    outboundDeliveries: number;
    maildirFiles: number;
  };
  restoredCounts: {
    users: number;
    authAccounts: number;
    emailAccounts: number;
    folderStates: number;
    messages: number;
    executedRules: number;
    executedActions: number;
    invitations: number;
    outboundDeliveries: number;
    maildirFiles: number;
  };
  credentialRestored: boolean;
  maildirHashesMatched: boolean;
  bundlePath: string;
}

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve port');
  await new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done())));
  return address.port;
}

async function canUsePgDump(): Promise<boolean> {
  try {
    await execFileAsync('pg_dump', ['--version']);
    await execFileAsync('pg_restore', ['--version']);
    return true;
  } catch {
    return false;
  }
}

async function getMaildirHashes(dir: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  async function scan(current: string, rel: string) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const ent of entries) {
      const fullPath = join(current, ent.name);
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await scan(fullPath, relPath);
      } else if (ent.isFile()) {
        const content = await readFile(fullPath);
        const hash = createHash('sha256').update(content).digest('hex');
        hashes.set(relPath, hash);
      }
    }
  }
  await scan(dir, '');
  return hashes;
}

function serializeSnapshot(obj: unknown): string {
  return JSON.stringify(
    obj,
    (_key, value) => {
      if (typeof value === 'bigint') {
        return { __type: 'bigint', value: value.toString() };
      }
      return value;
    },
    2,
  );
}

function parseSnapshot<T>(json: string): T {
  return JSON.parse(json, (_key, value) => {
    if (value && typeof value === 'object' && value.__type === 'bigint') {
      return BigInt(value.value);
    }
    if (
      typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    ) {
      return new Date(value);
    }
    return value;
  });
}

export async function runBackupRestoreDrill(
  options: BackupRestoreDrillOptions = {},
): Promise<BackupRestoreDrillResult> {
  const log = options.onLog ?? (() => {});

  if (!process.env.TOKEN_ENCRYPTION_KEY) {
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 42).toString('base64');
  }

  const rootDir = await mkdtemp(join(tmpdir(), 'oiz-backup-drill-'));
  const sourcePgDir = join(rootDir, 'source-pg');
  const targetPgDir = join(rootDir, 'target-pg');
  const sourceMaildirDir = join(rootDir, 'source-maildir');
  const backupStageDir = join(rootDir, 'backup-stage');
  const bundlePath = join(rootDir, 'backup-bundle.tar.gz');
  const restoreStageDir = join(rootDir, 'restore-stage');
  const targetMaildirDir = join(rootDir, 'target-maildir');

  await mkdir(join(sourceMaildirDir, 'cur'), { recursive: true });
  await mkdir(join(sourceMaildirDir, 'new'), { recursive: true });
  await mkdir(join(sourceMaildirDir, 'tmp'), { recursive: true });
  await mkdir(backupStageDir, { recursive: true });
  await mkdir(restoreStageDir, { recursive: true });
  await mkdir(targetMaildirDir, { recursive: true });

  const sourcePort = await getAvailablePort();
  const targetPort = await getAvailablePort();

  const sourceDb = new EmbeddedPostgres({
    databaseDir: sourcePgDir,
    user: 'postgres',
    password: 'source-test-password',
    port: sourcePort,
    persistent: true,
    authMethod: 'scram-sha-256',
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
    autoRehydrateSymlinks: true,
    onLog: () => undefined,
  });

  const targetDb = new EmbeddedPostgres({
    databaseDir: targetPgDir,
    user: 'postgres',
    password: 'target-test-password',
    port: targetPort,
    persistent: true,
    authMethod: 'scram-sha-256',
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
    autoRehydrateSymlinks: true,
    onLog: () => undefined,
  });

  let sourcePrisma: PrismaClient | undefined;
  let targetPrisma: PrismaClient | undefined;

  try {
    log('1. Initializing and starting isolated source and target EmbeddedPostgres in parallel...');
    await Promise.all([sourceDb.initialise(), targetDb.initialise()]);
    await Promise.all([sourceDb.start(), targetDb.start()]);

    const sourceUrl = `postgresql://postgres:source-test-password@127.0.0.1:${sourcePort}/postgres?schema=public`;
    const targetUrl = `postgresql://postgres:target-test-password@127.0.0.1:${targetPort}/postgres?schema=public`;

    log('2. Running prisma migrate deploy against both clean databases in parallel...');
    await Promise.all([
      execFileAsync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
        cwd: webDir,
        env: { ...process.env, DATABASE_URL: sourceUrl },
        timeout: 60_000,
      }),
      execFileAsync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
        cwd: webDir,
        env: { ...process.env, DATABASE_URL: targetUrl },
        timeout: 60_000,
      }),
    ]);

    sourcePrisma = new PrismaClient({ datasources: { db: { url: sourceUrl } } });
    targetPrisma = new PrismaClient({ datasources: { db: { url: targetUrl } } });

    const sourceMigrations = await sourcePrisma.$queryRawUnsafe<
      { migration_name: string; finished_at: Date | null }[]
    >(
      'SELECT migration_name, finished_at FROM _prisma_migrations WHERE migration_name = $1',
      '20261115000000_production_baseline',
    );
    const targetMigrations = await targetPrisma.$queryRawUnsafe<
      { migration_name: string; finished_at: Date | null }[]
    >(
      'SELECT migration_name, finished_at FROM _prisma_migrations WHERE migration_name = $1',
      '20261115000000_production_baseline',
    );

    if (!sourceMigrations.length || !sourceMigrations[0].finished_at) {
      throw new Error('Baseline migration was not applied cleanly to source database');
    }
    if (!targetMigrations.length || !targetMigrations[0].finished_at) {
      throw new Error('Baseline migration was not applied cleanly to target database');
    }

    log('3. Seeding rich realistic self-hosted state into source database...');
    const testUserId = 'user_drill_operator_1';
    const testAccountId = 'acc_drill_selfhosted_1';
    const mailboxEmail = 'operator@drill.internal';
    const mailboxPassword = 'mailbox-super-secret-password-42!';

    await sourcePrisma.user.create({
      data: {
        id: testUserId,
        email: mailboxEmail,
        name: 'Drill Operator',
        emailVerified: true,
      },
    });

    await sourcePrisma.authAccount.create({
      data: {
        id: 'auth_drill_account_1',
        accountId: mailboxEmail,
        providerId: 'credential',
        userId: testUserId,
        password: 'hashed-login-password',
      },
    });

    await sourcePrisma.emailAccount.create({
      data: {
        id: testAccountId,
        userId: testUserId,
        email: mailboxEmail,
        provider: 'selfhosted',
        authAccountId: 'auth_drill_account_1',
        coldEmailBlocker: 'LABEL_AND_ARCHIVE',
      },
    });

    await saveSelfHostedCredential({
      prisma: sourcePrisma,
      userId: testUserId,
      accountId: testAccountId,
      password: mailboxPassword,
    });

    await sourcePrisma.selfHostedFolderState.create({
      data: {
        emailAccountId: testAccountId,
        folderPath: 'INBOX',
        uidValidity: 1731670000n,
        lastSyncedUid: 42n,
        highestModSeq: 9876543210n,
        specialUse: '\\Inbox',
        lastScanCompletedAt: new Date('2026-11-15T10:00:00Z'),
      },
    });

    await sourcePrisma.selfHostedFolderState.create({
      data: {
        emailAccountId: testAccountId,
        folderPath: 'Sent',
        uidValidity: 1731670001n,
        lastSyncedUid: 15n,
        highestModSeq: 1234567890n,
        specialUse: '\\Sent',
        lastScanCompletedAt: new Date('2026-11-15T10:05:00Z'),
      },
    });

    const threadId = 'thread_drill_review_100';
    await sourcePrisma.emailMessage.create({
      data: {
        id: 'msg_drill_1',
        emailAccountId: testAccountId,
        threadId,
        messageId: '<orig-100@drill-sender.example>',
        fromEmail: 'client@drill-sender.example',
        toEmail: mailboxEmail,
        subject: 'Backup Drill Inspection Notice',
        snippet: 'Notice regarding disaster recovery verification.',
        textBody: 'Notice regarding disaster recovery verification.\nBest regards,\nClient Team',
        labels: ['INBOX'],
        internalDate: new Date('2026-11-15T09:00:00Z'),
        imapFolder: 'INBOX',
        imapUidValidity: 1731670000n,
        imapUid: 41n,
      },
    });

    await sourcePrisma.emailMessage.create({
      data: {
        id: 'msg_drill_2',
        emailAccountId: testAccountId,
        threadId,
        messageId: '<reply-100@drill-operator.example>',
        fromEmail: mailboxEmail,
        toEmail: 'client@drill-sender.example',
        subject: 'Re: Backup Drill Inspection Notice',
        snippet: 'Understood, DR drill proceeding according to plan.',
        textBody: 'Understood, DR drill proceeding according to plan.\nBest regards,\nOperator',
        labels: ['SENT'],
        inReplyTo: '<orig-100@drill-sender.example>',
        internalDate: new Date('2026-11-15T09:15:00Z'),
        imapFolder: 'Sent',
        imapUidValidity: 1731670001n,
        imapUid: 15n,
      },
    });

    const execRule = await sourcePrisma.executedRule.create({
      data: {
        id: 'exec_rule_drill_1',
        emailAccountId: testAccountId,
        threadId,
        messageId: '<orig-100@drill-sender.example>',
        status: 'APPLIED',
        automated: true,
        reason: 'Matched DR notice rule',
      },
    });

    await sourcePrisma.executedAction.create({
      data: {
        id: 'exec_action_drill_1',
        executedRuleId: execRule.id,
        type: 'LABEL',
        status: 'COMPLETED',
        label: 'DR-Verified',
        executedAt: new Date('2026-11-15T09:01:00Z'),
      },
    });

    await sourcePrisma.mailboxInvitation.create({
      data: {
        id: 'inv_drill_1',
        email: 'colleague@drill.internal',
        tokenHash: createHash('sha256').update('invitation-token-secret').digest('hex'),
        createdByAdmin: testUserId,
        expiresAt: new Date('2026-12-01T00:00:00Z'),
        userId: testUserId,
      },
    });

    await sourcePrisma.outboundMessageDelivery.create({
      data: {
        id: 'outbox_drill_1',
        emailAccountId: testAccountId,
        userId: testUserId,
        threadId,
        rfc822MessageId: '<reply-100@drill-operator.example>',
        toEmail: 'client@drill-sender.example',
        subject: 'Re: Backup Drill Inspection Notice',
        bodyHash: createHash('sha256').update('outbound-body-contents').digest('hex'),
        status: 'COMPLETED',
        smtpResponse: '250 2.0.0 Ok: queued as DRILL999',
        completedAt: new Date('2026-11-15T09:15:02Z'),
      },
    });

    log('4. Seeding RFC-822 messages in source Maildir...');
    const mail1Content = [
      'From: client@drill-sender.example',
      `To: ${mailboxEmail}`,
      'Subject: Backup Drill Inspection Notice',
      'Date: Sun, 15 Nov 2026 09:00:00 +0000',
      'Message-ID: <orig-100@drill-sender.example>',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Notice regarding disaster recovery verification.',
    ].join('\r\n');

    const mail2Content = [
      `From: ${mailboxEmail}`,
      'To: client@drill-sender.example',
      'Subject: Re: Backup Drill Inspection Notice',
      'Date: Sun, 15 Nov 2026 09:15:00 +0000',
      'Message-ID: <reply-100@drill-operator.example>',
      'In-Reply-To: <orig-100@drill-sender.example>',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Understood, DR drill proceeding according to plan.',
    ].join('\r\n');

    const mail3Content = [
      'From: automated-monitor@drill.internal',
      `To: ${mailboxEmail}`,
      'Subject: Health Monitor Ping',
      'Date: Sun, 15 Nov 2026 09:20:00 +0000',
      'Message-ID: <ping-200@drill.internal>',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'All local self-hosted mail daemons healthy.',
    ].join('\r\n');

    await writeFile(
      join(sourceMaildirDir, 'cur', '1731670800.M100000P1000Q1.mailhost:2,S'),
      mail1Content,
      'utf8',
    );
    await writeFile(
      join(sourceMaildirDir, 'cur', '1731671700.M200000P2000Q1.mailhost:2,RS'),
      mail2Content,
      'utf8',
    );
    await writeFile(
      join(sourceMaildirDir, 'new', '1731672000.M300000P3000Q1.mailhost:2,'),
      mail3Content,
      'utf8',
    );

    const sourceMaildirHashes = await getMaildirHashes(sourceMaildirDir);

    const seededCounts = {
      users: await sourcePrisma.user.count(),
      authAccounts: await sourcePrisma.authAccount.count(),
      emailAccounts: await sourcePrisma.emailAccount.count(),
      folderStates: await sourcePrisma.selfHostedFolderState.count(),
      messages: await sourcePrisma.emailMessage.count(),
      executedRules: await sourcePrisma.executedRule.count(),
      executedActions: await sourcePrisma.executedAction.count(),
      invitations: await sourcePrisma.mailboxInvitation.count(),
      outboundDeliveries: await sourcePrisma.outboundMessageDelivery.count(),
      maildirFiles: sourceMaildirHashes.size,
    };

    log(`Seeded items count: ${JSON.stringify(seededCounts)}`);

    // 5. Take backup
    const preferPg = options.preferPgDump !== false;
    const hasPgTools = await canUsePgDump();
    const backupMode: 'pg_dump' | 'logical_snapshot' = preferPg && hasPgTools ? 'pg_dump' : 'logical_snapshot';
    log(`5. Taking backup with mode: ${backupMode}...`);

    if (backupMode === 'pg_dump') {
      await execFileAsync('pg_dump', ['--format=custom', '--file', join(backupStageDir, 'database.dump'), sourceUrl], {
        timeout: 60_000,
      });
    } else {
      const snapshot = {
        users: await sourcePrisma.user.findMany(),
        authAccounts: await sourcePrisma.authAccount.findMany(),
        emailAccounts: await sourcePrisma.emailAccount.findMany(),
        selfHostedCredentials: await sourcePrisma.selfHostedCredential.findMany(),
        selfHostedFolderStates: await sourcePrisma.selfHostedFolderState.findMany(),
        executedRules: await sourcePrisma.executedRule.findMany(),
        executedActions: await sourcePrisma.executedAction.findMany(),
        mailboxInvitations: await sourcePrisma.mailboxInvitation.findMany(),
        outboundMessageDeliveries: await sourcePrisma.outboundMessageDelivery.findMany(),
        emailMessages: await sourcePrisma.emailMessage.findMany(),
      };

      const snapshotJson = serializeSnapshot(snapshot);
      const snapshotChecksum = createHash('sha256').update(snapshotJson).digest('hex');
      await writeFile(join(backupStageDir, 'database_snapshot.json'), snapshotJson, 'utf8');
      await writeFile(join(backupStageDir, 'database_snapshot.sha256'), snapshotChecksum, 'utf8');
    }

    // Archive Maildir
    await execFileAsync('/usr/bin/tar', ['-czf', join(backupStageDir, 'maildir.tar.gz'), '-C', sourceMaildirDir, '.']);

    const manifest = {
      version: 1,
      backupMode,
      createdAt: new Date().toISOString(),
      maildirFileHashes: Object.fromEntries(sourceMaildirHashes.entries()),
    };
    await writeFile(join(backupStageDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    // Archive entire backup stage into final artifact bundle
    await execFileAsync('/usr/bin/tar', ['-czf', bundlePath, '-C', backupStageDir, '.']);

    // 6. Restore backup into target DB and target Maildir
    log('6. Restoring backup artifact into clean target environment...');
    await execFileAsync('/usr/bin/tar', ['-xzf', bundlePath, '-C', restoreStageDir]);

    // Restore Maildir
    await execFileAsync('/usr/bin/tar', ['-xzf', join(restoreStageDir, 'maildir.tar.gz'), '-C', targetMaildirDir]);

    // Restore Database
    if (backupMode === 'pg_dump') {
      await execFileAsync(
        'pg_restore',
        ['--data-only', '--dbname', targetUrl, join(restoreStageDir, 'database.dump')],
        { timeout: 60_000 },
      );
    } else {
      const restoredJson = await readFile(join(restoreStageDir, 'database_snapshot.json'), 'utf8');
      const expectedChecksum = (await readFile(join(restoreStageDir, 'database_snapshot.sha256'), 'utf8')).trim();
      const actualChecksum = createHash('sha256').update(restoredJson).digest('hex');
      if (actualChecksum !== expectedChecksum) {
        throw new Error(`Checksum mismatch on restored database snapshot: expected ${expectedChecksum}, got ${actualChecksum}`);
      }

      type SnapshotType = {
        users: Prisma.UserCreateManyInput[];
        authAccounts: Prisma.AuthAccountCreateManyInput[];
        emailAccounts: Prisma.EmailAccountCreateManyInput[];
        selfHostedCredentials: Prisma.SelfHostedCredentialCreateManyInput[];
        selfHostedFolderStates: Prisma.SelfHostedFolderStateCreateManyInput[];
        executedRules: Prisma.ExecutedRuleCreateManyInput[];
        executedActions: Prisma.ExecutedActionCreateManyInput[];
        mailboxInvitations: Prisma.MailboxInvitationCreateManyInput[];
        outboundMessageDeliveries: Prisma.OutboundMessageDeliveryCreateManyInput[];
        emailMessages: Prisma.EmailMessageCreateManyInput[];
      };

      const restoredData = parseSnapshot<SnapshotType>(restoredJson);

      await targetPrisma.user.createMany({ data: restoredData.users });
      await targetPrisma.authAccount.createMany({ data: restoredData.authAccounts });
      await targetPrisma.emailAccount.createMany({ data: restoredData.emailAccounts });
      await targetPrisma.selfHostedCredential.createMany({ data: restoredData.selfHostedCredentials });
      await targetPrisma.selfHostedFolderState.createMany({ data: restoredData.selfHostedFolderStates });
      await targetPrisma.executedRule.createMany({ data: restoredData.executedRules });
      await targetPrisma.executedAction.createMany({ data: restoredData.executedActions });
      await targetPrisma.mailboxInvitation.createMany({ data: restoredData.mailboxInvitations });
      await targetPrisma.outboundMessageDelivery.createMany({ data: restoredData.outboundMessageDeliveries });
      await targetPrisma.emailMessage.createMany({ data: restoredData.emailMessages });
    }

    // 7. Verification & Assertions
    log('7. Verifying restored database and maildir state...');
    const decryptedCreds = await getSelfHostedCredential({
      prisma: targetPrisma,
      userId: testUserId,
      accountId: testAccountId,
    });

    if (decryptedCreds.username !== mailboxEmail || decryptedCreds.password !== mailboxPassword) {
      throw new Error(
        `Restored credential mismatch: expected ${mailboxEmail}/${mailboxPassword}, got ${decryptedCreds.username}/${decryptedCreds.password}`,
      );
    }

    const restoredMessages = await targetPrisma.emailMessage.findMany({
      where: { emailAccountId: testAccountId },
      orderBy: { id: 'asc' },
    });

    if (
      restoredMessages.length !== 2 ||
      restoredMessages[0].id !== 'msg_drill_1' ||
      restoredMessages[1].id !== 'msg_drill_2' ||
      restoredMessages[0].threadId !== threadId ||
      restoredMessages[1].threadId !== threadId ||
      restoredMessages[0].imapUid !== 41n ||
      restoredMessages[1].imapUid !== 15n ||
      restoredMessages[0].imapFolder !== 'INBOX' ||
      restoredMessages[1].imapFolder !== 'Sent'
    ) {
      throw new Error('Restored email messages or thread links failed verification');
    }

    const restoredInboxFolder = await targetPrisma.selfHostedFolderState.findUniqueOrThrow({
      where: {
        emailAccountId_folderPath: { emailAccountId: testAccountId, folderPath: 'INBOX' },
      },
    });

    if (
      restoredInboxFolder.uidValidity !== 1731670000n ||
      restoredInboxFolder.highestModSeq !== 9876543210n ||
      restoredInboxFolder.lastSyncedUid !== 42n
    ) {
      throw new Error('Restored folder state BigInt attributes failed verification');
    }

    const restoredRule = await targetPrisma.executedRule.findUniqueOrThrow({
      where: { id: 'exec_rule_drill_1' },
      include: { actionItems: true },
    });

    if (
      restoredRule.status !== 'APPLIED' ||
      restoredRule.actionItems.length !== 1 ||
      restoredRule.actionItems[0].status !== 'COMPLETED' ||
      restoredRule.actionItems[0].label !== 'DR-Verified'
    ) {
      throw new Error('Restored executed rules and audit action items failed verification');
    }

    const restoredInvitation = await targetPrisma.mailboxInvitation.findUniqueOrThrow({
      where: { id: 'inv_drill_1' },
    });
    if (restoredInvitation.email !== 'colleague@drill.internal') {
      throw new Error('Restored mailbox invitation failed verification');
    }

    const restoredOutbox = await targetPrisma.outboundMessageDelivery.findUniqueOrThrow({
      where: { id: 'outbox_drill_1' },
    });
    if (
      restoredOutbox.rfc822MessageId !== '<reply-100@drill-operator.example>' ||
      restoredOutbox.status !== 'COMPLETED' ||
      restoredOutbox.smtpResponse !== '250 2.0.0 Ok: queued as DRILL999'
    ) {
      throw new Error('Restored outbound message delivery audit record failed verification');
    }

    const restoredMaildirHashes = await getMaildirHashes(targetMaildirDir);
    if (restoredMaildirHashes.size !== sourceMaildirHashes.size) {
      throw new Error(
        `Restored maildir file count mismatch: expected ${sourceMaildirHashes.size}, got ${restoredMaildirHashes.size}`,
      );
    }

    for (const [relPath, srcHash] of sourceMaildirHashes.entries()) {
      const restoredHash = restoredMaildirHashes.get(relPath);
      if (restoredHash !== srcHash) {
        throw new Error(
          `Maildir file hash mismatch for ${relPath}: expected ${srcHash}, got ${restoredHash}`,
        );
      }
    }

    const restoredCounts = {
      users: await targetPrisma.user.count(),
      authAccounts: await targetPrisma.authAccount.count(),
      emailAccounts: await targetPrisma.emailAccount.count(),
      folderStates: await targetPrisma.selfHostedFolderState.count(),
      messages: await targetPrisma.emailMessage.count(),
      executedRules: await targetPrisma.executedRule.count(),
      executedActions: await targetPrisma.executedAction.count(),
      invitations: await targetPrisma.mailboxInvitation.count(),
      outboundDeliveries: await targetPrisma.outboundMessageDelivery.count(),
      maildirFiles: restoredMaildirHashes.size,
    };

    log('8. Backup & Restore Drill Completed Successfully!');
    return {
      backupMode,
      sourceMigrationApplied: true,
      targetMigrationApplied: true,
      seededCounts,
      restoredCounts,
      credentialRestored: true,
      maildirHashesMatched: true,
      bundlePath,
    };
  } finally {
    if (sourcePrisma) {
      await sourcePrisma.$disconnect().catch(() => {});
    }
    if (targetPrisma) {
      await targetPrisma.$disconnect().catch(() => {});
    }
    await sourceDb.stop().catch(() => {});
    await targetDb.stop().catch(() => {});
    if (options.cleanup !== false) {
      await rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function isDirectExecution(): boolean {
  if (typeof process === 'undefined' || !process.argv[1]) return false;
  const scriptPath = fileURLToPath(import.meta.url);
  const executedPath = resolve(process.argv[1]);
  return scriptPath === executedPath || executedPath.endsWith('verify-backup-restore.ts');
}

if (isDirectExecution()) {
  runBackupRestoreDrill({
    onLog: (msg) => console.log(msg),
  })
    .then((result) => {
      console.log('\n=== Backup & Restore Verification Drill Passed ===');
      console.log(`Backup mode used: ${result.backupMode}`);
      console.log(`Maildir files verified: ${result.restoredCounts.maildirFiles} (100% SHA-256 match)`);
      console.log(`Credential decrypted successfully: ${result.credentialRestored}`);
      console.log(`Database tables restored: ${JSON.stringify(result.restoredCounts, null, 2)}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('\n=== Backup & Restore Drill FAILED ===', err);
      process.exit(1);
    });
}
