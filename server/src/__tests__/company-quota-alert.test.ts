import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  companyMemberships,
  createDb,
  issueLabels,
  issues,
  labels,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  QUOTA_PAUSE_ALERT_ACTIVITY_ACTION,
  QUOTA_PAUSE_ALERT_ORIGIN_KIND,
  fireCompanyQuotaPauseAlert,
  formatResetAtKST,
} from "../services/company-quota-alert.js";
import { resetMailerForTests } from "../services/mailer.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const SMTP_ENV_KEYS = [
  "PAPERCLIP_SMTP_HOST",
  "PAPERCLIP_SMTP_PORT",
  "PAPERCLIP_SMTP_USER",
  "PAPERCLIP_SMTP_PASS",
  "PAPERCLIP_SMTP_FROM",
] as const;

function snapshotSmtpEnv(): Partial<Record<(typeof SMTP_ENV_KEYS)[number], string | undefined>> {
  const snapshot: Partial<Record<(typeof SMTP_ENV_KEYS)[number], string | undefined>> = {};
  for (const key of SMTP_ENV_KEYS) snapshot[key] = process.env[key];
  return snapshot;
}

function restoreSmtpEnv(snapshot: Partial<Record<(typeof SMTP_ENV_KEYS)[number], string | undefined>>) {
  for (const key of SMTP_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearSmtpEnv() {
  for (const key of SMTP_ENV_KEYS) delete process.env[key];
}

async function createCompany(db: ReturnType<typeof createDb>, opts?: { notificationChannels?: unknown }) {
  return db
    .insert(companies)
    .values({
      name: `Quota Alert ${randomUUID()}`,
      issuePrefix: `QA${randomUUID().slice(0, 6).toUpperCase()}`,
      ...(opts?.notificationChannels !== undefined
        ? { notificationChannels: opts.notificationChannels as never }
        : {}),
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function addOwner(db: ReturnType<typeof createDb>, companyId: string, role: string = "owner") {
  return db
    .insert(companyMemberships)
    .values({
      companyId,
      principalType: "user",
      principalId: `${role}-${randomUUID()}`,
      status: "active",
      membershipRole: role,
    })
    .returning()
    .then((rows) => rows[0]!);
}

describeEmbeddedPostgres("fireCompanyQuotaPauseAlert", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let envSnapshot: ReturnType<typeof snapshotSmtpEnv>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-quota-alert-");
    db = createDb(tempDb.connectionString);
    envSnapshot = snapshotSmtpEnv();
  }, 20_000);

  beforeEach(() => {
    clearSmtpEnv();
    resetMailerForTests();
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueLabels);
    await db.delete(issues);
    await db.delete(labels);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    restoreSmtpEnv(envSnapshot);
    await tempDb?.cleanup();
  });

  describe("formatResetAtKST", () => {
    it("renders UTC reset moments as Asia/Seoul `YYYY-MM-DD HH:mm KST`", () => {
      // 2026-05-12 14:00:00 UTC = 2026-05-12 23:00 KST
      const formatted = formatResetAtKST(new Date(Date.UTC(2026, 4, 12, 14, 0, 0)));
      expect(formatted).toBe("2026-05-12 23:00 KST");
    });

    it("renders KST midnight as 00:00 (not 24:00)", () => {
      const formatted = formatResetAtKST(new Date(Date.UTC(2026, 4, 12, 15, 0, 0)));
      expect(formatted).toBe("2026-05-13 00:00 KST");
    });
  });

  it("creates a critical incident+quota issue assigned to the owner user", async () => {
    const company = await createCompany(db);
    const owner = await addOwner(db, company.id, "owner");
    const mailer = vi.fn(async () => ({ skipped: true, reason: "test-mailer" }));

    const resetAt = new Date(Date.UTC(2026, 4, 12, 14, 0, 0));
    const pausedUntil = new Date(resetAt.getTime() + 2 * 60_000);
    const runId = randomUUID();
    const pausedReason = `claude_quota_exhausted:${runId}`;
    const result = await fireCompanyQuotaPauseAlert({
      db,
      companyId: company.id,
      pausedUntil,
      pausedReason,
      runId,
      resetAt,
      signal: "out of extra usage",
      mailer,
    });

    expect(result.issueCreated).toBe(true);
    expect(result.ownerUserId).toBe(owner.principalId);
    expect(result.issueId).not.toBeNull();

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, result.issueId!))
      .then((rows) => rows[0]!);
    expect(issue.title).toContain("2026-05-12 23:00 KST");
    expect(issue.priority).toBe("critical");
    expect(issue.assigneeUserId).toBe(owner.principalId);
    expect(issue.originKind).toBe(QUOTA_PAUSE_ALERT_ORIGIN_KIND);
    expect(issue.originFingerprint).toBe(pausedReason);
    expect(issue.description).toContain("out of extra usage");
    expect(issue.description).toContain(runId);

    const attachedLabels = await db
      .select({ name: labels.name })
      .from(issueLabels)
      .innerJoin(labels, eq(issueLabels.labelId, labels.id))
      .where(eq(issueLabels.issueId, issue.id));
    expect(attachedLabels.map((row) => row.name).sort()).toEqual(["incident", "quota"]);
  });

  it("is idempotent on (origin_kind, origin_fingerprint) within a company", async () => {
    const company = await createCompany(db, {
      notificationChannels: { owner_alerts: { email: "owner@example.com" } },
    });
    await addOwner(db, company.id, "owner");
    const mailer = vi.fn(async () => ({ skipped: false }));
    const runId = randomUUID();
    const pausedReason = `claude_quota_exhausted:${runId}`;
    const baseInput = {
      db,
      companyId: company.id,
      pausedUntil: new Date(Date.now() + 5 * 60_000),
      pausedReason,
      runId,
      resetAt: new Date(Date.now() + 3 * 60_000),
      mailer,
    };

    const first = await fireCompanyQuotaPauseAlert(baseInput);
    const second = await fireCompanyQuotaPauseAlert(baseInput);

    expect(first.issueCreated).toBe(true);
    expect(second.issueCreated).toBe(false);
    expect(second.issueId).toBe(first.issueId);
    expect(second.emailSent).toBe(false);
    expect(second.emailSkippedReason).toBe("duplicate_fingerprint");
    expect(mailer).toHaveBeenCalledTimes(1);

    const allMatching = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, company.id),
          eq(issues.originKind, QUOTA_PAUSE_ALERT_ORIGIN_KIND),
          eq(issues.originFingerprint, pausedReason),
        ),
      );
    expect(allMatching).toHaveLength(1);
  });

  it("sends email when notification_channels.owner_alerts.email and SMTP env are both set", async () => {
    const company = await createCompany(db, {
      notificationChannels: { owner_alerts: { email: "owner@example.com" } },
    });
    await addOwner(db, company.id, "owner");
    const mailer = vi.fn(async () => ({ skipped: false }));

    const runId = randomUUID();
    const result = await fireCompanyQuotaPauseAlert({
      db,
      companyId: company.id,
      pausedUntil: new Date(Date.now() + 5 * 60_000),
      pausedReason: `claude_quota_exhausted:${runId}`,
      runId,
      resetAt: new Date(Date.now() + 3 * 60_000),
      mailer,
    });

    expect(result.emailSent).toBe(true);
    expect(result.emailSkippedReason).toBeNull();
    expect(mailer).toHaveBeenCalledTimes(1);
    const mailCall = mailer.mock.calls[0]![0];
    expect(mailCall.to).toBe("owner@example.com");
    expect(mailCall.subject).toContain("[ALERT] Claude 한도 소진");
    expect(mailCall.text).toContain(runId);
  });

  it("skips email but still creates the issue when owner_alerts.email is unset", async () => {
    const company = await createCompany(db, {
      notificationChannels: { owner_alerts: {} },
    });
    await addOwner(db, company.id, "owner");
    const mailer = vi.fn(async () => ({ skipped: false }));

    const runId = randomUUID();
    const result = await fireCompanyQuotaPauseAlert({
      db,
      companyId: company.id,
      pausedUntil: new Date(Date.now() + 5 * 60_000),
      pausedReason: `claude_quota_exhausted:${runId}`,
      runId,
      resetAt: new Date(Date.now() + 3 * 60_000),
      mailer,
    });

    expect(result.issueCreated).toBe(true);
    expect(result.emailSent).toBe(false);
    expect(result.emailSkippedReason).toBe("no_owner_email_configured");
    expect(mailer).not.toHaveBeenCalled();
  });

  it("skips email but still creates the issue when the mailer reports skipped", async () => {
    const company = await createCompany(db, {
      notificationChannels: { owner_alerts: { email: "owner@example.com" } },
    });
    await addOwner(db, company.id, "owner");
    const mailer = vi.fn(async () => ({ skipped: true, reason: "smtp_env_missing:PAPERCLIP_SMTP_HOST" }));

    const runId = randomUUID();
    const result = await fireCompanyQuotaPauseAlert({
      db,
      companyId: company.id,
      pausedUntil: new Date(Date.now() + 5 * 60_000),
      pausedReason: `claude_quota_exhausted:${runId}`,
      runId,
      resetAt: new Date(Date.now() + 3 * 60_000),
      mailer,
    });

    expect(result.issueCreated).toBe(true);
    expect(result.emailSent).toBe(false);
    expect(result.emailSkippedReason).toBe("smtp_env_missing:PAPERCLIP_SMTP_HOST");
  });

  it("creates an unassigned backlog issue and warns when no active owner exists", async () => {
    const company = await createCompany(db);
    // intentionally no membership
    const mailer = vi.fn(async () => ({ skipped: true }));

    const runId = randomUUID();
    const result = await fireCompanyQuotaPauseAlert({
      db,
      companyId: company.id,
      pausedUntil: new Date(Date.now() + 5 * 60_000),
      pausedReason: `claude_quota_exhausted:${runId}`,
      runId,
      resetAt: new Date(Date.now() + 3 * 60_000),
      mailer,
    });

    expect(result.issueCreated).toBe(true);
    expect(result.ownerUserId).toBeNull();
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, result.issueId!))
      .then((rows) => rows[0]!);
    expect(issue.assigneeUserId).toBeNull();
    expect(issue.status).toBe("backlog");
  });

  it("prefers a membership with role=owner over a non-owner member when both are active", async () => {
    const company = await createCompany(db);
    const memberCreatedFirst = await addOwner(db, company.id, "member");
    const ownerCreatedSecond = await addOwner(db, company.id, "owner");
    expect(new Date(memberCreatedFirst.createdAt).getTime()).toBeLessThanOrEqual(
      new Date(ownerCreatedSecond.createdAt).getTime(),
    );
    const mailer = vi.fn(async () => ({ skipped: true }));

    const runId = randomUUID();
    const result = await fireCompanyQuotaPauseAlert({
      db,
      companyId: company.id,
      pausedUntil: new Date(Date.now() + 5 * 60_000),
      pausedReason: `claude_quota_exhausted:${runId}`,
      runId,
      resetAt: new Date(Date.now() + 3 * 60_000),
      mailer,
    });

    expect(result.ownerUserId).toBe(ownerCreatedSecond.principalId);
  });

  it("appends an activity_log row capturing the alert outcome (SOP-001 §6 data flow)", async () => {
    const company = await createCompany(db, {
      notificationChannels: { owner_alerts: { email: "owner@example.com" } },
    });
    await addOwner(db, company.id, "owner");
    const mailer = vi.fn(async () => ({ skipped: false }));

    const runId = randomUUID();
    const pausedReason = `claude_quota_exhausted:${runId}`;
    const result = await fireCompanyQuotaPauseAlert({
      db,
      companyId: company.id,
      pausedUntil: new Date(Date.now() + 5 * 60_000),
      pausedReason,
      runId,
      resetAt: new Date(Date.now() + 3 * 60_000),
      mailer,
    });

    const rows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, company.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe(QUOTA_PAUSE_ALERT_ACTIVITY_ACTION);
    const details = rows[0]!.details as Record<string, unknown>;
    expect(details.issueId).toBe(result.issueId);
    expect(details.emailSent).toBe(true);
    expect(details.runId).toBe(runId);
    expect(details.pausedReason).toBe(pausedReason);
  });
});
