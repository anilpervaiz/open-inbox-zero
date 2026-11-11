import { afterEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ account: vi.fn(), findDraft: vi.fn(), updateDraft: vi.fn() }));
vi.mock('../utils/server/prisma', () => ({ prisma: { emailAccount: { findUnique: m.account }, emailMessage: { findFirst: m.findDraft, update: m.updateDraft } } }));
import { POST } from '../app/api/workspace/route';
const token = 'a'.repeat(64);
function request(body: unknown, authorization = `Bearer ${token}`) { return new Request('http://127.0.0.1:3000/api/workspace', { method: 'POST', headers: { authorization, origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
describe('local workspace actions', () => {
  it('rejects unauthorized requests before looking up accounts', async () => {
    vi.stubEnv('LOCAL_EMULATOR_MODE', '1'); vi.stubEnv('LOCAL_EMULATOR_TOKEN', token);
    expect((await POST(request({ operation: 'archive', accountId: 'one', threadId: 't' }, 'Bearer incorrect'))).status).toBe(401);
    expect(m.account).not.toHaveBeenCalled();
  });
  it('limits accounts to emulator and prevents updating a draft in another thread', async () => {
    vi.stubEnv('LOCAL_EMULATOR_MODE', '1'); vi.stubEnv('LOCAL_EMULATOR_TOKEN', token);
    m.account.mockResolvedValueOnce({ id: 'one', provider: 'google' }).mockResolvedValueOnce({ id: 'one', provider: 'emulator' });
    const draft = { operation: 'draft', accountId: 'one', threadId: 'thread', draftId: 'draft', to: 'someone@example.test', subject: 'Hello', body: 'Text' };
    expect((await POST(request(draft))).status).toBe(404);
    m.findDraft.mockResolvedValueOnce(null);
    expect((await POST(request(draft))).status).toBe(400);
    expect(m.findDraft).toHaveBeenCalledWith({ where: { emailAccountId: 'one', messageId: 'draft', threadId: 'thread', labels: { has: 'DRAFT' } } });
    expect(m.updateDraft).not.toHaveBeenCalled();
  });
});
