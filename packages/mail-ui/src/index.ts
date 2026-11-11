import sanitizeHtml from 'sanitize-html';

/** Strip active content and remote resources from untrusted email HTML. */
export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['p', 'br', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'blockquote', 'ul', 'ol', 'li', 'a', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr'],
    allowedAttributes: { a: ['href', 'title'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    transformTags: { a: (_tag, attributes) => ({ tagName: 'a', attribs: { ...attributes, rel: 'noopener noreferrer', target: '_blank' } }) },
  });
}

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger';
export function executionBadge(status: string): { label: string; tone: BadgeTone } {
  switch (status) {
    case 'APPLIED': return { label: 'Applied', tone: 'success' };
    case 'PENDING': return { label: 'Pending', tone: 'warning' };
    case 'ERROR': return { label: 'Failed', tone: 'danger' };
    case 'REJECTED': return { label: 'Undone', tone: 'neutral' };
    case 'SKIPPED': return { label: 'Skipped', tone: 'neutral' };
    default: return { label: status, tone: 'neutral' };
  }
}

export function traceSummary(trace: { stage?: string | null; reason?: string | null }): string {
  return [trace.stage, trace.reason].filter(Boolean).join(' — ') || 'No matching trace';
}
