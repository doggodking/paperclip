import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companies,
  companyMemberships,
  issues,
  labels,
  type CompanyNotificationChannels,
} from "@paperclipai/db";
import { issueService } from "./issues.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";
import { sendOwnerAlertEmail } from "./mailer.js";

/**
 * ADR-001 D5 (P-3) — owner alert fired when a company crosses into a
 * `paused_until` window due to a Claude quota exhaustion. Emits up to three
 * side effects, each guarded so the others can still run on failure:
 *
 *  1. A `critical`/`incident`+`quota` Paperclip issue, assigned to the company
 *     owner user (when one exists). Idempotent via
 *     `origin_kind = 'quota_pause_alert'` + `origin_fingerprint = pausedReason`
 *     (the run id is embedded in pausedReason already), so reentry of the same
 *     hook does not double-create.
 *  2. An owner-alert email if `companies.notification_channels.owner_alerts.email`
 *     is set AND the SMTP env (host/port/user/pass/from) is configured. Missing
 *     either side ➜ graceful degradation: warn-log and skip.
 *  3. An `activity_log` row (`action = 'company.quota_pause_alert'`) so the
 *     SOP-001 §6 daily report can stitch "한도 도달 이벤트" without a separate
 *     event table.
 */

export const QUOTA_PAUSE_ALERT_ORIGIN_KIND = "quota_pause_alert";
export const QUOTA_PAUSE_ALERT_ACTIVITY_ACTION = "company.quota_pause_alert";
const QUOTA_INCIDENT_LABEL_NAMES = ["incident", "quota"] as const;
const QUOTA_INCIDENT_LABEL_COLOR = "#dc2626";

export interface FireCompanyQuotaPauseAlertInput {
  db: Db;
  companyId: string;
  pausedUntil: Date;
  pausedReason: string;
  runId: string;
  resetAt: Date;
  signal?: string | null;
  /**
   * Test seam — replaces the default nodemailer-backed transport. Production
   * code paths must omit this so SMTP env vars take effect.
   */
  mailer?: (input: {
    to: string;
    from: string;
    subject: string;
    text: string;
  }) => Promise<{ skipped: boolean; reason?: string }>;
}

export interface FireCompanyQuotaPauseAlertResult {
  issueId: string | null;
  issueCreated: boolean;
  emailSent: boolean;
  emailSkippedReason: string | null;
  ownerUserId: string | null;
}

/**
 * Renders the reset moment as `YYYY-MM-DD HH:mm KST` using Intl, so the
 * automated issue/email subject lands in the owner's expected timezone
 * regardless of host clock settings.
 */
export function formatResetAtKST(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const lookup = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const hour = lookup("hour") === "24" ? "00" : lookup("hour");
  return `${lookup("year")}-${lookup("month")}-${lookup("day")} ${hour}:${lookup("minute")} KST`;
}

function parseNotificationChannels(value: unknown): CompanyNotificationChannels {
  if (!value || typeof value !== "object") return {};
  return value as CompanyNotificationChannels;
}

async function resolveOwnerUserId(db: Db, companyId: string): Promise<string | null> {
  const rows = await db
    .select({
      principalId: companyMemberships.principalId,
      membershipRole: companyMemberships.membershipRole,
      createdAt: companyMemberships.createdAt,
    })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
      ),
    )
    .orderBy(asc(companyMemberships.createdAt), asc(companyMemberships.id));
  if (rows.length === 0) return null;
  const owner = rows.find((row) => row.membershipRole === "owner");
  return (owner ?? rows[0]).principalId;
}

async function ensureLabelIds(
  db: Db,
  companyId: string,
  names: ReadonlyArray<string>,
): Promise<string[]> {
  const trimmed = names.map((name) => name.trim()).filter((name) => name.length > 0);
  if (trimmed.length === 0) return [];
  const ids: string[] = [];
  for (const name of trimmed) {
    const existing = await db
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.companyId, companyId), eq(labels.name, name)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    try {
      const [created] = await db
        .insert(labels)
        .values({ companyId, name, color: QUOTA_INCIDENT_LABEL_COLOR })
        .returning({ id: labels.id });
      ids.push(created.id);
    } catch {
      // Race with a parallel writer of the same (companyId, name) — fetch the
      // row that won and reuse it. labels has a unique (company_id, name) idx.
      const raced = await db
        .select({ id: labels.id })
        .from(labels)
        .where(and(eq(labels.companyId, companyId), eq(labels.name, name)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (raced) ids.push(raced.id);
    }
  }
  return ids;
}

function buildAlertTitle(resetAt: Date): string {
  return `[ALERT] Claude 한도 소진 — KST ${formatResetAtKST(resetAt)}까지 회사 정지`;
}

function buildAlertBody(input: {
  pausedReason: string;
  pausedUntil: Date;
  resetAt: Date;
  runId: string;
  signal: string | null;
}): string {
  const lines = [
    "## 한도 자동 정지 알림",
    "",
    "회사가 Claude 한도 소진으로 자동 정지되었습니다 (ADR-001 D3 가드 발화).",
    "",
    "### 상세",
    `- 사유 (\`paused_reason\`): \`${input.pausedReason}\``,
    `- 시그널: ${input.signal ? `\`${input.signal}\`` : "_미보고_"}`,
    `- 실패 run id: \`${input.runId}\``,
    `- paused_until (UTC): \`${input.pausedUntil.toISOString()}\``,
    `- paused_until (KST): \`${formatResetAtKST(input.pausedUntil)}\``,
    `- 어댑터 reset_at (UTC): \`${input.resetAt.toISOString()}\``,
    `- 어댑터 reset_at (KST): \`${formatResetAtKST(input.resetAt)}\``,
    "",
    "### 카나리 일정",
    "`paused_until` 만료 직후 첫 run이 P-2 canary probe로 진입합니다. 별도 조치 불필요.",
    "",
    "### 긴급 무력화",
    "```sql",
    "UPDATE companies SET paused_until = NULL, paused_reason = NULL WHERE id = '<companyId>';",
    "```",
    "",
    "정책 근거: ADR-001 한도 가드 (P-1 D3, P-3 D5).",
  ];
  return lines.join("\n");
}

function bodyToPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?|```/g, ""))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "- ")
    .trim();
}

export async function fireCompanyQuotaPauseAlert(
  input: FireCompanyQuotaPauseAlertInput,
): Promise<FireCompanyQuotaPauseAlertResult> {
  const { db, companyId, pausedUntil, pausedReason, runId, resetAt } = input;
  const signal = input.signal ?? null;

  const existing = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, QUOTA_PAUSE_ALERT_ORIGIN_KIND),
        eq(issues.originFingerprint, pausedReason),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (existing) {
    return {
      issueId: existing.id,
      issueCreated: false,
      emailSent: false,
      emailSkippedReason: "duplicate_fingerprint",
      ownerUserId: null,
    };
  }

  const companyRow = await db
    .select({
      id: companies.id,
      notificationChannels: companies.notificationChannels,
    })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!companyRow) {
    logger.warn(
      { companyId, runId },
      "Skipping quota pause alert: company row missing",
    );
    return {
      issueId: null,
      issueCreated: false,
      emailSent: false,
      emailSkippedReason: "company_missing",
      ownerUserId: null,
    };
  }

  const channels = parseNotificationChannels(companyRow.notificationChannels);
  const ownerAlertChannel = channels.owner_alerts ?? {};
  const ownerUserId = await resolveOwnerUserId(db, companyId);
  if (!ownerUserId) {
    logger.warn(
      { companyId, runId },
      "Quota pause alert: no active owner user found; creating unassigned issue",
    );
  }

  const labelIds = await ensureLabelIds(db, companyId, QUOTA_INCIDENT_LABEL_NAMES);
  const title = buildAlertTitle(resetAt);
  const body = buildAlertBody({ pausedReason, pausedUntil, resetAt, runId, signal });

  let createdIssueId: string | null = null;
  try {
    const created = await issueService(db).create(companyId, {
      title,
      description: body,
      status: ownerUserId ? "todo" : "backlog",
      priority: "critical",
      assigneeUserId: ownerUserId ?? null,
      parentId: ownerAlertChannel.issue_parent_id ?? null,
      originKind: QUOTA_PAUSE_ALERT_ORIGIN_KIND,
      originId: runId,
      originRunId: runId,
      originFingerprint: pausedReason,
      labelIds,
    });
    createdIssueId = created.id;
  } catch (error) {
    logger.error(
      { err: error, companyId, runId },
      "Quota pause alert: failed to create critical issue",
    );
    throw error;
  }

  let emailSent = false;
  let emailSkippedReason: string | null = null;
  const ownerEmail = ownerAlertChannel.email?.trim();
  if (!ownerEmail) {
    emailSkippedReason = "no_owner_email_configured";
  } else {
    try {
      const mailer = input.mailer ?? sendOwnerAlertEmail;
      const outcome = await mailer({
        to: ownerEmail,
        // sendOwnerAlertEmail ignores `from` (SMTP env supplies it). The field
        // stays in the contract for the test seam.
        from: "",
        subject: title,
        text: bodyToPlainText(body),
      });
      if (outcome.skipped) {
        emailSkippedReason = outcome.reason ?? "mailer_skipped";
      } else {
        emailSent = true;
      }
    } catch (error) {
      logger.warn(
        { err: error, companyId, runId },
        "Quota pause alert: SMTP send failed; continuing with issue-only alert",
      );
      emailSkippedReason = "send_error";
    }
  }

  // Note: we keep runId in `details` rather than activity_log.run_id so the
  // alert is not coupled to the heartbeat_runs FK; that lets backfill /
  // replay tools insert quota alert rows without first reconstructing run
  // records, and avoids a CASCADE-on-delete tying alert history to run rows.
  await logActivity(db, {
    companyId,
    actorType: "system",
    actorId: "company-quota-alert",
    action: QUOTA_PAUSE_ALERT_ACTIVITY_ACTION,
    entityType: "company",
    entityId: companyId,
    details: {
      pausedUntil: pausedUntil.toISOString(),
      pausedReason,
      resetAt: resetAt.toISOString(),
      runId,
      issueId: createdIssueId,
      emailSent,
      emailSkippedReason,
      signal,
    },
  });

  return {
    issueId: createdIssueId,
    issueCreated: createdIssueId !== null,
    emailSent,
    emailSkippedReason,
    ownerUserId,
  };
}
