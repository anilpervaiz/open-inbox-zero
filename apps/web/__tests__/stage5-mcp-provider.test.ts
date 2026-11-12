import { afterEach, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mock = vi.hoisted(() => ({ tools: new Map<string, (args: never) => Promise<{ content: { text: string }[]; isError?: boolean }>>(), resolve: vi.fn(), enqueue: vi.fn(), draftArgs: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({ McpServer: class { registerTool(name: string, _options: unknown, callback: (args: never) => Promise<{ content: { text: string }[]; isError?: boolean }>) { mock.tools.set(name, callback); } } }));
vi.mock('../utils/mail-provider/provider-resolver', () => ({ resolveMailProvider: mock.resolve }));
vi.mock('../utils/worker/provider-sync-queue', () => ({ getProviderSyncQueue: () => ({}), enqueueProviderSync: mock.enqueue }));
vi.mock('../utils/ai/choose-rule/choose-args', () => ({ getActionItemsWithAiArgs: mock.draftArgs }));
import { createInboxMcpServer } from '../utils/mcp/server';

afterEach(() => { vi.clearAllMocks(); mock.tools.clear(); });
it('uses only owned provider credentials and reports a created draft even if refresh cannot be queued', async () => {
  const account = { id: 'owned', userId: 'user', provider: 'google' };
  const findFirst = vi.fn(async ({ where }: { where: { id: string; userId: string } }) => where.id === account.id && where.userId === account.userId ? account : null);
  const prisma = { emailAccount: { findFirst } } as unknown as PrismaClient;
  const createDraft = vi.fn(async () => ({ draftId: 'draft' }));
  mock.resolve.mockResolvedValue({ getThread: async () => ({ id: 'thread', messages: [{ id: 'message', threadId: 'thread', labelIds: ['INBOX'], headers: { from: 'sender@example.com', subject: 'Hello', messageId: '<message@example.com>' } }] }), createDraft });
  mock.draftArgs.mockResolvedValue([{ content: 'Reply' }]);
  mock.enqueue.mockRejectedValue(new Error('queue unavailable'));
  createInboxMcpServer(prisma, 'user');
  const invoke = mock.tools.get('create_reply_draft')!;
  const success = await invoke({ accountId: 'owned', threadId: 'thread', instructions: 'Reply' } as never);
  expect(JSON.parse(success.content[0].text)).toEqual({ draftId: 'draft', refreshUnscheduled: true });
  expect(createDraft).toHaveBeenCalledTimes(1);
  expect(mock.resolve).toHaveBeenCalledWith(prisma, 'owned');
  const denied = await invoke({ accountId: 'other', threadId: 'thread', instructions: 'Reply' } as never);
  expect(denied.isError).toBe(true);
  expect(mock.resolve).toHaveBeenCalledTimes(1);
  expect(findFirst).toHaveBeenLastCalledWith({ where: { id: 'other', userId: 'user' } });
});
