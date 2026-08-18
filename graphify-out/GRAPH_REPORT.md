# Graph Report - .  (2026-08-13)

## Corpus Check
- Large corpus: 210 files · ~1,144,720 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder.

## Summary
- 1499 nodes · 2717 edges · 122 communities (108 shown, 14 thin omitted)
- Extraction: 94% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 148 edges (avg confidence: 0.85)
- Token cost: 584,315 input · 0 output

## Community Hubs (Navigation)
- Redaction and Claim Codes
- Member App API Client
- Google Sheets Mirror
- Reporting Metrics and Suppression
- Database Seed and Staff Admin
- Member App Dependencies
- Offers and Benefit Screens
- Monorepo Root Package
- SMS Delivery Transport
- Admin App Dependencies
- Outlet App Dependencies
- Admin Member Management
- Redemption Recording
- Authorization and Audit
- Outlet App API Client
- Identity Payload Rules
- Admin Panel UI
- Sign-In and Passcode Design
- Base TypeScript Config
- Code Delivery Senders
- Build Plan and Stack Decisions
- Admin App API Client
- Deployment and Immutability
- Environment and Dev Server
- API App Bootstrap
- MFA and Auth Routes
- Rate Limiting and Journey Test
- API Dependencies
- Auth Route Schemas
- Identity Code Signing
- Outlet and Admin Access Decisions
- HTTP Error Types
- API Dev Dependencies
- OTP Generation and Verify
- Member Profile Screens
- Initial Database Schema
- Benefit Request Lifecycle
- Admin TypeScript Config
- Member TypeScript Config
- Outlet TypeScript Config
- Hosting and Cost Model
- Shared Package Manifest
- Outlet Login Tokens
- Refresh Token Rotation
- Product Definition
- Docker Compose Topology
- NPM Script Commands
- Route Permission Rules
- API Test Harness
- Refresh Session Cookie
- API TypeScript Config
- Admin Reporting UI
- PWA Icons and Hero Imagery
- Staff MFA Decisions
- Security Hardening Stages
- Membership Card Artwork
- Scoped Read Lint Test
- Privacy and Data Model
- Wireframe Drafts
- UI Package Exports
- Admin Chart Components
- Benefits and Roadmap Decisions
- Member Authentication Flow
- Client Invariant Test
- Outlet Scan Test
- Member App Entry and Assets
- Security Review Findings
- Shared TypeScript Config
- Windows Dev Database Script
- MFA Code Dev Helper
- Password Storage and Screening
- Core Security Architecture
- Health Check Endpoint
- Admin Surface Access
- Button Component
- App Navigation Helpers
- API Package Manifest
- Tab Bar Component
- Operations Runbook
- Data Model Test
- Test Environment Setup
- Field Component
- Stat Bar Component
- QR Scanner Component
- Fastify Plugin Dependency
- Nodemailer Dependency
- Admin App Entry
- Member App Entry
- Outlet App Entry
- App Role Init Script
- Migration Release Step

## God Nodes (most connected - your core abstractions)
1. `buildApp()` - 38 edges
2. `authRoutes()` - 32 edges
3. `issueAccessToken()` - 27 edges
4. `Env` - 26 edges
5. `loadEnv()` - 26 edges
6. `writeAudit()` - 24 edges
7. `outletRoutes()` - 20 edges
8. `scopedWhere()` - 20 edges
9. `compilerOptions` - 20 edges
10. `scripts` - 18 edges

## Surprising Connections (you probably didn't know these)
- `Wallet Pass Update Web Service Cost` --semantically_similar_to--> `Static QR on the Printed Card, Q1 Reversed`  [INFERRED] [semantically similar]
  COSTS.md → DECISIONS.md
- `Confidentiality of the Membership List` --semantically_similar_to--> `Masked Contact Details and Visible Access Notice`  [INFERRED] [semantically similar]
  SYSTEM-OVERVIEW.html → wireframes.html
- `Stage 18 — Passcode Delivery` --implements--> `createCodeSender()`  [INFERRED]
  ROADMAP.md → apps/api/src/notifications/code-sender.ts
- `Discount Rate Recorded on the Redemption` --implements--> `recordRedemption()`  [INFERRED]
  DECISIONS.md → apps/api/src/redemptions/record.ts
