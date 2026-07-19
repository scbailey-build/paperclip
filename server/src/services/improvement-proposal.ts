import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { clampIssueRequestDepth } from "@paperclipai/shared";
import { agents, companies, issueRecoveryActions, issues, projects } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { budgetService } from "./budgets.js";
import { issueService } from "./issues.js";
import { recoveryAssigneeAdapterOverrides } from "./recovery/model-profile-hint.js";

export const IMPROVEMENT_PROPOSAL_ORIGIN_KIND = "improvement_proposal";

// A recurring cause counts as an improvement candidate once it has stranded at
// least this many *distinct* issues inside the trailing window.
export const DEFAULT_IMPROVEMENT_MIN_DISTINCT_ISSUES = 2;
export const DEFAULT_IMPROVEMENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CAUSE_GROUPS = 100;
const MAX_EVIDENCE_ISSUES = 12;

type AgentRow = typeof agents.$inferSelect;

const IMPROVEMENT_PROPOSAL_UNIQUE_INDEX = "issues_active_improvement_proposal_uq";

// The open-proposal unique index guarantees idempotency, but the driver wraps
// the Postgres error (code 23505 / constraint name live on `.cause`, not the
// top-level object), so walk the cause chain and also match the constraint
// name in the message.
function isImprovementProposalUniqueConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const candidate = current as { code?: string; constraint?: string; message?: string; cause?: unknown };
    const constraintMatch = candidate.constraint === IMPROVEMENT_PROPOSAL_UNIQUE_INDEX;
    const messageMatch =
      typeof candidate.message === "string" && candidate.message.includes(IMPROVEMENT_PROPOSAL_UNIQUE_INDEX);
    if ((candidate.code === "23505" && constraintMatch) || messageMatch) return true;
    current = candidate.cause;
  }
  return false;
}

interface RecurringCauseGroup {
  companyId: string;
  cause: string;
  distinctIssueCount: number;
  totalActionCount: number;
  sourceIssueIds: string[];
  ownerAgentIds: string[];
  latestNextAction: string | null;
}

/**
 * Cross-issue improvement loop (design/bql-patterns/01-design.md, P7): the
 * per-issue recovery machinery fixes one stranded issue at a time and never
 * notices when the same *cause* keeps recurring across unrelated issues. This
 * sweep groups issue_recovery_actions by (companyId, cause) — read-side only,
 * no schema change to the per-issue uniqueness — and files an
 * `improvement_proposal` issue when a cause has stranded >= N distinct issues
 * in the window. The partial unique index keys on the cause fingerprint, so a
 * re-sweep while a proposal is open is a no-op.
 */
