import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetMailerForTests, sendOwnerAlertEmail } from "../services/mailer.js";

const SMTP_ENV_KEYS = [
  "PAPERCLIP_SMTP_HOST",
  "PAPERCLIP_SMTP_PORT",
  "PAPERCLIP_SMTP_USER",
  "PAPERCLIP_SMTP_PASS",
  "PAPERCLIP_SMTP_FROM",
] as const;

describe("sendOwnerAlertEmail", () => {
  const snapshot: Partial<Record<(typeof SMTP_ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of SMTP_ENV_KEYS) {
      snapshot[key] = process.env[key];
      delete process.env[key];
    }
    resetMailerForTests();
  });

  afterEach(() => {
    for (const key of SMTP_ENV_KEYS) {
      const value = snapshot[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetMailerForTests();
  });

  it("skips with a reason naming every missing env var when nothing is configured", async () => {
    const result = await sendOwnerAlertEmail({
      to: "owner@example.com",
      from: "",
      subject: "[ALERT]",
      text: "body",
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("smtp_env_missing:");
    expect(result.reason).toContain("PAPERCLIP_SMTP_HOST");
    expect(result.reason).toContain("PAPERCLIP_SMTP_PORT");
    expect(result.reason).toContain("PAPERCLIP_SMTP_USER");
    expect(result.reason).toContain("PAPERCLIP_SMTP_PASS");
    expect(result.reason).toContain("PAPERCLIP_SMTP_FROM");
  });

  it("skips when PAPERCLIP_SMTP_PORT is not a positive integer", async () => {
    process.env.PAPERCLIP_SMTP_HOST = "smtp.example.com";
    process.env.PAPERCLIP_SMTP_PORT = "not-a-number";
    process.env.PAPERCLIP_SMTP_USER = "user";
    process.env.PAPERCLIP_SMTP_PASS = "pass";
    process.env.PAPERCLIP_SMTP_FROM = "alerts@example.com";

    const result = await sendOwnerAlertEmail({
      to: "owner@example.com",
      from: "",
      subject: "[ALERT]",
      text: "body",
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("PAPERCLIP_SMTP_PORT");
  });

  it("reports just the single missing key when only one is unset", async () => {
    process.env.PAPERCLIP_SMTP_HOST = "smtp.example.com";
    process.env.PAPERCLIP_SMTP_PORT = "587";
    process.env.PAPERCLIP_SMTP_USER = "user";
    process.env.PAPERCLIP_SMTP_PASS = "pass";
    // PAPERCLIP_SMTP_FROM intentionally unset

    const result = await sendOwnerAlertEmail({
      to: "owner@example.com",
      from: "",
      subject: "[ALERT]",
      text: "body",
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("smtp_env_missing:PAPERCLIP_SMTP_FROM");
  });
});
