-- Add the token-backed outlet-device authentication method on its own.
--
-- PostgreSQL does not allow a newly-added enum value to be used by a CHECK
-- constraint until the transaction that added it has committed. Prisma runs
-- this migration before the column/constraint migration that follows, so the
-- value is committed and usable there.
ALTER TYPE "StaffAuthMethod" ADD VALUE 'TOKEN';
