/**
 * COO v1 rule engine — pure functions, no I/O. The heartbeat script fetches
 * state and posts approvals; everything decision-shaped lives here so it can
 * be unit-tested. Every recommendation carries situation, recommendation,
 * and costOfDecidingWrong: the COO never presents a situation without a
 * position.
 */

export const DEFAULT_CONFIG = {
  stallDays: 7,
  gateHours: 24,
  wipLimit: 5,
  budgetWarnPct: 80,
  unattributedMinCents: 100,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Fingerprints that must not be re-raised: pending, or decided in the last 7 days. */
export function suppressedFingerprints(approvals, now) {
  return new Set(
    approvals
      .filter(
        (a) =>
          (a.type === "coo_recommendation" || a.payload?.kind === "coo_recommendation") &&
          (a.status === "pending" || now - new Date(a.updatedAt).getTime() < 7 * DAY_MS),
      )
      .map((a) => a.payload?.fingerprint)
      .filter(Boolean),
  );
}

/** Plan checklist position: true = all boxes checked, false = some unchecked, null = no checklist. */
export function planChecklistState(planBody) {
  if (typeof planBody !== "string") return null;
  const boxes = planBody.match(/- \[[ x]\]/gi) ?? [];
  if (boxes.length === 0) return null;
  return boxes.every((box) => /x/i.test(box));
}

/**
 * Evaluate all five rules against a prefetched state snapshot.
 *
 * state: {
 *   now, config,
 *   issues, agents, projects, goals, approvals,
 *   budgets: { policies: [] },
 *   plansByIssueId: Map<issueId, planBody|null>,       // aged gate issues
 *   workProductsByIssueId: Map<issueId, WorkProduct[]>, // active issues
 * }
 * Returns recommendations (fingerprint-deduped against prior approvals).
 */
export function evaluateRules(state) {
  const { now } = state;
  const config = { ...DEFAULT_CONFIG, ...state.config };
  const projectName = new Map(state.projects.map((p) => [p.id, p.name]));
  const goalName = new Map(state.goals.map((g) => [g.id, g.title]));
  const agentName = new Map(state.agents.map((a) => [a.id, a.name]));
  const suppressed = suppressedFingerprints(state.approvals, now);
  const age = (value) => now - new Date(value).getTime();

  const recommendations = [];
  const recommend = (fingerprint, rec) => {
    if (suppressed.has(fingerprint)) return;
    recommendations.push({ ...rec, fingerprint });
  };

  const open = state.issues.filter((i) => !["done", "cancelled"].includes(i.status));

  // Rule 1 — budget thresholds, from the budget-policy overview.
  for (const p of state.budgets?.policies ?? []) {
    if (!p.isActive) continue;
    const warnAt = Math.min(p.warnPercent ?? 100, config.budgetWarnPct);
    if (p.utilizationPercent < warnAt) continue;
    const scope = `${p.scopeName ?? p.scopeType}`;
    const pct = Math.round(p.utilizationPercent);
    recommend(`budget:${p.scopeType}:${p.scopeId}:${p.windowStart}`, {
      rule: "budget_threshold",
      title: `${scope} at ${pct}% of ${p.windowKind === "calendar_month_utc" ? "monthly" : "window"} budget`,
      situation: `${scope} has used ${pct}% of its $${(p.amount / 100).toFixed(0)} budget ($${(p.remainingAmount / 100).toFixed(0)} left) with the window still open${p.hardStopEnabled ? "; the hard stop will pause it at 100%" : ""}.`,
      recommendation:
        p.utilizationPercent >= 100
          ? `${scope} is exhausted — raise the budget now or let the hard stop hold until next window.`
          : `Raise ${scope}'s budget or requeue its non-critical cards before the hard stop hits.`,
      costOfDecidingWrong:
        "Ignoring the breach means an automatic mid-work pause; raising blindly removes the spend gate.",
    });
  }

  // Rule 2 — stalled cards: restart under 2× the limit, kill at 2×+.
  for (const i of open) {
    const stalledFor = age(i.updatedAt);
    const isStalled =
      ["in_progress", "blocked"].includes(i.status) && stalledFor > config.stallDays * DAY_MS;
    if (!isStalled) continue;
    const d = Math.floor(stalledFor / DAY_MS);
    const kill = stalledFor > 2 * config.stallDays * DAY_MS;
    recommend(`stall:${i.id}:${kill ? "kill" : "restart"}`, {
      rule: "card_stalled",
      issueIds: [i.id],
      title: `${i.identifier} stalled ${d} days`,
      situation: `"${i.title}" (${projectName.get(i.projectId) ?? "no department"}, ${agentName.get(i.assigneeAgentId) ?? "unassigned"}) has made no progress in ${d} days.`,
      recommendation: kill
        ? `Kill ${i.identifier} — past ${2 * config.stallDays} days dead work distorts the board; recreate it later if it still matters.`
        : `Restart ${i.identifier} — requeue it so the assignee picks it up fresh.`,
      costOfDecidingWrong: kill
        ? "Killing live-but-quiet work loses context; keeping dead work hides real capacity."
        : "A restart costs one wake; leaving it quiet costs another week.",
    });
  }

  // Rule 3 — Review Gate items aging past the limit; position from the plan checklist.
  for (const i of open) {
    if (i.status !== "in_review") continue;
    const waited = age(i.updatedAt);
    if (waited < config.gateHours * HOUR_MS) continue;
    const h = Math.floor(waited / HOUR_MS);
    const allChecked = planChecklistState(state.plansByIssueId?.get(i.id) ?? null);
    recommend(`gate:${i.id}`, {
      rule: "gate_aging",
      issueIds: [i.id],
      title: `${i.identifier} waiting at the Review Gate ${h}h`,
      situation: `"${i.title}" has sat at the Review Gate for ${h} hours; the gate is the only column that needs you.`,
      recommendation:
        allChecked === true
          ? `Approve ${i.identifier} — every acceptance criterion in its plan is checked.`
          : allChecked === false
            ? `Override ${i.identifier} with feedback — its plan still has unchecked acceptance criteria.`
            : `Review ${i.identifier} now — it has no plan checklist to verify against, so it needs your eyes.`,
      costOfDecidingWrong:
        "Every hour at the gate idles the workflow behind it; a rushed approval ships unreviewed work.",
    });
  }

  // Rule 4 — WIP breach per department.
  const wipByProject = new Map();
  for (const i of open) {
    if (i.status === "in_progress" && i.projectId) {
      wipByProject.set(i.projectId, (wipByProject.get(i.projectId) ?? 0) + 1);
    }
  }
  for (const [projectId, wip] of wipByProject) {
    if (wip <= config.wipLimit) continue;
    const lowest = open
      .filter((i) => i.projectId === projectId && i.status === "in_progress")
      .sort(
        (a, b) =>
          ["low", "medium", "high", "critical"].indexOf(a.priority) -
          ["low", "medium", "high", "critical"].indexOf(b.priority),
      )[0];
    recommend(`wip:${projectId}:${wip}`, {
      rule: "wip_breach",
      issueIds: lowest ? [lowest.id] : [],
      title: `${projectName.get(projectId) ?? "Department"} over WIP limit (${wip}/${config.wipLimit})`,
      situation: `${projectName.get(projectId) ?? "A department"} has ${wip} cards in progress against a limit of ${config.wipLimit}; new work should queue, not start.`,
      recommendation: lowest
        ? `Requeue ${lowest.identifier} ("${lowest.title}") — it is the lowest-priority card in progress.`
        : `Hold new starts in ${projectName.get(projectId) ?? "this department"} until a card ships.`,
      costOfDecidingWrong:
        "Over-WIP departments finish nothing; requeuing the wrong card delays one task, not the department.",
    });
  }

  // Rule 5 — two workflows touching the same deliverable.
  const touch = new Map();
  for (const [issueId, products] of state.workProductsByIssueId ?? new Map()) {
    const issue = open.find((i) => i.id === issueId);
    if (!issue) continue;
    for (const p of products) {
      const key = (p.externalId ?? p.url ?? p.title).toLowerCase();
      if (!touch.has(key)) touch.set(key, []);
      touch.get(key).push({ issue, product: p });
    }
  }
  for (const [key, entries] of touch) {
    const goalsTouching = [...new Set(entries.map((e) => e.issue.goalId).filter(Boolean))];
    if (goalsTouching.length < 2) continue;
    const names = goalsTouching.map((g) => `"${goalName.get(g) ?? g}"`).join(" and ");
    recommend(`collision:${key}`, {
      rule: "deliverable_collision",
      issueIds: entries.map((e) => e.issue.id),
      title: `Two workflows touching ${entries[0].product.title}`,
      situation: `${names} both have active cards producing "${entries[0].product.title}".`,
      recommendation: `Merge the overlapping cards under one workflow and block the other on it.`,
      costOfDecidingWrong:
        "Parallel edits to one deliverable produce conflicting versions; consolidation costs one reassignment.",
    });
  }

  // Rule 6 — attribution completeness: spend in the window that no project
  // rollup can claim (total minus the by-project sum, which already includes
  // the activity-log fallback join). Fingerprint is day-bucketed so a
  // persisting gap re-raises daily instead of being 7-day-suppressed.
  if (state.costs) {
    const windowCents = Number(state.costs.windowCents ?? 0);
    const attributedCents = Number(state.costs.attributedCents ?? 0);
    const unattributedCents = Math.max(0, windowCents - attributedCents);
    if (unattributedCents >= config.unattributedMinCents) {
      const pct = windowCents > 0 ? Math.round((unattributedCents / windowCents) * 100) : 0;
      const day = new Date(now).toISOString().slice(0, 10);
      recommend(`cost-attribution:${day}`, {
        rule: "unattributed_spend",
        title: `$${(unattributedCents / 100).toFixed(2)} of spend has no project`,
        situation: `In the last day, $${(unattributedCents / 100).toFixed(2)} of $${(windowCents / 100).toFixed(2)} (${pct}%) landed on no department — those cost events carry no issue or project, so no client rollup can claim them.`,
        recommendation:
          "Find the agents producing unattributed runs (Costs → by agent vs by department) and tie their work to cards, or accept the overhead explicitly.",
        costOfDecidingWrong:
          "Unattributed spend silently distorts every per-department margin; chasing pennies wastes a decision slot.",
      });
    }
  }

  // Rule 7 — model pins missing from the adapter's current catalog. A pinned
  // model that the provider retired keeps failing runs quietly; surface it as
  // a decision. Fail-soft: no catalog for the adapter type → no opinion.
  if (state.modelsByAdapterType) {
    const day = new Date(now).toISOString().slice(0, 10);
    for (const a of state.agents) {
      if (["terminated", "archived"].includes(a.status)) continue;
      const pinned = typeof a.adapterConfig?.model === "string" ? a.adapterConfig.model.trim() : "";
      if (!pinned) continue;
      const models = state.modelsByAdapterType[a.adapterType];
      if (!Array.isArray(models) || models.length === 0) continue;
      const known = models.some((m) => (typeof m === "string" ? m : m?.id) === pinned);
      if (known) continue;
      recommend(`model-pin:${a.id}:${day}`, {
        rule: "model_pin_stale",
        title: `${a.name} pinned to unavailable model ${pinned}`,
        situation: `${a.name} (${a.adapterType}) is pinned to "${pinned}", which is not in the adapter's current model list — its runs will fail or silently fall back.`,
        recommendation: `Repoint ${a.name} to a current model (adapter settings → model), or clear the pin to use the adapter default.`,
        costOfDecidingWrong:
          "A stale pin quietly fails every run it schedules; switching models mid-task costs one review of recent output.",
      });
    }
  }

  return recommendations;
}
