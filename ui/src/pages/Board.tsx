import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { Agent, Issue, IssueWorkProduct, Project } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, issueUrl } from "../lib/utils";
import { useNavigate } from "../lib/router";

/**
 * The Board — the floor where agents work. Five universal stages; cards are
 * created and moved by agents (or the COO), never by hand: there is no
 * add-card control here by design. Review Gate is the only column that needs
 * the operator, and its contents feed the Brief's Decisions section.
 * Styling: operator tokens only. Two type sizes (body, detail) + accent weight.
 */

const STALL_THRESHOLD_DAYS = 7;
const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const PRIORITY_GLYPH: Record<string, string> = { critical: "‼", high: "↑", medium: "·", low: "↓" };

type ColumnKey = "queued" | "in_progress" | "review_gate" | "approved" | "shipped";

const COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: "queued", label: "Queued" },
  { key: "in_progress", label: "In Progress" },
  { key: "review_gate", label: "Review Gate" },
  { key: "approved", label: "Approved" },
  { key: "shipped", label: "Shipped" },
];

function toTime(value: Date | string | null | undefined): number {
  return value ? new Date(value).getTime() : 0;
}

export function isStalled(issue: Issue, now: number): boolean {
  return (
    (issue.status === "in_progress" || issue.status === "blocked") &&
    toTime(issue.updatedAt) < now - STALL_THRESHOLD_DAYS * 24 * 60 * 60 * 1000
  );
}

/** A done card counts as Shipped only with terminal delivery evidence. */
function isShippedEvidence(products: IssueWorkProduct[]): boolean {
  return products.some(
    (product) =>
      product.status === "merged" ||
      product.status === "approved" ||
      (product.status === "active" && product.type !== "pull_request" && product.type !== "branch"),
  );
}

