-- ---------------------------------------------------------------------------
-- R7 — redemptions are immutable, enforced by the database rather than by
-- convention. A correction is a new reversing row; the original is never
-- touched.
--
-- security-implementation.md §5 "Database backstop": the application role holds
-- no DELETE on members or redemptions, and no UPDATE on redemptions.
-- Destructive operations require the separate migration role that owns the
-- schema.
--
-- The application connects as `pgp_app`; migrations run as the owner. The
-- guard below makes this migration a no-op where that role does not exist
-- (a developer running everything as one superuser), so `migrate deploy`
-- succeeds either way — but then R7 is NOT enforced, which is why the Stage 1
-- acceptance test asserts the rejection rather than assuming it.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pgp_app') THEN
    RAISE NOTICE 'Role pgp_app absent — skipping privilege grants. R7 is NOT enforced at database level in this database.';
    RETURN;
  END IF;

  -- Baseline: the application reads and writes ordinary tables.
  EXECUTE 'GRANT USAGE ON SCHEMA public TO pgp_app';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pgp_app';
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pgp_app';
  EXECUTE 'GRANT EXECUTE ON FUNCTION next_member_number() TO pgp_app';

  -- R7: redemptions are append-only for the application.
  EXECUTE 'REVOKE UPDATE, DELETE ON "Redemption" FROM pgp_app';

  -- R16: members are suspended, never deleted.
  EXECUTE 'REVOKE DELETE ON "Member" FROM pgp_app';

  -- §9: the audit log is append-only. Stage 9 builds the writer; the privilege
  -- belongs with the rest of the backstop.
  EXECUTE 'REVOKE UPDATE, DELETE ON "AuditLog" FROM pgp_app';

  -- Consent history is evidence of what was agreed and when. Withdrawal is a
  -- new row, not an edit.
  EXECUTE 'REVOKE UPDATE, DELETE ON "ConsentRecord" FROM pgp_app';

  -- Anything created by a later migration inherits the same baseline, so a new
  -- table is never accidentally more permissive than these.
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pgp_app';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pgp_app';
END
$$;
