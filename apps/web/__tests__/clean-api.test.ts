import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findAccount: vi.fn(), refresh: vi.fn(), archive: vi.fn(), run: vi.fn(), undo: vi.fn(), unsubscribe: vi.fn(),
}));
vi.mock('../utils/server/prisma', () => ({ prisma: { emailAccount: { findUnique: mocks.findAccount } } }));
vi.mock('../utils/unsubscribe', () => ({ refreshSenderAnalytics: mocks.refresh, unsubscribeSender: mocks.unsubscribe }));
vi.mock('../utils/cleanup/cleanup-jobs', () => ({ createCleanupJob: mocks.archive, runCleanupJob: mocks.run, undoCleanupJob: mocks.undo }));
import { POST } from '../app/api/clean/route';

const token = 'a'.repeat(64);
function request(body: unknown, authorization = `Bearer ${token}`, origin = 'http://127.0.0.1:3000') {
  return new Request('http://127.0.0.1:3000/api/clean', { method: 'POST', headers: { authorization, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('local cleanup API', () => {
  it('denies unauthenticated and cross-origin requests before reading account data', async () => {
    vi.stubEnv('LOCAL_EMULATOR_MODE', '1'); vi.stubEnv('LOCAL_EMULATOR_TOKEN', token);
    expect((await POST(request({ operation: 'refresh', accountId: 'one' }, 'Bearer wrong'))).status).toBe(401);
    expect((await POST(request({ operation: 'refresh', accountId: 'one' }, `Bearer ${token}`, 'https://attacker.example'))).status).toBe(401);
    expect(mocks.findAccount).not.toHaveBeenCalled();
  });
  it('restricts access to emulator accounts and validates actions', async () => {
    vi.stubEnv('LOCAL_EMULATOR_MODE', '1'); vi.stubEnv('LOCAL_EMULATOR_TOKEN', token);
    mocks.findAccount.mockResolvedValueOnce({ id: 'real', provider: 'google' }).mockResolvedValueOnce({ id: 'demo', provider: 'emulator' });
    expect((await POST(request({ operation: 'refresh', accountId: 'real' }))).status).toBe(404);
    expect((await POST(request({ operation: 'unsubscribe', accountId: 'demo', newsletterId: 'n', messageId: 'm', method: 'one_click', userConfirmed: false }))).status).toBe(400);
    expect((await POST(request({ operation: 'refresh', accountId: 'demo' }))).status).toBe(200);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
});
