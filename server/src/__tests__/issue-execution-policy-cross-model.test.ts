import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, agents, companies } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  assertCrossModelReviewSatisfied,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("cross-model review for high-risk execution policies", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-model-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgents(models: { producer: string; reviewer: string }) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const producerId = randomUUID();
    const reviewerId = randomUUID();
    await db.insert(agents).values([
      {
        id: producerId,
        companyId,
        name: "Producer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: { model: models.producer },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: reviewerId,
        companyId,
        name: "Reviewer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: { model: models.reviewer },
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    return { producerId, reviewerId };
  }

  function highRiskPolicy(reviewerId: string) {
    return normalizeIssueExecutionPolicy({
      riskTier: "high",
      stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerId }] }],
    });
  }

  it("rejects a high-risk policy whose only reviewer shares the producer's model", async () => {
    const { producerId, reviewerId } = await seedAgents({ producer: "model-a", reviewer: "model-a" });
    await expect(
      assertCrossModelReviewSatisfied(db, {
        policy: highRiskPolicy(reviewerId),
        assigneeAgentId: producerId,
      }),
    ).rejects.toThrow(/different model/);
  });

  it("accepts a high-risk policy with a reviewer on a different model", async () => {
    const { producerId, reviewerId } = await seedAgents({ producer: "model-a", reviewer: "model-b" });
    await expect(
      assertCrossModelReviewSatisfied(db, {
        policy: highRiskPolicy(reviewerId),
        assigneeAgentId: producerId,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a high-risk policy with no review stage, and ignores non-high tiers", async () => {
    const { producerId, reviewerId } = await seedAgents({ producer: "model-a", reviewer: "model-a" });
    await expect(
      assertCrossModelReviewSatisfied(db, {
        policy: normalizeIssueExecutionPolicy({ riskTier: "high", stages: [] }),
        assigneeAgentId: producerId,
      }),
    ).rejects.toThrow(/review stage/);

    await expect(
      assertCrossModelReviewSatisfied(db, {
        policy: normalizeIssueExecutionPolicy({
          riskTier: "medium",
          stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerId }] }],
        }),
        assigneeAgentId: producerId,
      }),
    ).resolves.toBeUndefined();
  });

  it("treats user reviewers and unassigned producers as satisfying the rule", async () => {
    const { producerId } = await seedAgents({ producer: "model-a", reviewer: "model-a" });
    await expect(
      assertCrossModelReviewSatisfied(db, {
        policy: normalizeIssueExecutionPolicy({
          riskTier: "high",
          stages: [{ type: "review", participants: [{ type: "user", userId: "user-1" }] }],
        }),
        assigneeAgentId: producerId,
      }),
    ).resolves.toBeUndefined();

    await expect(
      assertCrossModelReviewSatisfied(db, {
        policy: normalizeIssueExecutionPolicy({ riskTier: "high", stages: [] }),
        assigneeAgentId: null,
      }),
    ).resolves.toBeUndefined();
  });
});
