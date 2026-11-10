/** Provider-independent labels used by the client. Custom provider labels remain intact. */
export type CanonicalSystemLabel = "INBOX" | "ARCHIVED" | "TRASH" | "STARRED" | "UNREAD" | "SENT" | "DRAFT";
export type CanonicalLabel = CanonicalSystemLabel | (string & {});

const gmailSystemLabels: Record<string, CanonicalSystemLabel> = {
  INBOX: "INBOX", TRASH: "TRASH", STARRED: "STARRED", UNREAD: "UNREAD", SENT: "SENT", DRAFT: "DRAFT",
};

/** Gmail has no ARCHIVED label: archive means absence of INBOX on an ordinary message. */
export function normalizeGmailLabels(labelIds: readonly string[]): CanonicalLabel[] {
  const labels = new Set<CanonicalLabel>();
  for (const label of labelIds) labels.add(gmailSystemLabels[label] ?? label);
  if (!["INBOX", "TRASH", "SENT", "DRAFT", "SPAM"].some((label) => labels.has(label))) labels.add("ARCHIVED");
  return [...labels];
}

export interface OutlookLabelInput {
  /** Well-known folder name, or the provider ID when folderNames maps it. */
  folderId: string;
  folderNames?: Readonly<Record<string, string>>;
  isRead: boolean;
  isFlagged?: boolean;
  categories?: readonly string[];
}

/** Resolve opaque Graph folder IDs through the caller's folder-name map when available. */
export function normalizeOutlookLabels(input: OutlookLabelInput): CanonicalLabel[] {
  const folder = input.folderNames?.[input.folderId] ?? input.folderId;
  const systemFolders: Record<string, CanonicalSystemLabel> = {
    inbox: "INBOX", archive: "ARCHIVED", deleteditems: "TRASH", trash: "TRASH",
    sentitems: "SENT", sent: "SENT", drafts: "DRAFT", draft: "DRAFT",
  };
  const normalizedFolder = folder.toLowerCase().replace(/[\s_-]/g, "");
  const labels = new Set<CanonicalLabel>([systemFolders[normalizedFolder] ?? folder, ...(input.categories ?? [])]);
  if (!input.isRead) labels.add("UNREAD");
  if (input.isFlagged) labels.add("STARRED");
  return [...labels];
}
