import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const CLAIMED_AGENT_ID = "22222222-2222-4222-8222-222222222222";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
  canUser: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
}

function createRouteDb(contextSnapshot: Record<string, unknown> = {}, runId = "run-1", agentId = "agent-1") {
  const runRows = [{
    id: runId,
    companyId: "company-1",
    agentId,
    contextSnapshot,
  }];
  return {
    select: vi.fn((selection: Record<string, unknown> = {}) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) => resolve(
            Object.keys(selection).includes("contextSnapshot") ? runRows : [],
          ),
        })),
      })),
    })),
  } as any;
}

async function createAppWithActor(actor: Record<string, unknown>) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", approvalRoutes(createRouteDb()));
  app.use(errorHandler);
  return app;
}

function boardActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "board",
    userId: "user-1",
    companyIds: ["company-1"],
    source: "session",
    isInstanceAdmin: false,
    ...overrides,
  };
}

function agentActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "agent",
    agentId: "agent-1",
    companyId: "company-1",
    runId: "run-1",
    source: "api_key",
    isInstanceAdmin: false,
    ...overrides,
  };
}

function deprecationCalls() {
  return mockLogActivity.mock.calls.filter(
    ([, input]: [unknown, { action: string }]) =>
      input.action === "approval.attribution_body_claim_deprecated",
  );
}

describe("approval creation attribution", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockAccessService.canUser.mockResolvedValue(false);
    mockApprovalService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: "approval-1",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      payload: {},
      ...input,
    }));
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("attributes agent actors from their credential, ignoring a mismatched body claim", async () => {
    const res = await request(await createAppWithActor(agentActor()))
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        payload: {},
        requestedByAgentId: CLAIMED_AGENT_ID,
      });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ requestedByAgentId: "agent-1" }),
    );
    const flagged = deprecationCalls();
    expect(flagged).toHaveLength(1);
    expect(flagged[0][1].details).toMatchObject({
      bodyClaimedAgentId: CLAIMED_AGENT_ID,
      recordedAgentId: "agent-1",
    });
  });

  it("attributes agent actors silently when no body claim is sent", async () => {
    const res = await request(await createAppWithActor(agentActor()))
      .post("/api/companies/company-1/approvals")
      .send({ type: "request_board_approval", payload: {} });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ requestedByAgentId: "agent-1" }),
    );
    expect(deprecationCalls()).toHaveLength(0);
  });

  it("keeps a board body claim during the deprecation window but flags it", async () => {
    const res = await request(await createAppWithActor(boardActor()))
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        payload: {},
        requestedByAgentId: CLAIMED_AGENT_ID,
      });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        requestedByAgentId: CLAIMED_AGENT_ID,
        requestedByUserId: "user-1",
      }),
    );
    expect(mockAccessService.canUser).toHaveBeenCalledWith("company-1", "user-1", "approvals:attribute");
    const flagged = deprecationCalls();
    expect(flagged).toHaveLength(1);
    expect(flagged[0][1].details).toMatchObject({
      bodyClaimedAgentId: CLAIMED_AGENT_ID,
      recordedAgentId: CLAIMED_AGENT_ID,
      attributeGranted: false,
    });
  });

  it("records board approvals without body claims as unattributed, with no flag", async () => {
    const res = await request(await createAppWithActor(boardActor()))
      .post("/api/companies/company-1/approvals")
      .send({ type: "request_board_approval", payload: {} });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        requestedByAgentId: null,
        requestedByUserId: "user-1",
      }),
    );
    expect(deprecationCalls()).toHaveLength(0);
    expect(mockAccessService.canUser).not.toHaveBeenCalled();
  });
});
