-- Snapshot the rate that was promised, at the moment it was promised.
--
-- Until now nothing recorded what a member was actually given. "Value given"
-- joined Redemption to Benefit and read the percentage *currently* on the
-- benefit row, and both history screens did the same. R14 makes that percentage
-- editable without a deployment — which is the point — so an administrator
-- moving dining from 25% to 20% silently rewrote every past month's figure, and
-- told a member they had been given 20% on a visit where they were given 25%.
--
-- The rate someone was given is a fact about that visit. It is not a property
-- of the benefit's current configuration, and it must stop being stored as one.
--
-- `benefitVersion` alongside it answers the other half: not just what the rate
-- was, but which revision of the benefit's terms and caps was in force. Benefit
-- already increments a version on every edit and records who made it, so this
-- is the join back to that history.

ALTER TABLE "Redemption" ADD COLUMN "discountPctApplied" DECIMAL(5,2);
ALTER TABLE "Redemption" ADD COLUMN "benefitVersion" INTEGER;

-- Backfill from the benefit as it stands today.
--
-- There is no record of what these rates were, so today's is the only available
-- answer — and it is the one the reports were already using, so no existing
-- figure changes. This migration does not recover lost history; it stops the
-- next edit from rewriting the history that exists from here on.
UPDATE "Redemption" r
   SET "discountPctApplied" = b."discountPct",
       "benefitVersion"     = b."version"
  FROM "Benefit" b
 WHERE b."id" = r."benefitId";

ALTER TABLE "Redemption" ALTER COLUMN "discountPctApplied" SET NOT NULL;
ALTER TABLE "Redemption" ALTER COLUMN "benefitVersion" SET NOT NULL;

-- Same bounds the Benefit table already carries. A rate outside 0-100 is a bug
-- wherever it came from, and the database is the one place that cannot be
-- talked out of noticing.
ALTER TABLE "Redemption"
  ADD CONSTRAINT "Redemption_discountPctApplied_range"
  CHECK ("discountPctApplied" >= 0 AND "discountPctApplied" <= 100);
