import { convertEmailHtmlToText } from "../get-email-from-message";
import type { ParsedMessage } from "./types";

export type ForwardInput = { threadId: string; messageId: string; to: string; cc?: string; comment?: string };

/** Text-only fallback: never silently drop a known attachment. */
export function formatForwardMessage(message: ParsedMessage, comment = ""): { subject: string; body: string } {
  if (message.hasAttachments !== false || message.attachmentNames?.length) throw new Error("Forwarding attachments is not supported by this provider");
  const body = message.textPlain || convertEmailHtmlToText(message.textHtml ?? "");
  return {
    subject: `Fwd: ${message.headers.subject}`,
    body: `${comment}${comment ? "\n\n" : ""}---------- Forwarded message ----------\nFrom: ${message.headers.from}\nDate: ${message.headers.date}\nSubject: ${message.headers.subject}\nTo: ${message.headers.to}\n\n${body}`,
  };
}
