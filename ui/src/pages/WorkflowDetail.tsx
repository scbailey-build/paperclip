import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { Agent, Issue } from "@paperclipai/shared";
import { goalsApi } from "../api/goals";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { useParams } from "../lib/router";
import { BoardCardPeek } from "../components/BoardCardPeek";
import { isStalled } from "../lib/stall";
import { milestonesOf } from "./Workflows";

/**
 * Workflow detail: milestones as a horizontal progression (gate cards),
 * deliverables under the active milestone, cards below, agents + skills in a
 * collapsed panel. Card click opens the same plan peek as the Board.
 */

export function WorkflowDetail() {
  const { goalId } = useParams<{ goalId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [peekIssueId, setPeekIssueId] = useState<string | null>(null);

  const { data: goal } = useQuery({
    queryKey: queryKeys.goals.detail(goalId!),
    queryFn: () => goalsApi.get(goalId!),
    enabled: !!goalId,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Workflows", href: "/workflows" }, { label: goal?.title ?? "…" }]);
  }, [setBreadcrumbs, goal?.title]);

  const { data: issues } = useQuery({
    queryKey: ["issues", selectedCompanyId, "workflows"] as const,
    queryFn: () => issuesApi.list(selectedCompanyId!, { limit: 250 }),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const cards = useMemo(
    () => (issues ?? []).filter((issue) => issue.goalId === goalId && issue.status !== "cancelled"),
    [issues, goalId],
  );

  const milestones = useMemo(() => milestonesOf(cards), [cards]);
  const activeMilestone =
    milestones.find((m) => m.status !== "done" && m.status !== "cancelled") ?? null;

  const workflowAgents = useMemo(() => {
    const ids = new Set(cards.map((card) => card.assigneeAgentId).filter(Boolean) as string[]);
    return ((agents ?? []) as Agent[]).filter((agent) => ids.has(agent.id));
  }, [cards, agents]);

  const skillQueries = useQueries({
    queries: workflowAgents.map((agent) => ({
      queryKey: ["agents", "skills", agent.id] as const,
      queryFn: () => agentsApi.skills(agent.id, selectedCompanyId ?? undefined),
      staleTime: 120_000,
      retry: false,
    })),
  });
  const skillsByAgent = useMemo(
    () =>
      workflowAgents.map((agent, index) => ({
        agent,
        skills: skillQueries[index]?.data?.desiredSkills ?? [],
      })),
    [workflowAgents, skillQueries],
  );

  const deliverableQueries = useQueries({
    queries: cards.slice(0, 50).map((card) => ({
      queryKey: queryKeys.issues.workProducts(card.id),
      queryFn: () => issuesApi.listWorkProducts(card.id),
      staleTime: 60_000,
    })),
  });
  const deliverables = useMemo(
    () =>
      cards.slice(0, 50).flatMap((card, index) =>
        (deliverableQueries[index]?.data ?? []).map((product) => ({ card, product })),
      ),
    [cards, deliverableQueries],
  );

  const now = Date.now();

  return (
    <div className="mx-auto max-w-3xl bg-ops-bg px-ops-4 py-ops-6 text-ops-body text-ops-ink">
      <h1 className="text-ops-title font-ops-accent">{goal?.title ?? "…"}</h1>
      <p className="mt-ops-1 text-ops-ink-muted">
        {goal?.status ?? ""}
        {goal?.description ? ` · ${goal.description}` : ""}
      </p>

      {/* Milestones — horizontal progression */}
      <section className="mt-ops-6">
        <h2 className="font-ops-accent text-ops-ink-muted">Milestones</h2>
        {milestones.length === 0 && (
          <p className="mt-ops-2 text-ops-ink-muted">
            No milestones yet — agents mark gate cards with the “milestone” label.
          </p>
        )}
        {milestones.length > 0 && (
          <div className="mt-ops-3 flex items-center gap-ops-1 overflow-x-auto pb-ops-2">
            {milestones.map((milestone, index) => {
              const passed = milestone.status === "done";
              const active = milestone.id === activeMilestone?.id;
              return (
                <div key={milestone.id} className="flex shrink-0 items-center gap-ops-1">
                  {index > 0 && <span className="h-px w-6 bg-ops-line" aria-hidden />}
                  <button
                    type="button"
                    onClick={() => setPeekIssueId(milestone.id)}
                    className={cn(
                      "border px-ops-3 py-ops-1",
                      active
                        ? "border-ops-accent font-ops-accent text-ops-accent"
                        : passed
                          ? "border-ops-line text-ops-ink-muted line-through"
                          : "border-ops-line text-ops-ink-muted",
                    )}
                  >
                    {milestone.title}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Deliverables under the active milestone */}
      <section className="mt-ops-6">
        <h2 className="font-ops-accent text-ops-ink-muted">
          Deliverables{activeMilestone ? ` — toward “${activeMilestone.title}”` : ""}
        </h2>
        {deliverables.length === 0 && (
          <p className="mt-ops-2 text-ops-ink-muted">No tracked deliverables yet.</p>
        )}
        <ul className="mt-ops-2 space-y-ops-1">
          {deliverables.map(({ card, product }) => (
            <li key={product.id} className="flex items-baseline gap-ops-2">
              {product.url ? (
                <a href={product.url} target="_blank" rel="noreferrer" className="min-w-0 truncate underline">
                  {product.title}
                </a>
              ) : (
                <span className="min-w-0 truncate">{product.title}</span>
              )}
              <span className="ml-auto shrink-0 text-ops-detail text-ops-ink-muted">
                {product.type.replace(/_/g, " ")} · {product.status} · {card.identifier}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* Cards */}
      <section className="mt-ops-6">
        <h2 className="font-ops-accent text-ops-ink-muted">Cards</h2>
        <ul className="mt-ops-2 divide-y divide-ops-line">
          {cards.map((card) => {
            const stalled = isStalled(card, now);
            return (
              <li key={card.id}>
                <button
                  type="button"
                  onClick={() => setPeekIssueId(card.id)}
                  className={cn(
                    "flex w-full items-baseline gap-ops-2 py-ops-2 text-left hover:bg-ops-bg-raised",
                    stalled && "border-l-2 border-ops-signal pl-ops-2",
                  )}
                >
                  <span className="w-16 shrink-0 text-ops-detail text-ops-ink-muted">
                    {card.identifier}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{card.title}</span>
                  <span
                    className={cn(
                      "shrink-0 text-ops-detail",
                      stalled ? "font-ops-accent text-ops-signal" : "text-ops-ink-muted",
                    )}
                  >
                    {stalled ? "stalled" : card.status.replace(/_/g, " ")} ·{" "}
                    {relativeTime(card.updatedAt)}
                  </span>
                </button>
              </li>
            );
          })}
          {cards.length === 0 && (
            <li className="py-ops-2 text-ops-ink-muted">No cards yet — agents create them.</li>
          )}
        </ul>
      </section>

      {/* Agents + skills, collapsed */}
      <details className="mt-ops-6 pb-ops-12">
        <summary className="cursor-pointer font-ops-accent text-ops-ink-muted">
          Agents &amp; skills ({workflowAgents.length})
        </summary>
        <ul className="mt-ops-2 space-y-ops-2">
          {skillsByAgent.map(({ agent, skills }) => (
            <li key={agent.id} className="flex items-baseline gap-ops-2">
              <span className="w-24 shrink-0 truncate font-ops-accent">{agent.name}</span>
              <span className="min-w-0 flex-1 truncate text-ops-ink-muted">
                {skills.length > 0 ? skills.join(", ") : "No skills assigned"}
              </span>
            </li>
          ))}
          {workflowAgents.length === 0 && (
            <li className="text-ops-ink-muted">No agents assigned yet.</li>
          )}
        </ul>
      </details>

      {peekIssueId && (
        <BoardCardPeek issueId={peekIssueId} onClose={() => setPeekIssueId(null)} />
      )}
    </div>
  );
}
