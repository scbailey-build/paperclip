# Dashboard Rebuild — Phase 2: Design Constitution

Status: **awaiting operator approval** (gate 2). Depends on the approved Phase 1 mapping
(`2026-07-18-dashboard-rebuild-phase-1-mapping.md`).

The constitution is the operator's hard rules; this document records how they are encoded so
every later screen is checkable against it. The enforcement artifact is the token file:
**`ui/src/tokens.css`**, imported by `ui/src/index.css`.

## Token file

| Constitution rule | Token encoding |
|---|---|
| Neutral palette, near-white bg / near-black text | `--ops-bg`, `--ops-bg-raised`, `--ops-ink`, `--ops-ink-muted`, `--ops-line` — all zero-chroma OKLCH, light + dark |
| One accent color: primary action + live status only | `--ops-accent` (+ `-ink`, `-soft`), blue, the only chromatic token besides signal |
| One warm signal color: stalled/blocked exclusively | `--ops-signal` (+ `-ink`, `-soft`), warm orange, hue-separated from both accent and the legacy destructive red |
| Max two type sizes per screen + one accent weight | `--ops-text-title`, `--ops-text-body` (with `--ops-text-detail` allowed as the second size on dense rows), `--ops-weight-accent: 600` |
| Spacing tokens, no ad-hoc values | `--ops-space-{1,2,3,4,6,8,12}` |
| Motion only to explain state change | `--ops-motion-duration`/`--ops-motion-ease` + the single sanctioned `.ops-state-change` wash; stalled is loud by color and sort order, not by animation (works under reduced motion) |

All tokens are exposed to Tailwind via `@theme inline`, so rebuilt screens use them as
utilities (`bg-ops-bg`, `text-ops-ink`, `text-ops-title`, `p-ops-4`, `border-ops-line`,
`bg-ops-signal-soft`, …). "Zero inline style exceptions" is reviewable by grepping rebuilt
screens for non-`ops-` color/size/spacing utilities.

**Migration stance:** legacy screens keep the existing shadcn semantic variables in
`index.css` untouched. Each screen adopts `ops-*` tokens when it is rebuilt in Phase 5 order.
No big-bang restyle, nothing breaks in the interim.

## Operator rules (restated as build checklist)

- **Brief is the home screen.** Three sections in order: Decisions needed (COO recommendation +
  one-line reasoning + approve/override as single taps), Moving without me (scannable < 1 min),
  One flagged risk or stall. No raw event feed — audit lives in Activity.
- **Nav is exactly four items:** Brief, Board, Workflows, Skills. Departments (= projects) are a
  filter inside Board and Workflows. Everything else relocates to drill-downs, the command
  palette, and the account/settings menus — all routes stay live (Phase 1 §2).
- **One primary action per screen.** The primary action is the only `ops-accent` element.
- **Progressive disclosure.** Row = name, current milestone, owner agent, status. Everything
  else on click.
- **Stalled is first-class.** No milestone progress past the threshold (default 7 days, stored
  in COO routine variables) → `ops-signal`, sorts to top, exactly two actions: restart or kill
  (one click + confirm → `cancelled`).
- **Skills are first-class.** Skill detail shows which workflows use it and how often
  (derived per Phase 1 G4); workflow detail names its skills.
- **Empty states teach:** one sentence, one button.
- **Kill decoration:** an element that doesn't change a decision or trigger an action does not
  ship; informational stats live in detail views.

## Definition of done (per screen, from the operator)

1. A first-time user can use it with no explanation.
2. Exactly one obvious next action.
3. Nothing exists only to look thorough.
4. Token file only — zero exceptions.

Next after approval: Phase 5 build order begins — Brief → Board → Workflow detail → COO agent →
stall/kill → WIP enforcement → Skills. One screen per commit, screenshot + two-sentence
first-time-user answer per commit.
