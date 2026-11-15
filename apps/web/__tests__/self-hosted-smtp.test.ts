import { PrismaClient } from '@prisma/client';
import EmbeddedPostgres from 'embedded-postgres';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import net from 'node:net';
import tls from 'node:tls';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ImapFlow } from 'imapflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveSelfHostedCredential } from '../utils/mail-provider/self-hosted-credentials';
import {
  reconcileUncertainOutboundDelivery,
  sendSelfHostedSmtpMessage,
} from '../utils/mail-provider/self-hosted-smtp';

const execFileAsync = promisify(execFile);
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

function makeMimeMessage(input: {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  messageId: string;
}): Buffer {
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    ...(input.cc ? [`Cc: ${input.cc}`] : []),
    `Subject: ${input.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${input.messageId}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`,
  ];
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${input.body}`);
}

type SimulatedMessage = {
  uid: number;
  flags: Set<string>;
  internalDate: Date;
  source: Buffer;
};

type SimulatedMailbox = {
  uidValidity: bigint;
  messages: SimulatedMessage[];
};

function createSimulatedClient(mailboxes: Record<string, SimulatedMailbox>) {
  let open = false;
  let currentFolder = 'INBOX';

  const mockFolders = [
    { path: 'INBOX', specialUse: null },
    { path: 'Sent', specialUse: '\\Sent' },
    { path: 'Drafts', specialUse: '\\Drafts' },
  ];

  const client = {
    get isOpen() {
      return open;
    },
    on: vi.fn(),
    connect: vi.fn(async () => {
      open = true;
    }),
    close: vi.fn(() => {
      open = false;
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
    append: vi.fn(async (folder: string, source: Buffer, flags?: string[]) => {
      const mb = mailboxes[folder] ?? (mailboxes[folder] = { uidValidity: 300n, messages: [] });
      const nextUid = (mb.messages.length ? Math.max(...mb.messages.map((m) => m.uid)) : 0) + 1;
      mb.messages.push({
        uid: nextUid,
        flags: new Set(flags ?? []),
        internalDate: new Date(),
        source,
      });
      return { uid: nextUid, uidValidity: mb.uidValidity };
    }),
    messageDelete: vi.fn(async (uid: number) => {
      const mb = mailboxes[currentFolder];
      if (mb) {
        mb.messages = mb.messages.filter((m) => m.uid !== uid);
      }
      return true;
    }),
    get mailbox() {
      const mb = mailboxes[currentFolder] ?? { uidValidity: 300n, messages: [] };
      return {
        uidValidity: mb.uidValidity,
      };
    },
  };

  return client;
}

describe('self-hosted SMTP sender and delivery reconciliation', () => {
  let tempDir: string;
  let database: EmbeddedPostgres;
  let prisma: PrismaClient;
  let certPath: string;
  let keyPath: string;
  let wrongCertPath: string;
  let wrongKeyPath: string;

  let tlsServer: tls.Server;
  let tlsPort: number;

  let wrongCertTlsServer: tls.Server;
  let wrongCertTlsPort: number;

  let starttlsServer: net.Server;
  let starttlsPort: number;

  let testAccountId: string;
  const testUserId = 'test-smtp-user';

  const mockServerState = {
    dropInData: false,
    rejectInData: false,
    rejectAuth: false,
    starttlsAuthReceivedOverTls: false,
  };

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 42).toString('base64');
    tempDir = await mkdtemp(join(tmpdir(), 'oiz-smtp-test-'));
    certPath = join(tempDir, 'cert.pem');
    keyPath = join(tempDir, 'key.pem');
    wrongCertPath = join(tempDir, 'wrong-cert.pem');
    wrongKeyPath = join(tempDir, 'wrong-key.pem');

    // Ephemeral self-signed cert for IP:127.0.0.1
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

    // Cert with mismatched CN/SAN
    await execFileAsync('/usr/bin/openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      wrongKeyPath,
      '-out',
      wrongCertPath,
      '-days',
      '1',
      '-subj',
      '/CN=wrong.example.test',
      '-addext',
      'subjectAltName=DNS:wrong.example.test',
    ]);

    const cert = await readFile(certPath);
    const key = await readFile(keyPath);
    const wrongCert = await readFile(wrongCertPath);
    const wrongKey = await readFile(wrongKeyPath);

    // 1. Implicit TLS mock server
    tlsServer = tls.createServer({ cert, key }, (socket) => {
      let inData = false;
      let dataBuffer = '';
      let cmdBuffer = '';

      socket.write('220 smtp.example.test ESMTP Mock Ready\r\n');

      socket.on('data', (chunk) => {
        if (inData) {
          dataBuffer += chunk.toString('utf-8');
          if (dataBuffer.includes('\r\n.\r\n')) {
            inData = false;
            dataBuffer = '';
            if (mockServerState.dropInData) {
              socket.destroy();
              return;
            }
            if (mockServerState.rejectInData) {
              socket.write('554 5.7.1 Message rejected by content filter\r\n');
              return;
            }
            socket.write('250 2.0.0 OK message queued as mock-msg-123\r\n');
          }
          return;
        }

        cmdBuffer += chunk.toString('utf-8');
        while (cmdBuffer.includes('\r\n')) {
          const idx = cmdBuffer.indexOf('\r\n');
          const line = cmdBuffer.slice(0, idx);
          cmdBuffer = cmdBuffer.slice(idx + 2);

          const parts = line.split(' ');
          const verb = parts[0]?.toUpperCase();

          if (verb === 'EHLO' || verb === 'HELO') {
            socket.write('250-smtp.example.test\r\n250-AUTH PLAIN\r\n250-8BITMIME\r\n250 OK\r\n');
          } else if (verb === 'AUTH') {
            if (mockServerState.rejectAuth) {
              socket.write('535 5.7.8 Authentication credentials invalid\r\n');
            } else {
              socket.write('235 2.7.0 Authentication successful\r\n');
            }
          } else if (verb === 'MAIL') {
            socket.write('250 2.1.0 Sender OK\r\n');
          } else if (verb === 'RCPT') {
            if (line.includes('rejected@example.test')) {
              socket.write('550 5.1.1 Recipient unknown\r\n');
            } else {
              socket.write('250 2.1.5 Recipient OK\r\n');
            }
          } else if (verb === 'DATA') {
            inData = true;
            dataBuffer = '';
            socket.write('354 Start mail input; end with <CRLF>.<CRLF>\r\n');
          } else if (verb === 'QUIT') {
            socket.write('221 2.0.0 Bye\r\n');
            socket.end();
          } else {
            socket.write(`250 OK ${verb}\r\n`);
          }
        }
      });
    });

    await new Promise<void>((res) => tlsServer.listen(0, '127.0.0.1', res));
    const tlsAddr = tlsServer.address();
    if (!tlsAddr || typeof tlsAddr === 'string') throw new Error('Missing TLS port');
    tlsPort = tlsAddr.port;

    // 2. Untrusted cert TLS server
    wrongCertTlsServer = tls.createServer({ cert: wrongCert, key: wrongKey }, (socket) => {
      socket.write('220 wrong.example.test ESMTP\r\n');
    });
    await new Promise<void>((res) => wrongCertTlsServer.listen(0, '127.0.0.1', res));
    const wrongAddr = wrongCertTlsServer.address();
    if (!wrongAddr || typeof wrongAddr === 'string') throw new Error('Missing wrong TLS port');
    wrongCertTlsPort = wrongAddr.port;

    // 3. STARTTLS mock server
    starttlsServer = net.createServer((socket) => {
      let inData = false;
      let dataBuffer = '';
      let cmdBuffer = '';
      let activeTlsSocket: tls.TLSSocket | null = null;

      socket.write('220 smtp.example.test ESMTP Mock STARTTLS Ready\r\n');

      function handleCommand(line: string, sock: net.Socket | tls.TLSSocket) {
        const parts = line.split(' ');
        const verb = parts[0]?.toUpperCase();

        if (verb === 'EHLO' || verb === 'HELO') {
          if (activeTlsSocket) {
            sock.write('250-smtp.example.test\r\n250-AUTH PLAIN\r\n250 OK\r\n');
          } else {
            sock.write('250-smtp.example.test\r\n250-STARTTLS\r\n250 OK\r\n');
          }
        } else if (verb === 'STARTTLS') {
          sock.write('220 2.0.0 Ready to start TLS\r\n');
          socket.removeAllListeners('data');
          activeTlsSocket = new tls.TLSSocket(socket, { isServer: true, cert, key });
          activeTlsSocket.on('data', (tlsChunk) => {
            if (inData) {
              dataBuffer += tlsChunk.toString('utf-8');
              if (dataBuffer.includes('\r\n.\r\n')) {
                inData = false;
                dataBuffer = '';
                activeTlsSocket!.write('250 2.0.0 OK queued as starttls-mock-123\r\n');
              }
              return;
            }
            cmdBuffer += tlsChunk.toString('utf-8');
            while (cmdBuffer.includes('\r\n')) {
              const idx = cmdBuffer.indexOf('\r\n');
              const cmdLine = cmdBuffer.slice(0, idx);
              cmdBuffer = cmdBuffer.slice(idx + 2);
              handleCommand(cmdLine, activeTlsSocket!);
            }
          });
        } else if (verb === 'AUTH') {
          mockServerState.starttlsAuthReceivedOverTls = Boolean(activeTlsSocket);
          sock.write('235 2.7.0 Authentication successful\r\n');
        } else if (verb === 'MAIL') {
          sock.write('250 2.1.0 Sender OK\r\n');
        } else if (verb === 'RCPT') {
          sock.write('250 2.1.5 Recipient OK\r\n');
        } else if (verb === 'DATA') {
          inData = true;
          dataBuffer = '';
          sock.write('354 Start mail input; end with <CRLF>.<CRLF>\r\n');
        } else if (verb === 'QUIT') {
          sock.write('221 2.0.0 Bye\r\n');
          sock.end();
        } else {
          sock.write(`250 OK ${verb}\r\n`);
        }
      }

      socket.on('data', (chunk) => {
        cmdBuffer += chunk.toString('utf-8');
        while (cmdBuffer.includes('\r\n')) {
          const idx = cmdBuffer.indexOf('\r\n');
          const line = cmdBuffer.slice(0, idx);
          cmdBuffer = cmdBuffer.slice(idx + 2);
          handleCommand(line, socket);
        }
      });
    });

    await new Promise<void>((res) => starttlsServer.listen(0, '127.0.0.1', res));
    const starttlsAddr = starttlsServer.address();
    if (!starttlsAddr || typeof starttlsAddr === 'string') throw new Error('Missing STARTTLS port');
    starttlsPort = starttlsAddr.port;

    // Database setup
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

    await saveSelfHostedCredential({
      prisma,
      userId: testUserId,
      accountId: testAccountId,
      password: 'test-password',
    });
  }, 120_000);

  afterAll(async () => {
    try {
      if (tlsServer) await new Promise<void>((done) => tlsServer.close(() => done()));
      if (wrongCertTlsServer) await new Promise<void>((done) => wrongCertTlsServer.close(() => done()));
      if (starttlsServer) await new Promise<void>((done) => starttlsServer.close(() => done()));
      if (prisma) await prisma.$disconnect();
      if (database) await database.stop();
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  beforeEach(async () => {
    mockServerState.dropInData = false;
    mockServerState.rejectInData = false;
    mockServerState.rejectAuth = false;
    mockServerState.starttlsAuthReceivedOverTls = false;

    await prisma.outboundMessageDelivery.deleteMany({});
    await prisma.emailMessage.deleteMany({});
  });

  it('1. sends via implicit TLS, marks delivery COMPLETED, appends to Sent, and caches EmailMessage', async () => {
    const mailboxes: Record<string, SimulatedMailbox> = {
      Sent: { uidValidity: 300n, messages: [] },
      Drafts: { uidValidity: 400n, messages: [] },
    };
    const imapClient = createSimulatedClient(mailboxes);

    const result = await sendSelfHostedSmtpMessage({
      prisma,
      sessionUserId: testUserId,
      emailAccountId: testAccountId,
      userInitiated: true,
      to: 'bob@example.test',
      cc: 'carol@example.test',
      subject: 'Hello World',
      body: 'Body line 1\r\n.Stuffed line\r\nBody line 3',
      env: {
        SELF_HOSTED_SMTP_HOST: '127.0.0.1',
        SELF_HOSTED_SMTP_PORT: String(tlsPort),
        SELF_HOSTED_SMTP_TLS_MODE: 'implicit',
        SELF_HOSTED_TLS_CA_FILE: certPath,
        SELF_HOSTED_IMAP_HOST: '127.0.0.1',
      },
      createImapClient: () => imapClient as unknown as ImapFlow,
    });

    expect(result.deliveryId).toBeDefined();
    expect(result.rfc822MessageId).toMatch(/^<[a-f0-9-]+@example\.test>$/);

    const delivery = await prisma.outboundMessageDelivery.findUniqueOrThrow({
      where: { id: result.deliveryId },
    });
    expect(delivery.status).toBe('COMPLETED');
    expect(delivery.smtpResponse).toContain('mock-msg-123');
    expect(delivery.completedAt).not.toBeNull();

    // Check IMAP append
    expect(mailboxes.Sent.messages.length).toBe(1);
    expect(mailboxes.Sent.messages[0].flags.has('\\Seen')).toBe(true);

    // Check cached EmailMessage
    const cached = await prisma.emailMessage.findFirstOrThrow({
      where: {
        emailAccountId: testAccountId,
        headerMessageId: result.rfc822MessageId,
      },
    });
    expect(cached.subject).toBe('Hello World');
    expect(cached.labels).toContain('SENT');
    expect(cached.imapFolder).toBe('Sent');
  });

  it('2. performs STARTTLS upgrade flow before sending AUTH/MAIL/DATA over TLS', async () => {
    const result = await sendSelfHostedSmtpMessage({
      prisma,
      sessionUserId: testUserId,
      emailAccountId: testAccountId,
      userInitiated: true,
      to: 'bob@example.test',
      subject: 'Hello via STARTTLS',
      body: 'Encrypted message',
      env: {
        SELF_HOSTED_SMTP_HOST: '127.0.0.1',
        SELF_HOSTED_SMTP_PORT: String(starttlsPort),
        SELF_HOSTED_SMTP_TLS_MODE: 'starttls',
        SELF_HOSTED_TLS_CA_FILE: certPath,
      },
    });

    expect(mockServerState.starttlsAuthReceivedOverTls).toBe(true);
    const delivery = await prisma.outboundMessageDelivery.findUniqueOrThrow({
      where: { id: result.deliveryId },
    });
    expect(delivery.status).toBe('COMPLETED');
    expect(delivery.smtpResponse).toContain('starttls-mock-123');
  });

  it('3. rejects untrusted server TLS cert and marks delivery FAILED without leaking credentials', async () => {
    await expect(
      sendSelfHostedSmtpMessage({
        prisma,
        sessionUserId: testUserId,
        emailAccountId: testAccountId,
        userInitiated: true,
        to: 'bob@example.test',
        subject: 'Untrusted test',
        body: 'Will fail cert verification',
        env: {
          SELF_HOSTED_SMTP_HOST: '127.0.0.1',
          SELF_HOSTED_SMTP_PORT: String(wrongCertTlsPort),
          SELF_HOSTED_SMTP_TLS_MODE: 'implicit',
          SELF_HOSTED_TLS_CA_FILE: certPath,
        },
      })
    ).rejects.toThrow();

    const deliveries = await prisma.outboundMessageDelivery.findMany({
      where: { emailAccountId: testAccountId },
    });
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].status).toBe('FAILED');
    expect(deliveries[0].error).not.toContain('test-password');
  });

  it('4. enforces pilot mode user-initiation guards, sender alignment, and rejects CRLF injections pre-socket', async () => {
    // A: userInitiated: false in pilot mode
    await expect(
      sendSelfHostedSmtpMessage({
        prisma,
        sessionUserId: testUserId,
        emailAccountId: testAccountId,
        userInitiated: false,
        to: 'bob@example.test',
        subject: 'Pilot test',
        body: 'Pilot body',
        env: { PILOT_MODE: 'true' },
      })
    ).rejects.toThrow('Automatic sending and forwarding are disabled in pilot mode');

    // B: automated: true in pilot mode
    await expect(
      sendSelfHostedSmtpMessage({
        prisma,
        sessionUserId: testUserId,
        emailAccountId: testAccountId,
        userInitiated: true,
        automated: true,
        to: 'bob@example.test',
        subject: 'Pilot test',
        body: 'Pilot body',
        env: { PILOT_MODE: 'true' },
      })
    ).rejects.toThrow('Automatic sending and forwarding are disabled in pilot mode');

    // C: userInitiated: false with PILOT_MODE=false
    await expect(
      sendSelfHostedSmtpMessage({
        prisma,
        sessionUserId: testUserId,
        emailAccountId: testAccountId,
        userInitiated: false,
        to: 'bob@example.test',
        subject: 'Non-pilot test',
        body: 'Non-pilot body',
        env: { PILOT_MODE: 'false' },
      })
    ).rejects.toThrow('Explicit user initiation is required for outbound SMTP');

    // D: Sender spoof
    await expect(
      sendSelfHostedSmtpMessage({
        prisma,
        sessionUserId: testUserId,
        emailAccountId: testAccountId,
        userInitiated: true,
        from: 'spoof@attacker.test',
        to: 'bob@example.test',
        subject: 'Spoofed from',
        body: 'Body',
        env: {
          SELF_HOSTED_SMTP_HOST: '127.0.0.1',
          SELF_HOSTED_SMTP_PORT: String(tlsPort),
          SELF_HOSTED_SMTP_TLS_MODE: 'implicit',
          SELF_HOSTED_TLS_CA_FILE: certPath,
        },
      })
    ).rejects.toThrow('Sender alignment mismatch');

    // E: CRLF in recipient
    await expect(
      sendSelfHostedSmtpMessage({
        prisma,
        sessionUserId: testUserId,
        emailAccountId: testAccountId,
        userInitiated: true,
        to: 'bob@example.test\r\nBcc: evil@attacker.test',
        subject: 'CRLF recipient',
        body: 'Body',
        env: {
          SELF_HOSTED_SMTP_HOST: '127.0.0.1',
          SELF_HOSTED_SMTP_PORT: String(tlsPort),
          SELF_HOSTED_SMTP_TLS_MODE: 'implicit',
          SELF_HOSTED_TLS_CA_FILE: certPath,
        },
      })
    ).rejects.toThrow('newline detected');

    // F: CRLF in subject
    await expect(
      sendSelfHostedSmtpMessage({
        prisma,
        sessionUserId: testUserId,
        emailAccountId: testAccountId,
        userInitiated: true,
        to: 'bob@example.test',
        subject: 'CRLF\r\nSubject: Injected',
        body: 'Body',
        env: {
          SELF_HOSTED_SMTP_HOST: '127.0.0.1',
          SELF_HOSTED_SMTP_PORT: String(tlsPort),
          SELF_HOSTED_SMTP_TLS_MODE: 'implicit',
          SELF_HOSTED_TLS_CA_FILE: certPath,
        },
      })
    ).rejects.toThrow('Subject cannot contain newlines');

    // Verify 0 delivery rows were created for any of these pre-socket failures
    expect(await prisma.outboundMessageDelivery.count()).toBe(0);
  });

  it('5. marks pre-DATA SMTP rejections as FAILED and permits later retry once resolved', async () => {
    // 535 auth failure
    mockServerState.rejectAuth = true;
    await expect(
      sendSelfHostedSmtpMessage({
        prisma,
        sessionUserId: testUserId,
        emailAccountId: testAccountId,
        userInitiated: true,
        to: 'bob@example.test',
        subject: 'Auth failure test',
        body: 'Test body',
        env: {
          SELF_HOSTED_SMTP_HOST: '127.0.0.1',
          SELF_HOSTED_SMTP_PORT: String(tlsPort),
          SELF_HOSTED_SMTP_TLS_MODE: 'implicit',
          SELF_HOSTED_TLS_CA_FILE: certPath,
        },
      })
    ).rejects.toThrow('SMTP authentication failed: code 535');

    const failedAuthDelivery = await prisma.outboundMessageDelivery.findFirstOrThrow({
      where: { subject: 'Auth failure test' },
    });
    expect(failedAuthDelivery.status).toBe('FAILED');

    // Server recovers
    mockServerState.rejectAuth = false;

    // Retry sending same content succeeds now that error is resolved
    const retryResult = await sendSelfHostedSmtpMessage({
      prisma,
      sessionUserId: testUserId,
      emailAccountId: testAccountId,
      userInitiated: true,
      to: 'bob@example.test',
      subject: 'Auth failure test',
      body: 'Test body',
      env: {
        SELF_HOSTED_SMTP_HOST: '127.0.0.1',
        SELF_HOSTED_SMTP_PORT: String(tlsPort),
        SELF_HOSTED_SMTP_TLS_MODE: 'implicit',
        SELF_HOSTED_TLS_CA_FILE: certPath,
      },
    });

    expect(retryResult.deliveryId).not.toBe(failedAuthDelivery.id);
    const retryDelivery = await prisma.outboundMessageDelivery.findUniqueOrThrow({
      where: { id: retryResult.deliveryId },
    });
    expect(retryDelivery.status).toBe('COMPLETED');

    // 550 recipient rejected
    await expect(
      sendSelfHostedSmtpMessage({
        prisma,
        sessionUserId: testUserId,
        emailAccountId: testAccountId,
        userInitiated: true,
        to: 'rejected@example.test',
        subject: 'Recipient reject test',
        body: 'Test body',
        env: {
          SELF_HOSTED_SMTP_HOST: '127.0.0.1',
          SELF_HOSTED_SMTP_PORT: String(tlsPort),
          SELF_HOSTED_SMTP_TLS_MODE: 'implicit',
          SELF_HOSTED_TLS_CA_FILE: certPath,
        },
      })
    ).rejects.toThrow('SMTP RCPT TO rejected: code 550');

    const rcptFailedDelivery = await prisma.outboundMessageDelivery.findFirstOrThrow({
      where: { toEmail: 'rejected@example.test' },
    });
    expect(rcptFailedDelivery.status).toBe('FAILED');
  });

  it('6. marks mid-DATA socket drop as UNCERTAIN and blocks duplicate retries', async () => {
    mockServerState.dropInData = true;

    await expect(
      sendSelfHostedSmtpMessage({
        prisma,
        sessionUserId: testUserId,
        emailAccountId: testAccountId,
        userInitiated: true,
        draftId: 'draft-uncertain-1',
        to: 'bob@example.test',
        subject: 'Mid-DATA drop test',
        body: 'Body during socket drop',
        env: {
          SELF_HOSTED_SMTP_HOST: '127.0.0.1',
          SELF_HOSTED_SMTP_PORT: String(tlsPort),
          SELF_HOSTED_SMTP_TLS_MODE: 'implicit',
          SELF_HOSTED_TLS_CA_FILE: certPath,
        },
      })
    ).rejects.toThrow('Outbound delivery outcome is uncertain; reconcile Sent folder before retrying');

    const uncertainDelivery = await prisma.outboundMessageDelivery.findFirstOrThrow({
      where: { draftId: 'draft-uncertain-1' },
    });
    expect(uncertainDelivery.status).toBe('UNCERTAIN');

    // Attempting duplicate send with the same draftId and body is blocked!
    mockServerState.dropInData = false;
    await expect(
      sendSelfHostedSmtpMessage({
        prisma,
        sessionUserId: testUserId,
        emailAccountId: testAccountId,
        userInitiated: true,
        draftId: 'draft-uncertain-1',
        to: 'bob@example.test',
        subject: 'Mid-DATA drop test',
        body: 'Body during socket drop',
        env: {
          SELF_HOSTED_SMTP_HOST: '127.0.0.1',
          SELF_HOSTED_SMTP_PORT: String(tlsPort),
          SELF_HOSTED_SMTP_TLS_MODE: 'implicit',
          SELF_HOSTED_TLS_CA_FILE: certPath,
        },
      })
    ).rejects.toThrow('Duplicate outbound delivery detected');

    // Attempting send with same rfc822MessageId is also blocked
    await expect(
      sendSelfHostedSmtpMessage({
        prisma,
        sessionUserId: testUserId,
        emailAccountId: testAccountId,
        userInitiated: true,
        rfc822MessageId: uncertainDelivery.rfc822MessageId,
        to: 'other@example.test',
        subject: 'Different subject',
        body: 'Different body',
        env: {
          SELF_HOSTED_SMTP_HOST: '127.0.0.1',
          SELF_HOSTED_SMTP_PORT: String(tlsPort),
          SELF_HOSTED_SMTP_TLS_MODE: 'implicit',
          SELF_HOSTED_TLS_CA_FILE: certPath,
        },
      })
    ).rejects.toThrow('Duplicate outbound delivery detected');
  });

  it('7. reconcileUncertainOutboundDelivery transitions UNCERTAIN -> COMPLETED when found, UNCERTAIN -> FAILED when absent, and preserves UNCERTAIN on error', async () => {
    // Sub-case A: Message found in Sent folder -> COMPLETED
    const messageId1 = `<msg-reconcile-found-1@example.test>`;
    const deliveryFound = await prisma.outboundMessageDelivery.create({
      data: {
        emailAccountId: testAccountId,
        userId: testUserId,
        rfc822MessageId: messageId1,
        toEmail: 'bob@example.test',
        subject: 'Reconcile Found',
        bodyHash: 'hash-found',
        status: 'UNCERTAIN',
      },
    });

    const mailboxesFound: Record<string, SimulatedMailbox> = {
      Sent: {
        uidValidity: 300n,
        messages: [
          {
            uid: 101,
            flags: new Set(['\\Seen']),
            internalDate: new Date('2026-11-15T12:00:00Z'),
            source: makeMimeMessage({
              from: 'alice@example.test',
              to: 'bob@example.test',
              subject: 'Reconcile Found',
              body: 'Found body',
              messageId: messageId1,
            }),
          },
        ],
      },
      Drafts: { uidValidity: 400n, messages: [] },
    };
    const imapClientFound = createSimulatedClient(mailboxesFound);

    const reconFoundResult = await reconcileUncertainOutboundDelivery({
      prisma,
      sessionUserId: testUserId,
      deliveryId: deliveryFound.id,
      createImapClient: () => imapClientFound as unknown as ImapFlow,
    });

    expect(reconFoundResult.status).toBe('COMPLETED');
    const updatedFound = await prisma.outboundMessageDelivery.findUniqueOrThrow({
      where: { id: deliveryFound.id },
    });
    expect(updatedFound.status).toBe('COMPLETED');
    expect(updatedFound.smtpResponse).toBe('Reconciled in Sent folder');
    expect(updatedFound.completedAt).not.toBeNull();

    // Cached message created
    const cachedFound = await prisma.emailMessage.findFirstOrThrow({
      where: { emailAccountId: testAccountId, headerMessageId: messageId1 },
    });
    expect(cachedFound.labels).toContain('SENT');

    // Sub-case B: Message absent from Sent folder after scan -> FAILED
    const messageId2 = `<msg-reconcile-absent-2@example.test>`;
    const deliveryAbsent = await prisma.outboundMessageDelivery.create({
      data: {
        emailAccountId: testAccountId,
        userId: testUserId,
        rfc822MessageId: messageId2,
        toEmail: 'bob@example.test',
        subject: 'Reconcile Absent',
        bodyHash: 'hash-absent',
        status: 'UNCERTAIN',
      },
    });

    const mailboxesAbsent: Record<string, SimulatedMailbox> = {
      Sent: { uidValidity: 300n, messages: [] },
      Drafts: { uidValidity: 400n, messages: [] },
    };
    const imapClientAbsent = createSimulatedClient(mailboxesAbsent);

    const reconAbsentResult = await reconcileUncertainOutboundDelivery({
      prisma,
      sessionUserId: testUserId,
      deliveryId: deliveryAbsent.id,
      createImapClient: () => imapClientAbsent as unknown as ImapFlow,
    });

    expect(reconAbsentResult.status).toBe('FAILED');
    const updatedAbsent = await prisma.outboundMessageDelivery.findUniqueOrThrow({
      where: { id: deliveryAbsent.id },
    });
    expect(updatedAbsent.status).toBe('FAILED');
    expect(updatedAbsent.error).toBe('Confirmed absent in Sent folder after scan');

    // Sub-case C: IMAP error throws and leaves UNCERTAIN intact
    const messageId3 = `<msg-reconcile-error-3@example.test>`;
    const deliveryError = await prisma.outboundMessageDelivery.create({
      data: {
        emailAccountId: testAccountId,
        userId: testUserId,
        rfc822MessageId: messageId3,
        toEmail: 'bob@example.test',
        subject: 'Reconcile Error',
        bodyHash: 'hash-error',
        status: 'UNCERTAIN',
      },
    });

    const brokenClient = {
      connect: vi.fn(async () => {
        throw new Error('IMAP connection drop');
      }),
      close: vi.fn(),
      on: vi.fn(),
    };

    await expect(
      reconcileUncertainOutboundDelivery({
        prisma,
        sessionUserId: testUserId,
        deliveryId: deliveryError.id,
        createImapClient: () => brokenClient as unknown as ImapFlow,
      })
    ).rejects.toThrow();

    const untouchedDelivery = await prisma.outboundMessageDelivery.findUniqueOrThrow({
      where: { id: deliveryError.id },
    });
    expect(untouchedDelivery.status).toBe('UNCERTAIN');
  });
});
