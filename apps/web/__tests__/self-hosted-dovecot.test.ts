import { PrismaClient } from '@prisma/client';
import EmbeddedPostgres from 'embedded-postgres';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import tls from 'node:tls';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { listSelfHostedFolders, withSelfHostedImapClient } from '../utils/mail-provider/self-hosted-imap';
import { syncSelfHostedAccount } from '../utils/worker/self-hosted-sync';

const execFileAsync = promisify(execFile);
const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

describe('self-hosted TLS / Dovecot protocol loopback tests', () => {
  let tempDir: string;
  let database: EmbeddedPostgres;
  let prisma: PrismaClient;
  let tlsServer: tls.Server;
  let tlsPort: number;
  let wrongHostTlsServer: tls.Server;
  let wrongHostTlsPort: number;
  let certPath: string;
  let wrongHostCertPath: string;
  let keyPath: string;
  let testAccountId: string;
  const testUserId = 'test-user-id';

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'oiz-dovecot-test-'));
    certPath = join(tempDir, 'cert.pem');
    wrongHostCertPath = join(tempDir, 'wrong-host-cert.pem');
    const wrongHostKeyPath = join(tempDir, 'wrong-host-key.pem');
    keyPath = join(tempDir, 'key.pem');

    // Generate ephemeral self-signed cert for IP:127.0.0.1
    await execFileAsync('/usr/bin/openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ]);

    // Generate ephemeral cert with mismatched SAN for hostname verification test
    await execFileAsync('/usr/bin/openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      wrongHostKeyPath,
      '-out',
      wrongHostCertPath,
      '-days',
      '1',
      '-subj',
      '/CN=wrong-host.example.test',
      '-addext',
      'subjectAltName=DNS:wrong-host.example.test',
    ]);

    const cert = await readFile(certPath);
    const key = await readFile(keyPath);
    const wrongCert = await readFile(wrongHostCertPath);
    const wrongKey = await readFile(wrongHostKeyPath);

    tlsServer = tls.createServer({ cert, key }, (socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1] Mock TLS IMAP Server Ready\r\n');
      socket.on('data', (data) => {
        const text = data.toString('utf-8');
        const lines = text.split('\r\n').filter(Boolean);
        for (const line of lines) {
          const parts = line.split(' ');
          const tag = parts[0];
          const cmd = parts[1]?.toUpperCase();
          if (cmd === 'CAPABILITY') {
            socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK Capability completed\r\n`);
          } else if (cmd === 'LOGIN') {
            socket.write(`${tag} OK LOGIN completed\r\n`);
          } else if (cmd === 'LIST') {
            socket.write(
              `* LIST (\\HasNoChildren) NIL "INBOX"\r\n* LIST (\\HasNoChildren \\Archive) NIL "Archive"\r\n${tag} OK LIST completed\r\n`
            );
          } else if (cmd === 'SELECT' || cmd === 'EXAMINE') {
            socket.write(
              `* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n* 0 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 777] UIDs valid\r\n* OK [UIDNEXT 1] Predicted next UID\r\n${tag} OK [READ-WRITE] Select completed\r\n`
            );
          } else if (cmd === 'UID' && parts[2]?.toUpperCase() === 'SEARCH') {
            socket.write(`* SEARCH\r\n${tag} OK UID SEARCH completed\r\n`);
          } else if (cmd === 'SEARCH') {
            socket.write(`* SEARCH\r\n${tag} OK SEARCH completed\r\n`);
          } else if (cmd === 'LOGOUT') {
            socket.write(`* BYE Logging out\r\n${tag} OK LOGOUT completed\r\n`);
            socket.end();
          } else {
            socket.write(`${tag} OK ${cmd} completed\r\n`);
          }
        }
      });
    });

    await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
    const addr = tlsServer.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to bind TLS server');
    tlsPort = addr.port;

    wrongHostTlsServer = tls.createServer({ cert: wrongCert, key: wrongKey }, (socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1] Wrong Host TLS IMAP Server Ready\r\n');
    });
    await new Promise<void>((resolve) => wrongHostTlsServer.listen(0, '127.0.0.1', resolve));
    const wrongAddr = wrongHostTlsServer.address();
    if (!wrongAddr || typeof wrongAddr === 'string') throw new Error('Failed to bind wrong-host TLS server');
    wrongHostTlsPort = wrongAddr.port;

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
    await execFileAsync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate'], {
      cwd: webDir,
      env: { ...process.env, DATABASE_URL: dbUrl },
      timeout: 60_000,
    });

    prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

    const user = await prisma.user.create({
      data: { id: testUserId, name: 'Alice', email: 'alice@example.test' },
    });
    const account = await prisma.emailAccount.create({
      data: {
        userId: user.id,
        email: 'alice@example.test',
        provider: 'selfhosted',
      },
    });
    testAccountId = account.id;
  }, 120_000);

  afterAll(async () => {
    try {
      if (tlsServer) {
        await new Promise<void>((done) => tlsServer.close(() => done()));
      }
      if (wrongHostTlsServer) {
        await new Promise<void>((done) => wrongHostTlsServer.close(() => done()));
      }
      if (prisma) await prisma.$disconnect();
      if (database) await database.stop();
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  it('connects via real TLS loopback with trusted CA and lists folders', async () => {
    const folders = await listSelfHostedFolders({
      prisma,
      userId: testUserId,
      accountId: testAccountId,
      env: {
        SELF_HOSTED_IMAP_HOST: '127.0.0.1',
        SELF_HOSTED_IMAP_PORT: String(tlsPort),
        SELF_HOSTED_TLS_CA_FILE: certPath,
      },
    });

    expect(folders).toHaveLength(2);
    expect(folders[0]).toMatchObject({ path: 'INBOX' });
    expect(folders[1]).toMatchObject({ path: 'Archive', specialUse: '\\Archive' });
  });

  it('rejects connection when CA file is missing or untrusted', async () => {
    await expect(
      listSelfHostedFolders({
        prisma,
        userId: testUserId,
        accountId: testAccountId,
        env: {
          SELF_HOSTED_IMAP_HOST: '127.0.0.1',
          SELF_HOSTED_IMAP_PORT: String(tlsPort),
          // No CA file -> rejectUnauthorized will reject self-signed cert
        },
      })
    ).rejects.toThrow('Self-hosted mailbox connection failed');
  });

  it('rejects connection when certificate hostname/SAN does not match server host even with trusted CA', async () => {
    await expect(
      listSelfHostedFolders({
        prisma,
        userId: testUserId,
        accountId: testAccountId,
        env: {
          SELF_HOSTED_IMAP_HOST: '127.0.0.1',
          SELF_HOSTED_IMAP_PORT: String(wrongHostTlsPort),
          SELF_HOSTED_TLS_CA_FILE: wrongHostCertPath,
        },
      })
    ).rejects.toThrow('Self-hosted mailbox connection failed');
  });

  it('completes syncSelfHostedAccount bootstrap over real TLS loopback', async () => {
    await syncSelfHostedAccount({
      prisma,
      emailAccountId: testAccountId,
      mode: 'bootstrap',
      env: {
        SELF_HOSTED_IMAP_HOST: '127.0.0.1',
        SELF_HOSTED_IMAP_PORT: String(tlsPort),
        SELF_HOSTED_TLS_CA_FILE: certPath,
      },
    });

    const folderStates = await prisma.selfHostedFolderState.findMany({
      where: { emailAccountId: testAccountId },
      orderBy: { folderPath: 'asc' },
    });
    expect(folderStates.map((s) => s.folderPath)).toEqual(['Archive', 'INBOX']);
    expect(folderStates.every((s) => s.uidValidity === 777n)).toBe(true);
  });

  it('rejects invalid port specifications in env', async () => {
    await expect(
      withSelfHostedImapClient(
        {
          prisma,
          userId: testUserId,
          accountId: testAccountId,
          env: {
            SELF_HOSTED_IMAP_HOST: '127.0.0.1',
            SELF_HOSTED_IMAP_PORT: 'invalid-port',
          },
        },
        async () => {}
      )
    ).rejects.toThrow('Self-hosted mail server is not configured');

    await expect(
      withSelfHostedImapClient(
        {
          prisma,
          userId: testUserId,
          accountId: testAccountId,
          env: {
            SELF_HOSTED_IMAP_HOST: '127.0.0.1',
            SELF_HOSTED_IMAP_PORT: '70000',
          },
        },
        async () => {}
      )
    ).rejects.toThrow('Self-hosted mail server is not configured');
  });

  describe.skipIf(!process.env.DOVECOT_TEST_HOST)('real Dovecot integration', () => {
    it('connects to real Dovecot test host when configured', async () => {
      const host = process.env.DOVECOT_TEST_HOST!;
      const port = process.env.DOVECOT_TEST_PORT ?? '993';
      const folders = await listSelfHostedFolders({
        prisma,
        userId: testUserId,
        accountId: testAccountId,
        env: {
          SELF_HOSTED_IMAP_HOST: host,
          SELF_HOSTED_IMAP_PORT: port,
          SELF_HOSTED_TLS_CA_FILE: process.env.DOVECOT_TEST_CA_FILE,
        },
      });
      expect(folders.length).toBeGreaterThan(0);
    });
  });
});
