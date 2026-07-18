import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { STALL_THRESHOLD_DAYS, isStalled } from "./stall";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function issue(status: string, ageDays: number): Issue {
  return { status, updatedAt: new Date(NOW - ageDays * DAY) } as Issue;
}

describe("isStalled", () => {
  it("stalls in_progress and blocked cards past the threshold", () => {
    expect(isStalled(issue("in_progress", STALL_THRESHOLD_DAYS + 1), NOW)).toBe(true);
    expect(isStalled(issue("blocked", STALL_THRESHOLD_DAYS + 1), NOW)).toBe(true);
  });

  it("never stalls fresh or terminal cards", () => {
    expect(isStalled(issue("in_progress", 1), NOW)).toBe(false);
    expect(isStalled(issue("done", 30), NOW)).toBe(false);
    expect(isStalled(issue("in_review", 30), NOW)).toBe(false);
    expect(isStalled(issue("todo", 30), NOW)).toBe(false);
  });
});
