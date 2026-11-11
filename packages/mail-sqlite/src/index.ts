import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';

export interface CachedMessage {
  accountId: string;
  threadId: string;
  messageId: string;
  subject: string;
  sender: string;
  body: string;
  receivedAt: string;
}

/** A local cache. Request OPFS explicitly in a supported browser worker for persistence. */
export class MailSqliteCache {
  private constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS messages (
      account_id TEXT NOT NULL, thread_id TEXT NOT NULL, message_id TEXT NOT NULL,
      subject TEXT NOT NULL, sender TEXT NOT NULL, body TEXT NOT NULL, received_at TEXT NOT NULL,
      PRIMARY KEY (account_id, message_id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
      account_id UNINDEXED, message_id UNINDEXED, subject, sender, body
    );`);
  }

  static async open(options: { persistent?: boolean; filename?: string } = {}) {
    const sqlite = await sqlite3InitModule();
    if (options.persistent && !('opfs' in sqlite)) throw new Error('Persistent SQLite cache requires OPFS in a supported browser worker');
    const db = options.persistent
      ? new sqlite.oo1.OpfsDb(options.filename ?? '/open-inbox-zero.sqlite3')
      : new sqlite.oo1.DB(':memory:', 'c');
    return new MailSqliteCache(db);
  }

  upsert(message: CachedMessage) {
    this.db.exec('BEGIN');
    try {
      this.db.exec({ sql: `INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, message_id) DO UPDATE SET thread_id=excluded.thread_id,
        subject=excluded.subject, sender=excluded.sender, body=excluded.body, received_at=excluded.received_at`,
      bind: [message.accountId, message.threadId, message.messageId, message.subject, message.sender, message.body, message.receivedAt] });
      this.db.exec({ sql: 'DELETE FROM message_search WHERE account_id=? AND message_id=?', bind: [message.accountId, message.messageId] });
      this.db.exec({ sql: 'INSERT INTO message_search VALUES (?, ?, ?, ?, ?)', bind: [message.accountId, message.messageId, message.subject, message.sender, message.body] });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  remove(accountId: string, messageId: string) {
    this.db.exec('BEGIN');
    try {
      this.db.exec({ sql: 'DELETE FROM messages WHERE account_id=? AND message_id=?', bind: [accountId, messageId] });
      this.db.exec({ sql: 'DELETE FROM message_search WHERE account_id=? AND message_id=?', bind: [accountId, messageId] });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  thread(accountId: string, threadId: string): CachedMessage[] {
    return this.rows('SELECT * FROM messages WHERE account_id=? AND thread_id=? ORDER BY received_at, message_id', [accountId, threadId]);
  }

  search(accountId: string, query: string): CachedMessage[] {
    const words = query.match(/[\p{L}\p{N}]+/gu);
    if (!words?.length) return [];
    const expression = words.map(word => `"${word}"`).join(' AND ');
    return this.rows(`SELECT m.* FROM messages m JOIN message_search s ON s.account_id=m.account_id AND s.message_id=m.message_id
      WHERE message_search MATCH ? AND m.account_id=? ORDER BY m.received_at DESC, m.message_id`, [expression, accountId]);
  }

  close() { this.db.close(); }

  private rows(sql: string, bind: string[]): CachedMessage[] {
    const rows = this.db.exec({ sql, bind, rowMode: 'object', returnValue: 'resultRows' });
    return rows.map(row => {
      const r = row as Record<string, string>;
      return { accountId: r.account_id, threadId: r.thread_id, messageId: r.message_id, subject: r.subject, sender: r.sender, body: r.body, receivedAt: r.received_at };
    });
  }
}