export function improvementProposalService(db: Db) {
  const issuesSvc = issueService(db);
  const budgets = budgetService(db);

  function isAgentInvokable(agent: AgentRow | null | undefined) {
    return Boolean(agent && !["paused", "terminated", "pending_approval"].includes(agent.status));
  }

  function improvementFingerprint(cause: string) {
    return `improvement:${cause}`;
  }

  async function getCompanyIssuePrefix(companyId: string) {
    return db
      .select({ issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0]?.issuePrefix ?? "PAP");
  }

  async function findRecurringCauses(since: Date, companyId?: string): Promise<RecurringCauseGroup[]> {
    const conditions = [gte(issueRecoveryActions.createdAt, since)];
    if (companyId) conditions.push(eq(issueRecoveryActions.companyId, companyId));
    const rows = await db
      .select({
        companyId: issueRecoveryActions.companyId,
        cause: issueRecoveryActions.cause,
        sourceIssueId: issueRecoveryActions.sourceIssueId,
        ownerAgentId: issueRecoveryActions.ownerAgentId,
        previousOwnerAgentId: issueRecoveryActions.previousOwnerAgentId,
        nextAction: issueRecoveryActions.nextAction,
        createdAt: issueRecoveryActions.createdAt,
      })
      .from(issueRecoveryActions)
      .where(and(...conditions))
      .orderBy(desc(issueRecoveryActions.createdAt));

    const groups = new Map<string, RecurringCauseGroup & { issueSet: Set<string>; ownerSet: Set<string> }>();
    for (const row of rows) {
      const key = `${row.companyId}:${row.cause}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          companyId: row.companyId,
          cause: row.cause,
          distinctIssueCount: 0,
          totalActionCount: 0,
          sourceIssueIds: [],
          ownerAgentIds: [],
          latestNextAction: row.nextAction ?? null,
          issueSet: new Set<string>(),
          ownerSet: new Set<string>(),
        };
        groups.set(key, group);
      }
      group.totalActionCount += 1;
      if (!group.issueSet.has(row.sourceIssueId)) {
        group.issueSet.add(row.sourceIssueId);
        if (group.sourceIssueIds.length < MAX_EVIDENCE_ISSUES) group.sourceIssueIds.push(row.sourceIssueId);
      }
      for (const owner of [row.ownerAgentId, row.previousOwnerAgentId]) {
        if (owner && !group.ownerSet.has(owner)) {
          group.ownerSet.add(owner);
          group.ownerAgentIds.push(owner);
        }
      }
    }

    return [...groups.values()]
      .map((group) => ({
        companyId: group.companyId,
        cause: group.cause,
        distinctIssueCount: group.issueSet.size,
        totalActionCount: group.totalActionCount,
        sourceIssueIds: group.sourceIssueIds,
        ownerAgentIds: group.ownerAgentIds,
        latestNextAction: group.latestNextAction,
      }))
      .filter((group) => group.distinctIssueCount >= DEFAULT_IMPROVEMENT_MIN_DISTINCT_ISSUES)
      .sort((a, b) => b.distinctIssueCount - a.distinctIssueCount)
      .slice(0, MAX_CAUSE_GROUPS);
  }

  async function getAgent(agentId: string) {
    return db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0] ?? null);
  }

  async function resolveProposalOwnerAgentId(group: RecurringCauseGroup): Promise<string | null> {
    const candidateIds: string[] = [];
    for (const ownerId of group.ownerAgentIds) {
      const owner = await getAgent(ownerId);
      if (owner?.reportsTo) candidateIds.push(owner.reportsTo);
    }
    const roleCandidates = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, group.companyId), inArray(agents.role, ["cto", "ceo"])))
      .orderBy(sql`case when ${agents.role} = 'cto' then 0 else 1 end`);
    candidateIds.push(...roleCandidates.map((row) => row.id));

    const seen = new Set<string>();
    for (const agentId of candidateIds) {
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      const candidate = await getAgent(agentId);
      if (!candidate || candidate.companyId !== group.companyId || !isAgentInvokable(candidate)) continue;
      const budgetBlock = await budgets.getInvocationBlock(group.companyId, candidate.id, {});
      if (!budgetBlock) return candidate.id;
    }
    return null;
  }

  function buildProposalMarkdown(group: RecurringCauseGroup, prefix: string, sourceIdentifiers: string[]) {
    const issuesList = sourceIdentifiers.length > 0
      ? sourceIdentifiers.map((identifier) => `- ${identifier}`).join("\n")
      : "- (identifiers unavailable)";
    return [
      `A recurring failure cause — \`${group.cause}\` — has stranded ${group.distinctIssueCount} distinct issues (${group.totalActionCount} recovery actions) in the last 30 days.`,
      "",
      "Per-issue recovery keeps fixing each occurrence in isolation. This proposal exists to fix the *cause* so the pattern stops recurring.",
      "",
      "## Affected Issues",
      "",
      issuesList,
      "",
      "## Latest Recorded Next Action",
      "",
      group.latestNextAction ? `> ${group.latestNextAction}` : "- (none recorded)",
      "",
      "## Suggested Decision",
      "",
      "- Identify the shared root cause across the affected issues.",
      "- Ship a systemic fix (config, prompt, adapter, workflow, or tooling change) and close this proposal.",
      "- Or close as won't-fix if the recurrence is expected and acceptable.",
    ].join("\n");
  }

  async function reconcileImprovementProposals(opts?: { now?: Date; companyId?: string }) {
    const now = opts?.now ?? new Date();
    const since = new Date(now.getTime() - DEFAULT_IMPROVEMENT_WINDOW_MS);
    const groups = await findRecurringCauses(since, opts?.companyId);

    let created = 0;
    let skipped = 0;
    let failed = 0;

    for (const group of groups) {
      try {
        const prefix = await getCompanyIssuePrefix(group.companyId);
        const sourceIssues = group.sourceIssueIds.length > 0
          ? await db
            .select({ id: issues.id, identifier: issues.identifier })
            .from(issues)
            .where(and(eq(issues.companyId, group.companyId), inArray(issues.id, group.sourceIssueIds)))
          : [];
        const sourceIdentifiers = sourceIssues.map((issue) => issue.identifier ?? issue.id);
        const ownerAgentId = await resolveProposalOwnerAgentId(group);

        try {
          const proposal = await issuesSvc.create(group.companyId, {
            title: `Recurring failure: ${group.cause} (${group.distinctIssueCount} issues in 30d)`,
            description: buildProposalMarkdown(group, prefix, sourceIdentifiers),
            status: "todo",
            priority: group.distinctIssueCount >= 4 ? "high" : "medium",
            assigneeAgentId: ownerAgentId,
            assigneeAdapterOverrides: recoveryAssigneeAdapterOverrides("status_only"),
            originKind: IMPROVEMENT_PROPOSAL_ORIGIN_KIND,
            originId: group.sourceIssueIds[0] ?? null,
            originFingerprint: improvementFingerprint(group.cause),
            requestDepth: clampIssueRequestDepth(1),
          });
          created += 1;
          await logActivity(db, {
            companyId: group.companyId,
            actorType: "system",
            actorId: "system",
            action: "issue.improvement_proposal_created",
            entityType: "issue",
            entityId: proposal.id,
            agentId: ownerAgentId,
            details: {
              source: "improvement_proposal.reconcile",
              cause: group.cause,
              distinctIssueCount: group.distinctIssueCount,
              totalActionCount: group.totalActionCount,
              sourceIssueIds: group.sourceIssueIds,
            },
          });
        } catch (error) {
          if (!isImprovementProposalUniqueConflict(error)) throw error;
          skipped += 1;
        }
      } catch (error) {
        failed += 1;
        logger.warn(
          { err: error, companyId: group.companyId, cause: group.cause },
          "failed to reconcile improvement proposal for recurring cause",
        );
      }
    }

    return { created, skipped, failed };
  }

  return {
    reconcileImprovementProposals,
  };
}
