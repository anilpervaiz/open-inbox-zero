import type { ExecutedAction, Prisma } from "@prisma/client";

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
}

export interface EmailProvider {
  readonly providerName: "google" | "microsoft" | "emulator";
  listThreads(options: { query?: string; labelIds?: string[]; maxResults?: number }): Promise<{ threadIds: string[] }>;
  getThread(threadId: string): Promise<{ id: string; messages: ParsedMessage[] }>;
  getMessage(messageId: string): Promise<ParsedMessage>;
  isReplyInThread(message: ParsedMessage): boolean;
  archiveThread(threadId: string): Promise<void>;
  addLabel(threadId: string, labelName: string): Promise<{ labelId: string }>;
  removeLabel(threadId: string, labelName: string): Promise<void>;
  markRead(threadId: string, read: boolean): Promise<void>;
  createDraft(input: { threadId?: string; to: string; cc?: string; subject: string; body: string; inReplyTo?: string }): Promise<{ draftId: string }>;
  sendEmail(input: { threadId?: string; to: string; cc?: string; subject: string; body: string; inReplyTo?: string }): Promise<{ messageId: string }>;
  captureUndoSnapshot(threadId: string): Promise<Prisma.InputJsonObject>;
  undoAction(action: ExecutedAction, threadId: string): Promise<void>;
}
