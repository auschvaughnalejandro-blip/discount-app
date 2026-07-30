-- Stage 19 hardening — TOTP replay protection.
--
-- A TOTP code is valid for its whole period plus the skew tolerance either side
-- (~90 seconds here). Recording the period a code was accepted in lets a second
-- presentation of the same code be refused, matching §3's requirement that the
-- member OTP be single use — there is no reason a staff second factor should be
-- weaker than a member's.
ALTER TABLE "StaffUser" ADD COLUMN "mfaLastUsedEpoch" INTEGER;
