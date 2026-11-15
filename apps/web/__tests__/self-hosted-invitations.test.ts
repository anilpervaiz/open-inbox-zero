import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import EmbeddedPostgres from 'embedded-postgres';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authConfiguration, createSessionAuth } from '../utils/auth/session-auth';
import {
  createMailboxInvitation,
  acceptMailboxInvitation,
  revokeMailboxInvitation,
  rotateSelfHostedMailboxPassword,
} from '../utils/auth/invitations';
import { getSelfHostedCredential } from '../utils/mail-provider/self-hosted-credentials';

const execFileAsync = promisify(execFile);
const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let prisma: PrismaClient;

vi.mock('../utils/server/prisma', () => ({
  get prisma() {
    return prisma;
  },
}));

vi.mock('../utils/server/public-rate-limit', () => ({
  publicRateLimitStore: () => ({
    consume: async () => ({ counts: [1, 1], retryAfterMs: 1000 }),
  }),
}));

const mockSessionUser = { id: 'dan-user-id' };
let currentSessionUser: { id: string } | null = mockSessionUser;

vi.mock('../utils/auth/session-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/auth/session-auth')>();
  return {
    ...actual,
    getSessionAuth: () => ({
      api: {
        getSession: vi.fn(async () => (currentSessionUser ? { user: currentSessionUser } : null)),
      },
    }),
  };
});

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Port unavailable');
  }
  const { port } = address;
  await new Promise<void>(done => server.close(() => done()));
  return port;
}

