import { PrismaClient } from '@prisma/client';
import EmbeddedPostgres from 'embedded-postgres';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { runBackupRestoreDrill } from '../scripts/verify-backup-restore';
import { runMailserverPreflight } from '../scripts/verify-mailserver-preflight';

const execFileAsync = promisify(execFile);
const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

describe('production baseline migration deploy', () => {
  it('applies 20261115000000_production_baseline migration cleanly on an empty postgres database', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'oiz-migrate-test-'));
    const port = await getAvailablePort();

    const db = new EmbeddedPostgres({
      databaseDir: join(tempDir, 'pg'),
      user: 'postgres',
      password: 'migrate-test-password',
      port,
      persistent: true,
      authMethod: 'scram-sha-256',
      postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
      autoRehydrateSymlinks: true,
      onLog: () => undefined,
    });

    let prisma: PrismaClient | undefined;

    try {
      await db.initialise();
      await db.start();

      const dbUrl = `postgresql://postgres:migrate-test-password@127.0.0.1:${port}/postgres?schema=public`;

      const deployResult = await execFileAsync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
        cwd: webDir,
        env: { ...process.env, DATABASE_URL: dbUrl },
        timeout: 60_000,
      });

      expect(deployResult.stdout).toContain('20261115000000_production_baseline');
      expect(deployResult.stdout).toContain('All migrations have been successfully applied');

      prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

      const migrations = await prisma.$queryRawUnsafe<
        { migration_name: string; finished_at: Date | null }[]
      >(
        'SELECT migration_name, finished_at FROM _prisma_migrations WHERE migration_name = $1',
        '20261115000000_production_baseline',
      );

      expect(migrations.length).toBe(1);
      expect(migrations[0].migration_name).toBe('20261115000000_production_baseline');
      expect(migrations[0].finished_at).not.toBeNull();

      // Verify all self-hosted and core tables exist and are queryable
      expect(await prisma.selfHostedCredential.count()).toBe(0);
      expect(await prisma.selfHostedFolderState.count()).toBe(0);
      expect(await prisma.mailboxInvitation.count()).toBe(0);
      expect(await prisma.outboundMessageDelivery.count()).toBe(0);
      expect(await prisma.user.count()).toBe(0);
      expect(await prisma.emailAccount.count()).toBe(0);
      expect(await prisma.emailMessage.count()).toBe(0);
      expect(await prisma.executedRule.count()).toBe(0);
      expect(await prisma.executedAction.count()).toBe(0);
    } finally {
      if (prisma) await prisma.$disconnect().catch(() => {});
      await db.stop().catch(() => {});
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 300_000);
});

describe('backup & restore disaster recovery drill', () => {
  it('executes full end-to-end drill, restoring schema, database state, credentials, and Maildir hashes', async () => {
    const drillResult = await runBackupRestoreDrill({ cleanup: true });

    expect(drillResult.sourceMigrationApplied).toBe(true);
    expect(drillResult.targetMigrationApplied).toBe(true);
    expect(['pg_dump', 'logical_snapshot']).toContain(drillResult.backupMode);
    expect(drillResult.credentialRestored).toBe(true);
    expect(drillResult.maildirHashesMatched).toBe(true);

    expect(drillResult.seededCounts.users).toBe(1);
    expect(drillResult.seededCounts.authAccounts).toBe(1);
    expect(drillResult.seededCounts.emailAccounts).toBe(1);
    expect(drillResult.seededCounts.folderStates).toBe(2);
    expect(drillResult.seededCounts.messages).toBe(2);
    expect(drillResult.seededCounts.executedRules).toBe(1);
    expect(drillResult.seededCounts.executedActions).toBe(1);
    expect(drillResult.seededCounts.invitations).toBe(1);
    expect(drillResult.seededCounts.outboundDeliveries).toBe(1);
    expect(drillResult.seededCounts.maildirFiles).toBe(3);

    expect(drillResult.restoredCounts.users).toBe(drillResult.seededCounts.users);
    expect(drillResult.restoredCounts.authAccounts).toBe(drillResult.seededCounts.authAccounts);
    expect(drillResult.restoredCounts.emailAccounts).toBe(drillResult.seededCounts.emailAccounts);
    expect(drillResult.restoredCounts.folderStates).toBe(drillResult.seededCounts.folderStates);
    expect(drillResult.restoredCounts.messages).toBe(drillResult.seededCounts.messages);
    expect(drillResult.restoredCounts.executedRules).toBe(drillResult.seededCounts.executedRules);
    expect(drillResult.restoredCounts.executedActions).toBe(drillResult.seededCounts.executedActions);
    expect(drillResult.restoredCounts.invitations).toBe(drillResult.seededCounts.invitations);
    expect(drillResult.restoredCounts.outboundDeliveries).toBe(drillResult.seededCounts.outboundDeliveries);
    expect(drillResult.restoredCounts.maildirFiles).toBe(drillResult.seededCounts.maildirFiles);
  }, 300_000);
});

