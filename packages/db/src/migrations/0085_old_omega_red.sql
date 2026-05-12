-- ADR-001 D5 (P-3) — companies.notification_channels jsonb column for owner
-- alert routing. NULL when no channels configured; shape is left jsonb so
-- additional channels (slack/webhook/...) can be added without further
-- migrations. Today only `owner_alerts.email` and `owner_alerts.issue_parent_id`
-- are read by server/src/services/company-quota-alert.ts.
--
-- Rollback (manual, since drizzle migrations are forward-only):
--   ALTER TABLE "companies" DROP COLUMN "notification_channels";
ALTER TABLE "companies" ADD COLUMN "notification_channels" jsonb;
