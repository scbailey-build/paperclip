# BQL OS v3.0 Patterns — Gap Analysis

Fork HEAD `f3aa1c3`. Upstream `paperclipai/paperclip@f12bb27`, merge-base `b947a7d`
(our exact fork point), **693 upstream commits since** — upstream findings below cite
commits from that range. Line refs are fork HEAD unless marked `upstream:`.

## 1. Ledger-grade identity — **upstream-solved (core), small fork delta**

**Today (fork):** Per-agent sha256-hashed `pcp_` keys with revocation
(`server/src/services/agents.ts:24-30,607-635`; `packages/db/src/schema/agent_api_keys.ts`,
revocation honored at `server/src/middleware/auth.ts:135`) and per-run HS256 JWTs
(`server/src/agent-auth-jwt.ts:68-93`). Byte-normalization: verification trims the bearer
token (`auth.ts:103`) and keys are server-generated clean hex, so a trailing newline
cannot produce a different hash — **that sub-requirement is already-done**.
**The defect is live:** the `process` adapter injects no credential
(`server/src/adapters/process/execute.ts:14-53`; `buildPaperclipEnv` at
`packages/adapter-utils/src/server-utils.ts:893-914` sets no key), so heartbeat API calls
resolve to the shared implicit `local-board` super-admin (`auth.ts:24-34`); agent identity
is then body-claimed (`server/src/routes/approvals.ts:94-95`) and the unverified
`X-Paperclip-Run-Id` header overrides the signed JWT `run_id` claim (`auth.ts:166`).
`agent_api_keys.keyHash` index is non-unique (`agent_api_keys.ts:18`), unlike board keys.

