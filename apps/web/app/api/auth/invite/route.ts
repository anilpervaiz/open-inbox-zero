import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../../../utils/server/prisma';
import { getSessionAuth } from '../../../../utils/auth/session-auth';
import { checkRateLimit } from '../../../../utils/rate-limit';
import { publicRateLimitStore } from '../../../../utils/server/public-rate-limit';
import { readJsonBody } from '../../../../utils/webhooks/request';
import {
  createMailboxInvitation,
  acceptMailboxInvitation,
  rotateSelfHostedMailboxPassword,
} from '../../../../utils/auth/invitations';
import { enqueueProviderSync, getProviderSyncQueue } from '../../../../utils/worker/provider-sync-queue';

export const dynamic = 'force-dynamic';

const createSchema = z.object({
  action: z.literal('create'),
  email: z.string().email().max(320),
  ttlHours: z.number().int().min(1).max(168).optional(),
}).strict();

const acceptSchema = z.object({
  action: z.literal('accept'),
  token: z.string().min(1).max(256),
  name: z.string().max(256).optional(),
  loginPassword: z.string().min(12).max(256),
  mailboxPassword: z.string().min(1).max(1024),
}).strict();

const rotatePasswordSchema = z.object({
  action: z.literal('rotate-password'),
  emailAccountId: z.string().min(1).max(256),
  newMailboxPassword: z.string().min(1).max(1024),
}).strict();

const requestSchema = z.discriminatedUnion('action', [
  createSchema,
  acceptSchema,
  rotatePasswordSchema,
]);

function timingSafeMatch(headerValue: string | null, expectedToken: string): boolean {
  if (!headerValue) return false;
  const token = headerValue.startsWith('Bearer ') ? headerValue.slice(7).trim() : headerValue.trim();
  if (!token) return false;
  const a = Buffer.from(token, 'utf-8');
  const b = Buffer.from(expectedToken, 'utf-8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<Response> {
  try {
    const limit = await checkRateLimit({
      store: publicRateLimitStore(),
      scope: 'auth-invite',
      clientIp: 'unattributed',
      accountId: 'anonymous',
      limit: 60,
      windowMs: 60_000,
    });
    if (!limit.allowed) {
      return Response.json(
        { error: 'Too many requests' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds), 'Cache-Control': 'no-store' } }
      );
    }
  } catch {
    return Response.json({ error: 'Service unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, 16_384);
  } catch {
    return Response.json({ error: 'Invalid request' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'Invalid request' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  const data = parsed.data;

  if (data.action === 'create') {
    const adminToken = process.env.ADMIN_INVITE_TOKEN;
    if (!adminToken || adminToken.length < 32) {
      return Response.json({ error: 'Admin invitations not configured' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    const authHeader = request.headers.get('x-admin-invite-token') ?? request.headers.get('authorization');
    if (!timingSafeMatch(authHeader, adminToken)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    }
    try {
      const result = await createMailboxInvitation({
        prisma,
        email: data.email,
        adminActor: 'admin-token',
        ttlHours: data.ttlHours,
      });
      return Response.json(
        {
          invitation: {
            id: result.invitationId,
            email: result.email,
            expiresAt: result.expiresAt,
            token: result.token,
          },
        },
        { status: 201, headers: { 'Cache-Control': 'no-store' } }
      );
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : 'Failed to create invitation' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }
  }

  if (data.action === 'accept') {
    let enqueueBootstrap: ((accountId: string) => Promise<void>) | undefined;
    try {
      const queue = getProviderSyncQueue();
      enqueueBootstrap = async (accountId: string) => {
        await enqueueProviderSync(queue, { provider: 'bootstrap', emailAccountId: accountId });
      };
    } catch {
      // queue unavailable in test or unconfigured environment
    }

    try {
      const result = await acceptMailboxInvitation({
        prisma,
        token: data.token,
        name: data.name,
        loginPassword: data.loginPassword,
        mailboxPassword: data.mailboxPassword,
        enqueueBootstrap,
      });
      return Response.json(
        {
          userId: result.userId,
          emailAccountId: result.emailAccountId,
          email: result.email,
        },
        { status: 201, headers: { 'Cache-Control': 'no-store' } }
      );
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : 'Failed to accept invitation' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }
  }

  // data.action === 'rotate-password'
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin) {
    return Response.json({ error: 'Forbidden' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const auth = getSessionAuth();
  if (!auth) {
    return Response.json({ error: 'Sign-in is not configured' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }

  let session;
  try {
    session = await auth.api.getSession({ headers: request.headers });
  } catch {
    return Response.json({ error: 'Service unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }

  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    await rotateSelfHostedMailboxPassword({
      prisma,
      sessionUserId: session.user.id,
      emailAccountId: data.emailAccountId,
      newMailboxPassword: data.newMailboxPassword,
    });
    return Response.json({ rotated: true }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'Failed to rotate password' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
