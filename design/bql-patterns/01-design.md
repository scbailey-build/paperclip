# Design — Adopted/Adapted Patterns

Ground rule: extend existing tables and plugin surfaces; add-new → migrate → retire; no
breaking renames. Phase 0 (see 03-plan) merges upstream `f12bb27`, which delivers pattern
1's core and pattern 4's enforcement engine before any fork work starts.

## P1. Identity (post-rebase fork delta)

- **Schema:** none new. Migration: add `uniqueIndex` on `agent_api_keys.key_hash`
  (add-new index → verify no dupes → retire old index), matching board keys
  (`board_api_keys.ts:17`).
- **API:** remove the body-claim fallback — `requestedByAgentId` becomes server-derived
  from `req.actor` for agent actors and **null for board actors** unless the caller holds
  a new `approvals:attribute` grant (extends the existing `PERMISSION_KEYS` enum,
  `constants.ts:655`). Migrate: one release logging a deprecation activity event when the
  body value is used (`logActivity`, `services/activity-log.ts:65`); retire: ignore it.
- **UI:** AgentDetail keys tab gains "last used / never used" from `lastUsedAt`
  (`agent_api_keys.ts:13`) so unused shared-era credentials are visibly retirable.
- **Propose upstream:** both changes.

## P2. External write contract (plugin-SDK surface)

One TypeScript contract shape, implemented once in the plugin SDK, instantiated per
object type by plugins (Notion page, CRM contact, Drive doc):

- **Schema:** extend `plugin_managed_resources` (existing table) with
  `idempotency_key text`, `contract_step text`, `last_reconciled_at timestamptz`,
  unique `(plugin_id, resource_type, idempotency_key)`. Add-new columns only.
- **SDK:** `defineWriteContract({ objectType, idempotencyKey(input), steps: [...],
  resolveRelations(input) })`. Steps run in declared order; each step is retried
  (reusing the scheduler's existing run bookkeeping, `plugin-job-scheduler.ts:392-425`,
  extended with bounded retry then a raised **exception issue**); ambiguous relation
  resolution returns `triage` → the SDK opens an `in_review` issue (triage queue = the
  Review Gate; ADR-g) and never links silently.
- **Reconciliation:** a nightly (`0 3 * * *`) plugin job per contract re-walks external
  state through the same idempotent steps — heal-on-the-same-path by construction. The
  scheduler's cron already supports this (`services/cron.ts`).
- **Also:** implement the documented webhook `external_id` dedup at
  `routes/plugins.ts:2323` (populate + reject duplicates) — upstream PR.
- **UI:** PluginSettings gains a per-contract health row (last sweep, drift healed,
  triage count).

## P3. Data-gated activation

- **Schema:** none new — `activationPreconditions` lives in the existing
  `agents.runtimeConfig` jsonb (validated in `agentRuntimeConfigSchema`,
  `validators/agent.ts:60`): `[{ kind: "min_rows", entity: "issues"|"projects"|…,
  where?, min }, { kind: "api_probe", path, expect }]`.
- **Server:** evaluated in two places: `activatePendingApproval`
  (`services/agents.ts:534-543`) — unmet → stays `pending_approval` with reasons in
  `agents.metadata.activationBlockers`; and heartbeat dispatch — unmet → skip run, log
  `agent.activation_precondition_unmet` activity (no silent budget burn).
- **UI:** AgentDetail banner listing unmet preconditions with the one action ("seed via
  import" link); NewAgent shows them pre-hire.
- **Migration:** absent field = no preconditions (today's behavior); templates for
  monitoring-class roles ship with sensible defaults.

## P4. Tool policy (post-rebase fork delta: tri-state)

Upstream's `tool-access-policy` service is the enforcement engine (agent/issue/project/
company scopes, allow/deny). Fork adds the *decision ledger*:

- **Schema:** extend upstream's policy profile shape with `default: "undecided"` (theirs:
  allow/deny). Undecided **evaluates as deny at runtime** but is recorded distinctly.
