import type { GroupItem } from "@prisma/client";
import type { ParsedMessage } from "../mail-provider/types";
import { matchesFieldPattern, type StaticField } from "../rule/email-from-pattern";

export type MatchableGroupItem = Pick<GroupItem, "type" | "value" | "exclude" | "source">;

/** Exclusions always win, irrespective of user or learned source and item order. */
export function findMatchingGroup(group: { items: readonly MatchableGroupItem[] }, message: ParsedMessage): boolean {
  const matches = (item: MatchableGroupItem) => matchesFieldPattern(item.value, message, item.type.toLowerCase() as StaticField);
  if (group.items.some((item) => item.exclude && matches(item))) return false;
  return group.items.some((item) => !item.exclude && matches(item));
}
