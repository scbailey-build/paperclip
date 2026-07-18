# Dashboard Rebuild — Phase 4: The COO Agent

Status: shipped and loop-tested. Built entirely on existing primitives; one Phase 1 claim
corrected below.

## What it is

A Paperclip agent named **COO** running `scripts/coo/coo-heartbeat.mjs` via the process
adapter. v1 logic is **deterministic rules, no model judgment** — which is why the agent is a
script, not an LLM adapter. Each heartbeat it reads company state through the API (agents have
company-wide read access; Phase 1 §4) and posts recommendations that surface in the Brief's
Decisions section. Every action carries its heartbeat run id, so the audit trail attributes
everything it does.

## Scope convention (operator-approved)

Read everything; write only recommendation-approvals. It never checks out work, never moves
cards, never spends beyond its own run cost. Hard enforcement of read-only agents does not
exist in the permission model (Phase 1 G1, flagged); enforcement here is by convention +
audit attribution + its small budget cap.

## The five rules

| # | Rule | Trigger | Position taken |
|---|---|---|---|
| 1 | `budget_threshold` | Any active budget policy (from `/budgets/overview`, the same engine that hard-stops agents) at/over its warn line | Raise the budget or requeue non-critical cards; at 100%: pause or raise now |
| 2 | `card_stalled` | No progress past `COO_STALL_DAYS` (default 7) on an in-progress/blocked card | Restart under 2× the limit; **kill** at 2×+ |
| 3 | `gate_aging` | Review Gate card older than `COO_GATE_HOURS` (default 24) | Approve if every acceptance criterion in its plan is checked; override with feedback if not; "needs your eyes" if no checklist |
| 4 | `wip_breach` | Department (project) with more than `COO_WIP_LIMIT` (default 5) cards in progress | Requeue the named lowest-priority in-progress card |
| 5 | `deliverable_collision` | Two workflows with active cards producing the same work product (matched on externalId/url/title) | Merge under one workflow, block the other |

Each recommendation = `{situation, recommendation, costOfDecidingWrong}` + rule + linked
issue ids. Dedup by fingerprint: never re-raised while pending or within 7 days of a decision.

## Implementation notes

- **Approval type**: the create validator enforces an enum (`hire_agent`,
  `approve_ceo_strategy`, `budget_override_required`, `request_board_approval`) — the Phase 1
  doc's "type is free text" was wrong at the API layer. Recommendations ride
  `request_board_approval` with `payload.kind: "coo_recommendation"`. A dedicated enum value
  would be a one-line backend change — flagged, not made.
- **One-tap actuation**: approving a `gate_aging` recommendation in the Brief also advances
  the linked in-review card(s) to done — the board-sanctioned action the recommendation asked
  for, executed as the operator, not the COO.
- **Brief dedup**: review-gate cards covered by a pending COO recommendation don't render a
  second raw row.
- **Config**: `COO_STALL_DAYS`, `COO_GATE_HOURS`, `COO_WIP_LIMIT`, `COO_BUDGET_WARN_PCT` env
  vars (production home: the COO routine's variables / adapter env).
- **Cadence**: heartbeat scheduler; the Brief renders on demand. No push notifications in v1.

## Loop test (performed live)

1. Atlas (real agent heartbeat, injected credentials) created card BEQ-15, checked it out,
   and moved it to the Review Gate.
2. After aging past 24h, a COO heartbeat (platform-invoked run) posted
   `gate_aging: BEQ-15 waiting at the Review Gate 25h` with a position.
3. Operator tapped Approve in the Brief (browser).
4. BEQ-15 advanced to `done`; the approval recorded `approved` / "Approved from the Brief." /
   `decidedByUserId: local-board` / `requestedByAgentId: <COO>`; the activity log shows
   `approval.created` → `approval.approved` → `issue.updated` → `issue.comment_added`.

## Install (any instance)

```sh
# 1. Create the agent (process adapter):
#    command: node, args: [<repo>/scripts/coo/coo-heartbeat.mjs]
# 2. Give it a small monthly budget.
# 3. Heartbeats run it; or create a cron routine assigned to it for a fixed cadence.
```
