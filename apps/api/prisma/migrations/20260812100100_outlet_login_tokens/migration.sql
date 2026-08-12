-- Per-device outlet login tokens.
--
-- Each device is its own StaffUser. That keeps the existing session,
-- tokenVersion and redemption-attribution machinery intact while making a lost
-- tablet revocable without signing every other device at the outlet out.

BEGIN;

-- A token-backed device is not a mailbox. PostgreSQL unique indexes permit
-- multiple nulls, so PASSWORD and GOOGLE addresses remain unique while TOKEN
-- accounts do not need fabricated email addresses.
ALTER TABLE "StaffUser"
  ALTER COLUMN "email" DROP NOT NULL,
  ADD COLUMN "outletTokenHash" TEXT,
  ADD COLUMN "outletTokenIssuedAt" TIMESTAMP(3),
  ADD COLUMN "outletTokenLastUsedAt" TIMESTAMP(3);

-- SHA-256 makes the high-entropy token directly indexable without storing the
-- plaintext credential. A collision is refused at the database boundary.
CREATE UNIQUE INDEX "StaffUser_outletTokenHash_key"
  ON "StaffUser"("outletTokenHash");

-- Replace the two-way PASSWORD/GOOGLE check with the three valid credential
-- shapes. Active TOKEN accounts must have a credential; a suspended/revoked
-- actor may have had the hash destroyed while its historical attribution stays.
-- Historical suspended PASSWORD outlet actors remain legal.
ALTER TABLE "StaffUser"
  DROP CONSTRAINT "StaffUser_credential_matches_auth_method";

ALTER TABLE "StaffUser"
  ADD CONSTRAINT "StaffUser_credential_matches_auth_method"
  CHECK (
    (
      "authMethod" = 'PASSWORD'
      AND "email" IS NOT NULL
      AND "passwordHash" IS NOT NULL
      AND "outletTokenHash" IS NULL
    )
    OR
    (
      "authMethod" = 'GOOGLE'
      AND "email" IS NOT NULL
      AND "passwordHash" IS NULL
      AND "outletTokenHash" IS NULL
    )
    OR
    (
      "authMethod" = 'TOKEN'
      AND "email" IS NULL
      AND "passwordHash" IS NULL
      AND "googleSubject" IS NULL
      AND ("status" <> 'ACTIVE' OR "outletTokenHash" IS NOT NULL)
    )
  );

COMMIT;
