import { simpleParser } from 'mailparser';

/** Metadata extracted from untrusted MIME; callers must sanitize HTML before display. */
export type RawEmail = {
  from: string; to: string; cc?: string; subject: string; date?: Date;
  messageId?: string; inReplyTo?: string; references?: string;
  text: string; html?: string;
  attachments: { name: string; contentType: string; size: number }[];
};

/** Parse bounded original MIME without generating HTML, embedding images or trusting headers. */
export async function parseRawEmail(raw: Uint8Array): Promise<RawEmail> {
  if (!raw.length || raw.length > 20_000_000) throw new Error('Email MIME is empty or too large');
  try {
    const mail = await simpleParser(Buffer.from(raw), { skipHtmlToText: true, skipTextToHtml: true, keepCidLinks: true, maxChildNodes: 500 });
    const address = (value: typeof mail.to) => value ? (Array.isArray(value) ? value : [value]).map(item => item.text).filter(Boolean).join(', ') : '';
    const references = Array.isArray(mail.references) ? mail.references.join(' ') : mail.references;
    return {
      from: mail.from?.text ?? '', to: address(mail.to), ...(mail.cc ? { cc: address(mail.cc) } : {}),
      subject: mail.subject ?? '', ...(mail.date && Number.isFinite(mail.date.getTime()) ? { date: mail.date } : {}),
      ...(mail.messageId ? { messageId: mail.messageId } : {}), ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
      ...(references ? { references } : {}), text: mail.text ?? '', ...(typeof mail.html === 'string' ? { html: mail.html } : {}),
      attachments: mail.attachments.map(item => ({ name: item.filename ?? '', contentType: item.contentType, size: item.size })),
    };
  } catch { throw new Error('Email MIME could not be parsed'); }
}
