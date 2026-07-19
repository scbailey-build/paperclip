# ADRs — decisions needing sign-off

Each has a recommendation and a default that applies if you don't respond.

## ADR-a: Rebase strategy for upstream (693 commits)
Merge upstream `f12bb27` before pattern work, accepting a large one-time integration
(our operator-dashboard fork work must be re-verified against the governed-MCP stack and
ACP-default adapters, upstream #9238). **Recommendation:** yes — patterns 1 and 4 arrive
mostly free; building them fork-side costs ~10k lines of permanent drift.
**Default:** merge upstream first.

## ADR-b: Enforcement mode for unattributed/uncredentialed writes
Hard-reject API writes lacking per-agent credentials (and cost events lacking project
attribution) vs log-and-flag. **Recommendation:** log-and-flag for one release
(deprecation activity events), then reject; hard-cut immediately would break any
operator's custom process agents. **Default:** two-stage (flag → reject next minor).

## ADR-c: Client entity
New `clients` table vs client = `project` + `billingCode` convention.
**Recommendation:** project-as-client with `billingCode` as the cross-project client
rollup key — a second container table is a drift surface against the Department=project
model already shipped. **Default:** project-as-client.

## ADR-d: Undecided-tool runtime behavior
Undecided tools evaluate deny (safe, may break workflows until classified) vs allow
(unsafe, preserves behavior). **Recommendation:** deny-at-runtime + loud open-decision
UI, with the activity-log-seeded initial classification (01-design P4) shrinking the
undecided set before enforcement turns on. **Default:** deny + flag.

## ADR-e: Risk-tier ownership
Tiers assigned per role (company settings) with per-agent override, vs per agent only.
**Recommendation:** role defaults + override — matches how `defaultPermissionsForRole`
already works (`agent-permissions.ts:5`). **Default:** role defaults + override.

## ADR-f: Improvement proposals representation
Issues with `improvement_proposal` origin kind vs a new backlog table.
**Recommendation:** issues — they inherit Board/Brief/COO/audit flows for free; a new
table gets none of them. **Default:** issues.

## ADR-g: Triage queue for ambiguous external relations
`in_review` issues (Review Gate) vs a plugin-owned UI queue. **Recommendation:** Review
Gate issues — ambiguity is a decision, and decisions already have one home in this
product. **Default:** Review Gate issues.

## ADR-h: Upstream contribution posture
Which fork deltas become upstream PRs: identity body-claim removal + keyHash unique
index, webhook `external_id` dedup, tool-policy tri-state. **Recommendation:** all four
— they are small, security-adjacent, and reduce our rebase surface.
**Default:** propose all four after they land in the fork.