- `Uniform Responses and Timings` --implements--> `verifyAgainstDummy()`  [EXTRACTED]
  docs/security-implementation.md → apps/api/src/security/password.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Redemption Immutability Enforcement Chain** — build_plan_r7_redemption_immutability, docs_security_implementation_database_backstop, decisions_dual_database_urls, deployment_r7_role_separation, security_review_redemption_immutability, costs_managed_postgres_breaks_r7 [EXTRACTED 1.00]
- **Per-Device Outlet Authentication Flow** — decisions_per_device_outlet_tokens, decisions_outlet_device_token_only, apps_api_src_security_outlet_login_token_generateoutletlogintoken, deployment_outlet_device_provisioning, deployment_internal_cidr, runbook_outlet_device_management, security_review_outlet_device_addendum [EXTRACTED 1.00]
- **Production Deployment Pipeline** — roadmap_stage_21_deployment, deployment_four_host_topology, deployment_r7_role_separation, deployment_explicit_migration_step, deployment_verification_checklist, deployment_backups [EXTRACTED 1.00]
- **Three Vite Front Ends Forming One Product Surface** — apps_web_member_index_member_shell, apps_web_admin_index_admin_shell, apps_web_outlet_index_outlet_shell, system_overview_fastify_api [INFERRED 0.85]
- **Production Compose Topology (two networks, three services)** — docker_compose_prod_db, docker_compose_prod_api, docker_compose_prod_web, docker_compose_prod_internal_network, docker_compose_prod_edge_network, docker_compose_prod_mandatory_secrets [EXTRACTED 1.00]
- **Request-Decide-Record Integrity Chain** — system_overview_request_decide_record, system_overview_rate_snapshot, system_overview_redemption_immutability, system_overview_database_role_split, docker_compose_prod_two_database_urls, docker_compose_prod_outlet_fulfilment_config [INFERRED 0.85]
- **Privilege Guest Member Journey (browse benefits, open offer, profile, show card)** — svg_files_a1_offers_list_2_1__offers_list_screen, svg_files_a2_offer_detail_1_1__offer_detail_screen, svg_files_a3_profile_2_1__profile_screen, svg_files_a4_membership_card_2_membership_card_screen [INFERRED 0.85]
- **Outlet Redemption and Savings Accrual Loop** — svg_files_a2_offer_detail_1_1__spa_offer_detail, svg_files_a4_membership_card_2_qr_barcode_placeholder, svg_files_a4_membership_card_2_outlet_redemption_flow, svg_files_a3_profile_2_1__redemption_record, svg_files_a3_profile_2_1__savings_stats_row [INFERRED 0.85]
- **Gold-on-Charcoal Luxury Component Language** — svg_files_a1_offers_list_2_1__discount_percentage_badge, svg_files_a1_offers_list_2_1__guest_limit_chip, svg_files_a1_offers_list_2_1__bottom_tab_bar, svg_files_a2_offer_detail_1_1__call_to_reserve_cta, svg_files_a4_membership_card_2_add_to_wallet_action, svg_files_a4_membership_card_2_privilege_guest_card_art [INFERRED 0.75]
- **Privilege Guest Authentication and Activation Flow (A5 to A7)** — svg_files_a5_signin_1_2__sign_in_screen, svg_files_a6_passcode_1_1__passcode_screen, svg_files_a7_activate_1_2__activate_membership_screen [INFERRED 0.90]
- **Mobile Number as the Sole Identity Credential** — svg_files_a5_signin_1_2__mobile_number_field, svg_files_a6_passcode_1_1__six_digit_otp_input, svg_files_a7_activate_1_2__mobile_number_field, svg_files_a5_signin_1_2__passwordless_phone_authentication [INFERRED 0.85]
- **Shared Branded Header Component Across All Auth Screens** — svg_files_frame_1_brand_lockup, svg_files_frame_1_steigenberger_wordmark_raster, svg_files_a5_signin_1_2__header_hero_placeholder, svg_files_a5_signin_1_2__privilege_guest_eyebrow [INFERRED 0.85]
- **Design Export Shipped Verbatim, Personalisation Overlaid** — svg_files_privilege_guest_card__1__1_1_privilegeguestcardface, apps_web_member_public_assets_card_face_cardface, svg_files_privilege_guest_card__1__1_1_specimennameandnumber, apps_web_member_public_assets_card_face_livetextoverlay, apps_web_member_public_assets_card_back_qrwell [INFERRED 0.85]
- **Licensed Wordmark With No Webfont** — apps_web_member_public_assets_lockup_lockup, apps_web_member_public_assets_lockup_flattenedwordmarkcomposite, apps_web_member_public_assets_lockup_steigenbergerwordmarkstack, svg_files_frame_1_frame1, apps_web_member_public_assets_card_face_cardface [INFERRED 0.85]
- **Five Icons Forming One PWA Install Identity** — apps_web_member_public_apple_touch_icon_appletouchicon, apps_web_member_public_icon_192_icon192, apps_web_member_public_icon_512_icon512, apps_web_member_public_icon_maskable_192_iconmaskable192, apps_web_member_public_icon_maskable_512_iconmaskable512 [EXTRACTED 1.00]
- **Benefit Category Photography Keyed by Offer** — apps_web_member_public_images_benefit_events_eventshero, apps_web_member_public_images_benefit_fnb_fnbhero, apps_web_member_public_images_benefit_spa_spahero, apps_web_member_public_images_benefit_fnb_benefitkeyheroconvention [EXTRACTED 1.00]

