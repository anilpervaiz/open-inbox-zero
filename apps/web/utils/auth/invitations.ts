import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { hashPassword } from 'better-auth/crypto';
import { z } from 'zod';
import { encryptToken } from '../encryption';
import { listSelfHostedFolders } from '../mail-provider/self-hosted-imap';

const emailSchema = z.string().email().max(320);

export function getConfiguredMailDomain(env: Record<string, string | undefined> = process.env): string {
  const domain = env.SELF_HOSTED_MAIL_DOMAIN?.trim().toLowerCase();
  if (!domain || domain.length > 253 || !domain.includes('.') || domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
    throw new Error('Self-hosted mail domain is not configured');
  }
  return domain;
}

export function validateMailboxEmail(email: string, env: Record<string, string | undefined> = process.env): string {
  const parsed = emailSchema.safeParse(email.trim());
  if (!parsed.success) {
    throw new Error('Invalid email address format');
  }
  const normalized = parsed.data.toLowerCase();
  const atIndex = normalized.lastIndexOf('@');
  if (atIndex === -1) {
    throw new Error('Invalid email address format');
  }
  const emailDomain = normalized.slice(atIndex + 1);
  const expectedDomain = getConfiguredMailDomain(env);
  if (emailDomain !== expectedDomain) {
    throw new Error(`Email domain must match configured domain: ${expectedDomain}`);
  }
  return normalized;
}

export interface CreateInvitationInput {
  prisma: PrismaClient;
  email: string;
  adminActor: string;
  ttlHours?: number;
  env?: Record<string, string | undefined>;
}

export interface CreateInvitationResult {
  invitationId: string;
  email: string;
  token: string;
  expiresAt: Date;
}

export async function createMailboxInvitation(input: CreateInvitationInput): Promise<CreateInvitationResult> {
  const { prisma, email, adminActor, ttlHours = 48, env } = input;
  if (!adminActor || typeof adminActor !== 'string' || adminActor.trim().length === 0) {
    throw new Error('Admin actor is required');
  }
  if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 168) {
    throw new Error('TTL hours must be an integer between 1 and 168');
  }
  const normalizedEmail = validateMailboxEmail(email, env);
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);

  const invitation = await prisma.mailboxInvitation.create({
    data: {
      email: normalizedEmail,
      tokenHash,
      createdByAdmin: adminActor.trim(),
      expiresAt,
    },
    select: {
      id: true,
      email: true,
      expiresAt: true,
    },
  });

  return {
    invitationId: invitation.id,
    email: invitation.email,
    token,
    expiresAt: invitation.expiresAt,
  };
}

export interface RevokeInvitationInput {
  prisma: PrismaClient;
  invitationId: string;
}

export async function revokeMailboxInvitation(input: RevokeInvitationInput): Promise<{ revoked: true }> {
  const { prisma, invitationId } = input;
  if (!invitationId || typeof invitationId !== 'string') {
    throw new Error('Invitation ID is required');
  }
  const now = new Date();
  const updated = await prisma.mailboxInvitation.updateMany({
    where: {
      id: invitationId,
      acceptedAt: null,
      revokedAt: null,
    },
    data: {
      revokedAt: now,
    },
  });

  if (updated.count !== 1) {
    throw new Error('Invitation not found or already processed');
  }
  return { revoked: true };
}

export interface AcceptInvitationInput {
  prisma: PrismaClient;
  token: string;
  name?: string | null;
  loginPassword: string;
  mailboxPassword: string;
  env?: Record<string, string | undefined>;
  createClient?: Parameters<typeof listSelfHostedFolders>[0]['createClient'];
  verifyMailbox?: boolean;
  enqueueBootstrap?: (emailAccountId: string) => Promise<void>;
}

export interface AcceptInvitationResult {
  userId: string;
  emailAccountId: string;
  email: string;
}