describe('self-hosted mailbox invitations and authentication', () => {
  let tempDir: string;
  let database: EmbeddedPostgres;
  let savedDbUrl: string | undefined;

  const encryptionKey = randomBytes(32).toString('base64');
  const adminInviteToken = 'admin-invite-secret-key-that-is-at-least-32-chars!';
  const authSecret = 'auth-secret-key-that-is-at-least-32-chars-long!';

  beforeAll(async () => {
    savedDbUrl = process.env.DATABASE_URL;
    process.env.TOKEN_ENCRYPTION_KEY = encryptionKey;
    process.env.ADMIN_INVITE_TOKEN = adminInviteToken;
    process.env.SELF_HOSTED_MAIL_DOMAIN = 'example.test';
    process.env.SELF_HOSTED_IMAP_HOST = 'mail.example.test';
    process.env.BETTER_AUTH_SECRET = authSecret;
    process.env.BETTER_AUTH_URL = 'http://localhost:3000';
    process.env.LOCAL_EMULATOR_MODE = '1';

    tempDir = await mkdtemp(join(tmpdir(), 'oiz-selfhosted-invitations-test-'));
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
  }, 120_000);

  afterAll(async () => {
    try {
      if (savedDbUrl !== undefined) process.env.DATABASE_URL = savedDbUrl;
      else delete process.env.DATABASE_URL;
      delete process.env.TOKEN_ENCRYPTION_KEY;
      delete process.env.ADMIN_INVITE_TOKEN;
      delete process.env.SELF_HOSTED_MAIL_DOMAIN;
      delete process.env.SELF_HOSTED_IMAP_HOST;
      delete process.env.BETTER_AUTH_SECRET;
      delete process.env.BETTER_AUTH_URL;
      delete process.env.LOCAL_EMULATOR_MODE;
      if (prisma) await prisma.$disconnect();
      if (database) await database.stop();
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
    } catch {
      // teardown cleanup
    }
  });

  it('1. rejects public registration via Better Auth and enables self-hosted auth without OAuth providers', async () => {
    const config = authConfiguration({
      BETTER_AUTH_SECRET: authSecret,
      BETTER_AUTH_URL: 'http://localhost:3000',
      SELF_HOSTED_MAIL_DOMAIN: 'example.test',
    });
    expect(config).not.toBeNull();
    expect(config?.selfHosted).toBe(true);
    expect(config?.google).toBeUndefined();
    expect(config?.microsoft).toBeUndefined();

    const auth = createSessionAuth(config!, prisma);
    await expect(
      auth.api.signUpEmail({
        body: {
          email: 'public-stranger@example.test',
          password: 'password123456',
          name: 'Stranger',
        },
      })
    ).rejects.toThrow();
  });

  it('2. rejects emails outside SELF_HOSTED_MAIL_DOMAIN and stores only SHA-256 tokenHash', async () => {
    await expect(
      createMailboxInvitation({
        prisma,
        email: 'alice@attacker.com',
        adminActor: 'admin-1',
      })
    ).rejects.toThrow('Email domain must match configured domain: example.test');

    const created = await createMailboxInvitation({
      prisma,
      email: 'alice@example.test',
      adminActor: 'admin-1',
    });

    expect(created.token).toBeDefined();
    expect(created.email).toBe('alice@example.test');

    const row = await prisma.mailboxInvitation.findUnique({
      where: { id: created.invitationId },
    });
    expect(row).not.toBeNull();
    // Raw token must never be persisted in the database!
    expect(row!.tokenHash).not.toBe(created.token);
    const expectedHash = createHash('sha256').update(created.token).digest('hex');
    expect(row!.tokenHash).toBe(expectedHash);
  });

  it('3. fails closed for expired, revoked, and replayed invitation tokens', async () => {
    // 3a: Expired token
    const inviteExp = await createMailboxInvitation({
      prisma,
      email: 'bob@example.test',
      adminActor: 'admin-1',
    });
    await prisma.mailboxInvitation.update({
      where: { id: inviteExp.invitationId },
      data: { expiresAt: new Date(Date.now() - 10_000) },
    });
    await expect(
      acceptMailboxInvitation({
        prisma,
        token: inviteExp.token,
        loginPassword: 'SuperPassword1234!',
        mailboxPassword: 'mailbox-pass-1',
        verifyMailbox: false,
      })
    ).rejects.toThrow('Invalid or expired invitation token');

    // 3b: Revoked token
    const inviteRev = await createMailboxInvitation({
      prisma,
      email: 'charlie@example.test',
      adminActor: 'admin-1',
    });
    const revokeResult = await revokeMailboxInvitation({
      prisma,
      invitationId: inviteRev.invitationId,
    });
    expect(revokeResult.revoked).toBe(true);

    // Revoking again fails
    await expect(
      revokeMailboxInvitation({ prisma, invitationId: inviteRev.invitationId })
    ).rejects.toThrow('Invitation not found or already processed');

    await expect(
      acceptMailboxInvitation({
        prisma,
        token: inviteRev.token,
        loginPassword: 'SuperPassword1234!',
        mailboxPassword: 'mailbox-pass-1',
        verifyMailbox: false,
      })
    ).rejects.toThrow('Invalid or expired invitation token');

    // 3c: Replayed token
    const inviteRep = await createMailboxInvitation({
      prisma,
      email: 'replay@example.test',
      adminActor: 'admin-1',
    });
    await acceptMailboxInvitation({
      prisma,
      token: inviteRep.token,
      loginPassword: 'SuperPassword1234!',
      mailboxPassword: 'mailbox-pass-1',
      verifyMailbox: false,
    });
    // Second attempt fails closed
    await expect(
      acceptMailboxInvitation({
        prisma,
        token: inviteRep.token,
        loginPassword: 'SuperPassword1234!',
        mailboxPassword: 'mailbox-pass-1',
        verifyMailbox: false,
      })
    ).rejects.toThrow();
  });

  it('4. accepts valid invitation, creates all entities, enqueues bootstrap sync, and signs in via signInEmail', async () => {
    const inviteDan = await createMailboxInvitation({
      prisma,
      email: 'dan@example.test',
      adminActor: 'admin-1',
    });

    const bootstrapFn = vi.fn(async () => {});

    const accepted = await acceptMailboxInvitation({
      prisma,
      token: inviteDan.token,
      name: 'Dan User',
      loginPassword: 'DanSuperSecurePassword123!',
      mailboxPassword: 'dan-mailbox-pass-99',
      verifyMailbox: false,
      enqueueBootstrap: bootstrapFn,
    });

    expect(accepted.email).toBe('dan@example.test');
    expect(accepted.userId).toBeDefined();
    expect(accepted.emailAccountId).toBeDefined();
    expect(bootstrapFn).toHaveBeenCalledWith(accepted.emailAccountId);

    // Verify User
    const user = await prisma.user.findUnique({ where: { id: accepted.userId } });
    expect(user).not.toBeNull();
    expect(user!.email).toBe('dan@example.test');
    expect(user!.name).toBe('Dan User');
    expect(user!.emailVerified).toBe(true);

    // Verify AuthAccount
    const authAccount = await prisma.authAccount.findUnique({
      where: {
        providerId_accountId: {
          providerId: 'credential',
          accountId: accepted.userId,
        },
      },
    });
    expect(authAccount).not.toBeNull();
    expect(authAccount!.userId).toBe(accepted.userId);
    expect(authAccount!.password).toBeDefined();

    // Verify EmailAccount
    const emailAccount = await prisma.emailAccount.findUnique({
      where: { id: accepted.emailAccountId },
    });
    expect(emailAccount).not.toBeNull();
    expect(emailAccount!.provider).toBe('selfhosted');
    expect(emailAccount!.initialSyncStatus).toBe('PENDING');

    // Verify SelfHostedCredential decryptable
    const cred = await getSelfHostedCredential({
      prisma,
      userId: accepted.userId,
      accountId: accepted.emailAccountId,
    });
    expect(cred).toEqual({
      username: 'dan@example.test',
      password: 'dan-mailbox-pass-99',
    });

    // Real Better Auth signInEmail
    const config = authConfiguration({
      BETTER_AUTH_SECRET: authSecret,
      BETTER_AUTH_URL: 'http://localhost:3000',
      SELF_HOSTED_MAIL_DOMAIN: 'example.test',
    });
    const auth = createSessionAuth(config!, prisma);

    const sessionResult = await auth.api.signInEmail({
      body: {
        email: 'dan@example.test',
        password: 'DanSuperSecurePassword123!',
      },
    });
    expect(sessionResult.user.email).toBe('dan@example.test');
    expect(sessionResult.token).toBeDefined();

    // Wrong password fails
    await expect(
      auth.api.signInEmail({
        body: {
          email: 'dan@example.test',
          password: 'IncorrectPassword123!',
        },
      })
    ).rejects.toThrow();
  });

  it('5. fails closed on cross-user mailbox password rotation without modifying the owner credential', async () => {
    // Dan's account
    const danAccount = await prisma.emailAccount.findFirst({
      where: { email: 'dan@example.test' },
    });
    expect(danAccount).not.toBeNull();

    // Another user: Eve
    const eveUser = await prisma.user.create({
      data: {
        email: 'eve@example.test',
        name: 'Eve Attacker',
      },
    });

    // Eve attempts to rotate Dan's mailbox password
    await expect(
      rotateSelfHostedMailboxPassword({
        prisma,
        sessionUserId: eveUser.id,
        emailAccountId: danAccount!.id,
        newMailboxPassword: 'hacked-password-1234',
        verifyImap: false,
      })
    ).rejects.toThrow('Mailbox unavailable');

    // Verify Dan's password was NOT changed
    const cred = await getSelfHostedCredential({
      prisma,
      userId: danAccount!.userId,
      accountId: danAccount!.id,
    });
    expect(cred.password).toBe('dan-mailbox-pass-99');
  });

  it('6. updates SelfHostedCredential on IMAP verification success and rolls back on failure', async () => {
    const danAccount = await prisma.emailAccount.findFirst({
      where: { email: 'dan@example.test' },
    });
    expect(danAccount).not.toBeNull();

    // 6a: Successful rotation with mock IMAP client
    const mockSuccessClient = {
      connect: vi.fn(async () => {}),
      close: vi.fn(),
      on: vi.fn(),
      list: vi.fn(async () => [{ path: 'INBOX', specialUse: '\\Inbox' }]),
    };

    const rotateSuccess = await rotateSelfHostedMailboxPassword({
      prisma,
      sessionUserId: danAccount!.userId,
      emailAccountId: danAccount!.id,
      newMailboxPassword: 'dan-rotated-password-1',
      verifyImap: true,
      createClient: () => mockSuccessClient as unknown as import('imapflow').ImapFlow,
    });
    expect(rotateSuccess.rotated).toBe(true);

    const updatedCred = await getSelfHostedCredential({
      prisma,
      userId: danAccount!.userId,
      accountId: danAccount!.id,
    });
    expect(updatedCred.password).toBe('dan-rotated-password-1');

    // 6b: Failed rotation rolls back to previous credential
    const mockFailClient = {
      connect: vi.fn(async () => {
        throw new Error('IMAP authentication failed');
      }),
      close: vi.fn(),
      on: vi.fn(),
    };

    await expect(
      rotateSelfHostedMailboxPassword({
        prisma,
        sessionUserId: danAccount!.userId,
        emailAccountId: danAccount!.id,
        newMailboxPassword: 'dan-broken-password',
        verifyImap: true,
        createClient: () => mockFailClient as unknown as import('imapflow').ImapFlow,
      })
    ).rejects.toThrow();

    // Verified rollback: old working password is restored!
    const rolledBackCred = await getSelfHostedCredential({
      prisma,
      userId: danAccount!.userId,
      accountId: danAccount!.id,
    });
    expect(rolledBackCred.password).toBe('dan-rotated-password-1');
  });

  it('7. /api/auth/invite route enforces admin token on create, accepts invites, and enforces owner session on rotate', async () => {
    const { POST: inviteRoute } = await import('../app/api/auth/invite/route');

    // 7a: Create without admin token fails 401
    const createReqUnauthorized = new Request('http://localhost:3000/api/auth/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create', email: 'route-test@example.test' }),
    });
    const resUnauth = await inviteRoute(createReqUnauthorized);
    expect(resUnauth.status).toBe(401);

    // 7b: Create with valid admin token succeeds 201
    const createReq = new Request('http://localhost:3000/api/auth/invite', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-invite-token': adminInviteToken,
      },
      body: JSON.stringify({ action: 'create', email: 'route-test@example.test' }),
    });
    const resCreate = await inviteRoute(createReq);
    expect(resCreate.status).toBe(201);
    expect(resCreate.headers.get('cache-control')).toBe('no-store');
    const { invitation } = await resCreate.json();
    expect(invitation.email).toBe('route-test@example.test');
    expect(invitation.token).toBeDefined();

    // 7c: Accept invite via route succeeds 201
    const acceptReq = new Request('http://localhost:3000/api/auth/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'accept',
        token: invitation.token,
        name: 'Route Test User',
        loginPassword: 'SuperRoutePassword123!',
        mailboxPassword: 'route-mailbox-pass-1',
      }),
    });
    const resAccept = await inviteRoute(acceptReq);
    expect(resAccept.status).toBe(201);
    const acceptedData = await resAccept.json();
    expect(acceptedData.email).toBe('route-test@example.test');
    expect(acceptedData.userId).toBeDefined();
    expect(acceptedData.emailAccountId).toBeDefined();

    // 7d: Rotate password requires same-origin
    const rotateNoOrigin = new Request('http://localhost:3000/api/auth/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'rotate-password',
        emailAccountId: acceptedData.emailAccountId,
        newMailboxPassword: 'new-route-password',
      }),
    });
    expect((await inviteRoute(rotateNoOrigin)).status).toBe(403);

    // 7e: Rotate password requires session
    currentSessionUser = null;
    const rotateNoSession = new Request('http://localhost:3000/api/auth/invite', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify({
        action: 'rotate-password',
        emailAccountId: acceptedData.emailAccountId,
        newMailboxPassword: 'new-route-password',
      }),
    });
    expect((await inviteRoute(rotateNoSession)).status).toBe(401);

    // 7f: Rotate password with owner session succeeds 200
    currentSessionUser = { id: acceptedData.userId };
    const rotateWithSession = new Request('http://localhost:3000/api/auth/invite', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify({
        action: 'rotate-password',
        emailAccountId: acceptedData.emailAccountId,
        newMailboxPassword: 'new-route-password-1234',
      }),
    });
    const resRotate = await inviteRoute(rotateWithSession);
    expect(resRotate.status).toBe(200);
    const rotateData = await resRotate.json();
    expect(rotateData.rotated).toBe(true);

    const rotatedCred = await getSelfHostedCredential({
      prisma,
      userId: acceptedData.userId,
      accountId: acceptedData.emailAccountId,
    });
    expect(rotatedCred.password).toBe('new-route-password-1234');
  });
});
