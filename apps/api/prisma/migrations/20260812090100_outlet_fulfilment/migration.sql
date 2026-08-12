-- Outlet fulfilment: the guest announces, the outlet confirms, nobody approves.
--
-- Three separate changes travel together because they are one product decision:
--   1. a request now names the outlet it was sent to, and carries delivery state
--   2. outlet accounts can sign in again, through Google rather than a password
--   3. the Stage 27 constraint that forbade (2) is replaced, not deleted
--
-- See DECISIONS.md, 2026-08-12.

BEGIN;

-- ── 1. The request ────────────────────────────────────────────────────────

-- New notices are SENT. The historical values stay reachable for old rows; only
-- what gets written from now on changes.
ALTER TABLE "BenefitRequest"
  ALTER COLUMN "status" SET DEFAULT 'SENT';

-- Which outlet was told. Nullable because rows created before the guest was
-- asked genuinely have no answer, and inventing one would be a lie in the
-- record. Every new row sets it.
ALTER TABLE "BenefitRequest"
  ADD COLUMN "outletId" TEXT,
  ADD COLUMN "seenAt" TIMESTAMP(3),
  ADD COLUMN "notifiedAt" TIMESTAMP(3),
  ADD COLUMN "notifyStatus" TEXT;

ALTER TABLE "BenefitRequest"
  ADD CONSTRAINT "BenefitRequest_outletId_fkey"
  FOREIGN KEY ("outletId") REFERENCES "Outlet"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- An outlet reads (its own outlet, SENT, oldest first). The existing
-- (status, requestedAt) index cannot serve that: outletId is not its leading
-- column, so the query would scan every outlet's notices and filter.
CREATE INDEX "BenefitRequest_outletId_status_requestedAt_idx"
  ON "BenefitRequest"("outletId", "status", "requestedAt");

-- ── 2. Outlet accounts sign in through Google ─────────────────────────────

-- An account whose credential is held by Google has no hash to store. Stated as
-- its own column rather than inferred from a null hash, because an outlet
-- account has neither a password nor a Google subject until its first sign-in —
-- so "no hash" alone cannot tell a Google account from a broken row.
CREATE TYPE "StaffAuthMethod" AS ENUM ('PASSWORD', 'GOOGLE');

ALTER TABLE "StaffUser"
  ADD COLUMN "authMethod" "StaffAuthMethod" NOT NULL DEFAULT 'PASSWORD',
  ADD COLUMN "googleSubject" TEXT;

ALTER TABLE "StaffUser"
  ALTER COLUMN "passwordHash" DROP NOT NULL;

-- Google's subject claim is stable for the life of the account and, unlike the
-- email address, is never reassigned. Unique so two accounts cannot both claim
-- the same Google identity.
CREATE UNIQUE INDEX "StaffUser_googleSubject_key"
  ON "StaffUser"("googleSubject");

-- The pairing, in both directions. Without the second half, an administrator
-- could be left with authMethod = PASSWORD and no hash — an account that can
-- never sign in and looks like a bug in the login route instead of a bad row.
ALTER TABLE "StaffUser"
  ADD CONSTRAINT "StaffUser_credential_matches_auth_method"
  CHECK (
    ("authMethod" = 'PASSWORD' AND "passwordHash" IS NOT NULL)
    OR ("authMethod" = 'GOOGLE' AND "passwordHash" IS NULL)
  );

-- An active outlet account must name the outlet it belongs to, or its scope is
-- undefined and it would read an empty queue for reasons nobody could see.
-- Conditioned on ACTIVE so the suspended historical OUTLET_STAFF rows, some of
-- which predate the column being populated, remain legal.
ALTER TABLE "StaffUser"
  ADD CONSTRAINT "StaffUser_active_outlet_account_has_outlet"
  CHECK (
    "role" <> 'OUTLET_STAFF'
    OR "status" = 'SUSPENDED'
    OR "outletId" IS NOT NULL
  );

-- ── 3. Replacing the Stage 27 constraint, by name ─────────────────────────
--
-- 20260809210000_administrator_only_accounts asserted that only administrators
-- may ever be ACTIVE, as defence in depth against application code quietly
-- reviving a retired role. Outlet accounts are no longer retired, so the
-- assertion is now wrong — but MANAGER and SUPPORT still are, and dropping the
-- constraint outright would stop saying so.
--
-- Replaced rather than removed, so the narrowing is a decision in the migration
-- history rather than an absence somebody has to notice.
ALTER TABLE "StaffUser"
  DROP CONSTRAINT "StaffUser_only_administrators_active";

ALTER TABLE "StaffUser"
  ADD CONSTRAINT "StaffUser_only_live_roles_active"
  CHECK (
    "role" IN ('ADMINISTRATOR', 'OUTLET_STAFF')
    OR "status" = 'SUSPENDED'
  );

-- ── 4. Where a notice is emailed ──────────────────────────────────────────
--
-- Separate from the outlet account's sign-in address on purpose: a hotel can
-- point notices at a shared distribution list without that list being able to
-- log in. Null is a supported configuration — the outlet works from its screen.
ALTER TABLE "Outlet"
  ADD COLUMN "notifyEmail" TEXT;

COMMIT;
