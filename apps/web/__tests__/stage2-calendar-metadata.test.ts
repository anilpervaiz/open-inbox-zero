import { describe, expect, it } from "vitest";
import { isCalendarInvite } from "../utils/ai/choose-rule/match-rules";
import type { ParsedMessage } from "../utils/mail-provider/types";

const plain: ParsedMessage = {
  id: "message", threadId: "thread", snippet: "", internalDate: new Date("2026-01-01T00:00:00Z"), labelIds: [],
  headers: { from: "alice@example.com", to: "me@example.com", subject: "Hello", date: "2026-01-01" }, textPlain: "Please join us.",
};

describe("calendar provider metadata", () => {
  it("detects calendar MIME or ICS attachments even without body or subject hints", () => {
    expect(isCalendarInvite({ ...plain, contentType: "text/calendar; method=REQUEST" })).toBe(true);
    expect(isCalendarInvite({ ...plain, contentType: "multipart/mixed", mimeTypes: ["text/plain", "TEXT/CALENDAR; charset=utf-8"] })).toBe(true);
    expect(isCalendarInvite({ ...plain, attachmentNames: ["Invite.ICS"] })).toBe(true);
    expect(isCalendarInvite({ ...plain, contentType: "text/plain", mimeTypes: ["text/plain"], attachmentNames: ["agenda.pdf"] })).toBe(false);
  });
});
