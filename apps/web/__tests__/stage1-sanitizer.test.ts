import { describe, expect, it } from 'vitest';
import { getEmailForLLM } from '../utils/get-email-from-message';
import type { ParsedMessage } from '../utils/mail-provider/types';

const base: ParsedMessage = {
  id: 'message', threadId: 'thread', snippet: '', internalDate: new Date('2026-01-01T00:00:00Z'), labelIds: [],
  headers: { from: 'alice@example.test', to: 'me@example.test', subject: 'Hello', date: '2026-01-01' },
  textPlain: '',
};

describe('email text sent to AI', () => {
  it('removes style, script, tracking images, data URIs and quoted reply history', () => {
    const email = { ...base, textHtml: '<style>secret css</style><script>secret script</script><p>Hello there.</p><img width="1" height="1" src="https://tracker.example/pixel"><img src="data:image/png;base64,AAAA"><p>On Tue, Jan 2, 2024, Alice &lt;alice@example.test&gt; wrote:</p><blockquote>&gt; old confidential reply</blockquote>' };
    const result = getEmailForLLM(email);
    expect(result.content).toContain('Hello there.');
    expect(result.content).not.toMatch(/secret css|secret script|tracker|base64|old confidential reply/i);
  });

  it('also removes markup accidentally delivered as plain text', () => {
    const result = getEmailForLLM({ ...base, textPlain: '<div>Visible</div><script>hidden()</script><img src="https://tracker.example">' });
    expect(result.content).toBe('Visible');
  });

  it('strips links from markup and keeps prose following a data URI', () => {
    const result = getEmailForLLM({ ...base, textPlain: '<a href="https://tracker.example">Hi</a> data:image/png;base64,AAAA Hello friend' });
    expect(result.content).toContain('Hi');
    expect(result.content).toContain('Hello friend');
    expect(result.content).not.toMatch(/tracker|base64|<a/);
  });

  it('caps long Unicode bodies without splitting surrogate pairs and reports headers', () => {
    const result = getEmailForLLM({ ...base, textPlain: 'a'.repeat(3999) + '😀' + 'ب'.repeat(100), headers: { ...base.headers, inReplyTo: '<old>', listUnsubscribe: '<https://example.test/unsubscribe>' } });
    expect(result.content.length).toBeLessThanOrEqual(4000);
    expect(result.content).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(result.isReply).toBe(true);
    expect(result.hasUnsubscribeHeader).toBe(true);
  });
});
