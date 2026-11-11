import { toNextJsHandler } from 'better-auth/next-js';
import { getSessionAuth } from '../../../../utils/auth/session-auth';
import { checkRateLimit } from '../../../../utils/rate-limit';
import { publicRateLimitStore } from '../../../../utils/server/public-rate-limit';

export const dynamic = 'force-dynamic';
function unavailable() { return Response.json({ error: 'Sign-in is not configured' }, { status: 503 }); }
async function handle(request: Request, method: 'GET' | 'POST') {
  const auth = getSessionAuth();
  if (!auth) return unavailable();
  try {
    const result = await checkRateLimit({ store: publicRateLimitStore(), scope: 'auth', clientIp: 'unattributed', accountId: 'anonymous', limit: 120, windowMs: 60_000 });
    if (!result.allowed) return Response.json({ error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': String(result.retryAfterSeconds) } });
    return await toNextJsHandler(auth)[method](request);
  } catch { return Response.json({ error: 'Sign-in unavailable' }, { status: 503 }); }
}
export async function GET(request: Request) { return handle(request, 'GET'); }
export async function POST(request: Request) { return handle(request, 'POST'); }
