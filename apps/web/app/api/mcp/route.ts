import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import Redis from 'ioredis';
import { prisma } from '../../../utils/server/prisma';
import { authenticateUserApiKey } from '../../../utils/server/api-keys';
import { createInboxMcpServer } from '../../../utils/mcp/server';
import { checkRateLimit, MemoryRateLimitStore, RedisRateLimitStore, type RateLimitStore } from '../../../utils/rate-limit';

export const dynamic = 'force-dynamic';
const shared = globalThis as typeof globalThis & { mcpMemoryLimit?: MemoryRateLimitStore; mcpRedis?: Redis; mcpRedisUrl?: string };
function store(): RateLimitStore {
  const url = process.env.REDIS_URL;
  if (url) {
    if (!shared.mcpRedis || shared.mcpRedisUrl !== url) {
      shared.mcpRedis?.disconnect();
      shared.mcpRedis = new Redis(url, { connectTimeout: 3000, commandTimeout: 3000, maxRetriesPerRequest: 0, retryStrategy: () => null });
      shared.mcpRedis.on('error', () => {});
      shared.mcpRedisUrl = url;
    }
    return new RedisRateLimitStore(shared.mcpRedis);
  }
  if (process.env.LOCAL_EMULATOR_MODE !== '1') throw new Error('Redis is required');
  return shared.mcpMemoryLimit ??= new MemoryRateLimitStore();
}
async function limit(limiter: RateLimitStore, scope: string, identity: string): Promise<Response | null> {
  // No proxy header is trusted by default. A shared IP bucket fails safe until trusted proxy configuration is added.
  const result = await checkRateLimit({ store: limiter, scope, clientIp: 'unattributed', accountId: identity, limit: 120, windowMs: 60_000 });
  return result.allowed ? null : Response.json({ error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': String(result.retryAfterSeconds) } });
}
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get('origin');
  if (origin) { try { if (new URL(origin).origin !== new URL(request.url).origin) return Response.json({ error: 'Forbidden' }, { status: 403 }); } catch { return Response.json({ error: 'Forbidden' }, { status: 403 }); } }
  let limiter: RateLimitStore;
  try { limiter = store(); const restricted = await limit(limiter, 'mcp-pre-auth', 'anonymous'); if (restricted) return restricted; }
  catch { return Response.json({ error: 'Service unavailable' }, { status: 503 }); }
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  let identity;
  try { identity = await authenticateUserApiKey(prisma, authorization.slice(7)); }
  catch { return Response.json({ error: 'Service unavailable' }, { status: 503 }); }
  if (!identity) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  try { const restricted = await limit(limiter, 'mcp-user', identity.userId); if (restricted) return restricted; }
  catch { return Response.json({ error: 'Service unavailable' }, { status: 503 }); }
  try {
    const server = createInboxMcpServer(prisma, identity.userId);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 65_536 });
    await server.connect(transport);
    return await transport.handleRequest(request);
  } catch { return Response.json({ error: 'Request could not be completed' }, { status: 500 }); }
}
