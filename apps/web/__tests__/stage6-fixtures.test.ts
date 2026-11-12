import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
it('keeps the golden labels separate and covers all benchmark categories and reply states', async () => {
  const emails = JSON.parse(await readFile('eval/golden-60-emails.json', 'utf8')) as { id: string; category: string; rule?: string }[];
  const expected = JSON.parse(await readFile('eval/expected-outcomes.json', 'utf8')) as { id: string; replyState: string; adversarial: boolean; unsafeUnsubscribe: boolean }[];
  expect(emails).toHaveLength(60); expect(expected).toHaveLength(60);
  expect(new Set(emails.map(item => item.id)).size).toBe(60);
  expect(new Set(expected.map(item => item.id))).toEqual(new Set(emails.map(item => item.id)));
  expect(new Set(emails.map(item => item.category)).size).toBe(8);
  expect(emails.filter(item => item.category === 'injection')).toHaveLength(6);
  expect(emails.every(item => !('rule' in item))).toBe(true);
  expect(new Set(expected.map(item => item.replyState))).toEqual(new Set(['needs_reply', 'awaiting_reply', 'none']));
  expect(expected.filter(item => item.adversarial)).toHaveLength(12);
  expect(expected.filter(item => item.unsafeUnsubscribe).length).toBeGreaterThan(0);
});
