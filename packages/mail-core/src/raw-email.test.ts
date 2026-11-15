import { expect, it } from 'vitest';
import { parseRawEmail } from './raw-email';

it('parses threaded MIME messages and attachment metadata without embedding attachments', async () => {
  const raw = Buffer.from([
    'From: Alice <alice@example.test>', 'To: Bob <bob@example.test>', 'Cc: carol@example.test',
    'Subject: =?UTF-8?B?SGVsbG8g8J+Riw==?=', 'Message-ID: <message@example.test>',
    'In-Reply-To: <previous@example.test>', 'References: <first@example.test> <previous@example.test>',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="boundary"', '',
    '--boundary', 'Content-Type: text/plain; charset=utf-8', '', 'Hello Bob',
    '--boundary', 'Content-Type: application/pdf; name="file.pdf"', 'Content-Disposition: attachment; filename="file.pdf"',
    'Content-Transfer-Encoding: base64', '', 'aGVsbG8=', '--boundary--', '',
  ].join('\r\n'));
  const result = await parseRawEmail(raw);
  expect(result).toMatchObject({ subject: 'Hello 👋', messageId: '<message@example.test>', inReplyTo: '<previous@example.test>', text: 'Hello Bob', attachments: [{ name: 'file.pdf', contentType: 'application/pdf', size: 5 }] });
  expect(result.references).toContain('<first@example.test>');
  expect(result.to).toContain('bob@example.test');
  expect(JSON.stringify(result.attachments)).not.toContain('aGVsbG8=');
});

it('rejects empty or oversized MIME before parsing', async () => {
  await expect(parseRawEmail(new Uint8Array())).rejects.toThrow('empty or too large');
  await expect(parseRawEmail(new Uint8Array(20_000_001))).rejects.toThrow('empty or too large');
});
