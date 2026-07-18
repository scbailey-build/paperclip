/**
 * The operator's standard card-plan structure. Every pre-drafted plan (agent-
 * or COO-authored) follows this template; the Board's "Request plan" action
 * sends it verbatim so agents draft in the expected shape.
 */
export const CARD_PLAN_TEMPLATE = `## Context
Why this matters and what project/phase it supports.

## Objective
What needs to be completed.

## Scope
Included:
-
-

Excluded:
-

## Acceptance Criteria
- [ ] Clear, testable condition #1
- [ ] Clear, testable condition #2
- [ ] Clear, testable condition #3

## Dependencies / Blockers
- Dependency, person, document, approval, or external input needed.

## Deliverables
- Final artifact, decision, update, file, email, permit package, automation, etc.

## Owner
Primary accountable person.

## Due Date
Target completion date.

## Priority
Low / Medium / High / Critical

## Status
To Do / In Progress / Blocked / Done
`;

export const REQUEST_PLAN_COMMENT = `Please draft a plan for this card as the issue document with key \`plan\` before starting work. Use exactly this structure:

${CARD_PLAN_TEMPLATE}`;