**Upstream:** fixed the core. `process` adapter now `supportsLocalAgentJwt: true` with
`authToken → PAPERCLIP_API_KEY` injection (`upstream:server/src/adapters/process/index.ts:10`,
`execute.ts:29`); run-id header/claim mismatch is detected and rejected
(`upstream:auth.ts:282-294`); run JWTs instance-isolated (#9162), per-company signing keys
(#5864), cloud tenants never instance-admin (#7525). **Still present upstream:** the
body-claim `requestedByAgentId` fallback (`upstream:routes/approvals.ts:149-150`) and the
`local-board` implicit actor (`upstream:auth.ts:147-151`).

**Verdict:** rebase onto upstream; fork delta = remove body-claim fallback, unique keyHash
index — both natural upstream PRs. **Cost of fork-building instead:** re-implementing four
shipped upstream security PRs as permanent private drift.

## 2. External write contract — **adapt (fork build on plugin surfaces)**

**Today:** No external-write layer. Work products only *record* artifacts created in agent
sandboxes (`server/src/services/work-products.ts:33-121`). Plugin webhooks are inbound,
and the documented `external_id` dedup is unimplemented (`packages/db/src/schema/plugin_webhooks.ts:44-45`
vs `server/src/routes/plugins.ts:2323-2333`). Plugin jobs: no retry (failure just advances
the schedule, `server/src/services/plugin-job-scheduler.ts:392-425`), and the documented
repeated-failure `error` status is never set (`plugin_jobs.ts:26`). Idempotency machinery
exists but is internal-only (interactions migration 0064; routine runs
`routines.ts:1153-1183`; recovery wakes `recovery/service.ts:1682`). Cron supports nightly
(`services/cron.ts`). No upstream coverage (reconciliation commits in range are all
internal issue-graph/worktree state).

**Verdict:** adapt — one contract shape in the plugin SDK reusing `plugin_managed_resources`
+ `plugin_jobs`; webhook-dedup fix is an upstream-PR candidate. **Cost of rejecting:**
every agent-written Notion/CRM/Drive object is a one-off with silent drift and dupes.

## 3. Data-gated activation — **adopt (fork)**

**Today:** Nothing. Activation is a bare status flip guarded only by prior status
(`server/src/services/agents.ts:534-543`); the hire hook does adapter notification only,
failures non-fatal (`server/src/services/hire-hook.ts:24-113`); no precondition concept
anywhere. No upstream coverage in the 693 commits.

**Verdict:** adopt. **Cost of rejecting:** monitoring-class agents burn heartbeat budget
producing nothing against empty substrates (observed in-session with the COO on a fresh
company: rules no-op but runs still bill).

## 4. Policy by decision — **upstream-solved (enforcement core); fork delta = tri-state**

**Today (fork):** No per-agent tool scope. MCP tools are one global ~40-tool array
(`packages/mcp-server/src/tools.ts:224`); plugin tool registry filters only by pluginId
(`server/src/services/plugin-tool-registry.ts:75,349`); grants are additive presence-only
over 8 capability keys (`packages/shared/src/constants.ts:655`;
`server/src/services/access.ts:55-75` — disable deletes the row); agent `permissions`
jsonb holds two booleans (`server/src/services/agent-permissions.ts:6-9`). Two bypasses:
`paperclipApiRequest` is an any-endpoint proxy (`mcp-server/src/tools.ts:595`), and
claude-local non-sandbox runs pass `--dangerously-skip-permissions`
(`packages/adapters/claude-local/src/server/permissions.ts:41`).

**Upstream:** the 8-part "governed MCP access" stack (#9558 et al.) ships a
`tool-access-policy` service with agent/issue/project/company-scoped profiles,
allow/deny evaluation, run-context-mismatch denial, and UI surfaces
(`upstream:server/src/routes/tool-access.ts`, 1,269 lines; 7,700+ lines of tests).
It is **binary** — no undecided/unclassified state surfaced as an open decision.

**Verdict:** upstream-solved for enforcement; rebase, then layer the tri-state
("undecided → open decision in UI, not silent deny") as a small fork extension and
propose it upstream. **Cost of fork-building:** ~9,000 lines of parallel policy engine
that permanently conflicts with upstream's.

## 5. Model policy with refresh — **adapt (fork)**

**Today:** Per-adapter model registry with on-demand refresh exists
(`server/src/adapters/registry.ts:622-654`; refresh route `server/src/routes/agents.ts:1354`;
60s caches in `codex-models.ts:7`/`cursor-models.ts:6`; Claude refresh added upstream
#6953). Exactly one wired profile, `"cheap"` (`constants.ts:79`), fully resolved in
heartbeat (`server/src/services/heartbeat.ts:1076,7044`) and forced for recovery
(`recovery/model-profile-hint.ts:1`). No risk tiers, **no staleness job** (no cron/model
reference in `services/cron.ts`), and execution-policy stages have no model dimension —
stage schema is participants-only (`packages/shared/src/validators/issue.ts:113`; stage
types `review|approval`, `constants.ts:287`), so cross-model review is only incidental.
The fork's smart-model-routing doc remains Status: Proposed and unimplemented both sides.

**Verdict:** adapt — extend the existing profile mechanism to risk tiers, add a scheduled
staleness sweep against the existing registry, express cross-model review through stage
participants. **Cost of rejecting:** stale pins rot silently and high-risk output is
self-reviewed by its own model.

## 6. Cost joined to work — **mostly already-done; small adapt**

**Today:** `cost_events` carries issue/project/goal/billingCode/run columns
(`packages/db/src/schema/cost_events.ts:14-19`); runs working an issue auto-populate
`issueId`/`projectId` (`heartbeat.ts:1305-1334,6668-6685`); by-project rollup exists with
an activity-log fallback join (`server/src/services/costs.ts:454-502`). Gaps: `goalId`
and `billingCode` are never auto-populated by that insert; runs with no issue attribute
to agent only (no invariant); margin is not automatic — `finance_events` (revenue) are
manual, board-only (`server/src/routes/costs.ts:102-130`); no client entity. No upstream
coverage.

**Verdict:** already-done for cost-per-project; adapt the residue (populate two columns,
attribution-completeness surfacing, client=project convention). **Cost of rejecting the
residue:** margin stays a spreadsheet exercise.

## 7. Improvement loop — **adapt (fork)**

**Today:** Rich per-issue machinery: recovery fingerprints uniquely indexed **per source
issue** (`packages/db/src/schema/issue_recovery_actions.ts:61-66`), and productivity
reviews already auto-create manager-assigned review issues from anomaly triggers via
`originKind` (`server/src/services/productivity-review.ts:44,182-191,684-699`). Nothing
detects the same failure across issues/runs; feedback is one-way telemetry to Labs with
no loop into work creation (`services/feedback.ts`, `feedback-share-client.ts:48`). No
upstream coverage (#4f5abf60 recovery-card work is per-issue).

**Verdict:** adapt — a cross-issue recurrence sweep reusing the productivity-review
pattern verbatim. **Cost of rejecting:** the same blocker gets hand-triaged forever;
tuition paid twice, lesson bought never.
