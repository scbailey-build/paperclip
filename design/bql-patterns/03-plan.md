# Build Plan — phased, smallest slice first

Identity (P1) precedes everything attribution-dependent (P2, P6, P7). Each phase has a
kill condition; a killed phase leaves prior phases fully shippable.

## Phase 0 — Upstream rebase (prereq, ADR-a)
Merge `upstream/master@f12bb27`; re-run the operator-dashboard verification suite
(screen tests, COO loop test) on the merged tree; re-verify our recommend-only
middleware composes with upstream's tool-access layer.
**Kill:** if the merge invalidates the operator dashboard beyond ~3 days of repair,
stop and cherry-pick only the identity (#9162, #5864, process-adapter JWT) and
governed-MCP commit stacks instead.

## Phase 1 — Identity closure (P1)
Post-rebase: verify process-adapter runs now carry per-run JWTs end-to-end (repeat this
session's empirical env-probe test); remove body-claim fallback behind the deprecation
window (ADR-b); unique index on `key_hash`.
**Kill:** none — this phase is the foundation; if the JWT path can't be made to work in
local_trusted, escalate rather than proceed to P2/P6/P7.

## Phase 2 — Cost residue (P6, tiny)
Populate `goalId`/`billingCode` in the run cost insert; nightly attribution-completeness
check feeding a COO recommendation.
**Kill:** if the completeness check shows <2% unattributed spend for two weeks, skip the
margin automation half until real client billing exists.

## Phase 3 — Activation gates (P3)
`activationPreconditions` in runtimeConfig; checks at activation + heartbeat dispatch;
AgentDetail banner. Ship with defaults on monitoring-class role templates.
**Kill:** if <10% of agents ever define preconditions after a month, freeze at the
schema + check (cheap to keep) and skip further UI investment.

## Phase 4 — Tool-policy tri-state (P4 delta)
Coverage view over upstream's policy engine; undecided = deny + open-decision UI;
activity-log-seeded classification; `paperclipApiRequest` default-deny for non-CEO.
**Kill:** if upstream accepts the tri-state PR quickly, drop the fork carry and track
upstream.

## Phase 5 — Model policy (P5)
Three risk-tier profiles; daily staleness sweep → COO rule 6; high-risk cross-model
review validation on execution policies.
**Kill:** if the staleness sweep fires zero findings in 60 days (models pinned to
evergreen aliases), demote the sweep to weekly and skip the tier UI.

## Phase 6 — Improvement loop (P7)
`reconcileImprovementProposals` sweep + `improvement_proposal` origin kind.
**Kill:** if >50% of proposals are closed as noise in the first month, raise the
threshold to 3 occurrences or narrow causes before investing further.

## Phase 7 — External write contract (P2, largest)
SDK contract shape + `plugin_managed_resources` columns + retry/exception + nightly
reconciliation + Review-Gate triage; first consumer = one real object type (Notion page
or Airtable row — the archivist is the natural pilot); webhook dedup fix alongside.
**Kill:** if no plugin actually writes to an external system of record by the time
phases 1–6 land, park the design (it is fully specified here) and do not build
speculatively.
