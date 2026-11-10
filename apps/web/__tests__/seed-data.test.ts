import { describe, expect, it } from "vitest";
import { demoSeed } from "../scripts/seed-data";

describe("local demo seed", () => {
  it("provides distinct, self-contained mailboxes with realistic rule templates", () => {
    expect(demoSeed.accounts.map((account) => account.email)).toEqual([
      "developer@example.com", "developer@outlook.test",
    ]);
    expect(demoSeed.rules.map((rule) => rule.name)).toEqual([
      "To Reply", "Receipts & Invoices", "Newsletters", "Cold Emails", "VIP Clients", "Calendar Invites",
    ]);
    expect(demoSeed.knowledge).toHaveLength(3);
    expect(demoSeed.replyMemories).toHaveLength(3);
    expect(demoSeed.messages).toHaveLength(25);
    expect(new Set(demoSeed.messages.map((message) => message.id)).size).toBe(25);
    for (const account of demoSeed.accounts) {
      const messages = demoSeed.messages.filter((message) => message.accountId === account.id);
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.every((message) => message.toEmail === account.email && message.labels.includes("INBOX"))).toBe(true);
    }
  });

  it("includes thread, unsubscribe, calendar and adversarial cases for offline testing", () => {
    const threads = new Map<string, number>();
    for (const message of demoSeed.messages) {
      const key = `${message.accountId}:${message.threadId}`;
      threads.set(key, (threads.get(key) ?? 0) + 1);
      expect(Number.isNaN(Date.parse(message.internalDate))).toBe(false);
    }
    expect([...threads.values()].filter((count) => count > 1).length).toBeGreaterThanOrEqual(2);
    expect(demoSeed.messages.some((message) => message.listUnsubscribe?.includes("https://") && message.listUnsubscribePost === "List-Unsubscribe=One-Click")).toBe(true);
    expect(demoSeed.messages.some((message) => message.textBody.includes("BEGIN:VCALENDAR"))).toBe(true);
    expect(demoSeed.messages.filter((message) => /ignore all rules|system override/i.test(message.textBody))).toHaveLength(2);
  });
});
