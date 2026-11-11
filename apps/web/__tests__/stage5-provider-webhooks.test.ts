import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ verify: vi.fn(), account: vi.fn(), subscription: vi.fn(), enqueue: vi.fn(), queue: vi.fn(() => ({})) }));
vi.mock('google-auth-library', () => ({ OAuth2Client: class { verifyIdToken = mocks.verify; } }));
vi.mock('../utils/server/prisma', () => ({ prisma: { emailAccount: { findFirst: mocks.account }, providerSubscription: { findUnique: mocks.subscription } } }));
vi.mock('../utils/worker/provider-sync-queue', () => ({ enqueueProviderSync: mocks.enqueue, getProviderSyncQueue: mocks.queue }));
import { POST as google } from '../app/api/google/webhook/route';
import { POST as outlook } from '../app/api/outlook/webhook/route';

afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
function googleRequest(token = 'valid') {
  const data = Buffer.from(JSON.stringify({ emailAddress: 'person@example.com', historyId: '123' })).toString('base64url');
  return new Request('http://localhost/api/google/webhook', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ subscription: 'projects/p/subscriptions/s', message: { messageId: 'delivery', data } }) });
}
function outlookRequest(clientState: string) {
  return new Request('http://localhost/api/outlook/webhook', { method: 'POST', body: JSON.stringify({ value: [{ subscriptionId: 'sub', clientState, changeType: 'created', resourceData: { id: 'message' } }] }) });
}
describe('provider webhooks', () => {
  it('requires a verified Google service-account token before queuing a notification', async () => {
    vi.stubEnv('GOOGLE_PUBSUB_AUDIENCE', 'https://example.test/hook'); vi.stubEnv('GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL', 'push@example.test'); vi.stubEnv('GOOGLE_PUBSUB_SUBSCRIPTION', 'projects/p/subscriptions/s');
    mocks.verify.mockRejectedValueOnce(new Error('invalid token'));
    expect((await google(googleRequest('bad'))).status).toBe(401);
    expect(mocks.account).not.toHaveBeenCalled();
    mocks.verify.mockResolvedValueOnce({ getPayload: () => ({ email_verified: true, email: 'push@example.test' }) });
    mocks.account.mockResolvedValueOnce({ id: 'account' });
    expect((await google(googleRequest())).status).toBe(204);
    expect(mocks.enqueue).toHaveBeenCalledWith({}, { provider: 'google', emailAccountId: 'account', historyId: '123' }, 'projects/p/subscriptions/s:delivery');
  });
  it('answers Microsoft validation and rejects an invalid client state', async () => {
    const validation = await outlook(new Request('http://localhost/api/outlook/webhook?validationToken=abc%2B123', { method: 'POST' }));
    expect(await validation.text()).toBe('abc+123');
    expect(validation.headers.get('content-type')).toContain('text/plain');
    const subscription = { clientStateHash: createHash('sha256').update('right').digest('hex'), expiresAt: new Date(Date.now() + 60_000), emailAccount: { id: 'account', provider: 'microsoft' } };
    mocks.subscription.mockResolvedValue(subscription);
    expect((await outlook(outlookRequest('wrong'))).status).toBe(401);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect((await outlook(outlookRequest('right'))).status).toBe(202);
    expect(mocks.enqueue).toHaveBeenCalledWith({}, { provider: 'microsoft', emailAccountId: 'account', messageId: 'message', changeType: 'created' });
  });
  it('returns a retryable error when the verified job cannot be enqueued', async () => {
    const subscription = { clientStateHash: createHash('sha256').update('right').digest('hex'), expiresAt: new Date(Date.now() + 60_000), emailAccount: { id: 'account', provider: 'microsoft' } };
    mocks.subscription.mockResolvedValue(subscription); mocks.enqueue.mockRejectedValueOnce(new Error('redis secret'));
    const response = await outlook(outlookRequest('right'));
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('secret');
  });
});
