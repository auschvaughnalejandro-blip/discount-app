-- Benefit requests: a member asks, a person decides, an outlet fulfils.
--
-- Until now a member was passive — they existed, and staff looked them up. This
-- adds the step the programme actually runs on: the member asks for a benefit
-- from the app, an administrator approves it, and the outlet sees the approval
-- waiting when the guest arrives.
--
-- Nothing here grants anything. The row records a request and a decision; a
-- Redemption is still the only record that a benefit was given, and fulfilment
-- is what links the two.

CREATE TYPE "BenefitRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'FULFILLED');

-- Which kind of outlet honours a benefit, so an approved spa request appears on
-- the spa's list and not the restaurant's. Nullable: a benefit nobody has
-- assigned yet is visible everywhere, because a request no outlet can see is a
-- worse failure than one seen too widely.
ALTER TABLE "Benefit" ADD COLUMN "outletKind" "OutletKind";

CREATE TABLE "BenefitRequest" (
  "id"              TEXT NOT NULL,
  "memberId"        TEXT NOT NULL,
  "benefitId"       TEXT NOT NULL,
  "status"          "BenefitRequestStatus" NOT NULL DEFAULT 'PENDING',
  "requestedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note"            TEXT,
  "decidedAt"       TIMESTAMP(3),
  "decidedByUserId" TEXT,
  "decisionReason"  TEXT,
  "redemptionId"    TEXT,
  "fulfilledAt"     TIMESTAMP(3),

  CONSTRAINT "BenefitRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BenefitRequest_redemptionId_key"
  ON "BenefitRequest"("redemptionId");
CREATE INDEX "BenefitRequest_status_requestedAt_idx"
  ON "BenefitRequest"("status", "requestedAt");
CREATE INDEX "BenefitRequest_memberId_requestedAt_idx"
  ON "BenefitRequest"("memberId", "requestedAt");

ALTER TABLE "BenefitRequest" ADD CONSTRAINT "BenefitRequest_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BenefitRequest" ADD CONSTRAINT "BenefitRequest_benefitId_fkey"
  FOREIGN KEY ("benefitId") REFERENCES "Benefit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BenefitRequest" ADD CONSTRAINT "BenefitRequest_decidedByUserId_fkey"
  FOREIGN KEY ("decidedByUserId") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BenefitRequest" ADD CONSTRAINT "BenefitRequest_redemptionId_fkey"
  FOREIGN KEY ("redemptionId") REFERENCES "Redemption"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A decision has to name its decider, and only a decided request may carry a
-- reason or a timestamp. Without this, "approved by nobody" is representable —
-- and an approval nobody is accountable for is the one thing this table must
-- not be able to hold.
ALTER TABLE "BenefitRequest" ADD CONSTRAINT "BenefitRequest_decision_complete" CHECK (
  ("status" = 'PENDING'  AND "decidedAt" IS NULL AND "decidedByUserId" IS NULL)
  OR
  ("status" <> 'PENDING' AND "decidedAt" IS NOT NULL AND "decidedByUserId" IS NOT NULL)
);

-- Fulfilment means a redemption exists. A FULFILLED row without one would be an
-- approval that was spent on nothing.
ALTER TABLE "BenefitRequest" ADD CONSTRAINT "BenefitRequest_fulfilment_complete" CHECK (
  ("status" = 'FULFILLED' AND "redemptionId" IS NOT NULL AND "fulfilledAt" IS NOT NULL)
  OR
  ("status" <> 'FULFILLED' AND "redemptionId" IS NULL AND "fulfilledAt" IS NULL)
);

-- The application role needs to write these: members create them, staff decide
-- them, fulfilment updates them. Deletion is not part of any flow — a withdrawn
-- request is a decision like any other, and losing the history of who asked for
-- what would defeat the point of recording it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pgp_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON "BenefitRequest" TO pgp_app';
    EXECUTE 'REVOKE DELETE ON "BenefitRequest" FROM pgp_app';
  END IF;
END
$$;
