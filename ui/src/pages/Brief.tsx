import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent, Approval, Issue } from "@paperclipai/shared";
import { approvalsApi } from "../api/approvals";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, issueUrl, relativeTime } from "../lib/utils";
import { Link } from "../lib/router";

/**
 * The Brief — the home screen. Three sections, in order:
 *   1. Decisions needed: pending approvals (incl. COO recommendations) and
 *      review-gate issues, each with approve/override as single taps.
 *   2. Moving without me: what shipped or advanced since the last visit.
 *   3. One flagged risk or stall, with restart/kill.
 * No raw event feed — that lives in Activity (audit).
 * Styling: operator tokens (ops-*) only. Two type sizes + one accent weight.
 */

const STALL_THRESHOLD_DAYS = 7;
const MOVING_ROW_CAP = 8;

function lastVisitKey(companyId: string) {
  return `paperclip.brief.lastVisit.${companyId}`;
}

function toTime(value: Date | string | null | undefined): number {
  if (!value) return 0;
  return new Date(value).getTime();
}

type Decision =
  | { kind: "approval"; approval: Approval }
  | { kind: "review_gate"; issue: Issue };

function approvalField(approval: Approval, keys: string[]): string | null {
  for (const key of keys) {
    const value = approval.payload?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export function Brief() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [confirmingKill, setConfirmingKill] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Brief" }]);
  }, [setBreadcrumbs]);

  // "Since my last visit" boundary: read once per mount, then stamp the visit.
  const [since] = useState<number>(() => {
    if (!selectedCompanyId) return 0;
    const raw = localStorage.getItem(lastVisitKey(selectedCompanyId));
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : Date.now() - 24 * 60 * 60 * 1000;
  });

  useEffect(() => {
    if (!selectedCompanyId) return;
    localStorage.setItem(lastVisitKey(selectedCompanyId), String(Date.now()));
  }, [selectedCompanyId]);

  const { data: pendingApprovals, isLoading: approvalsLoading } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!, "pending"),
    queryFn: () => approvalsApi.list(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
  });

  const { data: issues, isLoading: issuesLoading } = useQuery({
    queryKey: ["issues", selectedCompanyId, "brief"] as const,
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        status: "in_progress,in_review,blocked,done",
        limit: 200,
      }),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of (agents ?? []) as Agent[]) map.set(agent.id, agent.name);
    return map;
  }, [agents]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["issues"] });
    queryClient.invalidateQueries({ queryKey: ["approvals"] });
  };

  const decideApproval = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approve" | "override" }) =>
      decision === "approve"
        ? approvalsApi.approve(id, "Approved from the Brief.")
        : approvalsApi.reject(id, "Overridden from the Brief."),
    onSettled: invalidate,
  });

  const decideIssue = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approve" | "override" }) =>
      issuesApi.update(
        id,
        decision === "approve"
          ? { status: "done", comment: "Approved from the Brief." }
          : { status: "in_progress", comment: "Overridden from the Brief — changes requested; see thread." },
      ),
    onSettled: invalidate,
  });

  const restartIssue = useMutation({
    mutationFn: (id: string) =>
      issuesApi.update(id, { status: "todo", comment: "Restarted from the Brief." }),
    onSettled: invalidate,
  });

  const killIssue = useMutation({
    mutationFn: (id: string) =>
      issuesApi.update(id, { status: "cancelled", comment: "Killed from the Brief." }),
    onSettled: () => {
      setConfirmingKill(null);
      invalidate();
    },
  });

  const { decisions, moving, risk } = useMemo(() => {
    const all = issues ?? [];
    const now = Date.now();
    const stallCutoff = now - STALL_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

    const reviewGate = all
      .filter((issue) => issue.status === "in_review")
      .sort((a, b) => toTime(a.updatedAt) - toTime(b.updatedAt));

    const decisionList: Decision[] = [
      ...(pendingApprovals ?? []).map((approval): Decision => ({ kind: "approval", approval })),
      ...reviewGate.map((issue): Decision => ({ kind: "review_gate", issue })),
    ];

    const shipped = all
      .filter((issue) => issue.status === "done" && toTime(issue.completedAt) >= since)
      .map((issue) => ({ issue, at: toTime(issue.completedAt), verb: "shipped" as const }));
    const started = all
      .filter((issue) => issue.status === "in_progress" && toTime(issue.startedAt) >= since)
      .map((issue) => ({ issue, at: toTime(issue.startedAt), verb: "started" as const }));
    const movingList = [...shipped, ...started].sort((a, b) => b.at - a.at);

    const stalled = all
      .filter(
        (issue) =>
          (issue.status === "in_progress" || issue.status === "blocked") &&
          toTime(issue.updatedAt) < stallCutoff,
      )
      .sort((a, b) => toTime(a.updatedAt) - toTime(b.updatedAt));

    return { decisions: decisionList, moving: movingList, risk: stalled[0] ?? null };
  }, [issues, pendingApprovals, since]);

  const loading = approvalsLoading || issuesLoading;

  return (
    <div className="mx-auto max-w-2xl bg-ops-bg px-ops-4 py-ops-8 text-ops-body text-ops-ink">
      <h1 className="text-ops-title font-ops-accent">Brief</h1>
      <p className="mt-ops-1 text-ops-ink-muted">
        {new Date().toLocaleDateString(undefined, {
          weekday: "long",
          month: "long",
          day: "numeric",
        })}
      </p>

      {/* 1 — Decisions needed */}
      <section className="mt-ops-8">
        <h2 className="font-ops-accent text-ops-ink-muted">Decisions needed</h2>
        {loading && <p className="mt-ops-3 text-ops-ink-muted">Loading…</p>}
        {!loading && decisions.length === 0 && (
          <div className="mt-ops-3">
            <p>Nothing needs a decision right now.</p>
            <Link
              to="/board"
              className="mt-ops-2 inline-block border border-ops-line px-ops-3 py-ops-1 font-ops-accent hover:bg-ops-bg-raised"
            >
              Open the Board
            </Link>
          </div>
        )}
        <ul className="mt-ops-3 space-y-ops-3">
          {decisions.map((decision, index) => {
            const isPrimary = index === 0;
            if (decision.kind === "approval") {
              const { approval } = decision;
              const title =
                approvalField(approval, ["title", "situation"]) ?? approval.type.replace(/_/g, " ");
              const recommendation = approvalField(approval, ["recommendation", "recommendedAction"]);
              const reasoning = approvalField(approval, ["summary", "situation"]);
              const cost = approvalField(approval, ["costOfDecidingWrong"]);
              return (
                <li key={approval.id} className="border-l-2 border-ops-accent pl-ops-3">
                  <Link to={`/approvals/${approval.id}`} className="font-ops-accent hover:underline">
                    {title}
                  </Link>
                  {recommendation && <p className="mt-ops-1">Recommendation: {recommendation}</p>}
                  {reasoning && reasoning !== recommendation && (
                    <p className="mt-ops-1 text-ops-ink-muted">{reasoning}</p>
                  )}
                  {cost && <p className="mt-ops-1 text-ops-ink-muted">If wrong: {cost}</p>}
                  <div className="mt-ops-2 flex gap-ops-2">
                    <button
                      type="button"
                      disabled={decideApproval.isPending}
                      onClick={() => decideApproval.mutate({ id: approval.id, decision: "approve" })}
                      className={cn(
                        "px-ops-3 py-ops-1 font-ops-accent",
                        isPrimary
                          ? "bg-ops-accent text-ops-accent-ink"
                          : "border border-ops-line hover:bg-ops-bg-raised",
                      )}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={decideApproval.isPending}
                      onClick={() => decideApproval.mutate({ id: approval.id, decision: "override" })}
                      className="border border-ops-line px-ops-3 py-ops-1 hover:bg-ops-bg-raised"
                    >
                      Override
                    </button>
                  </div>
                </li>
              );
            }
            const { issue } = decision;
            const owner = issue.assigneeAgentId ? agentNames.get(issue.assigneeAgentId) : null;
            return (
              <li key={issue.id} className="border-l-2 border-ops-accent pl-ops-3">
                <Link to={issueUrl(issue)} className="font-ops-accent hover:underline">
                  {issue.title}
                </Link>
                <p className="mt-ops-1 text-ops-ink-muted">
                  At the review gate {relativeTime(issue.updatedAt)}
                  {owner ? ` · ${owner}` : ""}
                </p>
                <div className="mt-ops-2 flex gap-ops-2">
                  <button
                    type="button"
                    disabled={decideIssue.isPending}
                    onClick={() => decideIssue.mutate({ id: issue.id, decision: "approve" })}
                    className={cn(
                      "px-ops-3 py-ops-1 font-ops-accent",
                      isPrimary
                        ? "bg-ops-accent text-ops-accent-ink"
                        : "border border-ops-line hover:bg-ops-bg-raised",
                    )}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={decideIssue.isPending}
                    onClick={() => decideIssue.mutate({ id: issue.id, decision: "override" })}
                    className="border border-ops-line px-ops-3 py-ops-1 hover:bg-ops-bg-raised"
                  >
                    Override
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {/* 2 — Moving without me */}
      <section className="mt-ops-8">
        <h2 className="font-ops-accent text-ops-ink-muted">Moving without me</h2>
        {!loading && moving.length === 0 && (
          <div className="mt-ops-3">
            <p>Nothing has moved since your last visit.</p>
            <Link
              to="/activity"
              className="mt-ops-2 inline-block border border-ops-line px-ops-3 py-ops-1 font-ops-accent hover:bg-ops-bg-raised"
            >
              Open the audit trail
            </Link>
          </div>
        )}
        <ul className="mt-ops-3">
          {moving.slice(0, MOVING_ROW_CAP).map(({ issue, verb, at }) => {
            const owner = issue.assigneeAgentId ? agentNames.get(issue.assigneeAgentId) : null;
            return (
              <li key={`${issue.id}-${verb}`} className="flex items-baseline gap-ops-2 py-ops-1">
                <span className={cn("shrink-0 text-ops-ink-muted", verb === "shipped" && "font-ops-accent")}>
                  {verb}
                </span>
                <Link to={issueUrl(issue)} className="min-w-0 truncate hover:underline">
                  {issue.title}
                </Link>
                <span className="ml-auto shrink-0 text-ops-ink-muted">
                  {owner ? `${owner} · ` : ""}
                  {relativeTime(new Date(at))}
                </span>
              </li>
            );
          })}
        </ul>
        {moving.length > MOVING_ROW_CAP && (
          <p className="mt-ops-1 text-ops-ink-muted">
            <Link to="/activity" className="hover:underline">
              +{moving.length - MOVING_ROW_CAP} more in the audit trail
            </Link>
          </p>
        )}
      </section>

      {/* 3 — One flagged risk or stall */}
      <section className="mt-ops-8 pb-ops-12">
        <h2 className="font-ops-accent text-ops-ink-muted">Flagged</h2>
        {!loading && !risk && <p className="mt-ops-3">Nothing stalled, nothing at risk.</p>}
        {risk && (
          <div className="mt-ops-3 border-l-2 border-ops-signal bg-ops-signal-soft py-ops-2 pl-ops-3 pr-ops-3">
            <Link to={issueUrl(risk)} className="font-ops-accent hover:underline">
              {risk.title}
            </Link>
            <p className="mt-ops-1 text-ops-ink-muted">
              {risk.status === "blocked" ? "Blocked" : "No progress"} since {relativeTime(risk.updatedAt)}
              {risk.assigneeAgentId && agentNames.get(risk.assigneeAgentId)
                ? ` · ${agentNames.get(risk.assigneeAgentId)}`
                : ""}
            </p>
            <div className="mt-ops-2 flex gap-ops-2">
              <button
                type="button"
                disabled={restartIssue.isPending}
                onClick={() => restartIssue.mutate(risk.id)}
                className="border border-ops-line px-ops-3 py-ops-1 font-ops-accent hover:bg-ops-bg"
              >
                Restart
              </button>
              {confirmingKill === risk.id ? (
                <button
                  type="button"
                  disabled={killIssue.isPending}
                  onClick={() => killIssue.mutate(risk.id)}
                  className="bg-ops-signal px-ops-3 py-ops-1 font-ops-accent text-ops-signal-ink"
                >
                  Confirm kill
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingKill(risk.id)}
                  className="border border-ops-line px-ops-3 py-ops-1 hover:bg-ops-bg"
                >
                  Kill
                </button>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
