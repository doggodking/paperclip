import nodemailer, { type Transporter } from "nodemailer";
import { logger } from "../middleware/logger.js";

/**
 * ADR-001 D5 (P-3) — owner alert email transport. Wraps nodemailer with
 * env-driven SMTP config and a strict "configured-or-skip" policy:
 *
 *   PAPERCLIP_SMTP_HOST  — required
 *   PAPERCLIP_SMTP_PORT  — required, integer
 *   PAPERCLIP_SMTP_USER  — required (use empty string for unauthenticated
 *                          relays only)
 *   PAPERCLIP_SMTP_PASS  — required
 *   PAPERCLIP_SMTP_FROM  — required, RFC 5322 envelope sender
 *
 * If any value is missing the send is skipped with `skipped: true` so the
 * surrounding alert flow still records an `activity_log` row and creates the
 * Paperclip issue (graceful degradation per the P-3 spec).
 */

export interface SendOwnerAlertEmailInput {
  to: string;
  from: string;
  subject: string;
  text: string;
}

export interface SendOwnerAlertEmailResult {
  skipped: boolean;
  reason?: string;
}

interface ResolvedSmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

function readSmtpConfigFromEnv(): ResolvedSmtpConfig | { missing: string[] } {
  const host = process.env.PAPERCLIP_SMTP_HOST?.trim();
  const portRaw = process.env.PAPERCLIP_SMTP_PORT?.trim();
  const user = process.env.PAPERCLIP_SMTP_USER;
  const pass = process.env.PAPERCLIP_SMTP_PASS;
  const from = process.env.PAPERCLIP_SMTP_FROM?.trim();

  const missing: string[] = [];
  if (!host) missing.push("PAPERCLIP_SMTP_HOST");
  if (!portRaw) missing.push("PAPERCLIP_SMTP_PORT");
  if (user == null) missing.push("PAPERCLIP_SMTP_USER");
  if (pass == null) missing.push("PAPERCLIP_SMTP_PASS");
  if (!from) missing.push("PAPERCLIP_SMTP_FROM");
  if (missing.length > 0) return { missing };

  const port = Number.parseInt(portRaw!, 10);
  if (!Number.isFinite(port) || port <= 0) {
    return { missing: ["PAPERCLIP_SMTP_PORT (invalid integer)"] };
  }
  return { host: host!, port, user: user!, pass: pass!, from: from! };
}

let cachedTransporter: Transporter | null = null;
let cachedConfigSignature: string | null = null;

function getTransporter(config: ResolvedSmtpConfig): Transporter {
  const signature = `${config.host}:${config.port}:${config.user}`;
  if (cachedTransporter && cachedConfigSignature === signature) return cachedTransporter;
  cachedTransporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
  });
  cachedConfigSignature = signature;
  return cachedTransporter;
}

/** Test hook — clears the memoized transport so a new `process.env` snapshot is picked up. */
export function resetMailerForTests(): void {
  cachedTransporter = null;
  cachedConfigSignature = null;
}

export async function sendOwnerAlertEmail(
  input: SendOwnerAlertEmailInput,
): Promise<SendOwnerAlertEmailResult> {
  const config = readSmtpConfigFromEnv();
  if ("missing" in config) {
    logger.warn({ missing: config.missing }, "SMTP not configured — skipping owner alert email");
    return { skipped: true, reason: `smtp_env_missing:${config.missing.join(",")}` };
  }
  const transporter = getTransporter(config);
  await transporter.sendMail({
    from: config.from,
    to: input.to,
    subject: input.subject,
    text: input.text,
  });
  return { skipped: false };
}
