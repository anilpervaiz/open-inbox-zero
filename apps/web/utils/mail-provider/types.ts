import type { ExecutedAction, Prisma } from "@prisma/client";
import type { ForwardInput } from "./forward";

export interface ParsedMessage {
  id: string;
  threadId: string;
  snippet: string;
  internalDate: Date;
  labelIds: string[];
  headers: {
    from: string;
    to: string;
    cc?: string;
    subject: string;
    date: string;
    messageId?: string;
    inReplyTo?: string;
    references?: string;
    listUnsubscribe?: string;
    listUnsubscribePost?: string;
  };
  textPlain: string;
  textHtml?: string;
  /** Provider-reported MIME metadata, distinct from untrusted text in the body. */
  contentType?: string;
  mimeTypes?: string[];
  attachmentNames?: string[];
  hasAttachments?: boolean;
}

export interface EmailProvider {
  readonly providerName: "google" | "microsoft" | "emulator" | "selfhosted";
  /** The database account whose credentials and mailbox back this instance. */
  readonly emailAccountId: string;
  listThreads(options: { query?: string; labelIds?: string[]; maxResults?: number }): Promise<{ threadIds: string[] }>;
  /** Stream the mailbox snapshot without imposing the interactive list limit. */
  iterateThreadIds(): AsyncIterable<string>;
  getThread(threadId: string): Promise<{ id: string; messages: ParsedMessage[] }>;
  getMessage(messageId: string): Promise<ParsedMessage>;
  /** Exact provider MIME bytes; callers must verify authenticity independently. */
  getRawMessage(messageId: string): Promise<Uint8Array>;
  isReplyInThread(message: ParsedMessage): boolean;
  archiveThread(threadId: string): Promise<void>;
  markSpam(threadId: string): Promise<void>;
  forwardEmail(input: ForwardInput): Promise<{ messageId: string }>;
  createForwardDraft(input: ForwardInput): Promise<{ draftId: string; draftThreadId: string }>;
  addLabel(threadId: string, labelName: string): Promise<{ labelId: string }>;
  removeLabel(threadId: string, labelName: string): Promise<void>;
  markRead(threadId: string, read: boolean): Promise<void>;
  createDraft(input: { threadId?: string; to: string; cc?: string; subject: string; body: string; inReplyTo?: string }): Promise<{ draftId: string }>;
  updateDraft(input: { draftId: string; threadId: string; to: string; cc?: string; subject: string; body: string; inReplyTo?: string }): Promise<{ draftId: string }>;
  sendEmail(input: { threadId?: string; to: string; cc?: string; subject: string; body: string; inReplyTo?: string }): Promise<{ messageId: string }>;
  captureUndoSnapshot(threadId: string): Promise<Prisma.InputJsonObject>;
  restoreArchive(threadId: string, snapshot: Prisma.JsonValue): Promise<void>;
  undoAction(action: ExecutedAction, threadId: string): Promise<void>;
}
