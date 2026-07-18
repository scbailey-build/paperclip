import { describe, expect, it } from "vitest";
import type { Approval } from "@paperclipai/shared";
import { approvalField, approvalIssueIds, isCooRecommendation } from "./Brief";

function approval(partial: Partial<Approval>): Approval {
  return { id: "a1", type: "request_board_approval", payload: {}, ...partial } as Approval;
}

describe("isCooRecommendation", () => {
  it("accepts the first-class type", () => {
    expect(isCooRecommendation(approval({ type: "coo_recommendation" }))).toBe(true);
  });

  it("accepts legacy payload.kind recommendations for back-compat", () => {
    expect(
      isCooRecommendation(
        approval({ type: "request_board_approval", payload: { kind: "coo_recommendation" } }),
      ),
    ).toBe(true);
  });

  it("rejects plain board approvals", () => {
    expect(isCooRecommendation(approval({}))).toBe(false);
  });
});

describe("approvalField", () => {
  it("returns the first non-empty string across fallback keys", () => {
    const value = approvalField(
      approval({ payload: { title: "  ", situation: "Budget crossed" } }),
      ["title", "situation"],
    );
    expect(value).toBe("Budget crossed");
  });

  it("ignores non-string payload values", () => {
    expect(approvalField(approval({ payload: { title: 42 } }), ["title"])).toBeNull();
  });
});

describe("approvalIssueIds", () => {
  it("returns only string ids", () => {
    expect(
      approvalIssueIds(approval({ payload: { issueIds: ["i1", 2, null, "i2"] } })),
    ).toEqual(["i1", "i2"]);
  });

  it("returns empty for missing or malformed issueIds", () => {
    expect(approvalIssueIds(approval({}))).toEqual([]);
    expect(approvalIssueIds(approval({ payload: { issueIds: "i1" } }))).toEqual([]);
  });
});
