-- Stage 2 — security-implementation.md §4 "Forced re-authentication" requires
-- that membership suspension, like staff role change or password change,
-- invalidate outstanding access tokens. That mechanism is a token version
-- counter; StaffUser already had one (Stage 1 schema). This gives Member the
-- same mechanism.
ALTER TABLE "Member" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 1;
