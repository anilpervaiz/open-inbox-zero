import { describe, expect, it } from 'vitest';
import { executionBadge, sanitizeEmailHtml, traceSummary } from './index';

describe('mail UI primitives', () => {
  it('removes scripts, trackers and dangerous links', () => {
    const clean = sanitizeEmailHtml('<script>alert(1)</script><img src="https://tracker.test/x"><a href="javascript:alert(1)" onclick="evil()">hello</a>');
    expect(clean).not.toMatch(/script|img|javascript|onclick/);
    expect(clean).toContain('hello');
  });
  it('provides readable status and trace labels', () => {
    expect(executionBadge('ERROR').tone).toBe('danger');
    expect(traceSummary({ stage: 'STATIC', reason: 'matched' })).toBe('STATIC — matched');
  });
});
