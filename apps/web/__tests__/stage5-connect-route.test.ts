import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: vi.fn(), token: vi.fn(), connect: vi.fn() }));
vi.mock('../utils/auth/session-auth', () => ({ getSessionAuth: () => ({ api: { getSession: mocks.session, getAccessToken: mocks.token } }) }));
vi.mock('../utils/auth/connect-mailbox', () => ({ connectOAuthMailbox: mocks.connect }));
vi.mock('../utils/server/prisma', () => ({ prisma: {} }));
vi.mock('../utils/server/public-rate-limit', () => ({ publicRateLimitStore: () => ({ consume: async () => ({ counts: [1, 1], retryAfterMs: 1000 }) }) }));
import { POST } from '../app/api/accounts/connect/route';

afterEach(() => vi.clearAllMocks());
function request(origin?: string) { return new Request('https://inbox.example/api/accounts/connect', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ authAccountId: 'identity' }) }); }
describe('mailbox connection route', () => {
  it('requires a same-origin authenticated session before connecting', async () => {
    expect((await POST(request())).status).toBe(403);
    expect((await POST(request('https://attacker.example'))).status).toBe(403);
    mocks.session.mockResolvedValueOnce(null);
    expect((await POST(request('https://inbox.example'))).status).toBe(401);
    expect(mocks.connect).not.toHaveBeenCalled();
    mocks.session.mockResolvedValueOnce({ user: { id: 'user' } });
    mocks.connect.mockResolvedValueOnce({ id: 'mailbox', email: 'user@example.com', provider: 'google' });
    const response = await POST(request('https://inbox.example'));
    expect(response.status).toBe(200);
    expect(mocks.connect).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user', authAccountId: 'identity' }));
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
