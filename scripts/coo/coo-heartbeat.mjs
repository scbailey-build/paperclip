#!/usr/bin/env node
/**
 * COO agent heartbeat — v1 deterministic rules, no model judgment.
 *
 * Runs as a Paperclip agent (process adapter) each heartbeat. Reads company
 * state via the API (agents have company-wide read access) and posts
 * recommendations into the Brief as approvals of type `coo_recommendation`.
 * Every recommendation carries: situation, recommendation, costOfDecidingWrong.
 * The COO never presents a situation without a position.
 *
 * Scope convention (operator-approved, Phase 1 §4): this agent only READS
 * state and POSTS recommendation approvals. It never checks out work, never
 * moves cards, never spends budget. All its actions are attributed to its
 * run id in the audit trail.
 *
 * Rules:
 *   1. budget_threshold  — agent or company spend crossed the warn threshold
 *   2. card_stalled      — no progress past the stall limit (restart vs kill)
 *   3. gate_aging        — Review Gate item older than the gate limit
 *   4. wip_breach        — department over its WIP limit
 *   5. deliverable_collision — two workflows touching the same deliverable
 *
 * Config via env (production home: the COO routine's variables, which the
 * adapter exposes as env): COO_STALL_DAYS=7 COO_GATE_HOURS=24 COO_WIP_LIMIT=5
 * COO_BUDGET_WARN_PCT=80
 */

const RAW_API = process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100/api";
// Adapters may inject the base origin with or without the /api suffix.
const API = RAW_API.replace(/\/$/, "").endsWith("/api")
  ? RAW_API.replace(/\/$/, "")
  : `${RAW_API.replace(/\/$/, "")}/api`;
const KEY = process.env.PAPERCLIP_API_KEY ?? "";
const COMPANY = process.env.PAPERCLIP_COMPANY_ID;
const AGENT = process.env.PAPERCLIP_AGENT_ID ?? null;
const RUN_ID = process.env.PAPERCLIP_RUN_ID ?? null;

const STALL_DAYS = Number(process.env.COO_STALL_DAYS ?? 7);
const GATE_HOURS = Number(process.env.COO_GATE_HOURS ?? 24);
const WIP_LIMIT = Number(process.env.COO_WIP_LIMIT ?? 5);
const BUDGET_WARN_PCT = Number(process.env.COO_BUDGET_WARN_PCT ?? 80);

if (!COMPANY) {
  console.error("COO: PAPERCLIP_COMPANY_ID is required");
  process.exit(1);
}

const headers = { "Content-Type": "application/json" };
if (KEY) headers.Authorization = `Bearer ${KEY}`;
if (RUN_ID) headers["X-Paperclip-Run-Id"] = RUN_ID;