export function Board() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [departmentId, setDepartmentId] = useState<string>("all");
  const navigate = useNavigate();

  useEffect(() => {
    setBreadcrumbs([{ label: "Board" }]);
  }, [setBreadcrumbs]);

  const { data: issues, isLoading } = useQuery({
    queryKey: ["issues", selectedCompanyId, "board"] as const,
    queryFn: () => issuesApi.list(selectedCompanyId!, { limit: 250 }),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentById = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of (agents ?? []) as Agent[]) map.set(agent.id, agent);
    return map;
  }, [agents]);

  const visible = useMemo(
    () =>
      (issues ?? []).filter(
        (issue) =>
          issue.status !== "cancelled" &&
          (departmentId === "all" || issue.projectId === departmentId),
      ),
    [issues, departmentId],
  );

  // Shipped evidence: only done cards need a work-product lookup.
  const doneIssues = useMemo(() => visible.filter((issue) => issue.status === "done"), [visible]);
  const workProductQueries = useQueries({
    queries: doneIssues.slice(0, 50).map((issue) => ({
      queryKey: queryKeys.issues.workProducts(issue.id),
      queryFn: () => issuesApi.listWorkProducts(issue.id),
      staleTime: 60_000,
    })),
  });
  const shippedIds = useMemo(() => {
    const set = new Set<string>();
    doneIssues.slice(0, 50).forEach((issue, index) => {
      const products = workProductQueries[index]?.data;
      if (products && isShippedEvidence(products)) set.add(issue.id);
    });
    return set;
  }, [doneIssues, workProductQueries]);

  const columns = useMemo(() => {
    const now = Date.now();
    const byColumn: Record<ColumnKey, Issue[]> = {
      queued: [],
      in_progress: [],
      review_gate: [],
      approved: [],
      shipped: [],
    };
    for (const issue of visible) {
      if (issue.status === "backlog" || issue.status === "todo") byColumn.queued.push(issue);
      else if (issue.status === "in_progress" || issue.status === "blocked")
        byColumn.in_progress.push(issue);
      else if (issue.status === "in_review") byColumn.review_gate.push(issue);
      else if (issue.status === "done")
        (shippedIds.has(issue.id) ? byColumn.shipped : byColumn.approved).push(issue);
    }
    for (const key of Object.keys(byColumn) as ColumnKey[]) {
      byColumn[key].sort((a, b) => {
        const stallDelta = Number(isStalled(b, now)) - Number(isStalled(a, now));
        if (stallDelta !== 0) return stallDelta;
        const priorityDelta =
          (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9);
        if (priorityDelta !== 0) return priorityDelta;
        return toTime(b.updatedAt) - toTime(a.updatedAt);
      });
    }
    return byColumn;
  }, [visible, shippedIds]);

  const now = Date.now();

  return (
    <div className="flex h-full flex-col bg-ops-bg text-ops-body text-ops-ink">
      <div className="flex items-center gap-ops-3 px-ops-4 py-ops-3">
        <span className="font-ops-accent">Board</span>
        <select
          value={departmentId}
          onChange={(event) => setDepartmentId(event.target.value)}
          className="border border-ops-line bg-ops-bg px-ops-2 py-ops-1 text-ops-detail text-ops-ink"
          aria-label="Department filter"
        >
          <option value="all">All departments</option>
          {((projects ?? []) as Project[]).map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        {isLoading && <span className="text-ops-detail text-ops-ink-muted">Loading…</span>}
      </div>

      <div className="flex min-h-0 flex-1 gap-ops-3 overflow-x-auto px-ops-4 pb-ops-4">
        {COLUMNS.map((column) => {
          const cards = columns[column.key];
          return (
            <div key={column.key} className="flex min-w-52 flex-1 shrink-0 flex-col">
              <div className="flex items-baseline gap-ops-2 border-b border-ops-line pb-ops-2">
                <span className="font-ops-accent">{column.label}</span>
                <span className="text-ops-detail text-ops-ink-muted">{cards.length}</span>
              </div>
              <div className="min-h-0 flex-1 space-y-ops-2 overflow-y-auto pt-ops-2">
                {cards.length === 0 && (
                  <p className="pt-ops-2 text-ops-detail text-ops-ink-muted">
                    {column.key === "queued"
                      ? "Agents queue their own work here."
                      : "Nothing here right now."}
                  </p>
                )}
                {cards.map((issue) => {
                  const stalled = isStalled(issue, now);
                  const owner = issue.assigneeAgentId
                    ? agentById.get(issue.assigneeAgentId)
                    : null;
                  return (
                    <button
                      key={issue.id}
                      type="button"
                      onClick={() => navigate(issueUrl(issue))}
                      className={cn(
                        "block w-full border border-ops-line bg-ops-bg-raised p-ops-2 text-left hover:border-ops-ink-muted",
                        stalled && "border-l-2 border-l-ops-signal",
                      )}
                    >
                      <div className="flex items-baseline justify-between gap-ops-2">
                        <span className="text-ops-detail text-ops-ink-muted">
                          {issue.identifier ?? "—"}
                        </span>
                        <span
                          className={cn(
                            "text-ops-detail text-ops-ink-muted",
                            issue.priority === "critical" && "font-ops-accent",
                          )}
                          title={`Priority: ${issue.priority}`}
                        >
                          {PRIORITY_GLYPH[issue.priority] ?? "·"}
                        </span>
                      </div>
                      <p className="mt-ops-1 line-clamp-2">{issue.title}</p>
                      <div className="mt-ops-2 flex items-center gap-ops-2 text-ops-detail text-ops-ink-muted">
                        {owner ? (
                          <>
                            <span
                              aria-hidden
                              className="inline-flex h-4 w-4 items-center justify-center border border-ops-line font-ops-accent"
                            >
                              {owner.name.charAt(0).toUpperCase()}
                            </span>
                            <span className="truncate">{owner.name}</span>
                          </>
                        ) : (
                          <span>Unassigned</span>
                        )}
                        {stalled && (
                          <span className="ml-auto font-ops-accent text-ops-signal">stalled</span>
                        )}
                        {!stalled && issue.status === "blocked" && (
                          <span className="ml-auto text-ops-signal">blocked</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

    </div>
  );
}
