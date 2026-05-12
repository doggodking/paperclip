import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  CANARY_PHASE_MS,
  evaluateCanaryGate,
} from "../services/company-quota-canary.js";
import { applyCompanyQuotaPause } from "../services/company-quota-pause.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createCompany(db: ReturnType<typeof createDb>) {
  return db
    .insert(companies)
    .values({
      name: `Canary ${randomUUID()}`,
      issuePrefix: `QC${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(
  db: ReturnType<typeof createDb>,
  companyId: string,
  role: string,
  opts: { lastHeartbeatAt?: Date | null; name?: string } = {},
) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: opts.name ?? `${role}-${randomUUID().slice(0, 6)}`,
      role,
      lastHeartbeatAt: opts.lastHeartbeatAt ?? null,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function readPauseState(db: ReturnType<typeof createDb>, companyId: string) {
  return db
    .select({
      pausedUntil: companies.pausedUntil,
      pausedReason: companies.pausedReason,
      pausedCanaryAt: companies.pausedCanaryAt,
    })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0]!);
}

describeEmbeddedPostgres("company quota-pause canary (ADR-001 D4)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-quota-canary-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  describe("evaluateCanaryGate", () => {
    it("enters canary when paused_until expired + paused_canary_at NULL: only HRManager allowed, others skipped", async () => {
      const company = await createCompany(db);
      const hr = await createAgent(db, company.id, "hr_manager");
      const ceo = await createAgent(db, company.id, "ceo");
      const coder = await createAgent(db, company.id, "engineer");

      const past = new Date(Date.now() - 60_000);
      await db
        .update(companies)
        .set({ pausedUntil: past, pausedReason: "claude_quota_exhausted:run-1" })
        .where(eq(companies.id, company.id));

      const now = new Date();
      const hrGate = await evaluateCanaryGate(db, company.id, hr.id, now);
      expect(hrGate).toEqual({ decision: "allow", reason: "canary_probe" });
      // After the first call, paused_canary_at must be latched.
      const stateAfterEntry = await readPauseState(db, company.id);
      expect(stateAfterEntry.pausedCanaryAt).not.toBeNull();

      const ceoGate = await evaluateCanaryGate(db, company.id, ceo.id, now);
      expect(ceoGate).toEqual({ decision: "skip", reason: "canary_other_agent_only" });

      const coderGate = await evaluateCanaryGate(db, company.id, coder.id, now);
      expect(coderGate).toEqual({ decision: "skip", reason: "canary_other_agent_only" });
    });

    it("during canary <5min: HRManager allowed, all others skipped", async () => {
      const company = await createCompany(db);
      const hr = await createAgent(db, company.id, "hr_manager");
      const ceo = await createAgent(db, company.id, "ceo");
      const coder = await createAgent(db, company.id, "engineer");

      const past = new Date(Date.now() - 10 * 60_000);
      const canaryStart = new Date(Date.now() - 2 * 60_000); // 2 minutes ago
      await db
        .update(companies)
        .set({
          pausedUntil: past,
          pausedReason: "claude_quota_exhausted:run-1",
          pausedCanaryAt: canaryStart,
        })
        .where(eq(companies.id, company.id));

      const now = new Date();
      const hrGate = await evaluateCanaryGate(db, company.id, hr.id, now);
      expect(hrGate).toEqual({ decision: "allow", reason: "canary_probe" });

      const ceoGate = await evaluateCanaryGate(db, company.id, ceo.id, now);
      expect(ceoGate).toEqual({ decision: "skip", reason: "canary_other_agent_only" });

      const coderGate = await evaluateCanaryGate(db, company.id, coder.id, now);
      expect(coderGate).toEqual({ decision: "skip", reason: "canary_other_agent_only" });
    });

    it(">=5min elapsed + canary HR run started + paused_until expired → clear pause, full resume", async () => {
      const company = await createCompany(db);
      const canaryStart = new Date(Date.now() - 6 * 60_000); // 6 minutes ago
      // HR's heartbeat fired after canary_at — i.e., HR canary ran
      const hr = await createAgent(db, company.id, "hr_manager", {
        lastHeartbeatAt: new Date(canaryStart.getTime() + 30_000),
      });
      const coder = await createAgent(db, company.id, "engineer");

      const past = new Date(Date.now() - 10 * 60_000);
      await db
        .update(companies)
        .set({
          pausedUntil: past,
          pausedReason: "claude_quota_exhausted:run-1",
          pausedCanaryAt: canaryStart,
        })
        .where(eq(companies.id, company.id));

      const now = new Date();
      const gate = await evaluateCanaryGate(db, company.id, coder.id, now);
      expect(gate.decision).toBe("allow");
      expect(gate.reason).toBe("canary_success");

      const state = await readPauseState(db, company.id);
      expect(state.pausedUntil).toBeNull();
      expect(state.pausedReason).toBeNull();
      expect(state.pausedCanaryAt).toBeNull();

      // Subsequent calls all pass through.
      const hrAgain = await evaluateCanaryGate(db, company.id, hr.id, now);
      expect(hrAgain).toEqual({ decision: "allow", reason: "no_pause" });
    });

    it("canary failure: applyCompanyQuotaPause with conservativeOnCanaryMs widens paused_until by +30min, paused_canary_at preserved", async () => {
      const company = await createCompany(db);
      const hr = await createAgent(db, company.id, "hr_manager", {
        lastHeartbeatAt: new Date(Date.now() - 60_000),
      });
      const canaryStart = new Date(Date.now() - 2 * 60_000);
      await db
        .update(companies)
        .set({
          pausedUntil: new Date(Date.now() - 60_000),
          pausedReason: "claude_quota_exhausted:run-1",
          pausedCanaryAt: canaryStart,
        })
        .where(eq(companies.id, company.id));

      // Simulate the post-run hook firing again with a near reset time (1 min ahead).
      const tCallStart = Date.now();
      const resetAt = new Date(tCallStart + 60_000);
      const pauseResult = await applyCompanyQuotaPause({
        db,
        companyId: company.id,
        resetAt,
        runId: "run-2-canary-fail",
        conservativeOnCanaryMs: 30 * 60 * 1000,
      });
      const tCallEnd = Date.now();

      expect(pauseResult.applied).toBe(true);
      expect(pauseResult.conservativeApplied).toBe(true);
      // resetAt + 2min grace = ~3min ahead; conservative = ~30min ahead.
      // The widened pausedUntil should be ≥30min from when applyCompanyQuotaPause
      // was called, and strictly larger than the reset+grace baseline.
      const minExpected = tCallStart + 30 * 60 * 1000;
      const maxExpected = tCallEnd + 30 * 60 * 1000 + 1000;
      expect(pauseResult.pausedUntil.getTime()).toBeGreaterThanOrEqual(minExpected);
      expect(pauseResult.pausedUntil.getTime()).toBeLessThanOrEqual(maxExpected);

      const state = await readPauseState(db, company.id);
      // paused_canary_at must be preserved per ADR-001 D4.
      expect(state.pausedCanaryAt?.getTime()).toBe(canaryStart.getTime());
      // Evaluating the canary gate while we're inside the freshly-extended
      // window must skip wakes (in_pause_window), not clear.
      const now = new Date(pauseResult.pausedUntil.getTime() - 60_000);
      const gate = await evaluateCanaryGate(db, company.id, hr.id, now);
      expect(gate).toEqual({ decision: "skip", reason: "in_pause_window" });
    });

    it("HRManager fails to start within 5min → CEO fallback gets the canary turn", async () => {
      const company = await createCompany(db);
      // HR exists but hasn't heartbeat since canary_at
      const hr = await createAgent(db, company.id, "hr_manager", {
        lastHeartbeatAt: new Date(Date.now() - 60 * 60_000),
      });
      const ceo = await createAgent(db, company.id, "ceo", {
        lastHeartbeatAt: new Date(Date.now() - 60 * 60_000),
      });
      const coder = await createAgent(db, company.id, "engineer");

      // canary_at set ~6min ago — past HR's 5-min phase, into CEO's phase
      const canaryStart = new Date(Date.now() - (CANARY_PHASE_MS + 60_000));
      const past = new Date(Date.now() - 30 * 60_000);
      await db
        .update(companies)
        .set({
          pausedUntil: past,
          pausedReason: "claude_quota_exhausted:run-1",
          pausedCanaryAt: canaryStart,
        })
        .where(eq(companies.id, company.id));

      const now = new Date();
      const ceoGate = await evaluateCanaryGate(db, company.id, ceo.id, now);
      expect(ceoGate).toEqual({ decision: "allow", reason: "canary_probe" });

      const hrGate = await evaluateCanaryGate(db, company.id, hr.id, now);
      expect(hrGate).toEqual({ decision: "skip", reason: "canary_other_agent_only" });

      const coderGate = await evaluateCanaryGate(db, company.id, coder.id, now);
      expect(coderGate).toEqual({ decision: "skip", reason: "canary_other_agent_only" });
    });
  });

  describe("evaluateCanaryGate — passthrough", () => {
    it("returns allow/no_pause when company has never been paused", async () => {
      const company = await createCompany(db);
      const agent = await createAgent(db, company.id, "engineer");
      const gate = await evaluateCanaryGate(db, company.id, agent.id);
      expect(gate).toEqual({ decision: "allow", reason: "no_pause" });
    });

    it("skips every wake while paused_until is in the future and canary hasn't started", async () => {
      const company = await createCompany(db);
      const agent = await createAgent(db, company.id, "engineer");
      const future = new Date(Date.now() + 10 * 60_000);
      await db
        .update(companies)
        .set({ pausedUntil: future, pausedReason: "claude_quota_exhausted:run-1" })
        .where(eq(companies.id, company.id));
      const gate = await evaluateCanaryGate(db, company.id, agent.id);
      expect(gate).toEqual({ decision: "skip", reason: "in_pause_window" });
    });
  });
});
