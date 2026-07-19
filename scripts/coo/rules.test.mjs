import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  evaluateRules,
  planChecklistState,
  suppressedFingerprints,
} from "./rules.mjs";

const NOW = 1_800_000_000_000; // fixed clock
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function baseState(overrides = {}) {
  return {
    now: NOW,
    config: DEFAULT_CONFIG,
    issues: [],
    agents: [{ id: "ag1", name: "Atlas" }],
    projects: [{ id: "pr1", name: "Growth" }],
    goals: [
      { id: "g1", title: "Launch outreach engine" },
      { id: "g2", title: "Q3 revenue push" },
    ],
    approvals: [],
    budgets: { policies: [] },
    plansByIssueId: new Map(),
    workProductsByIssueId: new Map(),
    ...overrides,
  };
}

function issue(partial) {
  return {
    id: "i1",
    identifier: "BEQ-1",
    title: "Card",
    status: "in_progress",
    priority: "medium",
    projectId: "pr1",
    goalId: "g1",
    assigneeAgentId: "ag1",
    updatedAt: new Date(NOW).toISOString(),
    ...partial,
  };
}

test("rule 1: fires at the policy warn line and takes a position", () => {
  const recs = evaluateRules(
    baseState({
      budgets: {
        policies: [
          {
            isActive: true,
            scopeType: "agent",
            scopeId: "ag1",
            scopeName: "Atlas",
            utilizationPercent: 92,
            warnPercent: 80,
            amount: 100000,
            remainingAmount: 8000,
            hardStopEnabled: true,
            windowKind: "calendar_month_utc",
            windowStart: "2026-07-01",
          },
        ],
      },
    }),
  );
  assert.equal(recs.length, 1);
  assert.equal(recs[0].rule, "budget_threshold");
  assert.ok(recs[0].recommendation.length > 0);
  assert.ok(recs[0].costOfDecidingWrong.length > 0);
});

test("rule 1: silent under the warn line and for inactive policies", () => {
  const policies = [
    { isActive: true, utilizationPercent: 50, warnPercent: 80, amount: 1, remainingAmount: 1 },
    { isActive: false, utilizationPercent: 99, warnPercent: 80, amount: 1, remainingAmount: 1 },
  ];
  assert.equal(evaluateRules(baseState({ budgets: { policies } })).length, 0);
});

test("rule 2: restart under 2x the stall limit, kill at 2x+", () => {
  const restart = evaluateRules(
    baseState({ issues: [issue({ updatedAt: new Date(NOW - 9 * DAY).toISOString() })] }),
  );
  assert.equal(restart[0].rule, "card_stalled");
  assert.match(restart[0].recommendation, /^Restart/);

  const kill = evaluateRules(
    baseState({ issues: [issue({ updatedAt: new Date(NOW - 15 * DAY).toISOString() })] }),
  );
  assert.match(kill[0].recommendation, /^Kill/);
});

test("rule 2: fresh and done cards never stall", () => {
  const recs = evaluateRules(
    baseState({
      issues: [
        issue({ updatedAt: new Date(NOW - 1 * DAY).toISOString() }),
        issue({ id: "i2", status: "done", updatedAt: new Date(NOW - 30 * DAY).toISOString() }),
      ],
    }),
  );
  assert.equal(recs.length, 0);
});

test("rule 3: position follows the plan checklist", () => {
  const gated = issue({ status: "in_review", updatedAt: new Date(NOW - 30 * HOUR).toISOString() });
  const approve = evaluateRules(
    baseState({
      issues: [gated],
      plansByIssueId: new Map([[gated.id, "- [x] one\n- [X] two"]]),
    }),
  );
  assert.match(approve[0].recommendation, /^Approve/);

  const override = evaluateRules(
    baseState({
      issues: [gated],
      plansByIssueId: new Map([[gated.id, "- [x] one\n- [ ] two"]]),
    }),
  );
  assert.match(override[0].recommendation, /^Override/);

  const review = evaluateRules(baseState({ issues: [gated] }));
  assert.match(review[0].recommendation, /^Review/);
});

test("rule 3: silent under the gate age limit", () => {
  const gated = issue({ status: "in_review", updatedAt: new Date(NOW - 2 * HOUR).toISOString() });
  assert.equal(evaluateRules(baseState({ issues: [gated] })).length, 0);
});

