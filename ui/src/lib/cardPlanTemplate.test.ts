import { describe, expect, it } from "vitest";
import { CARD_PLAN_TEMPLATE, REQUEST_PLAN_COMMENT } from "./cardPlanTemplate";

describe("card plan template", () => {
  it("contains exactly the operator's sections, in order", () => {
    const headings = [...CARD_PLAN_TEMPLATE.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual([
      "Context",
      "Objective",
      "Scope",
      "Acceptance Criteria",
      "Dependencies / Blockers",
      "Deliverables",
    ]);
  });

  it("omits card-field duplicates (owner, due date, priority, status)", () => {
    expect(CARD_PLAN_TEMPLATE).not.toMatch(/^## (Owner|Due Date|Priority|Status)$/m);
  });

  it("keeps acceptance criteria as checkboxes so the COO can take a position", () => {
    expect(CARD_PLAN_TEMPLATE).toMatch(/- \[ \]/);
  });

  it("embeds the template verbatim in the request-plan comment", () => {
    expect(REQUEST_PLAN_COMMENT).toContain(CARD_PLAN_TEMPLATE);
    expect(REQUEST_PLAN_COMMENT).toContain("`plan`");
  });
});
