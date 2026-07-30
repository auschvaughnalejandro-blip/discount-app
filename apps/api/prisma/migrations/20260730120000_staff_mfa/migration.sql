-- Stage 19 — multi-factor authentication for staff accounts (PROGRESS.md Q5).
--
-- security-implementation.md §3: "MFA is mandatory on every dashboard account,
-- without exception", narrowed by the same section's "MFA for any staff account
-- that can reach more than the verification page" — so ADMINISTRATOR, MANAGER
-- and SUPPORT, not OUTLET_STAFF. See src/security/mfa.ts and DECISIONS.md.

-- Enrollment completion, distinct from "a secret exists". A started-then-
-- abandoned enrollment leaves mfaSecret set and this null, and must not count.
ALTER TABLE "StaffUser" ADD COLUMN "mfaEnrolledAt" TIMESTAMP(3);

CREATE TABLE "MfaRecoveryCode" (
    "id" TEXT NOT NULL,
    "staffUserId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MfaRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MfaRecoveryCode_staffUserId_usedAt_idx"
    ON "MfaRecoveryCode"("staffUserId", "usedAt");

ALTER TABLE "MfaRecoveryCode"
    ADD CONSTRAINT "MfaRecoveryCode_staffUserId_fkey"
    FOREIGN KEY ("staffUserId") REFERENCES "StaffUser"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- The application role needs the same grants it holds elsewhere. Recovery
-- codes are marked used rather than deleted, so UPDATE is required; DELETE is
-- not, and is withheld for the same reason it is withheld on Redemption —
-- nothing in the application has cause to erase this trail.
GRANT SELECT, INSERT, UPDATE ON "MfaRecoveryCode" TO pgp_app;
