import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import { clearCompanyQuotaPause } from "./company-quota-pause.js";

/**
 * ADR-001 D4 — canary re-entry after a quota-driven auto-pause window expires.
 *
 * Invariants (mirrors the spec in DOGAA-90):
 *  - `paused_until = NULL` and `paused_canary_at = NULL` → no pause; all wakes allowed.
 *  - `paused_until > now` and `paused_canary_at = NULL` → in active pause window; skip every wake.
 *  - `paused_until <= now` and `paused_canary_at = NULL` → enter canary: latch
 *    `paused_canary_at = now`, allow only the HRManager (or CEO fallback) wake.
 *  - `paused_canary_at != NULL` → canary in progress; only one role is eligible per
 *    5-minute phase, HR first then CEO if HR fails to start, looping back to HR.
 *  - On canary success (canary agent's run completed and the post-run hook did NOT
 *    re-apply a pause), clear `paused_until`, `paused_reason`, `paused_canary_at`.
 *  - On canary failure (post-run hook re-applied `paused_until`), keep
 *    `paused_canary_at` intact so the next expiry goes through a single canary
 *    probe again, and let the caller's heartbeat hook apply the +30-minute
 *    conservative grace via `applyCompanyQuotaPause({ conservativeOnCanaryMs })`.
 */

export const CANARY_PHASE_MS = 5 * 60 * 1000;

export const CANARY_ROLES = {
  hrManager: "hr_manager",
  ceo: "ceo",
} as const;

export type CanaryGateOutcome =
  | { decision: "allow"; reason: "no_pause" | "canary_success" | "canary_probe" }
  | { decision: "skip"; reason: "in_pause_window" | "canary_other_agent_only" };

/**
 * Decide whether `agentId` is allowed to wake right now given the company's
 * quota-pause + canary state. Mutates the row when state transitions are due
 * (entering canary, clearing on success, rotating fallback roles).
 */
export async function evaluateCanaryGate(
  db: Db,
  companyId: string,
  agentId: string,
  now: Date = new Date(),
): Promise<CanaryGateOutcome> {
  const row = await db
    .select({
      pausedUntil: companies.pausedUntil,
      pausedCanaryAt: companies.pausedCanaryAt,
    })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!row) return { decision: "allow", reason: "no_pause" };

  const pausedUntilMs = row.pausedUntil?.getTime() ?? null;
  const canaryAtMs = row.pausedCanaryAt?.getTime() ?? null;
  const nowMs = now.getTime();

  // Fully un-paused.
  if (pausedUntilMs === null && canaryAtMs === null) {
    return { decision: "allow", reason: "no_pause" };
  }

  // Active pause window with no canary started yet.
  if (canaryAtMs === null && pausedUntilMs !== null && pausedUntilMs > nowMs) {
    return { decision: "skip", reason: "in_pause_window" };
  }

  // pause_until expired (or null) and no canary yet → enter canary.
  if (canaryAtMs === null) {
    const canary = await pickCanaryAgent(db, companyId, "hr_manager");
    if (!canary) {
      // No HR and no CEO available — degenerate setup, just clear the latch
      // so the company isn't stuck.
      await clearCompanyQuotaPause(db, companyId);
      return { decision: "allow", reason: "canary_success" };
    }
    const latched = await db
      .update(companies)
      .set({ pausedCanaryAt: now, updatedAt: sql`now()` })
      .where(and(eq(companies.id, companyId), isNull(companies.pausedCanaryAt)))
      .returning({ id: companies.id });
    if (latched.length === 0) {
      // Lost the race against another tick — re-evaluate against fresh state.
      return evaluateCanaryGate(db, companyId, agentId, now);
    }
    return canary.id === agentId
      ? { decision: "allow", reason: "canary_probe" }
      : { decision: "skip", reason: "canary_other_agent_only" };
  }

  // canary_at is set — determine current phase.
  const elapsedMs = Math.max(0, nowMs - canaryAtMs);
  const phaseIndex = Math.floor(elapsedMs / CANARY_PHASE_MS);
  const desiredRole = phaseIndex % 2 === 0 ? "hr_manager" : "ceo";
  const canary = await pickCanaryAgent(db, companyId, desiredRole, /* fallbackToOtherRole */ true);

  if (!canary) {
    // Same degenerate case — no eligible agent at all.
    await clearCompanyQuotaPause(db, companyId);
    return { decision: "allow", reason: "canary_success" };
  }

  // If the canary candidate actually started a run since canary_at, AND the
  // post-run hook did NOT extend the pause window past now, the canary is
  // considered successful → clear all pause state.
  const lastHeartbeatMs = canary.lastHeartbeatAt?.getTime() ?? null;
  const canaryStarted = lastHeartbeatMs !== null && lastHeartbeatMs >= canaryAtMs;
  if (canaryStarted) {
    if (pausedUntilMs !== null && pausedUntilMs > nowMs) {
      // Canary failure path — applyCompanyQuotaPause re-extended the window.
      // Keep `paused_canary_at` intact per spec; skip until expiry.
      return { decision: "skip", reason: "in_pause_window" };
    }
    await clearCompanyQuotaPause(db, companyId);
    return { decision: "allow", reason: "canary_success" };
  }

  // Canary hasn't started yet within its phase window. If we've drifted past
  // the second phase (HR + CEO each got their 5 minutes), rebase canary_at to
  // start a fresh HR-first cycle so we don't accumulate unbounded drift.
  if (phaseIndex >= 2) {
    await db
      .update(companies)
      .set({ pausedCanaryAt: now, updatedAt: sql`now()` })
      .where(eq(companies.id, companyId));
    return canary.id === agentId
      ? { decision: "allow", reason: "canary_probe" }
      : { decision: "skip", reason: "canary_other_agent_only" };
  }

  return canary.id === agentId
    ? { decision: "allow", reason: "canary_probe" }
    : { decision: "skip", reason: "canary_other_agent_only" };
}

interface CanaryAgentRow {
  id: string;
  role: string;
  lastHeartbeatAt: Date | null;
}

/**
 * Select the single agent eligible to run as the canary right now. Picks the
 * most recently active agent with the requested role; if `fallbackToOtherRole`
 * is true and no agent matches, falls back to the other canary role so the
 * canary loop never wedges on a missing HR or missing CEO.
 */
async function pickCanaryAgent(
  db: Db,
  companyId: string,
  preferredRole: "hr_manager" | "ceo",
  fallbackToOtherRole = false,
): Promise<CanaryAgentRow | null> {
  const primary = await db
    .select({
      id: agents.id,
      role: agents.role,
      lastHeartbeatAt: agents.lastHeartbeatAt,
    })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.role, preferredRole)))
    .orderBy(desc(agents.lastHeartbeatAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (primary) return primary;

  if (!fallbackToOtherRole) return null;
  const otherRole = preferredRole === "hr_manager" ? "ceo" : "hr_manager";
  return db
    .select({
      id: agents.id,
      role: agents.role,
      lastHeartbeatAt: agents.lastHeartbeatAt,
    })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.role, otherRole)))
    .orderBy(desc(agents.lastHeartbeatAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}
