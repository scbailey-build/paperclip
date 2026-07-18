import { describe, expect, it } from "vitest";
import type { Issue, IssueWorkProduct } from "@paperclipai/shared";
import { deriveBoardColumns, findWipBreach, isShippedEvidence } from "./Board";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function issue(partial: Partial<Issue>): Issue {
  return {
    id: Math.random().toString(36).slice(2),
    title: "Card",
    status: "todo",
    priority: "medium",
    projectId: "pr1",
    updatedAt: new Date(NOW),
    ...partial,
  } as Issue;
}

function product(partial: Partial<IssueWorkProduct>): IssueWorkProduct {
  return { type: "pull_request", status: "active", title: "wp", ...partial } as IssueWorkProduct;
}

describe("deriveBoardColumns", () => {
  it("maps statuses onto the five universal stages", () => {
    const backlog = issue({ status: "backlog" });
    const todo = issue({ status: "todo" });
    const inProgress = issue({ status: "in_progress" });
    const blocked = issue({ status: "blocked" });
    const inReview = issue({ status: "in_review" });
    const doneNoEvidence = issue({ status: "done" });
    const doneShipped = issue({ status: "done" });

    const columns = deriveBoardColumns(
      [backlog, todo, inProgress, blocked, inReview, doneNoEvidence, doneShipped],
      new Set([doneShipped.id]),
      NOW,
    );

    expect(columns.queued.map((i) => i.id).sort()).toEqual([backlog.id, todo.id].sort());
    expect(columns.in_progress.map((i) => i.id).sort()).toEqual(
      [inProgress.id, blocked.id].sort(),
    );
    expect(columns.review_gate.map((i) => i.id)).toEqual([inReview.id]);
    expect(columns.approved.map((i) => i.id)).toEqual([doneNoEvidence.id]);
    expect(columns.shipped.map((i) => i.id)).toEqual([doneShipped.id]);
  });

  it("sorts stalled cards to the top of their column", () => {
    const fresh = issue({ status: "in_progress", priority: "critical" });
    const stalled = issue({
      status: "in_progress",
      priority: "low",
      updatedAt: new Date(NOW - 9 * DAY),
    });
    const columns = deriveBoardColumns([fresh, stalled], new Set(), NOW);
    expect(columns.in_progress[0].id).toBe(stalled.id);
  });

  it("sorts by priority within non-stalled cards", () => {
    const low = issue({ status: "todo", priority: "low" });
    const critical = issue({ status: "todo", priority: "critical" });
    const columns = deriveBoardColumns([low, critical], new Set(), NOW);
    expect(columns.queued[0].id).toBe(critical.id);
  });
});

describe("isShippedEvidence", () => {
  it("counts merged PRs and live non-PR artifacts as shipped", () => {
    expect(isShippedEvidence([product({ status: "merged" })])).toBe(true);
    expect(isShippedEvidence([product({ status: "approved" })])).toBe(true);
    expect(isShippedEvidence([product({ type: "preview_url", status: "active" })])).toBe(true);
  });

  it("does not count open or closed-unmerged PRs", () => {
    expect(isShippedEvidence([product({ status: "active" })])).toBe(false);
    expect(isShippedEvidence([product({ status: "closed" })])).toBe(false);
    expect(isShippedEvidence([])).toBe(false);
  });
});

describe("findWipBreach", () => {
  it("flags a department only past the limit, counting in_progress only", () => {
    const cards = [
      ...Array.from({ length: 6 }, () => issue({ status: "in_progress" })),
      issue({ status: "blocked" }),
    ];
    expect(findWipBreach(cards, 5)).toEqual({ projectId: "pr1", count: 6 });
    expect(findWipBreach(cards.slice(0, 5), 5)).toBeNull();
  });

  it("ignores cards without a department", () => {
    const cards = Array.from({ length: 8 }, () =>
      issue({ status: "in_progress", projectId: null }),
    );
    expect(findWipBreach(cards, 5)).toBeNull();
  });
});
