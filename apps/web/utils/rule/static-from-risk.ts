import type { ActionType, Rule } from "@prisma/client";
import { matchesPattern } from "./email-from-pattern";

const outbound: ActionType[] = ["REPLY", "SEND_EMAIL", "FORWARD"];

/** Sender-controlled headers and reply headers do not authenticate a sender. */
export function getBlockedLowTrustStaticFromActionTypes(input: {
  rule: Pick<Rule, "from"> | null;
  stage: "STATIC" | "GROUP" | "COLD" | "AI" | "SYSTEM";
  hasVerifiedSenderReplyHistory: boolean;
  matchedFields?: ("from" | "to" | "subject" | "body")[];
}): ActionType[] {
  const onlyFrom = !input.matchedFields?.length || input.matchedFields.every((field) => field === "from");
  return input.stage === "STATIC" && Boolean(input.rule?.from) && onlyFrom && !input.hasVerifiedSenderReplyHistory ? outbound : [];
}

export function senderAddress(header: string): string | undefined {
  const extracted = header.match(/<([^<>]+)>\s*$/)?.[1] ?? header.trim();
  const address = extracted.trim().toLowerCase();
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(address) ? address : undefined;
}

function patternMatchesAddress(pattern: string, address: string): boolean {
  try {
    return matchesPattern(pattern, address, true);
  } catch {
    // An invalid VIP pattern must not turn protection off.
    return true;
  }
}

/** Protect the account's own domain plus configured VIP addresses or glob patterns. */
export function shouldSkipAutomatedArchiveForSender(input: { sender: string; accountEmail: string; protectedSenders: string[] }): boolean {
  const sender = senderAddress(input.sender);
  const account = senderAddress(input.accountEmail);
  // Ambiguous sender identities cannot be safely assessed, so don't auto-archive.
  if (!sender || !account) return true;
  if (sender.split("@")[1] === account.split("@")[1]) return true;
  return input.protectedSenders.some((entry) => patternMatchesAddress(entry, sender));
}
