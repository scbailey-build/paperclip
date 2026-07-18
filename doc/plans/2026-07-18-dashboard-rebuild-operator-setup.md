# Dashboard Rebuild — Operator Setup on a Real Instance

Replays what was built and verified in the dev sandbox onto a production/local instance.

## Day-one checklist (after pulling master)

```sh
pnpm install && pnpm build
pnpm db:migrate                      # applies 0085 (notification webhook column)
pnpm paperclipai run                 # or pnpm dev
```

Then, in order:

1. Open the app — it lands on **/brief**. Nav is Brief / Board / Workflows / Skills;
   everything else is under System (collapsed) and Cmd+K.
2. Create the **COO agent** (step 1 below) and set `permissions.recommendOnly: true` via
   `PATCH /api/agents/:id/permissions` — the server then hard-denies it every issue write.
3. Import your **skill library** (step 2 below).
4. Create the **milestone label** once per company; agents label gate cards with it.
5. Optional: set the **notification webhook** (Company Settings → General) — only budget
   breaches and hard blockers notify. Optional: the **Airtable archivist** (step 3 below).

## 1. The COO agent

Create an agent with the process adapter:

- command: `node`, args: `[<repo>/scripts/coo/coo-heartbeat.mjs]`
- small monthly budget (it only reads and posts recommendations)
- optional env: `COO_STALL_DAYS` (7), `COO_GATE_HOURS` (24), `COO_WIP_LIMIT` (5),
  `COO_BUDGET_WARN_PCT` (80)

Heartbeats run it automatically; prefer a cron routine cadence for predictable timing (see
the adapter re-invocation caveat in the Phase 4 doc). Its recommendations appear in the
Brief's Decisions section with approve/override as one-tap actions.

## 2. Import the operator's skill library

```sh
scripts/import-operator-skills.sh <company-id>            # defaults to ~/.claude/skills
scripts/import-operator-skills.sh <company-id> /path/to/skills http://127.0.0.1:3100/api
```

Imports every markdown skill folder into the company skills library (visible at `/skills`,
manageable at `/skills/library`). Assign skills to agents deliberately, per workflow demand —
`POST /api/agents/:agentId/skills/sync` — rather than blanket-assigning: agent skill lists
load into working context on every run.

Claude.ai cloud plugins are not importable this way (they are hosted, not files); export a
plugin's prompts as markdown skills first if their content should live in Paperclip.

## 3. Optional: Airtable board backup (archivist agent)

`scripts/archivist/airtable-backup.mjs` — same scaffolding as the COO: a process-adapter
agent (heartbeat cadence) that reads the board via the API and upserts one row per card to
Airtable, keyed on Identifier. Idempotent; writes flow one way (Paperclip → Airtable) so the
mirror can never conflict with the source of truth.

Setup: create the Cards table (fields listed in the script header), store the Airtable
personal access token as a company secret, and bind it into the agent's `adapterConfig.env`
as `AIRTABLE_API_KEY` alongside `AIRTABLE_BASE_ID` and `AIRTABLE_TABLE`. Verify with
`ARCHIVIST_DRY_RUN=1`, which prints the upsert plan without writing.

## 4. Demo-data conventions the screens rely on

- **Milestones** = cards labeled `milestone` (create the label once per company).
- **Card plans** = issue document key `plan`, structured per `ui/src/lib/cardPlanTemplate.ts`
  (Context / Objective / Scope / Acceptance Criteria / Dependencies / Deliverables — owner,
  due date, priority, and status live on the card itself, never in the plan).
- **Shipped** = done + a work product in a terminal delivery state (merged PR, live
  deployment/artifact).
