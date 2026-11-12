import { afterEach, describe, expect, it, vi } from 'vitest';

const { database, count, providers, resolveProvider, redis } = vi.hoisted(() => ({ database: vi.fn(), count: vi.fn(), providers: vi.fn(), resolveProvider: vi.fn(), redis: { connect: vi.fn(), ping: vi.fn(), disconnect: vi.fn(), on: vi.fn() } }));
vi.mock('../utils/server/prisma', () => ({ prisma: { $queryRaw: database, emailAccount: { count, findMany: providers } } }));
vi.mock('../utils/mail-provider/provider-resolver', () => ({ resolveMailProvider: resolveProvider }));
vi.mock('ioredis', () => ({ default: class { connect = redis.connect; ping = redis.ping; disconnect = redis.disconnect; on = redis.on; } }));
import { GET } from '../app/api/health/route';

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; vi.clearAllMocks(); });
const request = (authorization?: string) => new Request('http://localhost/api/health', { headers: authorization ? { authorization } : {} });

describe('health endpoint', () => {
  it('does no dependency checks for public liveness', async () => {
    const result = await GET(request());
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ status: 'ok' });
    expect(database).not.toHaveBeenCalled();
    expect(redis.connect).not.toHaveBeenCalled();
  });
  it('rejects bad tokens before checking dependencies', async () => {
    process.env.HEALTH_TOKEN = 'correct';
    expect((await GET(request('Bearer incorrect'))).status).toBe(401);
    expect(database).not.toHaveBeenCalled();
  });
  it('checks configured mail providers only after token authentication', async () => {
    process.env.HEALTH_TOKEN = 'correct'; database.mockResolvedValue([]); providers.mockResolvedValue([{ id: 'account' }]);
    const listThreads = vi.fn(async () => ({ threadIds: [] })); resolveProvider.mockResolvedValue({ listThreads });
    const response = await GET(request('Bearer correct'));
    expect(response.status).toBe(200); expect((await response.json()).checks.provider).toBe('ok');
    expect(listThreads).toHaveBeenCalledWith({ maxResults: 1 });
    resolveProvider.mockRejectedValueOnce(new Error('private provider token'));
    const unavailable = await GET(request('Bearer correct'));
    expect(unavailable.status).toBe(503); expect(await unavailable.text()).not.toContain('private');
  });
  it('runs configured checks and never returns connection errors or secrets', async () => {
    process.env.HEALTH_TOKEN = 'correct'; process.env.REDIS_URL = 'redis://user:secret@localhost:6379'; process.env.LOCAL_DEMO_MODE = 'true';
    database.mockResolvedValueOnce([]); count.mockResolvedValueOnce(2); providers.mockResolvedValueOnce([]); redis.connect.mockResolvedValueOnce(undefined); redis.ping.mockResolvedValueOnce('PONG');
    const good = await GET(request('Bearer correct'));
    expect(await good.json()).toEqual({ status: 'ok', checks: { database: 'ok', redis: 'ok', emulator: 'ok', provider: 'not_configured' } });
    database.mockRejectedValueOnce(new Error('private database credentials'));
    redis.connect.mockRejectedValueOnce(new Error('secret'));
    const bad = await GET(request('Bearer correct'));
    expect(bad.status).toBe(503);
    expect(await bad.text()).not.toMatch(/private|credentials|secret/);
    expect(redis.disconnect).toHaveBeenCalledTimes(2);
  });
});
