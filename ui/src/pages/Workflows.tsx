import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent, Goal, Issue } from "@paperclipai/shared";
import { goalsApi } from "../api/goals";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useDialogActions } from "../context/DialogContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Link } from "../lib/router";
import { isStalled } from "./Board";

/**
 * Workflows — the primary object. A row shows exactly: name, current
 * milestone, owner agent, status. Everything else on click (progressive
 * disclosure). Milestones are the workflow's gate cards (label "milestone").
 */

export const MILESTONE_LABEL = "milestone";

export function milestonesOf(cards: Issue[]): Issue[] {
  return cards
    .filter((card) =>
      (card.labels ?? []).some((label) => label.name.toLowerCase() === MILESTONE_LABEL),
    )
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

export function currentMilestoneOf(cards: Issue[]): Issue | null {
  const milestones = milestonesOf(cards);
  return milestones.find((m) => m.status !== "done" && m.status !== "cancelled") ?? null;
}

export function Workflows() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openNewGoal } = useDialogActions();

  useEffect(() => {
    setBreadcrumbs([{ label: "Workflows" }]);
  }, [setBreadcrumbs]);

  const { data: goals, isLoading } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

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

  const agentNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of (agents ?? []) as Agent[]) map.set(agent.id, agent.name);
    return map;
  }, [agents]);

  const rows = useMemo(() => {
    const now = Date.now();
    return ((goals ?? []) as Goal[])
      .filter((goal) => goal.status !== "cancelled")
      .map((goal) => {
        const cards = (issues ?? []).filter((issue) => issue.goalId === goal.id);
        const current = currentMilestoneOf(cards);
        const stalled = cards.some((card) => isStalled(card, now));
        return { goal, current, stalled, cardCount: cards.length };
      })
      .sort((a, b) => Number(b.stalled) - Number(a.stalled));
  }, [goals, issues]);

  return (
    <div className="mx-auto max-w-3xl bg-ops-bg px-ops-4 py-ops-6 text-ops-body text-ops-ink">
      {isLoading && <p className="text-ops-ink-muted">Loading…</p>}

      {!isLoading && rows.length === 0 && (
        <div>
          <p>No workflows yet — a workflow is an objective agents work toward.</p>
          <button
            type="button"
            onClick={() => openNewGoal()}
            className="mt-ops-2 border border-ops-line px-ops-3 py-ops-1 font-ops-accent hover:bg-ops-bg-raised"
          >
            New workflow
          </button>
        </div>
      )}

      <ul className="divide-y divide-ops-line">
        {rows.map(({ goal, current, stalled, cardCount }) => (
          <li key={goal.id}>
            <Link
              to={`/workflows/${goal.id}`}
              className={cn(
                "flex items-baseline gap-ops-3 py-ops-3 hover:bg-ops-bg-raised",
                stalled && "border-l-2 border-ops-signal pl-ops-2",
              )}
            >
              <span className="min-w-0 flex-1 truncate font-ops-accent">{goal.title}</span>
              <span className="min-w-0 flex-1 truncate text-ops-ink-muted">
                {current ? current.title : cardCount === 0 ? "No cards yet" : "No open milestone"}
              </span>
              <span className="w-24 shrink-0 truncate text-ops-ink-muted">
                {goal.ownerAgentId ? (agentNames.get(goal.ownerAgentId) ?? "—") : "—"}
              </span>
              <span
                className={cn(
                  "w-20 shrink-0 text-right text-ops-detail",
                  stalled ? "font-ops-accent text-ops-signal" : "text-ops-ink-muted",
                )}
              >
                {stalled ? "stalled" : goal.status}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
