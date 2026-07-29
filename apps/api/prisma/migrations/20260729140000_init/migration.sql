-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMINISTRATOR', 'MANAGER', 'OUTLET_STAFF', 'SUPPORT');

-- CreateEnum
CREATE TYPE "OutletKind" AS ENUM ('DINING', 'SPA', 'ROOMS', 'EVENTS', 'OTHER');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "SubjectType" AS ENUM ('MEMBER', 'STAFF');

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL,
    "memberNumber" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "status" "MemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "joinedAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimCode" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaimCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffUser" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "outletId" TEXT,
    "tokenVersion" INTEGER NOT NULL DEFAULT 1,
    "mfaSecret" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Outlet" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "OutletKind" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Outlet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Benefit" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "discountPct" DECIMAL(5,2) NOT NULL,
    "secondaryLabel" TEXT,
    "secondaryPct" DECIMAL(5,2),
    "childRules" JSONB,
    "maxGuests" INTEGER,
    "minGuests" INTEGER,
    "reservationPhone" TEXT,
    "terms" TEXT NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Benefit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Redemption" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "benefitId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "staffUserId" TEXT NOT NULL,
    "partySize" INTEGER,
    "billAmountMinor" INTEGER,
    "idempotencyKey" TEXT NOT NULL,
    "reversesId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Redemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "wordingVersion" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "subjectType" "SubjectType" NOT NULL,
    "familyId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "subjectType" TEXT,
    "subjectId" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpCode" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "OtpCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Member_memberNumber_key" ON "Member"("memberNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Member_phone_key" ON "Member"("phone");

-- CreateIndex
CREATE INDEX "Member_status_idx" ON "Member"("status");

-- CreateIndex
CREATE INDEX "Member_claimedAt_idx" ON "Member"("claimedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimCode_codeHash_key" ON "ClaimCode"("codeHash");

-- CreateIndex
CREATE INDEX "ClaimCode_memberId_idx" ON "ClaimCode"("memberId");

-- CreateIndex
CREATE INDEX "ClaimCode_expiresAt_idx" ON "ClaimCode"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "StaffUser_email_key" ON "StaffUser"("email");

-- CreateIndex
CREATE INDEX "StaffUser_role_idx" ON "StaffUser"("role");

-- CreateIndex
CREATE INDEX "StaffUser_outletId_idx" ON "StaffUser"("outletId");

-- CreateIndex
CREATE UNIQUE INDEX "Benefit_key_key" ON "Benefit"("key");

-- CreateIndex
CREATE INDEX "Benefit_published_sortOrder_idx" ON "Benefit"("published", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Redemption_idempotencyKey_key" ON "Redemption"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Redemption_reversesId_key" ON "Redemption"("reversesId");

-- CreateIndex
CREATE INDEX "Redemption_memberId_occurredAt_idx" ON "Redemption"("memberId", "occurredAt");

-- CreateIndex
CREATE INDEX "Redemption_outletId_occurredAt_idx" ON "Redemption"("outletId", "occurredAt");

-- CreateIndex
CREATE INDEX "Redemption_benefitId_occurredAt_idx" ON "Redemption"("benefitId", "occurredAt");

-- CreateIndex
CREATE INDEX "Redemption_occurredAt_idx" ON "Redemption"("occurredAt");

-- CreateIndex
CREATE INDEX "ConsentRecord_memberId_channel_recordedAt_idx" ON "ConsentRecord"("memberId", "channel", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");

-- CreateIndex
CREATE INDEX "RefreshToken_subjectType_subjectId_idx" ON "RefreshToken"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_occurredAt_idx" ON "AuditLog"("actorId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditLog_subjectType_subjectId_occurredAt_idx" ON "AuditLog"("subjectType", "subjectId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_occurredAt_idx" ON "AuditLog"("action", "occurredAt");

-- CreateIndex
CREATE INDEX "OtpCode_phone_expiresAt_idx" ON "OtpCode"("phone", "expiresAt");

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimCode" ADD CONSTRAINT "ClaimCode_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffUser" ADD CONSTRAINT "StaffUser_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Benefit" ADD CONSTRAINT "Benefit_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_benefitId_fkey" FOREIGN KEY ("benefitId") REFERENCES "Benefit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "Redemption"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Beyond what Prisma models. Kept in the same migration because these are part
-- of the data model, not a later concern.
-- ---------------------------------------------------------------------------

-- R3: membership numbers are sequential and public ("PG-0003"). The internal
-- reference stays an opaque UUID. Generating the number in the database rather
-- than the application means two concurrent admin creates cannot collide.
CREATE SEQUENCE IF NOT EXISTS "member_number_seq" AS BIGINT START WITH 1 INCREMENT BY 1;

CREATE OR REPLACE FUNCTION "next_member_number"() RETURNS TEXT
  LANGUAGE SQL
  AS $$ SELECT 'PG-' || LPAD(nextval('member_number_seq')::TEXT, 4, '0') $$;

-- An outlet_staff account is scoped to one outlet; every other role is not.
-- Enforced here so a bug in application code cannot produce an unscoped
-- verification account.
ALTER TABLE "StaffUser"
  ADD CONSTRAINT "StaffUser_outlet_required_for_outlet_staff"
  CHECK (
    ("role" = 'OUTLET_STAFF' AND "outletId" IS NOT NULL)
    OR ("role" <> 'OUTLET_STAFF' AND "outletId" IS NULL)
  );

-- R7: a reversing entry must point at a different row, and only reversals
-- carry the pointer.
ALTER TABLE "Redemption"
  ADD CONSTRAINT "Redemption_reverses_not_self"
  CHECK ("reversesId" IS NULL OR "reversesId" <> "id");

-- R5/R6 are benefit-level rules enforced in application code at Stage 7, but a
-- negative or zero party size is never valid for any benefit.
ALTER TABLE "Redemption"
  ADD CONSTRAINT "Redemption_party_size_positive"
  CHECK ("partySize" IS NULL OR "partySize" > 0);

-- Money is stored in minor units as an integer. A negative bill is only
-- meaningful on a reversing entry.
ALTER TABLE "Redemption"
  ADD CONSTRAINT "Redemption_bill_amount_sign"
  CHECK (
    "billAmountMinor" IS NULL
    OR ("reversesId" IS NULL AND "billAmountMinor" >= 0)
    OR ("reversesId" IS NOT NULL AND "billAmountMinor" <= 0)
  );

-- Percentages are percentages.
ALTER TABLE "Benefit"
  ADD CONSTRAINT "Benefit_discount_pct_range"
  CHECK ("discountPct" >= 0 AND "discountPct" <= 100);

ALTER TABLE "Benefit"
  ADD CONSTRAINT "Benefit_secondary_pct_range"
  CHECK ("secondaryPct" IS NULL OR ("secondaryPct" >= 0 AND "secondaryPct" <= 100));

-- A minimum above a maximum would make the benefit unusable (R5/R6).
ALTER TABLE "Benefit"
  ADD CONSTRAINT "Benefit_guest_range_coherent"
  CHECK ("minGuests" IS NULL OR "maxGuests" IS NULL OR "minGuests" <= "maxGuests");
