import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ADR-008 §C.4 promises that mentions in alert-issue traffic fan out via the
// standard mention notification pipeline. The route-level POST/PATCH handlers
// are the only place that actually resolves @-mentions and emits
// heartbeat.wakeup(reason="issue_comment_mentioned"). DOGAA-2658 asks for an
// integration test that proves the fan-out wire-up is live so we catch a
// silent regression before the first production breach.

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const ASSIGNEE_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const MENTIONED_AGENT_ID = "33333333-3333-4333-8333-333333333333";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  getDependencyReadiness: vi.fn(),
  findMentionedAgents: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  getRelationSummaries: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(async () => []),
  saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: {
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    },
  })),
  listCompanyIds: vi.fn(async () => ["company-1"]),
}));

const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));

const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));

const mockIssueTreeControlService = vi.hoisted(() => ({
  getActivePauseHoldGate: vi.fn(async () => null),
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/feedback.js", () => ({
  feedbackService: () => mockFeedbackService,
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => mockHeartbeatService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../services/routines.js", () => ({
  routineService: () => mockRoutineService,
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => mockFeedbackService,
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => mockIssueThreadInteractionService,
  issueTreeControlService: () => mockIssueTreeControlService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => mockRoutineService,
  workProductService: () => ({}),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  return app;
}

async function installActor(app: express.Express, actor?: Record<string, unknown>) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    status: "in_progress",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: ASSIGNEE_AGENT_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-2658",
    title: "Rate-limit alert thread",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

async function waitForWakeup(assertion: () => void) {
  await vi.waitFor(assertion);
}

describe.sequential("ADR-008 mention fan-out via comment routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.addComment.mockReset();
    mockIssueService.getDependencyReadiness.mockReset();
    mockIssueService.findMentionedAgents.mockReset();
    mockIssueService.listWakeableBlockedDependents.mockReset();
    mockIssueService.getWakeableParentAfterChildCompletion.mockReset();
    mockIssueService.getRelationSummaries.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockAccessService.canUser.mockReset();
    mockAccessService.hasPermission.mockReset();
    mockHeartbeatService.wakeup.mockReset();
    mockHeartbeatService.reportRunActivity.mockReset();
    mockHeartbeatService.getRun.mockReset();
    mockHeartbeatService.getActiveRunForAgent.mockReset();
    mockHeartbeatService.cancelRun.mockReset();
    mockAgentService.getById.mockReset();
    mockAgentService.list.mockReset();
    mockAgentService.resolveByReference.mockReset();
    mockLogActivity.mockReset();
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockLogActivity.mockResolvedValue(undefined);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: ISSUE_ID,
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      allBlockersDone: true,
      isDependencyReady: true,
    });
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAgentService.getById.mockResolvedValue(null);
    mockAgentService.list.mockResolvedValue([]);
    mockAgentService.resolveByReference.mockImplementation(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: { id: raw },
    }));
  });

  it("fans out a heartbeat wakeup to a mentioned agent when a board user posts a comment", async () => {
    const issue = makeIssue();
    const commentBody = `Investigate this. [@Reviewer](agent://${MENTIONED_AGENT_ID})`;
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-mention-1",
      issueId: ISSUE_ID,
      companyId: "company-1",
      body: commentBody,
      authorType: "user",
      authorAgentId: null,
      authorUserId: "local-board",
      presentation: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);

    const res = await request(await installActor(createApp()))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: commentBody });

    expect(res.status).toBe(201);
    expect(mockIssueService.findMentionedAgents).toHaveBeenCalledWith("company-1", commentBody);
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      MENTIONED_AGENT_ID,
      expect.objectContaining({
        source: "automation",
        reason: "issue_comment_mentioned",
        payload: expect.objectContaining({
          issueId: ISSUE_ID,
          commentId: "comment-mention-1",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: ISSUE_ID,
          taskId: ISSUE_ID,
          commentId: "comment-mention-1",
          wakeCommentId: "comment-mention-1",
          wakeReason: "issue_comment_mentioned",
          source: "comment.mention",
        }),
      }),
    ));
  });

  it("fans out a mention wakeup attached to a PATCH-with-comment update", async () => {
    const issue = makeIssue();
    const commentBody = `cc [@Reviewer](agent://${MENTIONED_AGENT_ID}) please review`;
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue(issue);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-mention-2",
      issueId: ISSUE_ID,
      companyId: "company-1",
      body: commentBody,
      authorType: "user",
      authorAgentId: null,
      authorUserId: "local-board",
      presentation: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);

    const res = await request(await installActor(createApp()))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ comment: commentBody });

    expect(res.status).toBe(200);
    expect(mockIssueService.findMentionedAgents).toHaveBeenCalledWith("company-1", commentBody);
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      MENTIONED_AGENT_ID,
      expect.objectContaining({
        reason: "issue_comment_mentioned",
        payload: expect.objectContaining({
          issueId: ISSUE_ID,
          commentId: "comment-mention-2",
        }),
        contextSnapshot: expect.objectContaining({
          wakeReason: "issue_comment_mentioned",
          source: "comment.mention",
          commentId: "comment-mention-2",
          wakeCommentId: "comment-mention-2",
        }),
      }),
    ));
  });

  it("does not fan out a mention wakeup back to the mentioning agent itself", async () => {
    const issue = makeIssue();
    const commentBody = `self-note [@Self](agent://${MENTIONED_AGENT_ID})`;
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-mention-3",
      issueId: ISSUE_ID,
      companyId: "company-1",
      body: commentBody,
      authorType: "agent",
      authorAgentId: MENTIONED_AGENT_ID,
      authorUserId: null,
      presentation: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);

    const res = await request(await installActor(createApp(), {
      type: "agent",
      agentId: MENTIONED_AGENT_ID,
      companyId: "company-1",
      source: "agent_key",
      runId: null,
    }))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: commentBody });

    expect(res.status).toBe(201);
    // Allow the fire-and-forget wakeup block to settle, then assert no mention
    // wake was queued for the author. The issue assignee is the same agent in
    // this fixture, so the comment-wake skip logic also applies — the net
    // expectation is that wakeup was never called for the self-mention case.
    await new Promise((resolve) => setImmediate(resolve));
    const selfMentionCalls = mockHeartbeatService.wakeup.mock.calls.filter(
      ([targetAgentId, payload]) =>
        targetAgentId === MENTIONED_AGENT_ID && (payload as { reason: string }).reason === "issue_comment_mentioned",
    );
    expect(selfMentionCalls).toHaveLength(0);
  });
});