## Communities (122 total, 14 thin omitted)

### Community 0 - "Redaction and Claim Codes"
Cohesion: 0.05
Nodes (40): ALLOWED, isAllowedKey(), isSensitiveKey(), redact(), REDACT_PATHS, REDACTED, SENSITIVE, SENSITIVE_KEYS (+32 more)

### Community 1 - "Member App API Client"
Cohesion: 0.09
Nodes (35): api, ApiError, Benefit, BenefitRequest, call(), clearTokens(), ConsentState, MemberProfile (+27 more)

### Community 2 - "Google Sheets Mirror"
Cohesion: 0.09
Nodes (33): main(), GoogleSheetsConfig, requireGoogleSheetsConfig(), conditionalFormats(), createGoogleSheetsPublisher(), extendedValue(), GoogleSheetsPublisher, numericFormats() (+25 more)

### Community 3 - "Reporting Metrics and Suppression"
Cohesion: 0.07
Nodes (35): DIMENSION_NAME_LIST, DIMENSION_NAMES, DimensionName, DIMENSIONS, isDimensionName(), isMetricName(), METRIC_NAME_LIST, METRIC_NAMES (+27 more)

### Community 4 - "Database Seed and Staff Admin"
Cohesion: 0.09
Nodes (29): BENEFITS, BenefitSeed, main(), MEMBERS, OUTLETS, prisma, adminStaffRoutes(), changePasswordSchema (+21 more)

### Community 5 - "Member App Dependencies"
Cohesion: 0.06
Nodes (34): dependencies, @pgp/ui, react, react-dom, react-qr-code, react-router-dom, devDependencies, @types/react (+26 more)

### Community 6 - "Offers and Benefit Screens"
Cohesion: 0.09
Nodes (34): Benefit Category Card, Offers / Profile Bottom Tab Bar, Details Action Button, Discount Percentage Badge, F&B Outlets Benefit (25%), Guest Limit Chip (Maximum/Minimum Guests), Lifestyle & SPG Benefit (30%), Meetings & Events Benefit (25%) (+26 more)

### Community 7 - "Monorepo Root Package"
Cohesion: 0.06
Nodes (32): concurrently, devDependencies, concurrently, typescript, engines, node, typescript, name (+24 more)

### Community 8 - "SMS Delivery Transport"
Cohesion: 0.11
Nodes (21): assertSingleSegment(), broadcast(), createSmsSender(), passcodeBody(), SmsSenderOptions, BatchSummary, createDispatcher(), DispatcherOptions (+13 more)

### Community 9 - "Admin App Dependencies"
Cohesion: 0.06
Nodes (30): dependencies, @pgp/ui, react, react-dom, react-qr-code, devDependencies, @types/react, @types/react-dom (+22 more)

### Community 10 - "Outlet App Dependencies"
Cohesion: 0.06
Nodes (30): dependencies, @pgp/ui, react, react-dom, @zxing/browser, devDependencies, @types/react, @types/react-dom (+22 more)

### Community 11 - "Admin Member Management"
Cohesion: 0.14
Nodes (25): toCsv(), adminMemberRoutes(), cardExportQuerySchema, ConsentRow, createMemberSchema, currentConsent(), idParamSchema, issueClaimCodeData() (+17 more)

