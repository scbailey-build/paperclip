import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, companies, issues, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { evaluateActivationPreconditions } from "../services/agent-activation.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("activation precondition evaluation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-activation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(projects);
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

  it("treats absent or malformed preconditions as met", async () => {
    const companyId = await seedCompany();
    for (const runtimeConfig of [undefined, {}, { activationPreconditions: "nope" }, { activationPreconditions: [{ kind: "unknown" }] }]) {
      const result = await evaluateActivationPreconditions(db, { companyId, runtimeConfig });
      expect(result.met).toBe(true);
      expect(result.blockers).toHaveLength(0);
    }
  });

  it("blocks on min_rows until the data exists, honoring the status filter", async () => {
    const companyId = await seedCompany();
    const runtimeConfig = {
      activationPreconditions: [
        { kind: "min_rows", entity: "issues", status: "in_progress", min: 1 },
        { kind: "min_rows", entity: "projects", min: 1 },
      ],
    };

    const blocked = await evaluateActivationPreconditions(db, { companyId, runtimeConfig });
    expect(blocked.met).toBe(false);
    expect(blocked.blockers).toHaveLength(2);
    expect(blocked.blockers[0].description).toContain("in_progress");
    expect(blocked.blockers[0].actual).toBe(0);

    await db.insert(projects).values({ id: randomUUID(), companyId, name: "Growth" });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Backlog card",
      status: "backlog",
      priority: "medium",
      issueNumber: 1,
      identifier: "TST-1",
    });

    // Status filter still unmet: the only issue is backlog, not in_progress.
    const partial = await evaluateActivationPreconditions(db, { companyId, runtimeConfig });
    expect(partial.met).toBe(false);
    expect(partial.blockers).toHaveLength(1);
    expect(partial.blockers[0].entity).toBe("issues");

    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Active card",
      status: "in_progress",
      priority: "medium",
      issueNumber: 2,
      identifier: "TST-2",
    });

    const met = await evaluateActivationPreconditions(db, { companyId, runtimeConfig });
    expect(met.met).toBe(true);
    expect(met.blockers).toHaveLength(0);
  });

  it("scopes counts to the agent's company", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    await db.insert(projects).values({ id: randomUUID(), companyId: otherCompanyId, name: "Elsewhere" });

    const result = await evaluateActivationPreconditions(db, {
      companyId,
      runtimeConfig: { activationPreconditions: [{ kind: "min_rows", entity: "projects", min: 1 }] },
    });
    expect(result.met).toBe(false);
    expect(result.blockers[0].actual).toBe(0);
  });
});
