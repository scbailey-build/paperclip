import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySkills, goals, issues, projects } from "@paperclipai/db";
import { agentActivationPreconditionSchema } from "@paperclipai/shared";

export interface ActivationBlocker {
  kind: "min_rows";
  entity: string;
  status?: string;
  min: number;
  actual: number;
  description: string;
}

export interface ActivationEvaluation {
  met: boolean;
  blockers: ActivationBlocker[];
}

const ENTITY_TABLES = {
  issues,
  projects,
  goals,
  company_skills: companySkills,
} as const;

function readPreconditions(runtimeConfig: unknown) {
  if (!runtimeConfig || typeof runtimeConfig !== "object") return [];
  const raw = (runtimeConfig as Record<string, unknown>).activationPreconditions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const parsed = agentActivationPreconditionSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Data-gated activation (design/bql-patterns/01-design.md, P3): an agent whose
 * runtimeConfig declares activationPreconditions only activates — and only
 * gets dispatched — while the company data it monitors actually exists.
 * Absent or malformed preconditions evaluate as met (today's behavior).
 */
export async function evaluateActivationPreconditions(
  db: Db,
  agent: { companyId: string; runtimeConfig?: unknown },
): Promise<ActivationEvaluation> {
  const preconditions = readPreconditions(agent.runtimeConfig);
  if (preconditions.length === 0) return { met: true, blockers: [] };

  const blockers: ActivationBlocker[] = [];
  for (const pre of preconditions) {
    const table = ENTITY_TABLES[pre.entity];
    const conditions = [eq(table.companyId, agent.companyId)];
    if (pre.status && "status" in table) {
      conditions.push(eq((table as typeof issues).status, pre.status));
    }
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(table)
      .where(and(...conditions));
    const actual = Number(row?.count ?? 0);
    if (actual < pre.min) {
      blockers.push({
        kind: pre.kind,
        entity: pre.entity,
        ...(pre.status ? { status: pre.status } : {}),
        min: pre.min,
        actual,
        description: `needs at least ${pre.min} ${pre.status ? `${pre.status} ` : ""}${pre.entity.replace("_", " ")} (have ${actual})`,
      });
    }
  }
  return { met: blockers.length === 0, blockers };
}