### Community 12 - "Redemption Recording"
Cohesion: 0.14
Nodes (25): logDeliveryOutcome(), RECORDED_SELECT, RecordedRedemption, recordRedemption(), RecordRedemptionFailure, RecordRedemptionInput, RecordRedemptionResult, replayContext() (+17 more)

### Community 13 - "Authorization and Audit"
Cohesion: 0.13
Nodes (21): authorizationPlugin(), fastify, FastifyContextConfig, FastifyRequest, AuditAction, AuditEntry, Actor, actorFor() (+13 more)

### Community 14 - "Outlet App API Client"
Cohesion: 0.16
Nodes (20): api, ApiError, call(), clearTokens(), idempotencyKey(), isSignedIn(), logout(), Outlet (+12 more)

### Community 15 - "Identity Payload Rules"
Cohesion: 0.13
Nodes (23): permissionsForRole(), R10 — The Payload Identifies, Never Authorises, R11 — No Member Enumeration for Outlet Staff, R3 — Sequential Public Numbers, Opaque Internal Reference, Benefit Request Replaces the Guest QR, 160-Bit Crockford Base32 Claim Codes, Exhaustive Role Matrix, No Wildcard, Membership Numbers from a PostgreSQL Sequence (+15 more)

### Community 16 - "Admin Panel UI"
Cohesion: 0.12
Nodes (16): BenefitAction, BenefitDraft, BenefitEditor(), ChildDiscountDraft, draftFromBenefit(), Members(), Outlets(), Redemptions() (+8 more)

### Community 17 - "Sign-In and Passcode Design"
Cohesion: 0.14
Nodes (23): Hero Header Image Placeholder (Lobby / Evening), Have an Invitation Code? Entry Point, Mobile Number Field (+974), Passwordless Phone-Number Authentication, Privilege Guest Programme Eyebrow, Send Passcode Action, A5 Sign-In Screen, Terms and Privacy Consent Notice (+15 more)

### Community 18 - "Base TypeScript Config"
Cohesion: 0.09
Nodes (22): compilerOptions, esModuleInterop, exactOptionalPropertyTypes, forceConsistentCasingInFileNames, isolatedModules, lib, module, moduleResolution (+14 more)

### Community 19 - "Code Delivery Senders"
Cohesion: 0.16
Nodes (15): CodeDelivery, CodePurpose, DeliveryOutcome, LifecycleDelivery, LifecyclePurpose, maskEmail(), maskPhone(), MemberDelivery (+7 more)

### Community 20 - "Build Plan and Stack Decisions"
Cohesion: 0.15
Nodes (21): resolvePrincipal(), Archived Build Plan, Six Prime Directives, R16 — Members Are Suspended, Never Deleted, Monorepo Repository Structure, Decided Stack, Technical Decision Log, HS256 Access Tokens Within a Single Deployable (+13 more)

### Community 21 - "Admin App API Client"
Cohesion: 0.15
Nodes (19): AdminBenefit, ApiError, call(), clearTokens(), downloadFile(), endSession(), INSUFFICIENT_DATA, MemberRow (+11 more)

### Community 22 - "Deployment and Immutability"
Cohesion: 0.12
Nodes (21): Primary Acceptance Journey, R7 — Redemptions Are Immutable, Managed Postgres Silently Breaks R7, Shared Caddy api_proxy Snippet with CIDR Restriction Inside, CHECK Constraints for Invariants Prisma Cannot Express, Two Database URLs: App Role and Owner Role, Split Liveness and Readiness Probes, Nightly Encrypted Backups and Restore Drill (+13 more)

### Community 23 - "Environment and Dev Server"
Cohesion: 0.15
Nodes (15): DIVIDER, line(), main(), envSchema, loadEnv(), optionalBase64, optionalEmail, optionalNonEmptyString (+7 more)

### Community 24 - "API App Bootstrap"
Cohesion: 0.13
Nodes (17): buildApp(), fastify, errorHandlerPlugin(), fastify, FastifyInstance, prismaPlugin(), adminOutletRoutes(), benefitFields (+9 more)

### Community 25 - "MFA and Auth Routes"
Cohesion: 0.23
Nodes (18): authRoutes(), codesMatch(), decryptMfaSecret(), encryptionKey(), encryptMfaSecret(), generateMfaSecret(), generateRecoveryCode(), generateRecoveryCodes() (+10 more)

