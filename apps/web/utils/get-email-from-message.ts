import EmailReplyParser from 'email-reply-parser';
import { convert } from 'html-to-text';
import type { ParsedMessage } from './mail-provider/types';

const MAX_BODY_LENGTH = 4_000;

/** Remove non-content HTML, tracking images and embedded data before extracting text. */
export function convertEmailHtmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'style', format: 'skip' },
      { selector: 'script', format: 'skip' },
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { ignoreHref: true } },
    ],
  }).replace(/data:[\w.+-]+\/[\w.+-]+(?:;[\w=+-]+)*;base64,[A-Za-z0-9+/=]+(?:\r?\n[A-Za-z0-9+/=]+)*/gi, '');
}

/** The body sent to a model is bounded, stripped of tracking markup and quoted history. */
export function getEmailForLLM(message: ParsedMessage) {
  const raw = message.textPlain.trim() || convertEmailHtmlToText(message.textHtml ?? '');
  const withoutMarkup = raw
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/data:[\w.+-]+\/[\w.+-]+(?:;[\w=+-]+)*;base64,[A-Za-z0-9+/=]+(?:\r?\n[A-Za-z0-9+/=]+)*/gi, '');
  const text = /<\/?[a-z][a-z0-9-]*(?:\s+[^<>]*?)?\s*\/?>/i.test(withoutMarkup)
    ? convertEmailHtmlToText(withoutMarkup)
    : withoutMarkup;
  const visible = new EmailReplyParser().parseReply(text).trim();
  // Slice by UTF-16 units to enforce the strict cap without leaving a split surrogate.
  let content = visible.slice(0, MAX_BODY_LENGTH);
  if (/[\uD800-\uDBFF]$/.test(content)) content = content.slice(0, -1);
  return {
    from: message.headers.from,
    to: message.headers.to,
    subject: message.headers.subject,
    date: message.headers.date,
    content,
    isReply: Boolean(message.headers.inReplyTo || message.headers.references),
    hasUnsubscribeHeader: Boolean(message.headers.listUnsubscribe),
  };
}