async function get(path) {
  const res = await fetch(`${API}${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

const age = (value) => Date.now() - new Date(value).getTime();
const days = (n) => n * 24 * 60 * 60 * 1000;
const hours = (n) => n * 60 * 60 * 1000;

async function main() {
  const [issues, agents, projects, goals, approvals, budgets] = await Promise.all([
    get(`/companies/${COMPANY}/issues?limit=250`),
    get(`/companies/${COMPANY}/agents`),
    get(`/companies/${COMPANY}/projects`),
    get(`/companies/${COMPANY}/goals`),
    get(`/companies/${COMPANY}/approvals`),
    get(`/companies/${COMPANY}/budgets/overview`),
  ]);

  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const goalName = new Map(goals.map((g) => [g.id, g.title]));
  const agentName = new Map(agents.map((a) => [a.id, a.name]));

  // Dedup: never re-raise a fingerprint that is pending, or was decided
  // (approved or overridden) within the last 7 days.
  const suppressed = new Set(
    approvals
      .filter(
        (a) =>
          a.payload?.kind === "coo_recommendation" &&
          (a.status === "pending" || age(a.updatedAt) < days(7)),
      )
      .map((a) => a.payload?.fingerprint)
      .filter(Boolean),
  );

  const recommendations = [];
  const recommend = (fingerprint, rec) => {
    if (suppressed.has(fingerprint)) return;
    recommendations.push({ ...rec, fingerprint });
  };

  const open = issues.filter((i) => !["done", "cancelled"].includes(i.status));

  // Rule 1 — budget thresholds, from the budget-policy overview (the same
  // engine that pauses agents at 100%). Fires at each policy's own warn line
  // or the COO's floor, whichever is lower.
  for (const p of budgets.policies ?? []) {
    if (!p.isActive) continue;
    const warnAt = Math.min(p.warnPercent ?? 100, BUDGET_WARN_PCT);
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
      ["in_progress", "blocked"].includes(i.status) && stalledFor > days(STALL_DAYS);
    if (!isStalled) continue;
    const d = Math.floor(stalledFor / days(1));
    const kill = stalledFor > 2 * days(STALL_DAYS);
    recommend(`stall:${i.id}:${kill ? "kill" : "restart"}`, {
      rule: "card_stalled",
      issueIds: [i.id],
      title: `${i.identifier} stalled ${d} days`,
      situation: `"${i.title}" (${projectName.get(i.projectId) ?? "no department"}, ${agentName.get(i.assigneeAgentId) ?? "unassigned"}) has made no progress in ${d} days.`,
      recommendation: kill
        ? `Kill ${i.identifier} — past ${2 * STALL_DAYS} days dead work distorts the board; recreate it later if it still matters.`
        : `Restart ${i.identifier} — requeue it so the assignee picks it up fresh.`,
      costOfDecidingWrong: kill
        ? "Killing live-but-quiet work loses context; keeping dead work hides real capacity."
        : "A restart costs one wake; leaving it quiet costs another week.",
    });
  }

  // Rule 3 — Review Gate items aging past the limit.
  for (const i of open) {
    if (i.status !== "in_review") continue;
    const waited = age(i.updatedAt);
    if (waited < hours(GATE_HOURS)) continue;
    const h = Math.floor(waited / hours(1));
    let allChecked = null;
    try {
      const plan = await get(`/issues/${i.id}/documents/plan`);
      const boxes = plan.body.match(/- \[[ x]\]/gi) ?? [];
      allChecked = boxes.length > 0 && boxes.every((b) => /x/i.test(b));
    } catch {
      allChecked = null;
    }
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
    if (wip <= WIP_LIMIT) continue;
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
      title: `${projectName.get(projectId) ?? "Department"} over WIP limit (${wip}/${WIP_LIMIT})`,
      situation: `${projectName.get(projectId) ?? "A department"} has ${wip} cards in progress against a limit of ${WIP_LIMIT}; new work should queue, not start.`,
      recommendation: lowest
        ? `Requeue ${lowest.identifier} ("${lowest.title}") — it is the lowest-priority card in progress.`
        : `Hold new starts in ${projectName.get(projectId) ?? "this department"} until a card ships.`,
      costOfDecidingWrong:
        "Over-WIP departments finish nothing; requeuing the wrong card delays one task, not the department.",
    });
  }

  // Rule 5 — two workflows touching the same deliverable.
  const active = open.filter((i) => ["in_progress", "in_review", "blocked"].includes(i.status));
  const touch = new Map(); // deliverable key -> [{issue, product}]
  for (const i of active.slice(0, 60)) {
    let products = [];
    try {
      products = await get(`/issues/${i.id}/work-products`);
    } catch {
      continue;
    }
    for (const p of products) {
      const key = (p.externalId ?? p.url ?? p.title).toLowerCase();
      if (!touch.has(key)) touch.set(key, []);
      touch.get(key).push({ issue: i, product: p });
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

  // Post recommendations as approvals — the Brief's Decisions section reads
  // title/situation/recommendation/costOfDecidingWrong from this payload.
  for (const rec of recommendations) {
    const { issueIds = [], ...payload } = rec;
    await post(`/companies/${COMPANY}/approvals`, {
      type: "coo_recommendation",
      ...(AGENT ? { requestedByAgentId: AGENT } : {}),
      issueIds,
      // payload.kind stays for back-compat with pre-enum recommendations;
      // issueIds ride in the payload too so the Brief can act on the linked
      // cards (and suppress duplicate raw gate rows) without extra fetches.
      payload: { kind: "coo_recommendation", issueIds, ...payload },
    });
    console.log(`COO: recommended [${payload.rule}] ${payload.title}`);
  }
  console.log(
    `COO: heartbeat done — ${recommendations.length} new recommendation(s), ${suppressed.size} suppressed as duplicates.`,
  );
}

main().catch((err) => {
  console.error("COO heartbeat failed:", err.message);
  process.exit(1);
});