### Community 26 - "Rate Limiting and Journey Test"
Cohesion: 0.13
Nodes (15): Bucket, buckets, RateLimitResult, RateLimitRule, resetRateLimits(), journey, ownerPrisma, clearReplayMarker() (+7 more)

### Community 27 - "API Dependencies"
Cohesion: 0.11
Nodes (19): dependencies, fastify, @fastify/cookie, googleapis, jose, @node-rs/argon2, otplib, @pgp/shared (+11 more)

### Community 28 - "Auth Route Schemas"
Cohesion: 0.15
Nodes (17): logoutSchema, mfaEnrollConfirmSchema, mfaEnrollStartSchema, mfaVerifySchema, PUBLIC_ROUTE, refreshSchema, requestOtpSchema, sendTooManyRequests() (+9 more)

### Community 29 - "Identity Code Signing"
Cohesion: 0.18
Nodes (16): hmacSecret(), IdentityCodeFailureReason, IdentityCodeResult, issueCardCode(), issueRotatingCode(), sign(), signatureMatches(), verifyIdentityCode() (+8 more)

### Community 30 - "Outlet and Admin Access Decisions"
Cohesion: 0.13
Nodes (19): One Hotel-Facing Account Type: Administrator, In-Memory Two-Dimensional Rate Limiter, Outlet Authentication Is Device-Token-Only, Outlet Accounts Authenticating Through Google, Per-Device Outlet Tokens, The Benefit Request Becomes a Notice, WhatsApp Considered and Rejected, Outlet Device Token Provisioning (+11 more)

### Community 31 - "HTTP Error Types"
Cohesion: 0.16
Nodes (10): ForbiddenError, HttpError, NotFoundError, RateLimitedError, UnauthorizedError, createOutletDeviceSchema, DEVICE_VIEW, idParamSchema (+2 more)

### Community 32 - "API Dev Dependencies"
Cohesion: 0.12
Nodes (17): devDependencies, prisma, supertest, tsx, @types/node, @types/nodemailer, @types/supertest, typescript (+9 more)

### Community 33 - "OTP Generation and Verify"
Cohesion: 0.19
Nodes (15): constantTimeEqual(), generateOtpCode(), hashOtpCode(), hmacSecret(), IssuedOtp, issueOtp(), maxAttempts(), OtpFailureReason (+7 more)

### Community 34 - "Member Profile Screens"
Cohesion: 0.20
Nodes (13): ActivityRow(), CardModal(), netVisits(), Profile(), RequestCard(), dateAndTime, dateOnly, formatDate() (+5 more)

### Community 35 - "Initial Database Schema"
Cohesion: 0.23
Nodes (12): "AuditLog", "Benefit", "ClaimCode", "ConsentRecord", "Member", "OtpCode", "Outlet", "Redemption" (+4 more)

### Community 36 - "Benefit Request Lifecycle"
Cohesion: 0.20
Nodes (12): requestExpiryPlugin(), createSchema, expireStaleRequests(), MEMBER_VIEW, outletsForBenefit(), queueQuerySchema, requestRoutes(), serializeForMember() (+4 more)

### Community 37 - "Admin TypeScript Config"
Cohesion: 0.12
Nodes (15): compilerOptions, jsx, lib, noEmit, types, extends, include, DOM (+7 more)

### Community 38 - "Member TypeScript Config"
Cohesion: 0.12
Nodes (15): compilerOptions, jsx, lib, noEmit, types, extends, include, DOM (+7 more)

### Community 39 - "Outlet TypeScript Config"
Cohesion: 0.12
Nodes (15): compilerOptions, jsx, lib, noEmit, types, extends, include, DOM (+7 more)

### Community 40 - "Hosting and Cost Model"
Cohesion: 0.15
Nodes (16): AWS me-central-1 / me-south-1 Alternative, Azure Qatar Central Hosting, Publishing and Running Cost Model, Google Play Organisation Account Exemption, In-Region Qatar Hosting Is Free, Cost-Gated Launch Sequence, SMS Is the Only Steeply Scaling Cost, Quoted vs Derived Sourcing Discipline (+8 more)

### Community 41 - "Shared Package Manifest"
Cohesion: 0.12
Nodes (15): dependencies, zod, devDependencies, typescript, exports, typescript, zod, main (+7 more)