- **Server:** a `tool-policy-coverage` view: enumerate all registered tools (MCP array
  `mcp-server/src/tools.ts:224` + plugin registry `listTools`,
  `plugin-tool-registry.ts:349`) minus explicitly classified → undecided set.
- **UI:** Settings → Tool Policy screen: per-role matrix, undecided rendered as open
  decisions (signal-colored count in the Brief's System awareness is out of scope; a
  badge on the settings row suffices). One tap classifies.
- **Constraint handling:** `paperclipApiRequest` (`tools.ts:595`) is classified like any
  tool but defaults **deny** for non-CEO roles; claude-local non-sandbox
  `--dangerously-skip-permissions` (`claude-local/.../permissions.ts:41`) is surfaced as
  a permanent open decision until an explicit per-agent allowlist replaces it.
- **Migration:** on rebase, seed classifications from observed tool usage in
  `activity_log`; everything unobserved starts undecided. Propose tri-state upstream.

## P5. Model policy

- **Schema:** extend `MODEL_PROFILE_KEYS` from `["cheap"]` (`constants.ts:79`) to
  `["cheap","standard","frontier"]` mapped to risk tiers low/medium/high; per-role
  defaults in company settings (existing companies row, new jsonb column
  `model_policy` — add-new, nullable); per-agent override stays `adapterConfig.model`.
- **Staleness sweep:** a scheduled job (same registration path as productivity
  reconciliation, `server/src/index.ts:749-780`, but daily) compares every agent's
  pinned `adapterConfig.model` against `listAdapterModels` (`registry.ts:622`) with
  `refresh=1`; unknown/retired pin → `model_pin_stale` activity event + a Brief-feeding
  `coo_recommendation` approval (the COO rule engine gains rule 6 in
  `scripts/coo/rules.mjs` — deterministic, fits the existing shape).
- **Cross-model adversarial review:** no stage schema change. A validation rule on
  `executionPolicy` (in `issue-execution-policy.ts` validation path): when the policy is
  marked `riskTier: "high"`, the review stage's participant agent must resolve to a
  different `adapterConfig.model` (or different adapter) than the producer; violation →
  policy rejected at set time with a clear message. Reviewer diversity via participants,
  per upstream's stage shape (`validators/issue.ts:113`).

## P6. Cost residue

- Populate `goalId` + `billingCode` in the run cost insert (`heartbeat.ts:6668-6685`)
  from the already-loaded issue — two fields, no schema change.
- **Attribution invariant:** nightly check (same sweep runner) counts cost events with
  null `projectId` after the fallback join (`costs.ts:454-502`); nonzero → activity
  event + COO recommendation. Enforcement stays soft (ADR-b).
- **Margin:** client = project (ADR-c). Automate the revenue side minimally: extend the
  existing archivist/routine pattern to post `finance_events` credits from a per-project
  `billingCode` rate config (companies-settings jsonb) — board approval gate unchanged
  (`routes/costs.ts:102-130`). Costs UI gains margin = credits − debits per project
  from the existing finance-summary endpoints (`routes/costs.ts:185-207`).

## P7. Improvement loop

- **Schema:** none new. New origin kind `improvement_proposal` on issues (pattern:
  `issues.ts:45,94-137` partial unique indexes — add one for this kind).
- **Server:** `reconcileImprovementProposals` in the existing reconciliation family
  (`server/src/index.ts:749-780`): groups `issue_recovery_actions` by `(companyId,
  cause, fingerprint-family)` **across issues** (today's uniqueness is per-issue,
  `issue_recovery_actions.ts:64-66` — read-side grouping only, no index change), plus
  repeated identical override notes on approvals; ≥2 occurrences in 30 days → create an
  `improvement_proposal` issue via the exact `createOrUpdateReview` pattern
  (`productivity-review.ts:684-699`): evidence markdown, links to source issues/runs,
  assigned to the source agents' manager, rate-limited and fingerprinted so re-sweeps
  are no-ops.
- **UI:** proposals are ordinary cards (Board/Brief flows apply); a `improvement` label
  makes them filterable.
