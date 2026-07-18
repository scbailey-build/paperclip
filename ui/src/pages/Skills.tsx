import { useEffect, useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { Agent, Goal } from "@paperclipai/shared";
import { companySkillsApi } from "../api/companySkills";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { goalsApi } from "../api/goals";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { Link } from "../lib/router";

/**
 * Skills — first-class objects, not agent config. Each row shows which
 * workflows use the skill and how often. Usage derives via holders (skill →
 * agents holding it → their open cards → workflows), per the approved mapping:
 * run-level skill telemetry doesn't exist, so counts are labeled as card
 * counts via holders, not invocation counts.
 */

export function Skills() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Skills" }]);
  }, [setBreadcrumbs]);

  const { data: skills, isLoading } = useQuery({
    queryKey: ["company-skills", selectedCompanyId] as const,
    queryFn: () => companySkillsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: issues } = useQuery({
    queryKey: ["issues", selectedCompanyId, "skills-usage"] as const,
    queryFn: () => issuesApi.list(selectedCompanyId!, { limit: 250 }),
    enabled: !!selectedCompanyId,
  });

  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentList = (agents ?? []) as Agent[];
  const skillQueries = useQueries({
    queries: agentList.map((agent) => ({
      queryKey: ["agents", "skills", agent.id] as const,
      queryFn: () => agentsApi.skills(agent.id, selectedCompanyId ?? undefined),
      staleTime: 120_000,
      retry: false,
    })),
  });

  const rows = useMemo(() => {
    const goalTitle = new Map(((goals ?? []) as Goal[]).map((goal) => [goal.id, goal.title]));
    const holdersBySkill = new Map<string, Agent[]>();
    agentList.forEach((agent, index) => {
      const held = skillQueries[index]?.data?.desiredSkills ?? [];
      for (const key of held) {
        if (!holdersBySkill.has(key)) holdersBySkill.set(key, []);
        holdersBySkill.get(key)!.push(agent);
      }
    });

    const openCards = (issues ?? []).filter(
      (issue) => !["done", "cancelled"].includes(issue.status),
    );

    return (skills ?? []).map((skill) => {
      const holders = holdersBySkill.get(skill.key) ?? [];
      const holderIds = new Set(holders.map((agent) => agent.id));
      const usage = new Map<string, number>();
      for (const card of openCards) {
        if (!card.goalId || !card.assigneeAgentId || !holderIds.has(card.assigneeAgentId)) continue;
        usage.set(card.goalId, (usage.get(card.goalId) ?? 0) + 1);
      }
      const workflows = [...usage.entries()]
        .map(([goalId, count]) => ({ goalId, count, title: goalTitle.get(goalId) ?? "…" }))
        .sort((a, b) => b.count - a.count);
      return { skill, holders, workflows };
    });
  }, [skills, agentList, skillQueries, issues, goals]);

  return (
    <div className="mx-auto max-w-3xl bg-ops-bg px-ops-4 py-ops-6 text-ops-body text-ops-ink">
      <div className="flex items-baseline justify-between">
        <h1 className="text-ops-title font-ops-accent">Skills</h1>
        <Link to="/skills/library" className="text-ops-ink-muted underline">
          Manage library
        </Link>
      </div>

      {isLoading && <p className="mt-ops-3 text-ops-ink-muted">Loading…</p>}

      {!isLoading && rows.length === 0 && (
        <div className="mt-ops-3">
          <p>No skills installed — skills are reusable capabilities agents carry between workflows.</p>
          <Link
            to="/skills/library"
            className="mt-ops-2 inline-block border border-ops-line px-ops-3 py-ops-1 font-ops-accent hover:bg-ops-bg-raised"
          >
            Install a skill
          </Link>
        </div>
      )}

      <ul className="mt-ops-3 divide-y divide-ops-line">
        {rows.map(({ skill, holders, workflows }) => (
          <li key={skill.id} className="py-ops-3">
            <details>
              <summary className="flex cursor-pointer items-baseline gap-ops-3">
                <span className="min-w-0 flex-1 truncate font-ops-accent">{skill.name}</span>
                <span className="shrink-0 text-ops-detail text-ops-ink-muted">
                  {holders.length} agent{holders.length === 1 ? "" : "s"} ·{" "}
                  {workflows.length} workflow{workflows.length === 1 ? "" : "s"}
                </span>
              </summary>
              <div className="mt-ops-2 pl-ops-3">
                {skill.description && <p className="text-ops-ink-muted">{skill.description}</p>}
                <p className="mt-ops-2 text-ops-detail text-ops-ink-muted">
                  Held by: {holders.length > 0 ? holders.map((a) => a.name).join(", ") : "no one yet"}
                </p>
                <ul className="mt-ops-1 space-y-ops-1">
                  {workflows.map(({ goalId, title, count }) => (
                    <li key={goalId} className="flex items-baseline gap-ops-2">
                      <Link to={`/workflows/${goalId}`} className="min-w-0 truncate underline">
                        {title}
                      </Link>
                      <span className="shrink-0 text-ops-detail text-ops-ink-muted">
                        {count} open card{count === 1 ? "" : "s"} via holders
                      </span>
                    </li>
                  ))}
                  {workflows.length === 0 && (
                    <li className="text-ops-detail text-ops-ink-muted">
                      Not in use on any open workflow.
                    </li>
                  )}
                </ul>
                <p className="mt-ops-2 text-ops-detail">
                  <Link to={`/skills/${encodeURIComponent(skill.key)}`} className="underline">
                    Open in library
                  </Link>
                </p>
              </div>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}
