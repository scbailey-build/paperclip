#!/usr/bin/env node
/**
 * COO agent heartbeat — v1 deterministic rules, no model judgment.
 *
 * Runs as a Paperclip agent (process adapter) each heartbeat. Fetches company
 * state via the API (agents have company-wide read access), evaluates the
 * five rules in ./rules.mjs, and posts recommendations into the Brief as
 * approvals of type `coo_recommendation`.
 *
 * Scope: this agent carries permissions.recommendOnly — the server denies it
 * every issue-surface write; approvals are its only output channel, and every
 * action is attributed to its run id in the audit trail.
 *
 * Config env (production home: the agent's adapterConfig.env, which the
 * process adapter injects; supports plain values and company-secret refs):
 *   COO_STALL_DAYS=7 COO_GATE_HOURS=24 COO_WIP_LIMIT=5 COO_BUDGET_WARN_PCT=80
 *
 * Idempotency matters: the process adapter may re-invoke a fast-exiting
 * command within one heartbeat window. Fingerprint dedup (pending or decided
 * within 7 days) makes re-runs no-ops.
 */

import { DEFAULT_CONFIG, evaluateRules } from "./rules.mjs";

const RAW_API = process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100/api";
// Adapters may inject the base origin with or without the /api suffix.
const API = RAW_API.replace(/\/$/, "").endsWith("/api")
  ? RAW_API.replace(/\/$/, "")
  : `${RAW_API.replace(/\/$/, "")}/api`;
const KEY = process.env.PAPERCLIP_API_KEY ?? "";
const COMPANY = process.env.PAPERCLIP_COMPANY_ID;
const AGENT = process.env.PAPERCLIP_AGENT_ID ?? null;
const RUN_ID = process.env.PAPERCLIP_RUN_ID ?? null;

if (!COMPANY) {
  console.error("COO: PAPERCLIP_COMPANY_ID is required");
  process.exit(1);
}

const config = {
  stallDays: Number(process.env.COO_STALL_DAYS ?? DEFAULT_CONFIG.stallDays),
  gateHours: Number(process.env.COO_GATE_HOURS ?? DEFAULT_CONFIG.gateHours),
  wipLimit: Number(process.env.COO_WIP_LIMIT ?? DEFAULT_CONFIG.wipLimit),
  budgetWarnPct: Number(process.env.COO_BUDGET_WARN_PCT ?? DEFAULT_CONFIG.budgetWarnPct),
};

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

async function main() {
  const now = Date.now();
  const windowFrom = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const [issues, agents, projects, goals, approvals, budgets, costSummary, costByProject] =
    await Promise.all([
      get(`/companies/${COMPANY}/issues?limit=250`),
      get(`/companies/${COMPANY}/agents`),
      get(`/companies/${COMPANY}/projects`),
      get(`/companies/${COMPANY}/goals`),
      get(`/companies/${COMPANY}/approvals`),
      get(`/companies/${COMPANY}/budgets/overview`),
      get(`/companies/${COMPANY}/costs/summary?from=${encodeURIComponent(windowFrom)}`).catch(() => null),
      get(`/companies/${COMPANY}/costs/by-project?from=${encodeURIComponent(windowFrom)}`).catch(() => null),
    ]);

  const open = issues.filter((i) => !["done", "cancelled"].includes(i.status));

  // Prefetch plans only for gate items past the age limit (rule 3 position).
  const agedGates = open.filter(
    (i) =>
      i.status === "in_review" &&
      now - new Date(i.updatedAt).getTime() >= config.gateHours * 60 * 60 * 1000,
  );
  const plansByIssueId = new Map();
  for (const issue of agedGates) {
    try {
      const plan = await get(`/issues/${issue.id}/documents/plan`);
      plansByIssueId.set(issue.id, plan.body);
    } catch {
      plansByIssueId.set(issue.id, null);
    }
  }

  // Prefetch work products for active cards (rule 5), bounded.
  const active = open.filter((i) => ["in_progress", "in_review", "blocked"].includes(i.status));
  const workProductsByIssueId = new Map();
  for (const issue of active.slice(0, 60)) {
    try {
      workProductsByIssueId.set(issue.id, await get(`/issues/${issue.id}/work-products`));
    } catch {
      // skip unreadable work products; rule 5 just sees fewer entries
    }
  }

  // Rule 6 input: last-24h attribution completeness. by-project already
  // includes the activity-log fallback join, so total minus its sum is the
  // spend no rollup can claim.
  const costs =
    costSummary == null
      ? null
      : {
        windowCents: Number(costSummary.spendCents ?? 0),
        attributedCents: (costByProject ?? []).reduce(
          (sum, row) => sum + Number(row.costCents ?? 0),
          0,
        ),
      };

  const recommendations = evaluateRules({
    now,
    config,
    issues,
    agents,
    projects,
    goals,
    approvals,
    budgets,
    costs,
    plansByIssueId,
    workProductsByIssueId,
  });

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
  console.log(`COO: heartbeat done — ${recommendations.length} new recommendation(s).`);
}

main().catch((err) => {
  console.error("COO heartbeat failed:", err.message);
  process.exit(1);
});