test("rule 4: names the lowest-priority card when a department breaches WIP", () => {
  const cards = ["critical", "high", "medium", "low", "medium", "high"].map((priority, index) =>
    issue({ id: `i${index}`, identifier: `BEQ-${index}`, priority }),
  );
  const recs = evaluateRules(baseState({ issues: cards }));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].rule, "wip_breach");
  assert.match(recs[0].recommendation, /BEQ-3/); // the "low" card
});

test("rule 5: flags only cross-workflow deliverable collisions", () => {
  const a = issue({ id: "ia", identifier: "BEQ-10", goalId: "g1" });
  const b = issue({ id: "ib", identifier: "BEQ-11", goalId: "g2" });
  const sameGoal = issue({ id: "ic", identifier: "BEQ-12", goalId: "g1" });
  const product = { title: "Pricing page", url: "https://x.co/pricing", externalId: null };

  const collide = evaluateRules(
    baseState({
      issues: [a, b],
      workProductsByIssueId: new Map([
        ["ia", [product]],
        ["ib", [product]],
      ]),
    }),
  );
  assert.equal(collide.length, 1);
  assert.equal(collide[0].rule, "deliverable_collision");

  const noCollide = evaluateRules(
    baseState({
      issues: [a, sameGoal],
      workProductsByIssueId: new Map([
        ["ia", [product]],
        ["ic", [product]],
      ]),
    }),
  );
  assert.equal(noCollide.length, 0);
});

test("fingerprint dedup: pending and recently-decided recommendations stay suppressed", () => {
  const stalled = issue({ updatedAt: new Date(NOW - 9 * DAY).toISOString() });
  const pending = {
    type: "coo_recommendation",
    status: "pending",
    updatedAt: new Date(NOW).toISOString(),
    payload: { fingerprint: `stall:${stalled.id}:restart` },
  };
  assert.equal(evaluateRules(baseState({ issues: [stalled], approvals: [pending] })).length, 0);

  const decidedOld = {
    ...pending,
    status: "rejected",
    updatedAt: new Date(NOW - 8 * DAY).toISOString(),
  };
  assert.equal(evaluateRules(baseState({ issues: [stalled], approvals: [decidedOld] })).length, 1);

  // Legacy pre-enum recommendations suppress via payload.kind.
  const legacy = {
    type: "request_board_approval",
    status: "pending",
    updatedAt: new Date(NOW).toISOString(),
    payload: { kind: "coo_recommendation", fingerprint: `stall:${stalled.id}:restart` },
  };
  assert.equal(evaluateRules(baseState({ issues: [stalled], approvals: [legacy] })).length, 0);
});

test("planChecklistState handles empty and mixed bodies", () => {
  assert.equal(planChecklistState(null), null);
  assert.equal(planChecklistState("no boxes here"), null);
  assert.equal(planChecklistState("- [x] a\n- [x] b"), true);
  assert.equal(planChecklistState("- [x] a\n- [ ] b"), false);
});

test("suppressedFingerprints ignores non-COO approvals", () => {
  const set = suppressedFingerprints(
    [
      {
        type: "hire_agent",
        status: "pending",
        updatedAt: new Date(NOW).toISOString(),
        payload: { fingerprint: "x" },
      },
    ],
    NOW,
  );
  assert.equal(set.size, 0);
});

test("rule 6: flags unattributed spend over the floor, day-bucketed fingerprint", () => {
  const recs = evaluateRules(
    baseState({ costs: { windowCents: 5000, attributedCents: 3000 } }),
  ).filter((r) => r.rule === "unattributed_spend");
  assert.equal(recs.length, 1);
  assert.match(recs[0].title, /\$20\.00/);
  assert.match(recs[0].situation, /40%/);
  assert.equal(recs[0].fingerprint, `cost-attribution:${new Date(NOW).toISOString().slice(0, 10)}`);
});

test("rule 6: silent under the floor, without cost data, and when fully attributed", () => {
  for (const costs of [
    null,
    { windowCents: 50, attributedCents: 0 },
    { windowCents: 5000, attributedCents: 5000 },
    { windowCents: 3000, attributedCents: 5000 },
  ]) {
    const recs = evaluateRules(baseState({ costs })).filter(
      (r) => r.rule === "unattributed_spend",
    );
    assert.equal(recs.length, 0, `expected silence for ${JSON.stringify(costs)}`);
  }
});
