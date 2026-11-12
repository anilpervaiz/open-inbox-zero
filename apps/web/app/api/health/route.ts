import { createHash, timingSafeEqual } from 'node:crypto';
import Redis from 'ioredis';
import { prisma } from '../../../utils/server/prisma';
import { resolveMailProvider } from '../../../utils/mail-provider/provider-resolver';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

function authorized(header: string, token: string | undefined): boolean {
  if (!token || !header.startsWith('Bearer ')) return false;
  const actual = createHash('sha256').update(header.slice(7)).digest();
  const expected = createHash('sha256').update(token).digest();
  return timingSafeEqual(actual, expected);
}

/** Public liveness is free. Detailed checks require the server-side health token. */
export async function GET(request: Request): Promise<Response> {
  const authorization = request.headers.get('authorization');
  if (authorization === null) return Response.json({ status: 'ok' }, { headers });
  if (!authorized(authorization, process.env.HEALTH_TOKEN)) return Response.json({ error: 'Unauthorized' }, { status: 401, headers });

  const checks: { database: string; redis: string; emulator: string; provider: string } = { database: 'unavailable', redis: 'not_configured', emulator: 'not_configured', provider: 'not_configured' };
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = 'ok';
    if (process.env.LOCAL_EMULATOR_MODE === '1' || process.env.LOCAL_DEMO_MODE === 'true') {
      const count = await prisma.emailAccount.count({ where: { provider: 'emulator' } });
      checks.emulator = count > 0 ? 'ok' : 'unavailable';
    }
  } catch { checks.database = 'unavailable'; }
  if (checks.database === 'ok') {
    try {
      // Bound the number of provider requests; partial is never reported as fully healthy.
      const accounts = await prisma.emailAccount.findMany({ where: { provider: { in: ['google', 'microsoft'] } }, select: { id: true }, orderBy: { id: 'asc' }, take: 11 });
      if (accounts.length) {
        const probes = accounts.slice(0, 10).map(async account => {
          const provider = await resolveMailProvider(prisma, account.id);
          await provider.listThreads({ maxResults: 1 });
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Provider check timed out')), 5000); timer.unref(); });
        try { await Promise.race([Promise.all(probes), timeout]); } finally { if (timer) clearTimeout(timer); }
        checks.provider = accounts.length > 10 ? 'partial' : 'ok';
      }
    } catch { checks.provider = 'unavailable'; }
  }
  if (process.env.REDIS_URL) {
    try {
      const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, connectTimeout: 3000, commandTimeout: 3000, maxRetriesPerRequest: 0, retryStrategy: () => null, enableOfflineQueue: false });
      redis.on('error', () => {});
      try { await redis.connect(); checks.redis = await redis.ping() === 'PONG' ? 'ok' : 'unavailable'; }
      finally { redis.disconnect(); }
    } catch { checks.redis = 'unavailable'; }
  }
  const healthy = checks.database === 'ok' && checks.redis !== 'unavailable' && checks.emulator !== 'unavailable' && !['unavailable', 'partial'].includes(checks.provider);
  return Response.json({ status: healthy ? 'ok' : 'degraded', checks }, { status: healthy ? 200 : 503, headers });
}
