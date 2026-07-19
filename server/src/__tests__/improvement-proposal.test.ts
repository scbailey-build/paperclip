import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, createDb, agents, companies, issueRecoveryActions, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  IMPROVEMENT_PROPOSAL_ORIGIN_KIND,
  improvementProposalService,
} from "../services/improvement-proposal.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("improvement proposal reconciliation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-improvement-proposal-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // The service writes an activity_log row on proposal creation; clear it
    // before companies so the FK to companies does not block teardown.
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedIssue(companyId: string, identifier: string) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: `Source ${identifier}`,
      status: "in_progress",
      priority: "medium",
      issueNumber: Number(identifier.replace(/\D/g, "")) || 1,
      identifier,
    });
    return id;
  }

  async function seedRecoveryAction(companyId: string, sourceIssueId: string, cause: string, createdAt?: Date) {
    await db.insert(issueRecoveryActions).values({
      id: randomUUID(),
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      cause,
      fingerprint: `${cause}:${sourceIssueId}`,
      nextAction: `recover ${sourceIssueId}`,
      ...(createdAt ? { createdAt } : {}),
    });
  }

  async function openProposals(companyId: string) {
    return db
      .select({ id: issues.id, title: issues.title, originFingerprint: issues.originFingerprint })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, IMPROVEMENT_PROPOSAL_ORIGIN_KIND)));
  }

  it("files one proposal when a cause strands >= 2 distinct issues, and is idempotent on re-sweep", async () => {
    const companyId = await seedCompany();
    const issueA = await seedIssue(companyId, "TST-1");
    const issueB = await seedIssue(companyId, "TST-2");
    await seedRecoveryAction(companyId, issueA, "process_lost");
    await seedRecoveryAction(companyId, issueB, "process_lost");

    const svc = improvementProposalService(db);
    const first = await svc.reconcileImprovementProposals();
    expect(first.created).toBe(1);
    expect(first.failed).toBe(0);

    const proposals = await openProposals(companyId);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].title).toContain("process_lost");
    expect(proposals[0].originFingerprint).toBe("improvement:process_lost");

    // Re-sweep while the proposal is open: the partial unique index makes it a no-op.
    const second = await svc.reconcileImprovementProposals();
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);
    expect(await openProposals(companyId)).toHaveLength(1);
  });

  it("does not file a proposal when a cause has stranded only one distinct issue", async () => {
    const companyId = await seedCompany();
    const issueA = await seedIssue(companyId, "TST-1");
    // Two recovery actions, but on the SAME issue — not cross-issue recurrence.
    await seedRecoveryAction(companyId, issueA, "provider_quota");
    await seedRecoveryAction(companyId, issueA, "provider_quota");

    const result = await improvementProposalService(db).reconcileImprovementProposals();
    expect(result.created).toBe(0);
    expect(await openProposals(companyId)).toHaveLength(0);
  });

  it("ignores recovery actions older than the 30-day window", async () => {
    const companyId = await seedCompany();
    const issueA = await seedIssue(companyId, "TST-1");
    const issueB = await seedIssue(companyId, "TST-2");
    const stale = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    await seedRecoveryAction(companyId, issueA, "workspace_validation_failed", stale);
    await seedRecoveryAction(companyId, issueB, "workspace_validation_failed", stale);

    const result = await improvementProposalService(db).reconcileImprovementProposals();
    expect(result.created).toBe(0);
    expect(await openProposals(companyId)).toHaveLength(0);
  });

  it("files a fresh proposal once the previous one is closed", async () => {
    const companyId = await seedCompany();
    const issueA = await seedIssue(companyId, "TST-1");
    const issueB = await seedIssue(companyId, "TST-2");
    await seedRecoveryAction(companyId, issueA, "process_lost");
    await seedRecoveryAction(companyId, issueB, "process_lost");

    const svc = improvementProposalService(db);
    await svc.reconcileImprovementProposals();
    const [proposal] = await openProposals(companyId);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, proposal.id));

    // The unique index only covers open proposals, so a closed one no longer blocks.
    const again = await svc.reconcileImprovementProposals();
    expect(again.created).toBe(1);
  });
});
