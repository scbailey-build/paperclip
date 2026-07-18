# Dashboard Rebuild — Phase 1: Mapping Document

Status: **awaiting operator approval** (gate 1 of the rebuild). No product code has been changed.
Scope of this phase: read the schema and API end to end, inventory the screens, propose the entity
mapping, answer the COO-permissions question, flag gaps. Build starts only after approval.

---

## 1. The hierarchy answer

**Hierarchy is baked into the data model and server logic — but not into the approval path.
The org chart itself is a pure view-layer projection.** Detail:

- The data model encodes reporting lines and roles directly: `agents.reportsTo` (self-FK,
  `packages/db/src/schema/agents.ts:24`) and `agents.role` (`agents.ts:20`, enum `ceo, cto, cmo,
  cfo, security, engineer, designer, pm, qa, devops, researcher, general`). There is a dedicated
  DB index on `(companyId, reportsTo)` — the backend is optimized for reporting-line queries.
- Server behavior really depends on these fields:
  - `role === "ceo"` seeds `canCreateAgents` and bypasses several authz checks
    (`server/src/services/agent-permissions.ts:5-9`, `server/src/routes/agents.ts:477`).
  - Managers may intervene in a subordinate's active task checkout by walking `reportsTo`
    (`server/src/routes/issues.ts:1063-1071`).
  - Workspace runtime-service management is scoped to an agent's reporting subtree
    (`server/src/routes/workspace-runtime-service-authz.ts`).
  - Stall/liveness recovery escalates to the assignee's manager first, then CTO/CEO by role
    (`server/src/services/recovery/service.ts:809-815`, `recovery/issue-graph-liveness.ts:217-303`).
  - New agents joining are auto-parented under the CEO (`server/src/routes/access.ts:2069-2076`).
- **The approval path ignores hierarchy entirely.** Approvals are decided by *board users*
  (humans), gated by `assertBoard` (`server/src/routes/approvals.ts:137,233,261`), recorded in
  `approvals.decidedByUserId`. Nothing routes an approval up a reporting chain. On approval the
  *requesting agent* is woken — not a manager.
- The org chart (`server/src/routes/org-chart-svg.ts`, `ui/src/pages/OrgChart.tsx`) is a
  read-only renderer of a tree computed from `reportsTo`. Removing it from the UI changes zero
  behavior.

**Consequence for the rebuild:** your model is achievable purely in the presentation layer.
Reporting lines stay in the backend as invisible machinery (escalation, recovery, manager
override) — which is exactly where a COO wants them: working, not on the home screen. The
board-over-agents approval mechanic is already hierarchy-free and maps directly onto "decisions
come up to me."

---

## 2. Screen inventory (every screen → backend capability)

Company-scoped screens (URL-prefixed `/:PREFIX/...`), from `ui/src/App.tsx`:

| Screen (route) | Backend capability exposed | Fate in rebuild |
|---|---|---|
| Dashboard (`/dashboard`) | `GET /companies/:id/dashboard` summary, activity, live runs, budget incidents | Replaced by **Brief** |
| Live runs (`/dashboard/live`) | `GET /companies/:id/live-runs` | Drill-down from Brief/Board |
| Inbox (`/inbox/*`) | Issues assigned/touched, pending approvals, failed runs, join requests; read/archive state | Decision items absorbed into **Brief**; rest reachable from Brief sections |
| Org chart (`/org`) | `GET /companies/:id/org` (reportsTo tree), company import/export | Demoted to a view inside Agents/resources; never home |
| Issues (`/issues`) | `GET/POST /companies/:id/issues`, labels, filters | Becomes the **Board** (kanban) + list inside Workflow detail |
| Issue detail (`/issues/:id`) | Full issue surface: thread, runs, sub-issues, documents, work products, blockers, monitor, checkout, recovery | Card drill-down; largely preserved |
| Search (`/search`) | `GET /companies/:id/search` | Preserved (command palette + search) |
| Routines (`/routines`, `/:id`) | Routines CRUD, cron/webhook triggers, runs, revisions | Relocated under Workflows/resources; powers the COO cadence |
| Goals (`/goals`, `/:id`) | Goals CRUD, project links | Absorbed into **Workflows** |
| Projects (`/projects`, `/:id/*`) | Projects CRUD, per-project kanban, workspaces, budget, config | Becomes **Departments** (filter) + workflow container |
| Workspaces (`/workspaces`, experimental) + execution workspace detail | Execution workspaces, runtime services, logs | Preserved as infra drill-down (note: these are *git/exec* workspaces, not org containers — see §3) |
| Agents (`/agents`, `/agents/:id`, `/agents/new`) | Agent roster, config, permissions, skills sync, keys, budgets, runs, pause/resume, hire | Relocated to resource panels + drill-down; hiring flow preserved |
| Approvals (`/approvals`, `/:id`) | List/decide approvals (approve/reject/request revision), comments, linked issues | Absorbed into **Brief → Decisions**; detail view preserved |
| Costs (`/costs`) | Spend by agent/model/project/provider, budget policies, incidents, quota windows | Drill-down from Brief (budget risk) — informational stats live in detail views |
| Activity (`/activity`) | `GET /companies/:id/activity` audit feed | Preserved as the audit drill-down ("no raw event feed on the Brief") |
| Company settings (`/company/settings/*`) | Company, environments, access, invites, secrets | Preserved unchanged (settings chrome, not nav) |
| Skills (`/skills`) | Company skill library: install/import/scan/update/files | Promoted to top-level **Skills** |
| Company export/import | Portability bundles | Preserved under settings |
| Instance settings (`/instance/settings/*`) | Instance access, heartbeats, experimental flags, plugins, adapters | Preserved unchanged |
| Companies, user profile, onboarding, auth, board claim, CLI auth, invite landing | Session/identity/tenancy | Preserved unchanged |