export async function acceptMailboxInvitation(input: AcceptInvitationInput): Promise<AcceptInvitationResult> {
  const { prisma, token, name, loginPassword, mailboxPassword, env, createClient, verifyMailbox, enqueueBootstrap } = input;

  if (!token || typeof token !== 'string') {
    throw new Error('Invitation token is required');
  }
  if (!loginPassword || typeof loginPassword !== 'string' || loginPassword.length < 12 || loginPassword.length > 256) {
    throw new Error('Login password must be between 12 and 256 characters');
  }
  if (!mailboxPassword || typeof mailboxPassword !== 'string' || mailboxPassword.length < 1 || mailboxPassword.length > 1024) {
    throw new Error('Invalid mailbox credentials');
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');
  const invitation = await prisma.mailboxInvitation.findUnique({
    where: { tokenHash },
  });

  if (!invitation) {
    throw new Error('Invalid or expired invitation token');
  }
  const now = new Date();
  if (invitation.revokedAt !== null || invitation.acceptedAt !== null || invitation.expiresAt <= now) {
    throw new Error('Invalid or expired invitation token');
  }

  const normalizedEmail = invitation.email.toLowerCase();
  const existingUser = await prisma.user.findFirst({
    where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
  });
  if (existingUser) {
    throw new Error('An account already exists for this email address');
  }

  const existingEmailAccount = await prisma.emailAccount.findFirst({
    where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
  });
  if (existingEmailAccount) {
    throw new Error('A mailbox already exists for this email address');
  }

  const hashedLoginPassword = await hashPassword(loginPassword);

  const result = await prisma.$transaction(async tx => {
    const claim = await tx.mailboxInvitation.updateMany({
      where: {
        id: invitation.id,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        acceptedAt: now,
      },
    });
    if (claim.count !== 1) {
      throw new Error('Invitation is no longer valid');
    }

    const user = await tx.user.create({
      data: {
        email: normalizedEmail,
        name: name?.trim() || null,
        emailVerified: true,
      },
    });

    await tx.authAccount.create({
      data: {
        id: randomUUID(),
        userId: user.id,
        providerId: 'credential',
        accountId: user.id,
        password: hashedLoginPassword,
      },
    });

    const emailAccount = await tx.emailAccount.create({
      data: {
        userId: user.id,
        email: normalizedEmail,
        provider: 'selfhosted',
        initialSyncStatus: 'PENDING',
      },
    });

    const secretPayload = {
      version: 1,
      accountId: emailAccount.id,
      userId: user.id,
      email: emailAccount.email,
      password: mailboxPassword,
    };
    const encryptedSecret = encryptToken(JSON.stringify(secretPayload));

    await tx.selfHostedCredential.create({
      data: {
        emailAccountId: emailAccount.id,
        encryptedSecret,
      },
    });

    await tx.mailboxInvitation.update({
      where: { id: invitation.id },
      data: {
        userId: user.id,
      },
    });

    return {
      userId: user.id,
      emailAccountId: emailAccount.id,
      email: emailAccount.email,
    };
  });

  const currentEnv = env ?? process.env;
  const shouldVerify = verifyMailbox !== false && (Boolean(createClient) || (verifyMailbox === true && Boolean(currentEnv.SELF_HOSTED_IMAP_HOST)));
  if (shouldVerify) {
    try {
      await listSelfHostedFolders({
        prisma,
        userId: result.userId,
        accountId: result.emailAccountId,
        env: currentEnv,
        createClient,
      });
    } catch (err) {
      await prisma.$transaction(async tx => {
        await tx.user.delete({ where: { id: result.userId } }).catch(() => {});
        await tx.mailboxInvitation.update({
          where: { id: invitation.id },
          data: { acceptedAt: null, userId: null },
        }).catch(() => {});
      }).catch(() => {});
      throw err;
    }
  }

  if (enqueueBootstrap) {
    await enqueueBootstrap(result.emailAccountId);
  }

  return result;
}

export interface RotateMailboxPasswordInput {
  prisma: PrismaClient;
  sessionUserId: string;
  emailAccountId: string;
  newMailboxPassword: string;
  env?: Record<string, string | undefined>;
  createClient?: Parameters<typeof listSelfHostedFolders>[0]['createClient'];
  verifyImap?: boolean;
}

export async function rotateSelfHostedMailboxPassword(input: RotateMailboxPasswordInput): Promise<{ rotated: true }> {
  const { prisma, sessionUserId, emailAccountId, newMailboxPassword, env, createClient, verifyImap } = input;

  if (!sessionUserId || typeof sessionUserId !== 'string') {
    throw new Error('Unauthorized');
  }
  if (!emailAccountId || typeof emailAccountId !== 'string') {
    throw new Error('Mailbox is required');
  }
  if (!newMailboxPassword || typeof newMailboxPassword !== 'string' || newMailboxPassword.length > 1024) {
    throw new Error('Invalid mailbox credentials');
  }

  const account = await prisma.emailAccount.findFirst({
    where: {
      id: emailAccountId,
      userId: sessionUserId,
      provider: 'selfhosted',
    },
    select: {
      id: true,
      userId: true,
      email: true,
      selfHostedCredential: { select: { encryptedSecret: true } },
    },
  });

  if (!account) {
    throw new Error('Mailbox unavailable');
  }

  const currentEnv = env ?? process.env;
  const shouldVerify = verifyImap !== false && (Boolean(createClient) || (verifyImap === true && Boolean(currentEnv.SELF_HOSTED_IMAP_HOST)));
  const previousSecret = account.selfHostedCredential?.encryptedSecret;

  const secretPayload = {
    version: 1,
    accountId: account.id,
    userId: account.userId,
    email: account.email,
    password: newMailboxPassword,
  };
  const encryptedSecret = encryptToken(JSON.stringify(secretPayload));

  await prisma.selfHostedCredential.upsert({
    where: { emailAccountId: account.id },
    create: {
      emailAccountId: account.id,
      encryptedSecret,
    },
    update: {
      encryptedSecret,
    },
  });

  if (shouldVerify) {
    try {
      await listSelfHostedFolders({
        prisma,
        userId: sessionUserId,
        accountId: emailAccountId,
        env: currentEnv,
        createClient,
      });
    } catch (err) {
      if (previousSecret) {
        await prisma.selfHostedCredential.update({
          where: { emailAccountId: account.id },
          data: { encryptedSecret: previousSecret },
        });
      } else {
        await prisma.selfHostedCredential.delete({
          where: { emailAccountId: account.id },
        });
      }
      throw err;
    }
  }

  return { rotated: true };
}
