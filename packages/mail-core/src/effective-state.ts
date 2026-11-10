import type { CanonicalLabel } from "./canonical";

export interface Draft {
  id: string;
  to: string;
  subject: string;
  body: string;
}
export interface ThreadState {
  id: string;
  labels: CanonicalLabel[];
  drafts: Draft[];
}
export type MailMutation =
  | { type: "archive" }
  | { type: "addLabel"; label: string }
  | { type: "markRead"; read: boolean }
  | { type: "createDraft"; draft: Draft };

/** Pure reducer: recomputing pending changes over confirmed state enables safe rollback. */
export function applyMutation(thread: ThreadState, mutation: MailMutation): ThreadState {
  const labels = new Set(thread.labels);
  let drafts = thread.drafts;
  switch (mutation.type) {
    case "archive":
      labels.delete("INBOX");
      labels.add("ARCHIVED");
      break;
    case "addLabel":
      labels.add(mutation.label);
      break;
    case "markRead":
      if (mutation.read) labels.delete("UNREAD");
      else labels.add("UNREAD");
      break;
    case "createDraft":
      drafts = [...drafts.filter((draft) => draft.id !== mutation.draft.id), { ...mutation.draft }];
      labels.add("DRAFT");
      break;
  }
  return { ...thread, labels: [...labels], drafts };
}

export function effectiveState(confirmed: ThreadState, pending: readonly MailMutation[]): ThreadState {
  return pending.reduce(applyMutation, confirmed);
}
