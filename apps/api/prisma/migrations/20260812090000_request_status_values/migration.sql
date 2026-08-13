-- The benefit request stops being a petition and becomes a notice.
--
-- Only the enum values are added here. PostgreSQL permits `ALTER TYPE ... ADD
-- VALUE` inside a transaction but refuses to *use* the new value in that same
-- transaction, so the column default, the new columns and the constraints that
-- reference 'SENT' all live in the migration that follows this one. Splitting
-- them is not tidiness; combining them fails with "unsafe use of new value".
--
-- PENDING, APPROVED and DECLINED are deliberately left in place. Existing rows
-- keep them, and so does every audit entry that named them, because rewriting
-- history to match a new workflow would falsify the record the programme exists
-- to keep.

ALTER TYPE "BenefitRequestStatus" ADD VALUE IF NOT EXISTS 'SENT';
ALTER TYPE "BenefitRequestStatus" ADD VALUE IF NOT EXISTS 'NOT_USED';
