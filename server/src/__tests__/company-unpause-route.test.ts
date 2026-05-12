import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockCompanyPortabilityService = vi.hoisted(() => ({
  exportBundle: vi.fn(),
  previewExport: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const mockFeedbackService = vi.hoisted(() => ({
  listFeedbackTraces: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  budgetService: () => mockBudgetService,
  companyPortabilityService: () => mockCompanyPortabilityService,
  companyService: () => mockCompanyService,
  feedbackService: () => mockFeedbackService,
  logActivity: mockLogActivity,
}));

interface FakeCompanyRow {
  id: string;
  pausedUntil: Date | null;
  pausedReason: string | null;
  pausedCanaryAt: Date | null;
}

function createFakeDb(rows: FakeCompanyRow[]) {
  const state = { rows: [...rows], updateCalls: [] as Array<{ values: Record<string, unknown> }> };
  const fakeDb = {
    select(_columns: unknown) {
      return {
        from(_table: unknown) {
          return {
            where(_predicate: unknown) {
              return {
                limit(_n: number) {
                  return {
                    // Return *clones* so production-style "SELECT then later
                    // UPDATE" semantics hold: mutating the row in the table
                    // must not retroactively change values that callers
                    // already read.
                    then(resolve: (rows: unknown[]) => unknown) {
                      const clones = state.rows.map((row) => ({ ...row }));
                      return Promise.resolve(resolve(clones));
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
    update(_table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          state.updateCalls.push({ values });
          // Apply the update to in-memory row(s) so subsequent reads see it.
          for (const row of state.rows) {
            if ("pausedUntil" in values) row.pausedUntil = values.pausedUntil as Date | null;
            if ("pausedReason" in values) row.pausedReason = values.pausedReason as string | null;
            if ("pausedCanaryAt" in values) row.pausedCanaryAt = values.pausedCanaryAt as Date | null;
          }
          return {
            where(_predicate: unknown) {
              return Promise.resolve(undefined);
            },
          };
        },
      };
    },
  };
  return { fakeDb, state };
}

async function createApp(
  actor: Record<string, unknown>,
  db: unknown,
) {
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/companies.js")>("../routes/companies.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/companies", companyRoutes(db as any));
  app.use(errorHandler);
  return app;
}

describe("POST /api/companies/:companyId/unpause", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/companies.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
  });

  it("allows a board user to clear paused_until/paused_reason/paused_canary_at", async () => {
    const before: FakeCompanyRow = {
      id: "company-1",
      pausedUntil: new Date("2026-05-12T13:00:00.000Z"),
      pausedReason: "claude_quota_exhausted:run-1",
      pausedCanaryAt: new Date("2026-05-12T12:55:00.000Z"),
    };
    const { fakeDb, state } = createFakeDb([before]);
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
        isInstanceAdmin: true,
      },
      fakeDb,
    );

    const res = await request(app)
      .post("/api/companies/company-1/unpause")
      .send({ reason: "emergency unpause" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, companyId: "company-1" });
    expect(typeof res.body.clearedAt).toBe("string");
    // All three columns must be NULL post-update.
    expect(state.rows[0]!.pausedUntil).toBeNull();
    expect(state.rows[0]!.pausedReason).toBeNull();
    expect(state.rows[0]!.pausedCanaryAt).toBeNull();
    // Audit log records previous values + actor.
    expect(mockLogActivity).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        companyId: "company-1",
        actorType: "user",
        actorId: "user-1",
        action: "company.quota_pause_cleared",
        entityType: "company",
        entityId: "company-1",
        details: expect.objectContaining({
          reason: "emergency unpause",
          previousPausedUntil: "2026-05-12T13:00:00.000Z",
          previousPausedReason: "claude_quota_exhausted:run-1",
          previousPausedCanaryAt: "2026-05-12T12:55:00.000Z",
        }),
      }),
    );
  });

  it("rejects agent-token callers with 403, leaves pause state untouched", async () => {
    const before: FakeCompanyRow = {
      id: "company-1",
      pausedUntil: new Date("2026-05-12T13:00:00.000Z"),
      pausedReason: "claude_quota_exhausted:run-1",
      pausedCanaryAt: new Date("2026-05-12T12:55:00.000Z"),
    };
    const { fakeDb, state } = createFakeDb([before]);
    const app = await createApp(
      {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        source: "agent_jwt",
      },
      fakeDb,
    );

    const res = await request(app)
      .post("/api/companies/company-1/unpause")
      .send({ reason: "agent attempt" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/human users/i);
    // No mutation must have occurred.
    expect(state.updateCalls).toHaveLength(0);
    expect(state.rows[0]!.pausedUntil?.toISOString()).toBe("2026-05-12T13:00:00.000Z");
    expect(state.rows[0]!.pausedReason).toBe("claude_quota_exhausted:run-1");
    expect(state.rows[0]!.pausedCanaryAt?.toISOString()).toBe("2026-05-12T12:55:00.000Z");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("returns 400 when reason is missing or empty", async () => {
    const { fakeDb, state } = createFakeDb([
      {
        id: "company-1",
        pausedUntil: null,
        pausedReason: null,
        pausedCanaryAt: null,
      },
    ]);
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
        isInstanceAdmin: true,
      },
      fakeDb,
    );

    const empty = await request(app).post("/api/companies/company-1/unpause").send({});
    expect(empty.status).toBe(400);

    const blank = await request(app).post("/api/companies/company-1/unpause").send({ reason: "   " });
    expect(blank.status).toBe(400);

    expect(state.updateCalls).toHaveLength(0);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
