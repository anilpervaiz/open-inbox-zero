import type { Rule } from "@prisma/client";
import { RE2JS } from "re2js";
import type { ParsedMessage } from "../mail-provider/types";
import { convertEmailHtmlToText } from "../get-email-from-message";

export type StaticField = "from" | "to" | "subject" | "body";
export type StaticRule = Pick<Rule, StaticField | "conditionalOperator">;

/** Translate a glob to a regex source, escaping all characters except * and ?. */
export function globToRegexSource(pattern: string): string {
  return [...pattern].map((character) => character === "*" ? ".*" : character === "?" ? "." : /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character).join("");
}

function regexPattern(pattern: string): { source: string; flags: number } | null {
  if (!pattern.startsWith("/")) return null;
  const end = pattern.lastIndexOf("/");
  if (end <= 0) throw new Error("Invalid rule regex: missing closing slash");
  const flags = pattern.slice(end + 1);
  if (!/^[imsu]*$/.test(flags) || new Set(flags).size !== flags.length) throw new Error("Invalid rule regex flags");
  return { source: pattern.slice(1, end), flags: (flags.includes("i") ? RE2JS.CASE_INSENSITIVE : 0) | (flags.includes("m") ? RE2JS.MULTILINE : 0) | (flags.includes("s") ? RE2JS.DOTALL : 0) };
}

/** Match exact mailbox globs, or substring text globs; /regex/flags works for both. */
export function matchesPattern(pattern: string, value: string, exact = false): boolean {
  const explicit = regexPattern(pattern);
  const source = explicit?.source ?? globToRegexSource(pattern);
  try {
    const expression = RE2JS.compile(exact && !explicit ? `^(?:${source})$` : source, explicit?.flags ?? RE2JS.CASE_INSENSITIVE);
    return expression.matcher(value).find();
  } catch {
    throw new Error("Invalid or unsupported rule pattern");
  }
}

function addresses(header: string): string[] {
  const mailboxes = header.match(/[^\s<>,;"()]+@[^\s<>,;"()]+/g);
  return mailboxes ?? (header.trim() ? [header.trim()] : []);
}

export function getMessageField(message: ParsedMessage, field: StaticField): string {
  switch (field) {
    case "from": return message.headers.from;
    case "to": return message.headers.to;
    case "subject": return message.headers.subject;
    case "body": return message.textPlain || convertEmailHtmlToText(message.textHtml ?? "");
  }
}

export function matchesFieldPattern(pattern: string, message: ParsedMessage, field: StaticField): boolean {
  const value = getMessageField(message, field);
  return field === "from" || field === "to"
    ? addresses(value).some((address) => matchesPattern(pattern, address, true))
    : matchesPattern(pattern, value);
}

export function getStaticMatchDetails(rule: StaticRule, message: ParsedMessage): { matches: boolean; configuredFields: StaticField[]; matchedFields: StaticField[] } {
  const fields: StaticField[] = ["from", "to", "subject", "body"];
  const configuredFields = fields.filter((field) => Boolean(rule[field]?.trim()));
  const matchedFields = configuredFields.filter((field) => matchesFieldPattern(rule[field]!, message, field));
  const matches = configuredFields.length > 0 && (rule.conditionalOperator === "OR" ? matchedFields.length > 0 : matchedFields.length === configuredFields.length);
  return { matches, configuredFields, matchedFields };
}

export function matchesStaticRule(rule: StaticRule, message: ParsedMessage): boolean {
  return getStaticMatchDetails(rule, message).matches;
}
