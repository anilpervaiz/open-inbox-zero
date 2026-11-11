import { z } from 'zod';
import { getSessionAuth } from '../../../../utils/auth/session-auth';
import { connectOAuthMailbox } from '../../../../utils/auth/connect-mailbox';
import { prisma } from '../../../../utils/server/prisma';
import { checkRateLimit } from '../../../../utils/rate-limit';
import { publicRateLimitStore } from '../../../../utils/server/public-rate-limit';
import { readJsonBody } from '../../../../utils/webhooks/request';

const bodySchema = z.object({ authAccountId: z.string().min(1).max(256) }).strict();
export async function POST(request: Request): Promise<Response> {
  const auth = getSessionAuth();
  if (!auth) return Response.json({ error: 'Sign-in is not configured' }, { status: 503 });
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin) return Response.json({ error: 'Forbidden' }, { status: 403 });
  let session;
  try { session = await auth.api.getSession({ headers: request.headers }); }
  catch { return Response.json({ error: 'Service unavailable' }, { status: 503 }); }
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const limit = await checkRateLimit({ store: publicRateLimitStore(), scope: 'mailbox-connect', clientIp: 'unattributed', accountId: session.user.id, limit: 30, windowMs: 60_000 });
    if (!limit.allowed) return Response.json({ error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } });
  } catch { return Response.json({ error: 'Service unavailable' }, { status: 503 }); }
  let data: z.infer<typeof bodySchema>;
  try { data = bodySchema.parse(await readJsonBody(request, 16_384)); }
  catch { return Response.json({ error: 'Invalid request' }, { status: 400 }); }
  try {
    const mailbox = await connectOAuthMailbox({ prisma, userId: session.user.id, authAccountId: data.authAccountId, getAccessToken: async (accountId, userId) => (await auth.api.getAccessToken({ body: { accountId, userId } })).accessToken });
    return Response.json({ mailbox }, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ error: 'Mailbox could not be connected' }, { status: 400 }); }
}