### Community 42 - "Outlet Login Tokens"
Cohesion: 0.20
Nodes (9): generateOutletLoginToken(), hashOutletLoginToken(), OUTLET_LOGIN_TOKEN_PREFIX, BOM, fixtureMemberIds, ownerPrisma, createOutletDeviceFixture(), createdRedemptionIds (+1 more)

### Community 43 - "Refresh Token Rotation"
Cohesion: 0.20
Nodes (13): generateOpaqueToken(), hashToken(), identifyRefreshToken(), IssuedRefreshToken, IssueRefreshTokenInput, RefreshTokenError, RefreshTokenFailureReason, RefreshTokenLookup (+5 more)

### Community 44 - "Product Definition"
Cohesion: 0.15
Nodes (15): Email-First Passcode Delivery, Passcodes Delivered by Email over SMTP, Member Guest App, No Points, Tiers or Balances, Invitation-Only Onboarding and Claim Flow, Product Open Questions, Three-Phase Delivery, Steigenberger Doha Privilege Guest Program (+7 more)

### Community 45 - "Docker Compose Topology"
Cohesion: 0.24
Nodes (15): db — postgres:15-alpine (dev), Development Compose Stack, Postgres Init Scripts Mount, api Service, db — postgres:16-alpine (prod), edge Network, internal Network, Production Compose Stack (pgp) (+7 more)

### Community 46 - "NPM Script Commands"
Cohesion: 0.14
Nodes (14): scripts, dev, generate, mail:test, mfa:code, migrate, migrate:dev, predev (+6 more)

### Community 47 - "Route Permission Rules"
Cohesion: 0.21
Nodes (14): PERMISSIONS, Eighteen Business Rules, Things That Will Go Wrong, R17 — Every Route Declares a Permission, R18 — Out-of-Scope Records Return 404, 403 for a Route, 404 for an Out-of-Scope Record, R17 Enforced by an onRoute Hook, scopedWhere Instead of Spreading the Scope Fragment (+6 more)

### Community 48 - "API Test Harness"
Cohesion: 0.18
Nodes (8): BuildAppOptions, FastifyInstance, Env, CodeSender, capturingSender, deliveries, outletDeviceIds, ownerPrisma

### Community 49 - "Refresh Session Cookie"
Cohesion: 0.22
Nodes (8): baseOptions(), clearRefreshCookie(), readRefreshToken(), REFRESH_COOKIE, REFRESH_COOKIE_PATH, setRefreshCookie(), ownerPrisma, ownerPrisma

### Community 50 - "API TypeScript Config"
Cohesion: 0.15
Nodes (12): compilerOptions, noEmit, types, extends, include, src/**/*.ts, ../../tsconfig.base.json, node (+4 more)

### Community 51 - "Admin Reporting UI"
Cohesion: 0.15
Nodes (6): api, BenefitGroup, ReportMember, ReportSummary, Props, RecentRedemption

### Community 52 - "PWA Icons and Hero Imagery"
Cohesion: 0.17
Nodes (13): Apple Touch Icon (180x180 gold diamond on navy), PWA Icon 192 (any purpose, full-bleed mark), Gold Diamond Brand Mark (Privilege Guest install identity), PWA Icon 512 (any purpose, splash and store size), PWA Maskable Icon 192 (mark inset for Android safe zone), PWA Maskable Icon 512 (mark inset for Android safe zone), Arrival Moment: One Photograph Across Sign-In and Activation, Auth Hero: Steigenberger Dubai Exterior at Dusk (+5 more)

### Community 53 - "Staff MFA Decisions"
Cohesion: 0.18
Nodes (13): Consent Records a Declined Channel Explicitly, MFA Scope Resolved from the Narrower Sentence, Refresh Tokens Hashed with SHA-256, Dashboard Refreshes Through One Shared Promise, STAFF_MFA_REQUIRED Development Switch, Refresh Rotation with Family Reuse Detection, Q5 — Staff MFA Gap, Stage 19 — Staff MFA (+5 more)

### Community 54 - "Security Hardening Stages"
Cohesion: 0.21
Nodes (13): Refresh Token Moves to an httpOnly Cookie, IDENTITY_CODE_HMAC_SECRET Rotation, API Hardening, Client Token Storage Rules, Stage Ledger 0 to 28, Stage 20 — Hardening for a Public Network, Checklist Status Summary, Deferred — Real-Time Alerting (+5 more)

