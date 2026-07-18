#!/usr/bin/env node
/**
 * Archivist agent — one-way board mirror to Airtable.
 *
 * Reads the company's cards (plus plans, owners, departments, workflows)
 * from the Paperclip API and upserts one row per card into an Airtable
 * table, keyed on the card Identifier. Writes flow only Paperclip →
 * Airtable, so the mirror can never conflict with the source of truth.
 *
 * Run as a Paperclip process-adapter agent (heartbeat cadence) or from cron.
 * Idempotent: re-runs update existing rows in place.
 *
 * Env:
 *   PAPERCLIP_API_URL / PAPERCLIP_COMPANY_ID / PAPERCLIP_API_KEY  (injected on agent runs)
 *   AIRTABLE_API_KEY   personal access token; production home: a company
 *                      secret bound into the agent's adapterConfig.env
 *   AIRTABLE_BASE_ID   e.g. appXXXXXXXXXXXXXX
 *   AIRTABLE_TABLE     table id or name (default "Cards")
 *   ARCHIVIST_DRY_RUN  "1" to print the upsert plan without writing
 *
 * Expected Airtable fields (single-line text unless noted): Identifier,
 * Title, Column (single select: Queued / In Progress / Review Gate /
 * Approved / Shipped / Cancelled), Status, Priority (single select),
 * Owner, Department, Workflow, Plan (long text), Stalled (checkbox),
 * Updated, Snapshot At.
 */

const RAW_API = process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100/api";
const API = RAW_API.replace(/\/$/, "").endsWith("/api")
  ? RAW_API.replace(/\/$/, "")
  : `${RAW_API.replace(/\/$/, "")}/api`;
const KEY = process.env.PAPERCLIP_API_KEY ?? "";
const COMPANY = process.env.PAPERCLIP_COMPANY_ID;

const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY ?? "";
const BASE_ID = process.env.AIRTABLE_BASE_ID ?? "";
const TABLE = process.env.AIRTABLE_TABLE ?? "Cards";
const DRY_RUN = process.env.ARCHIVIST_DRY_RUN === "1";
const STALL_DAYS = Number(process.env.COO_STALL_DAYS ?? 7);

if (!COMPANY) {
  console.error("archivist: PAPERCLIP_COMPANY_ID is required");
  process.exit(1);
}
if (!DRY_RUN && (!AIRTABLE_KEY || !BASE_ID)) {
  console.error("archivist: AIRTABLE_API_KEY and AIRTABLE_BASE_ID are required (or set ARCHIVIST_DRY_RUN=1)");
  process.exit(1);
}

const pcHeaders = { "Content-Type": "application/json" };
if (KEY) pcHeaders.Authorization = `Bearer ${KEY}`;

async function pc(path) {
  const res = await fetch(`${API}${path}`, { headers: pcHeaders });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

const AT_BASE = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE)}`;
const atHeaders = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${AIRTABLE_KEY}`,
};

async function airtable(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: atHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

function columnFor(issue, shipped) {
  if (issue.status === "backlog" || issue.status === "todo") return "Queued";
  if (issue.status === "in_progress" || issue.status === "blocked") return "In Progress";
  if (issue.status === "in_review") return "Review Gate";
  if (issue.status === "cancelled") return "Cancelled";
  return shipped ? "Shipped" : "Approved";
}

function titleCase(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

async function main() {
  const now = Date.now();
  const snapshotAt = new Date(now).toISOString();

  const [issues, agents, projects, goals] = await Promise.all([
    pc(`/companies/${COMPANY}/issues?limit=250`),
    pc(`/companies/${COMPANY}/agents`),
    pc(`/companies/${COMPANY}/projects`),
    pc(`/companies/${COMPANY}/goals`),
  ]);
  const agentName = new Map(agents.map((a) => [a.id, a.name]));
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const goalTitle = new Map(goals.map((g) => [g.id, g.title]));

  // Shipped evidence + plans, bounded per run.
  const done = issues.filter((i) => i.status === "done").slice(0, 50);
  const shippedIds = new Set();
  for (const issue of done) {
    try {
      const products = await pc(`/issues/${issue.id}/work-products`);
      const shipped = products.some(
        (p) =>
          p.status === "merged" ||
          p.status === "approved" ||
          (p.status === "active" && p.type !== "pull_request" && p.type !== "branch"),
      );
      if (shipped) shippedIds.add(issue.id);
    } catch {
      // no evidence readable — stays Approved
    }
  }
  const plansByIssue = new Map();
  for (const issue of issues.filter((i) => (i.documentKeys ?? []).includes("plan"))) {
    try {
      plansByIssue.set(issue.id, (await pc(`/issues/${issue.id}/documents/plan`)).body);
    } catch {
      // plan unreadable — mirrored without it
    }
  }

  const rows = issues
    .filter((issue) => issue.identifier)
    .map((issue) => ({
      Identifier: issue.identifier,
      Title: issue.title,
      Column: columnFor(issue, shippedIds.has(issue.id)),
      Status: issue.status,
      Priority: titleCase(issue.priority),
      Owner: issue.assigneeAgentId ? (agentName.get(issue.assigneeAgentId) ?? "") : "",
      Department: issue.projectId ? (projectName.get(issue.projectId) ?? "") : "",
      Workflow: issue.goalId ? (goalTitle.get(issue.goalId) ?? "") : "",
      ...(plansByIssue.has(issue.id) ? { Plan: plansByIssue.get(issue.id) } : {}),
      Stalled:
        (issue.status === "in_progress" || issue.status === "blocked") &&
        now - new Date(issue.updatedAt).getTime() > STALL_DAYS * 24 * 60 * 60 * 1000,
      Updated: new Date(issue.updatedAt).toISOString(),
      "Snapshot At": snapshotAt,
    }));

  if (DRY_RUN) {
    console.log(`archivist (dry run): would upsert ${rows.length} row(s):`);
    for (const row of rows) {
      console.log(`  ${row.Identifier} [${row.Column}] ${row.Title}${row.Stalled ? " (stalled)" : ""}`);
    }
    return;
  }

  // Existing rows keyed by Identifier (paginated).
  const existing = new Map();
  let offset;
  do {
    const page = await airtable(
      "GET",
      `${AT_BASE}?pageSize=100${offset ? `&offset=${offset}` : ""}`,
    );
    for (const record of page.records) {
      if (record.fields?.Identifier) existing.set(record.fields.Identifier, record.id);
    }
    offset = page.offset;
  } while (offset);

  const updates = rows
    .filter((row) => existing.has(row.Identifier))
    .map((row) => ({ id: existing.get(row.Identifier), fields: row }));
  const creates = rows
    .filter((row) => !existing.has(row.Identifier))
    .map((row) => ({ fields: row }));

  for (let i = 0; i < updates.length; i += 10) {
    await airtable("PATCH", AT_BASE, { records: updates.slice(i, i + 10), typecast: true });
  }
  for (let i = 0; i < creates.length; i += 10) {
    await airtable("POST", AT_BASE, { records: creates.slice(i, i + 10), typecast: true });
  }

  console.log(
    `archivist: mirrored ${rows.length} card(s) — ${updates.length} updated, ${creates.length} created.`,
  );
}

main().catch((err) => {
  console.error("archivist failed:", err.message);
  process.exit(1);
});
