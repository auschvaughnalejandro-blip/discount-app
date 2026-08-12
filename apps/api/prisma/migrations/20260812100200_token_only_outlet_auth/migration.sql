BEGIN;

-- Outlet email is notification data, not an authentication identifier. Preserve
-- an already-configured notification address; otherwise carry forward the one
-- unambiguous active Google outlet address before making those rows historical.
WITH "UnambiguousGoogleAddress" AS (
  SELECT "outletId", MIN("email") AS "email"
  FROM "StaffUser"
  WHERE "role" = 'OUTLET_STAFF'
    AND "authMethod" = 'GOOGLE'
    AND "status" = 'ACTIVE'
    AND "outletId" IS NOT NULL
    AND "email" IS NOT NULL
  GROUP BY "outletId"
  HAVING COUNT(*) = 1
)
UPDATE "Outlet" AS outlet
SET "notifyEmail" = candidate."email"
FROM "UnambiguousGoogleAddress" AS candidate
WHERE outlet."id" = candidate."outletId"
  AND outlet."notifyEmail" IS NULL;

-- A refresh token is a public-route credential, so every family belonging to a
-- retired non-token outlet actor is revoked before the row is suspended.
UPDATE "RefreshToken"
SET "revokedAt" = CURRENT_TIMESTAMP
WHERE "subjectType" = 'STAFF'
  AND "revokedAt" IS NULL
  AND "subjectId" IN (
    SELECT "id"
    FROM "StaffUser"
    WHERE "role" = 'OUTLET_STAFF'
      AND "authMethod" <> 'TOKEN'
  );

-- GOOGLE is the expected legacy shape, but suspend any anomalous PASSWORD
-- OUTLET_STAFF row too so the new fail-closed constraint can be installed.
UPDATE "StaffUser"
SET "status" = 'SUSPENDED',
    "tokenVersion" = "tokenVersion" + 1
WHERE "role" = 'OUTLET_STAFF'
  AND "authMethod" <> 'TOKEN'
  AND "status" = 'ACTIVE';

ALTER TABLE "StaffUser"
  ADD CONSTRAINT "StaffUser_active_outlet_staff_uses_token"
  CHECK (
    "role" <> 'OUTLET_STAFF'
    OR "status" <> 'ACTIVE'
    OR "authMethod" = 'TOKEN'
  );

COMMIT;