### Community 55 - "Membership Card Artwork"
Cohesion: 0.26
Nodes (12): card-back.svg (shipped card reverse), QR Well, card-face.svg (shipped card front), Charcoal Card Gradient, Ship the Export, Overlay the Live Text, Flattened Wordmark Composite, lockup.svg (Steigenberger brand lockup), Steigenberger Wordmark Stack (+4 more)

### Community 56 - "Scoped Read Lint Test"
Cohesion: 0.24
Nodes (10): EXEMPT, Finding, findUnscopedReads(), READ_METHODS, ROUTES_DIR, SCANNED_DIRS, scanSource(), SCOPED_MODELS (+2 more)

### Community 57 - "Privacy and Data Model"
Cohesion: 0.20
Nodes (11): Search-Engine Exclusion (noindex, nofollow), Outlet App HTML Entry, Outlet Fulfilment Configuration, Append-Only Audit Trail, Eleven-Table Data Model, Health Data Excluded by Construction, Two-Layer Log Redaction, Confidentiality of the Membership List (+3 more)

### Community 58 - "Wireframe Drafts"
Cohesion: 0.24
Nodes (11): Pinch-Zoom Deliberately Allowed, Wireframes Draft 2 (docs copy), No Points, Tiers or Balances, Admin Dashboard Wireframes (03), Per-Channel Consent, Unticked by Default, Wireframes Draft 2 (revised scope), Masked Contact Details and Visible Access Notice, Member App Screens (01) (+3 more)

### Community 59 - "UI Package Exports"
Cohesion: 0.18
Nodes (10): exports, ./base.css, ./format, ./foundation.css, ./reset.css, ./tokens.css, name, private (+2 more)

### Community 60 - "Admin Chart Components"
Cohesion: 0.29
Nodes (7): Figure, isWithheld(), BarChart(), BarRow, FigureValue(), formatCount(), Meter()

### Community 61 - "Benefits and Roadmap Decisions"
Cohesion: 0.29
Nodes (10): R14 — Benefit Values Are Database Rows, Capacitor over React Native, Wallet Pass Update Web Service Cost, Design Tokens in packages/ui, Not Tailwind, Fixed Benefit Discount Schedule, Seeded Benefit Values, BenefitTranslation Table for Arabic Content, Stage 17 — Design System and Styling (+2 more)

### Community 62 - "Member Authentication Flow"
Cohesion: 0.24
Nodes (10): IDENTITY_CODE_HMAC_SECRET, SMTP Passcode Delivery, Account Enumeration and Timing Resistance, Invitation and Activation Flow, Member Guest App, Member OTP Sign-in, Digital Card Without QR Credential, Rate Snapshot on Redemption (+2 more)

### Community 63 - "Client Invariant Test"
Cohesion: 0.25
Nodes (4): CLIENT_APPS, memberSources(), REPO_ROOT, sourceFiles()

### Community 64 - "Outlet Scan Test"
Cohesion: 0.25
Nodes (6): AnyDelivery, capturingSender, deliveries, outletDeviceIds, ownerPrisma, resolveThen()

### Community 65 - "Member App Entry and Assets"
Cohesion: 0.36
Nodes (8): Member App HTML Entry, Member PWA and Status-Bar Metadata, Fairplex Narrow Font Drop-In, Hero Image Drop-In Convention, Fixed Benefit Discount Schedule, Benefit Versioning and Attribution, Privilege Guest Program, Benefit Management as the Test of Delivery

### Community 66 - "Security Review Findings"
Cohesion: 0.25
Nodes (8): Mandatory Secret Interpolation (:?), Counter Lookup Rate Limit, Google Sheets Sync Configuration, Finding: 25 Failing Tests, One Cause, Google Sheets Mirror, Pre-Launch Blockers, Finding: SECURITY-REVIEW.md Documentation Drift, Finding: Stale VERIFICATION_SESSION_HMAC_SECRET

### Community 67 - "Shared TypeScript Config"
Cohesion: 0.25
Nodes (7): compilerOptions, noEmit, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 68 - "Windows Dev Database Script"
Cohesion: 0.54
Nodes (7): Assert-PostgresInstalled(), Get-ServerRunning(), Invoke-Psql(), New-Cluster(), Reset-Cluster(), Start-Server(), Stop-Server()