describe('operator mailserver preflight checks', () => {
  const healthyDns = {
    resolveA: async () => ['192.0.2.25'],
    resolveAaaa: async () => ['2001:db8::25'],
    resolveMx: async () => [{ exchange: 'mail.company.example', priority: 10 }],
    resolvePtr: async () => ['mail.company.example'],
    resolveTxt: async (hostname: string) => {
      if (hostname === 'company.example') {
        return [['v=spf1 mx ip4:192.0.2.25 -all']];
      }
      if (hostname === 'mail._domainkey.company.example') {
        return [['v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...']];
      }
      if (hostname === '_dmarc.company.example') {
        return [['v=DMARC1; p=reject; rua=mailto:dmarc@company.example']];
      }
      return [];
    },
  };

  const healthyTls = async () => ({
    authorized: true,
    validTo: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000), // 60 days
    subjectAltNames: ['mail.company.example'],
  });

  const healthySmtp = async () => ({
    rejected: true,
    statusCode: 554,
    response: '554 5.7.1 Relay access denied',
  });

  it('passes all checks when DNS, TLS, and anti-relay are healthy', async () => {
    const report = await runMailserverPreflight({
      domain: 'company.example',
      mailHost: 'mail.company.example',
      dnsLookup: healthyDns,
      tlsConnect: healthyTls,
      smtpProbe: healthySmtp,
    });

    expect(report.passed).toBe(true);
    expect(report.checks.every((c) => c.passed)).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual([
      'domain_fqdn_syntax',
      'mail_host_fqdn_syntax',
      'mail_host_a_aaaa_records',
      'domain_mx_record',
      'mail_host_ptr_record',
      'domain_spf_record',
      'domain_dkim_record',
      'domain_dmarc_record',
      'tls_port_465_smtps',
      'tls_port_587_smtp_submission_starttls',
      'tls_port_993_imaps',
      'unauthenticated_open_relay_rejection',
    ]);
  });

  it('fails closed when domain syntax is not a valid FQDN', async () => {
    const report = await runMailserverPreflight({
      domain: 'invalid domain with spaces',
      mailHost: 'mail.company.example',
      dnsLookup: healthyDns,
      tlsConnect: healthyTls,
      smtpProbe: healthySmtp,
    });

    expect(report.passed).toBe(false);
    const syntaxCheck = report.checks.find((c) => c.name === 'domain_fqdn_syntax');
    expect(syntaxCheck?.passed).toBe(false);
  });

  it('fails closed when SPF TXT record is missing', async () => {
    const report = await runMailserverPreflight({
      domain: 'company.example',
      mailHost: 'mail.company.example',
      dnsLookup: {
        ...healthyDns,
        resolveTxt: async (hostname: string) => {
          if (hostname === 'company.example') return [];
          return healthyDns.resolveTxt(hostname);
        },
      },
      tlsConnect: healthyTls,
      smtpProbe: healthySmtp,
    });

    expect(report.passed).toBe(false);
    const spfCheck = report.checks.find((c) => c.name === 'domain_spf_record');
    expect(spfCheck?.passed).toBe(false);
  });

  it('fails closed when DMARC TXT record is missing', async () => {
    const report = await runMailserverPreflight({
      domain: 'company.example',
      mailHost: 'mail.company.example',
      dnsLookup: {
        ...healthyDns,
        resolveTxt: async (hostname: string) => {
          if (hostname === '_dmarc.company.example') return [];
          return healthyDns.resolveTxt(hostname);
        },
      },
      tlsConnect: healthyTls,
      smtpProbe: healthySmtp,
    });

    expect(report.passed).toBe(false);
    const dmarcCheck = report.checks.find((c) => c.name === 'domain_dmarc_record');
    expect(dmarcCheck?.passed).toBe(false);
  });

  it('fails closed when DKIM record is missing at configured selector', async () => {
    const report = await runMailserverPreflight({
      domain: 'company.example',
      mailHost: 'mail.company.example',
      dkimSelector: 'custom-sel',
      dnsLookup: {
        ...healthyDns,
        resolveTxt: async (hostname: string) => {
          if (hostname === 'custom-sel._domainkey.company.example') return [];
          return healthyDns.resolveTxt(hostname);
        },
      },
      tlsConnect: healthyTls,
      smtpProbe: healthySmtp,
    });

    expect(report.passed).toBe(false);
    const dkimCheck = report.checks.find((c) => c.name === 'domain_dkim_record');
    expect(dkimCheck?.passed).toBe(false);
  });

  it('fails closed when TLS cert expires in < 7 days or SAN does not match', async () => {
    const report = await runMailserverPreflight({
      domain: 'company.example',
      mailHost: 'mail.company.example',
      dnsLookup: healthyDns,
      tlsConnect: async () => ({
        authorized: true,
        validTo: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000), // 2 days only
        subjectAltNames: ['other.example'],
      }),
      smtpProbe: healthySmtp,
    });

    expect(report.passed).toBe(false);
    const smtpsTlsCheck = report.checks.find((c) => c.name === 'tls_port_465_smtps');
    expect(smtpsTlsCheck?.passed).toBe(false);
    expect(smtpsTlsCheck?.details).toContain('expires in < 7 days');
    expect(smtpsTlsCheck?.details).toContain('SAN mismatch');
  });

  it('fails closed when server permits unauthenticated external relay', async () => {
    const report = await runMailserverPreflight({
      domain: 'company.example',
      mailHost: 'mail.company.example',
      dnsLookup: healthyDns,
      tlsConnect: healthyTls,
      smtpProbe: async () => ({
        rejected: false,
        statusCode: 250,
        response: '250 2.1.5 Recipient OK',
      }),
    });

    expect(report.passed).toBe(false);
    const relayCheck = report.checks.find((c) => c.name === 'unauthenticated_open_relay_rejection');
    expect(relayCheck?.passed).toBe(false);
    expect(relayCheck?.details).toContain('CRITICAL: Server did not reject unauthenticated relay');
  });
});
