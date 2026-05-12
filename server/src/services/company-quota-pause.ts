import { and, eq, isNotNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { HttpError } from "../errors.js";

const DEFAULT_GRACE_MS = 2 * 60 * 1000;

/**
 * Thrown when a company is currently under a quota-driven auto-pause window
 * (`companies.paused_until > now()`). HTTP 503 so the API and dispatcher both
 * surface the same status to callers.
 */
export class CompanyPausedError extends HttpError {
  readonly pausedUntil: Date;
  readonly pausedReason: string | null;

  constructor(pausedUntil: Date, pausedReason: string | null) {
    super(
      503,
      pausedReason
        ? `Company is paused until ${pausedUntil.toISOString()} (${pausedReason}).`
        : `Company is paused until ${pausedUntil.toISOString()}.`,
      { pausedUntil: pausedUntil.toISOString(), pausedReason },
    );
    this.pausedUntil = pausedUntil;
    this.pausedReason = pausedReason;
  }
}

/**
 * Reads `companies.paused_until` and throws `CompanyPausedError` if the pause
 * window is still active. Used by the heartbeat dispatcher, the issue checkout
 * route, and the agent-token auth middleware to short-circuit work for a paused
 * company in a single place (ADR-001 D3). The middleware MUST only apply this
 * to agent tokens — human user requests bypass the gate so a manual unpause is
 * always possible.
 */
export async function assertCompanyNotPaused(
  db: Db,
  companyId: string,
  now: Date = new Date(),
): Promise<void> {
  const rows = await db
    .select({
      pausedUntil: companies.pausedUntil,
      pausedReason: companies.pausedReason,
    })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);

  const row = rows[0];
  if (!row?.pausedUntil) return;
  if (row.pausedUntil.getTime() <= now.getTime()) return;
  throw new CompanyPausedError(row.pausedUntil, row.pausedReason ?? null);
}

export interface ApplyCompanyQuotaPauseInput {
  db: Db;
  companyId: string;
  /** Reset moment reported by the adapter (e.g. Claude's `resets HH:MM`). */
  resetAt: Date;
  /** Run id that triggered the pause, embedded into `paused_reason` for audit. */
  runId: string;
  /** Extra wall-clock buffer beyond the reset moment. Defaults to 2 minutes per ADR-001 D3. */
  graceMs?: number;
  /**
   * ADR-001 D4 — when the company is currently in the canary probe window
   * (`paused_canary_at IS NOT NULL`), widen `paused_until` to at least
   * `now + conservativeOnCanaryMs` so a back-to-back quota failure cannot land
   * on a too-narrow reset window. `paused_canary_at` itself is left intact so
   * the canary latch still triggers a single probe at the next expiry.
   */
  conservativeOnCanaryMs?: number;
}

export interface ApplyCompanyQuotaPauseResult {
  applied: boolean;
  pausedUntil: Date;
  pausedReason: string;
  /** True when the conservative-on-canary widening kicked in (ADR-001 D4). */
  conservativeApplied: boolean;
}

/**
 * Sets `paused_until` and `paused_reason` on the company in one statement,
 * keyed on the new `pausedUntil` only being later than the current one (so
 * concurrent quota signals don't shorten an existing pause window). ADR-001 D3.
 *
 * When the company is in the canary probe window
 * (`paused_canary_at IS NOT NULL`) and `conservativeOnCanaryMs` is supplied,
 * the new `paused_until` is widened to `max(resetAt + grace, now + conservative)`
 * so a canary-time re-failure cannot leave a too-narrow next-attempt window
 * (ADR-001 D4).
 */
export async function applyCompanyQuotaPause(
  input: ApplyCompanyQuotaPauseInput,
): Promise<ApplyCompanyQuotaPauseResult> {
  const graceMs = input.graceMs ?? DEFAULT_GRACE_MS;
  const basePausedUntil = new Date(input.resetAt.getTime() + graceMs);
  const pausedReason = `claude_quota_exhausted:${input.runId}`;

  let pausedUntil = basePausedUntil;
  let conservativeApplied = false;
  if (input.conservativeOnCanaryMs && input.conservativeOnCanaryMs > 0) {
    const currentRow = await input.db
      .select({ pausedCanaryAt: companies.pausedCanaryAt })
      .from(companies)
      .where(eq(companies.id, input.companyId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (currentRow?.pausedCanaryAt) {
      const conservativeUntil = new Date(Date.now() + input.conservativeOnCanaryMs);
      if (conservativeUntil.getTime() > pausedUntil.getTime()) {
        pausedUntil = conservativeUntil;
        conservativeApplied = true;
      }
    }
  }

  const result = await input.db
    .update(companies)
    .set({
      pausedUntil,
      pausedReason,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(companies.id, input.companyId),
        or(
          sql`${companies.pausedUntil} IS NULL`,
          lt(companies.pausedUntil, pausedUntil),
        ),
      ),
    )
    .returning({ id: companies.id });

  return {
    applied: result.length > 0,
    pausedUntil,
    pausedReason,
    conservativeApplied,
  };
}

/**
 * Clears the quota auto-pause window. Used by the P-2 canary path and by
 * admin/unpause flows. Leaves the existing manual `pause_reason`/`paused_at`
 * fields untouched — those belong to the budgets service.
 */
export async function clearCompanyQuotaPause(db: Db, companyId: string): Promise<void> {
  await db
    .update(companies)
    .set({
      pausedUntil: null,
      pausedReason: null,
      pausedCanaryAt: null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(companies.id, companyId), isNotNull(companies.pausedUntil)));
}
