import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: vi.fn(), accounts: vi.fn(), account: vi.fn(), resolve: vi.fn(), enqueue: vi.fn() }));
vi.mock('../utils/auth/session-auth', () => ({ getSessionAuth: () => ({ api: { getSession: mocks.session } }) }));
vi.mock('../utils/server/prisma', () => ({ prisma: { emailAccount: { findMany: mocks.accounts, findFirst: mocks.account } } }));
vi.mock('../utils/mail-provider/provider-resolver', () => ({ resolveMailProvider: mocks.resolve }));
vi.mock('../utils/worker/provider-sync-queue', () => ({ getProviderSyncQueue: () => ({}), enqueueProviderSync: mocks.enqueue }));
vi.mock('../utils/server/public-rate-limit', () => ({ publicRateLimitStore: () => ({ consume: async () => ({ counts: [1, 1], retryAfterMs: 1000 }) }) }));
import { GET, POST } from '../app/api/workspace/route';

afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
describe('session workspace access', () => {
  it('limits account lookup to the signed-in user', async () => {
    mocks.session.mockResolvedValue({ user: { id: 'owner' } }); mocks.accounts.mockResolvedValue([]); mocks.account.mockResolvedValue(null);
    const listed = await GET(new Request('https://inbox.example/api/workspace'));
    expect(listed.status).toBe(200);
    expect(mocks.accounts).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'owner' } }));
    const action = new Request('https://inbox.example/api/workspace', { method: 'POST', headers: { origin: 'https://inbox.example', 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'archive', accountId: 'someone-elses-account', threadId: 'thread' }) });
    expect((await POST(action)).status).toBe(404);
    expect(mocks.account).toHaveBeenCalledWith({ where: { id: 'someone-elses-account', userId: 'owner' } });
  });
  it('reports a completed provider action even when its cache refresh must be queued', async () => {
    mocks.session.mockResolvedValue({ user: { id: 'owner' } }); mocks.account.mockResolvedValue({ id: 'account', provider: 'google', userId: 'owner' });
    const archiveThread = vi.fn(async () => {}); const getThread = vi.fn(async () => { throw new Error('temporary provider failure'); });
    mocks.resolve.mockResolvedValue({ archiveThread, getThread }); mocks.enqueue.mockResolvedValue({});
    const action = () => new Request('https://inbox.example/api/workspace', { method: 'POST', headers: { origin: 'https://inbox.example', 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'archive', accountId: 'account', threadId: 'thread' }) });
    const response = await POST(action());
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, refreshPending: true });
    expect(archiveThread).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledWith({}, { provider: 'refresh', emailAccountId: 'account', threadId: 'thread' });
    mocks.enqueue.mockRejectedValueOnce(new Error('redis unavailable'));
    const unavailable = await POST(action());
    expect(unavailable.status).toBe(200); expect(await unavailable.json()).toEqual({ ok: true, refreshUnscheduled: true });
  });
  it('rejects a cross-origin mutation and invalid bearer token', async () => {
    mocks.session.mockResolvedValue({ user: { id: 'owner' } });
    const action = new Request('https://inbox.example/api/workspace', { method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{}' });
    expect((await POST(action)).status).toBe(401);
    expect((await GET(new Request('https://inbox.example/api/workspace', { headers: { authorization: 'Bearer wrong' } }))).status).toBe(401);
  });
});
