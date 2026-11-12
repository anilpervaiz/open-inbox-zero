import { authorizeLocalApi } from './local-api-auth';
import { getSessionAuth } from '../auth/session-auth';
import { checkRateLimit, localRateLimit } from '../rate-limit';
import { publicRateLimitStore } from './public-rate-limit';

export type WorkspacePrincipal = { kind: 'local' } | { kind: 'session'; userId: string };
export async function workspacePrincipal(request: Request): Promise<WorkspacePrincipal | null> {
  if (authorizeLocalApi(request)) return { kind: 'local' };
  // A malformed or invalid bearer token must not silently fall back to cookies.
  if (request.headers.has('authorization')) return null;
  if (!['GET', 'HEAD'].includes(request.method)) {
    const origin = request.headers.get('origin');
    if (!origin || origin !== new URL(request.url).origin) return null;
  }
  const auth = getSessionAuth();
  const session = auth ? await auth.api.getSession({ headers: request.headers }) : null;
  return session ? { kind: 'session', userId: session.user.id } : null;
}
export async function workspaceRateLimit(principal: WorkspacePrincipal, accountId: string): Promise<Response | null> {
  if (principal.kind === 'local') return localRateLimit(accountId);
  try {
    const result = await checkRateLimit({ store: publicRateLimitStore(), scope: 'workspace', clientIp: 'unattributed', accountId: principal.userId, limit: 120, windowMs: 60_000 });
    return result.allowed ? null : Response.json({ error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': String(result.retryAfterSeconds) } });
  } catch { return Response.json({ error: 'Service unavailable' }, { status: 503 }); }
}