### Community 69 - "MFA Code Dev Helper"
Cohesion: 0.52
Nodes (6): box(), main(), secondsRemaining(), sleep(), write(), roleRequiresMfa()

### Community 70 - "Password Storage and Screening"
Cohesion: 0.29
Nodes (7): MINIMUM_PASSWORD_LENGTH, Argon2id Parameters Pinned in Code, Breached-Password Screening via HIBP k-Anonymity, /admin/staff Management Endpoints, Argon2id Password Storage, Password Pepper in a Key Management Service, Staff Management Was Never Built

### Community 71 - "Core Security Architecture"
Cohesion: 0.29
Nodes (7): Split JWT Audiences (member vs staff), Caddy Edge Proxy, Deny-by-Default Route Authorisation, Fastify API, Query Scoping in the WHERE Clause, Refresh Token Rotation with Reuse Detection, Two-Audience Token Separation

### Community 73 - "Admin Surface Access"
Cohesion: 0.40
Nodes (6): Admin App HTML Entry, INTERNAL_CIDR Network Restriction, Administrator Password + TOTP Sign-in, Administrator Panel, Reporting and CSV Export, Small-Cohort Suppression

### Community 74 - "Button Component"
Cohesion: 0.47
Nodes (4): ButtonProps, CommonProps, LinkProps, Variant

### Community 75 - "App Navigation Helpers"
Cohesion: 0.47
Nodes (5): AppLink(), NavKind, NavOptions, stamp(), useAppNavigate()

### Community 76 - "API Package Manifest"
Cohesion: 0.40
Nodes (4): name, private, type, version

### Community 79 - "Operations Runbook"
Cohesion: 0.67
Nodes (4): Environment Deviations, Local Startup: Four Processes, What Is Not Covered by Tests, Operations Runbook

## Ambiguous Edges - Review These
- `Digital Card Without QR Credential` → `IDENTITY_CODE_HMAC_SECRET`  [AMBIGUOUS]
  docker-compose.prod.yml · relation: conceptually_related_to
- `A6 Passcode Verification Screen` → `Activate Membership Action`  [AMBIGUOUS]
  svg files/A7-activate 1 (2).svg · relation: references
- `Auth Hero: Steigenberger Dubai Exterior at Dusk` → `Benefit Hero Convention: File Named for the Offer Key`  [AMBIGUOUS]
  apps/web-member/public/images/auth.webp · relation: conceptually_related_to

## Knowledge Gaps
- **454 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+449 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **14 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Digital Card Without QR Credential` and `IDENTITY_CODE_HMAC_SECRET`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `A6 Passcode Verification Screen` and `Activate Membership Action`?**
  _Edge tagged AMBIGUOUS (relation: references) - confidence is low._
- **What is the exact relationship between `Auth Hero: Steigenberger Dubai Exterior at Dusk` and `Benefit Hero Convention: File Named for the Offer Key`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `loadEnv()` connect `Environment and Dev Server` to `Redaction and Claim Codes`, `OTP Generation and Verify`, `Google Sheets Mirror`, `Outlet Scan Test`, `Reporting Metrics and Suppression`, `Database Seed and Staff Admin`, `Health Check Endpoint`, `Outlet Login Tokens`, `API Test Harness`, `Refresh Session Cookie`, `Build Plan and Stack Decisions`, `Staff MFA Decisions`, `Rate Limiting and Journey Test`?**
  _High betweenness centrality (0.024) - this node is a cross-community bridge._
- **Why does `Security Implementation Specification v3` connect `Build Plan and Stack Decisions` to `Reporting Metrics and Suppression`, `Password Storage and Screening`, `Hosting and Cost Model`, `Route Permission Rules`, `Identity Payload Rules`, `Security Hardening Stages`, `Deployment and Immutability`, `Outlet and Admin Access Decisions`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **Why does `recordRedemption()` connect `Redemption Recording` to `Reporting Metrics and Suppression`, `Admin Member Management`, `Benefit Request Lifecycle`, `Outlet and Admin Access Decisions`?**
  _High betweenness centrality (0.014) - this node is a cross-community bridge._
- **Are the 17 inferred relationships involving `buildApp()` (e.g. with `redact()` and `authorizationPlugin()`) actually correct?**
  _`buildApp()` has 17 INFERRED edges - model-reasoned connections that need verification._