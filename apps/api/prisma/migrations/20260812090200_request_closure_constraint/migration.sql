-- The closure constraint, restated for a flow with no approver.
--
-- `BenefitRequest_decision_complete` (20260808120000) said: PENDING has no
-- decision recorded, anything else has both a timestamp and an accountable
-- account. That was exactly right when a person had to approve every request, and
-- it is wrong now in one specific way.
--
-- **A notice can be closed by a clock.** When nobody confirms a guest arrived, the
-- expiry sweep closes the row as NOT_USED. There is no account behind that, and
-- attributing it to one would put somebody's name against an action they never
-- took — which is the same falsification the original constraint existed to
-- prevent, pointing the other way.
--
-- So the rule splits three ways:
--
--   open        (SENT, and historical PENDING) — nothing closed, nothing recorded
--   closed by a person (FULFILLED, and historical APPROVED/DECLINED) — both
--   closed by the clock (NOT_USED) — a timestamp, and an account only if a person
--                                    did it
--
-- The historical values stay in the predicate. Dropping them would make every
-- pre-existing row illegal, and the point of keeping them was that no row moves.

BEGIN;

ALTER TABLE "BenefitRequest"
  DROP CONSTRAINT "BenefitRequest_decision_complete";

ALTER TABLE "BenefitRequest"
  ADD CONSTRAINT "BenefitRequest_closure_complete"
  CHECK (
    (
      "status" IN ('SENT', 'PENDING')
      AND "decidedAt" IS NULL
      AND "decidedByUserId" IS NULL
    )
    OR (
      "status" IN ('FULFILLED', 'APPROVED', 'DECLINED')
      AND "decidedAt" IS NOT NULL
      AND "decidedByUserId" IS NOT NULL
    )
    OR (
      -- Closed for certain. The account is optional here and only here.
      "status" = 'NOT_USED'
      AND "decidedAt" IS NOT NULL
    )
  );

COMMIT;