Nothing the backend can do is dropped; prominence changes, routes stay live, command palette
(Cmd+K) and deep links keep every capability reachable.

**Design-system note:** tokens already live in one place — `ui/src/index.css` (Tailwind v4
CSS-first, OKLCH custom properties, light+dark, square corners) with shadcn primitives in
`ui/src/components/ui/`. Phase 2's token file will be a *tightening* of this existing file
(reduce to the constitution's palette), not a new system.

---

## 3. Entity mapping (proposal)

| Your concept | Paperclip entity | Why it fits | Confidence |
|---|---|---|---|
| **Department** | `projects` | Containers and filters, not reporting lines: projects already scope issues, the per-project kanban, budgets (`budget_policies.scopeType = "project"`), routines, and sidebar filters. Per-department budget + WIP flagging falls out naturally. | High |
| **Workflow** | `goals` (linked to departments via `project_goals`, cards via `issues.goalId`) | A goal is a named objective with `ownerAgentId`, lifecycle (`planned/active/achieved/cancelled`), and hierarchy (`parentId`). Every issue and project can point at it. It is the one entity that spans "what are we trying to achieve" across cards. | Medium-high |
| **Milestone** (approval gate) | Gate issues inside the workflow: `issues.status = "in_review"` + `approvals` + `issue_thread_interactions` (`request_confirmation`), sequenced with first-class blockers (`blockedByIssueIds`, auto-wake on resolve) | This *is* the existing "approve risky decisions" mechanic. A milestone = a designated gate issue; passing it (board approval) auto-unblocks the next phase via `issue_blockers_resolved` wakes. Ordered progression comes free from the blocker chain. | Medium (synthesized, not first-class — see gap G3) |
| **Deliverable** | `issue_work_products` | Purpose-built: typed tracked outputs (PRs, deployments, artifacts) with `status`, `reviewState`, `isPrimary`, `healthStatus`, URL, linked to issue + project. | High |
| **Agent + skills as resources** | `agents` assigned to a workflow's issues; `company_skills` synced to agents (`/api/agents/:id/skills/sync`) | Skills are already first-class company objects with markdown bodies and per-agent assignment. "Which workflows use this skill" derives from: skill → agents holding it → issues those agents work → goals. | Medium (usage *frequency* is approximate — gap G4) |

**Board (5 universal stages) mapping onto `issues.status`:**

| Board column | Issue status |
|---|---|
| Queued | `backlog`, `todo` |
| In Progress | `in_progress` (`blocked` renders here, loud, per the stall rule) |
| Review Gate | `in_review` |
| Approved | `done`, shipping evidence not yet present |
| Shipped | `done` + primary work product in a shipped/merged terminal state |

The Approved/Shipped split does not exist in the schema; it is derived from work products
(gap G2). Everything else is a lossless projection of existing statuses. `cancelled` is the
"kill" outcome and leaves the board.

**Alternative considered and set aside:** workflow = top-level issue tree (parent issue with
children). It wins on native mechanics (agents already advance children, gates and work products
attach directly) but loses on identity — workflows would be indistinguishable from big tasks, and
the Workflows screen would need heuristics to decide what counts. Goals give workflows a stable,
named, owned identity. The gate-issue milestone mechanic is identical under both. Happy to flip
this at the gate if you disagree.

---

## 4. The COO permissions answer

**Read: yes, fully.** Any authenticated company agent can read *all* issues (any assignee, any
status), company-wide costs and budget overviews, the activity/audit feed, and all approvals —
every one of these routes is gated only by `assertCompanyAccess`, which for agents checks company
membership alone (`server/src/routes/authz.ts:42-64`, `costs.ts:132-245`, `activity.ts:35-37`,
`approvals.ts:52-69`). A COO agent that sees everything requires zero backend work.

**Hard-enforced zero execution rights: no.** This is the honest answer and the one flag that
matters:

- The permission-grant system (`principal_permission_grants`) is *additive only* — its 8 keys are
  all elevated write/admin actions; there is no read-only key, no deny rule, no scope reduction.
- Agent API keys and JWTs carry no scopes (`agent_api_keys` has no scopes column;
  `agent-auth-jwt.ts:8-18` has no permission claims).
- The read-only "viewer" role exists **for humans only** (`authz.ts:47-62`); agents never hit
  that branch.
- Consequently every company agent retains an irreducible write surface: mutate/close any
  *unassigned* issue (`issues.ts:1087-1088`), check out work, create issues, comment (which can
  implicitly move an issue to `todo`), create approvals.

**And one definitional point:** the COO's sole required output — recommendations into the Brief —
is itself a write. The natural (and I'd argue correct) implementation is
`POST /companies/:id/approvals` with a dedicated type (e.g. `coo_recommendation`) and payload
`{situation, recommendation, costOfDecidingWrong}`. Your approve/override taps are the existing
board approve/reject with `decisionNote`, which lands in `approvals.decidedByUserId` + the
activity log — the audit requirement in Phase 4 is satisfied natively, with zero new tables.

**Recommendation (decision needed at this gate):** build COO v1 as a *convention-constrained*
agent — instructions restrict it to reads + posting recommendation-approvals; a cron `routine`
(existing primitive) gives it its cadence; WIP limits and the stall threshold live in the
routine's `variables` (existing primitive). Every action it takes is attributed to its run ID in
the audit trail, so any deviation is visible, and its budget cap bounds blast radius.
**Cost of deciding wrong:** if the convention ever breaks, the COO could move a card before we
notice it in audit — embarrassing, recoverable, and detectable; versus the alternative (a real
read-only agent primitive), which is backend surgery and per your non-negotiables is flagged
here and not built. If soft enforcement is unacceptable, say so and I'll spec the backend change
as a separate proposal instead of building Phase 4.

---

## 5. Flagged gaps

- **G1 — No hard read-only agent primitive** (§4). Soft-enforced COO proposed; hard enforcement
  = backend change, stopped and flagged.
- **G2 — Approved vs Shipped is not in the schema.** `done` is terminal. Proposal: derive
  Shipped from the primary work product's terminal state; where a workflow has no tracked work
  product, Approved and Shipped collapse into one column entry. If you want a true shipped
  state, that's a backend change — flagged, not made.
- **G3 — Milestones are not first-class.** Synthesized from gate issues + blocker chains +
  approvals. Works with existing wake semantics, but "milestone" as a named, reorderable object
  with its own table does not exist. Presentation layer can carry this; a first-class entity
  would be a backend change — flagged.
- **G4 — Skill→workflow usage frequency is approximate.** No per-run record of which skill was
  exercised. "Which workflows use this skill" derives via agents; "how often" can only be
  approximated (e.g., count of cards worked by agents holding the skill). Exact counts would
  need run-level skill telemetry — backend change, flagged.
- **G5 — No first-class WIP-limit config.** Budget policies are money, not card counts.
  Proposal: store per-department WIP limits in the COO routine's `variables` (existing
  primitive, revision-tracked). No backend change needed.
- **G6 — Naming collision on "workspaces."** In Paperclip, workspaces are *git/execution
  infrastructure* (`project_workspaces`, `execution_workspaces`), not org containers. Your
  "Departments = workspaces" intent maps to **projects** (§3). The infra workspaces stay as
  drill-downs.
- **G7 — Stall detection is derivable, not stored.** "No milestone progress in 7 days" computes
  client-side from `updatedAt`/`startedAt`/blocker state; threshold lives in COO routine
  variables. The backend's own recovery service already escalates stale runs independently —
  the two are complementary, not conflicting. No backend change needed.
- **G8 — "No add-card button for me" vs. preserving functionality.** The backend allows humans
  to create issues, and that stays reachable (command palette, Workflows detail). The Board
  simply won't offer it. Nothing becomes unreachable; the Board stops being an entry form.

---

## 6. What approval unlocks

Phase 2 (design constitution + token tightening of `ui/src/index.css`), then the build order:
Brief → Board → Workflow detail → COO agent (five deterministic rules, `coo_recommendation`
approvals) → stall/kill → WIP enforcement → Skills view. One screen per commit, screenshot +
two-sentence answer each.

Decisions needed from you at this gate:

1. Entity mapping §3 — confirm **Department=project, Workflow=goal, Milestone=gate-issue chain,
   Deliverable=work product**, or flip Workflow to issue-tree.
2. COO enforcement §4 — accept convention-constrained v1, or stop for a backend-change spec.
3. Approved/Shipped derivation G2 — accept work-product-derived Shipped.
