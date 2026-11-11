import { describe, expect, it } from 'vitest';
import { MailSqliteCache } from './index';

describe('SQLite message cache', () => {
  it('indexes updates and deletes, scoped to the account', async () => {
    const cache = await MailSqliteCache.open();
    const message = { accountId: 'a', threadId: 't', messageId: 'm', subject: 'Project update', sender: 'alice@example.com', body: 'Meeting tomorrow', receivedAt: '2026-01-01' };
    cache.upsert(message);
    cache.upsert({ ...message, accountId: 'b' });
    expect(cache.search('a', 'meeting')).toHaveLength(1);
    expect(cache.thread('b', 't')).toHaveLength(1);
    cache.upsert({ ...message, body: 'Budget review' });
    expect(cache.search('a', 'meeting')).toHaveLength(0);
    expect(cache.search('a', 'budget')).toHaveLength(1);
    expect(cache.search('b', 'meeting')).toHaveLength(1);
    cache.remove('a', 'm');
    expect(cache.thread('a', 't')).toHaveLength(0);
    expect(cache.search('a', 'budget')).toHaveLength(0);
    cache.close();
  });
});
