-- The product has two account-facing surfaces: the member app and the
-- administrator dashboard. MANAGER, OUTLET_STAFF and SUPPORT remain enum
-- values only because historical Member and Redemption rows point at the
-- StaffUser that performed the action. Re-labelling or deleting those actors
-- would falsify that history.

BEGIN;

-- A legacy refresh token is a public-route credential, so permission changes
-- alone are not enough. Revoke every live token before suspending the account.
UPDATE "RefreshToken" AS token
SET "revokedAt" = CURRENT_TIMESTAMP
WHERE token."subjectType" = 'STAFF'
  AND token."revokedAt" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "StaffUser" AS staff
    WHERE staff."id" = token."subjectId"
      AND staff."role" <> 'ADMINISTRATOR'
  );

-- Bumping tokenVersion invalidates already-issued access tokens. The rows stay
-- in place as immutable attribution targets, but can no longer sign in.
UPDATE "StaffUser"
SET "status" = 'SUSPENDED',
    "tokenVersion" = "tokenVersion" + 1
WHERE "role" <> 'ADMINISTRATOR';

-- Defense in depth: application code cannot accidentally reactivate a legacy
-- role later. Only administrator accounts may ever be ACTIVE.
ALTER TABLE "StaffUser"
  ADD CONSTRAINT "StaffUser_only_administrators_active"
  CHECK ("role" = 'ADMINISTRATOR' OR "status" = 'SUSPENDED');

COMMIT;
