# BUILD PLAN — Privilege Guest Program

**Read this file completely before writing any code.**

You are building the backend logic and minimal working clients for a hotel membership programme. This document is the authoritative build order. The specification documents referenced below are the authoritative source of *what* to build.

> **If your tool auto-reads a specific filename** (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`), rename or symlink this file accordingly.

---

# 0. Prime directives

Read these once, then follow them for every stage.

**1. Logic only. No styling.**
No CSS files, no Tailwind, no component libraries, no design work. Use plain semantic HTML. Ugly is correct at this stage. If you find yourself writing a `class` attribute for appearance, stop.

**2. Do not invent features.**
Build only what `docs/product-definition.md` specifies. If something seems missing, it is either deliberately out of scope or an open question. Do not fill gaps with assumptions.

**3. Security rules are not negotiable.**
`docs/security-implementation.md` overrides convenience, speed, and your own preferences. Where any document conflicts with it on a security matter, it wins.

**4. Stop and ask rather than guess.**
Section 11 of the product definition lists open questions. If a stage depends on one, implement the documented assumption, add a `TODO(open-question)` comment, and record it in `PROGRESS.md`. Do not silently decide.

**5. One stage at a time.**
Complete a stage, make its acceptance criteria pass, update `PROGRESS.md`, commit. Then start the next. Do not work ahead.

**6. Tests are part of the stage, not a later chore.**
A stage is not complete until its acceptance criteria are verified by a passing test.

---

# 1. Reference documents

Place these in `docs/` before starting.

| File | Status | What it is |
|---|---|---|
| `docs/product-definition.md` | **CURRENT — authoritative** | What the product is, scope, features, business rules |
| `docs/security-implementation.md` | **CURRENT — authoritative** | Auth, tokens, authorization, hashing, audit. Engineering-level |
| `docs/wireframes.html` | **CURRENT — authoritative** | Every screen, with annotations explaining each decision |
| `docs/foundations-four-things.md` | Background | Domain concepts. Read for context, not requirements |
| `docs/security-architecture.md` | **STALE** | Written for an earlier, larger scope. Threat-model and legal sections still apply; ignore anything about points, ledgers or multi-tenant isolation |
| `docs/build-plan.md` | **STALE** | Written for an earlier scope. Superseded by this file |

**Open `docs/wireframes.html` in a browser.** The numbered notes beside each screen explain *why* each element exists. Those notes are requirements, not commentary.

---

# 2. What you are building

A membership programme for a single hotel property. Members receive a fixed set of benefits — percentage discounts across dining, rooms, spa, events and lifestyle services. Membership is **invitation-only**.

**Three surfaces:**

1. **Member app** — browse benefits, search, view digital card, see own history
2. **Verification page** — staff scan or type a membership number, record a benefit being used
3. **Admin dashboard** — manage members, edit benefits, view redemption records and reports

**There are no points, no tiers, no balances, no earned currency.** Benefits are granted on joining and never change per member. If you find yourself writing a `balance` column, you have misread the specification.

---

# 3. Stack — decided, do not substitute

| Concern | Choice |
|---|---|
| Language | TypeScript, strict mode |
| Runtime | Node 20+ |
| API framework | Fastify |
| Database | PostgreSQL 15+ |
| ORM | Prisma |
| Validation | Zod |
| Password hashing | `@node-rs/argon2` |
| Tokens | `jose` |
| Testing | Vitest + Supertest |
| Clients | React + Vite (three separate apps) |
| Monorepo | npm workspaces |

**Rationale for the clients:** three separate React apps rather than one, because they have entirely different authentication and authorization models. Do not merge them.

---

# 4. Repository structure

```
/
├── docs/                      reference documents (read-only)
├── apps/
│   ├── api/                   Fastify server — the bulk of the work
│   ├── web-member/            member client
│   ├── web-verify/            staff verification client
│   └── web-admin/             admin dashboard client
├── packages/
│   └── shared/                Zod schemas and types shared by api and clients
├── PROGRESS.md                you maintain this — see section 5
├── DECISIONS.md               you maintain this — see section 5
└── BUILD-PLAN.md              this file
```

---

# 5. Progress tracking — required

You maintain two files. Update them at the end of every stage, before committing.

## PROGRESS.md

Create it in Stage 0 with this exact structure:

```markdown
# Progress

Last updated: <date>
Current stage: <n>

## Stages
- [ ] 0 — Foundation
- [ ] 1 — Data model
- [ ] 2 — Authentication
- [ ] 3 — Authorization
- [ ] 4 — Member lifecycle
- [ ] 5 — Benefits
- [ ] 6 — Identity codes
- [ ] 7 — Redemption
- [ ] 8 — Reporting
- [ ] 9 — Audit logging
- [ ] 10 — Member client
- [ ] 11 — Verification client
- [ ] 12 — Admin client
- [ ] 13 — Integration & acceptance
- [ ] 14 — Security review

## Stage log
### Stage 0 — Foundation
Status: complete
Files created: ...
Acceptance: ...
Notes: ...

## Open questions blocking work
- [ ] Q1: ...

## Deviations from spec
- None
```

## DECISIONS.md

Append an entry whenever you make a technical choice the specification did not dictate. Format: date, decision, alternatives considered, reason. Keep entries to three or four lines.

---

# 6. Business rules — implement exactly

These are the logic. Everything else is plumbing.

| # | Rule | Enforced where |
|---|---|---|
| R1 | A claim code is single-use, bound to one member, and expires | Stage 4 |
| R2 | A claim code is cryptographically random and unrelated to the membership number | Stage 4 |
| R3 | Membership numbers are sequential and public (`PG-0003`); the internal member reference is an opaque random ID | Stage 1 |
| R4 | Only an `ACTIVE` member may have a benefit recorded | Stage 7 |
| R5 | Party size must not exceed the benefit's `maxGuests` | Stage 7 |
| R6 | Party size must meet the benefit's `minGuests` where set (events require 20) | Stage 7 |
| R7 | Redemptions are immutable — no `UPDATE`, no `DELETE`. A correction is a new reversing row | Stage 7 |
| R8 | Redemption creation is idempotent by client-supplied key | Stage 7 |
| R9 | The member identity payload rotates and is rejected once stale (default 24h, configurable) | Stage 6 |
| R10 | The identity payload identifies only — it never authorises a discount by itself | Stage 6 |
| R11 | `outlet_staff` has **no** endpoint that lists, searches or enumerates members | Stage 3 |
| R12 | Member lookup requires an exact membership number or a scanned payload — no partial matching | Stage 7 |
| R13 | Reporting suppresses any cohort smaller than 5 | Stage 8 |
| R14 | Benefit values (percentages, caps, phone numbers, terms) are database rows, never constants in code | Stage 5 |
| R15 | Consent is recorded per channel with timestamp; withdrawal takes effect immediately | Stage 4 |
| R16 | Members are suspended, never deleted | Stage 4 |
| R17 | Every route declares a required permission; an undeclared route fails at startup | Stage 3 |
| R18 | Out-of-scope records return 404, never 403 | Stage 3 |

**R14 is the acceptance test for the whole project.** Changing the dining discount from 25% to 20% must be a database update through an admin endpoint. If it requires a code change, the build has failed regardless of what else works.

---

# 7. Stages

Each stage lists what to read, what to build, and how you know it is done.

---

## Stage 0 — Foundation

**Read:** this file, `docs/product-definition.md` sections 1–3.

**Build:**
- npm workspaces monorepo per section 4
- TypeScript strict configuration
- Fastify server that starts and serves `GET /health`
- Docker Compose with PostgreSQL
- Prisma initialised and connecting
- Vitest configured, one passing placeholder test
- `.env.example` with every variable named
- `PROGRESS.md` and `DECISIONS.md` created

**Acceptance:**
- `npm run dev` starts the API
- `GET /health` returns 200
- `npm test` passes
- `npx prisma migrate dev` runs against the container

---

## Stage 1 — Data model

**Read:** `docs/product-definition.md` sections 2, 6, 7. `docs/security-implementation.md` sections 3, 7.

**Build:** the Prisma schema and initial migration.

```
Member
  id              String   @id @default(uuid())   // opaque internal reference
  memberNumber    String   @unique                // "PG-0003", public, sequential
  fullName        String
  phone           String?  @unique
  email           String?
  status          MemberStatus                    // ACTIVE | SUSPENDED
  joinedAt        DateTime
  claimedAt       DateTime?                       // null until app activated
  createdByUserId String
  createdAt       DateTime @default(now())

ClaimCode
  id         String   @id @default(uuid())
  memberId   String
  codeHash   String                               // never store plaintext — R2
  expiresAt  DateTime
  usedAt     DateTime?
  createdAt  DateTime @default(now())

StaffUser
  id            String   @id @default(uuid())
  fullName      String
  email         String   @unique
  passwordHash  String
  role          Role                              // ADMINISTRATOR | MANAGER | OUTLET_STAFF | SUPPORT
  outletId      String?                           // required when role = OUTLET_STAFF
  tokenVersion  Int      @default(1)              // increment to invalidate all tokens
  mfaSecret     String?
  status        UserStatus
  createdAt     DateTime @default(now())

Outlet
  id     String  @id @default(uuid())
  name   String
  kind   OutletKind                               // DINING | SPA | ROOMS | EVENTS | OTHER
  active Boolean @default(true)

Benefit
  id                  String  @id @default(uuid())
  key                 String  @unique             // "fnb", "rooms", "spa", "events", "lifestyle"
  title               String
  category            String
  discountPct         Decimal
  secondaryLabel      String?                     // "Retail products"
  secondaryPct        Decimal?
  childRules          Json?                       // { "6-12": 50, "0-6": 100 }
  maxGuests           Int?                        // R5
  minGuests           Int?                        // R6
  reservationPhone    String?
  terms               String
  published           Boolean @default(false)
  sortOrder           Int
  version             Int     @default(1)
  updatedByUserId     String?
  updatedAt           DateTime @updatedAt

Redemption                                         // immutable — R7
  id               String   @id @default(uuid())
  memberId         String
  benefitId        String
  outletId         String
  staffUserId      String
  partySize        Int?
  billAmountMinor  Int?                            // minor units (fils). Never floats
  idempotencyKey   String   @unique                // R8
  reversesId       String?                         // set on a reversing entry
  occurredAt       DateTime @default(now())

ConsentRecord
  id             String   @id @default(uuid())
  memberId       String
  channel        Channel                           // EMAIL | SMS
  granted        Boolean
  wordingVersion String
  recordedAt     DateTime @default(now())

RefreshToken
  id         String   @id @default(uuid())
  subjectId  String
  subjectType SubjectType                          // MEMBER | STAFF
  familyId   String
  tokenHash  String
  expiresAt  DateTime
  usedAt     DateTime?
  revokedAt  DateTime?

AuditLog
  id          String   @id @default(uuid())
  actorType   String
  actorId     String?
  action      String                               // "member.viewed", "benefit.updated"
  subjectType String?
  subjectId   String?
  metadata    Json?
  ipAddress   String?
  occurredAt  DateTime @default(now())

OtpCode
  id         String   @id @default(uuid())
  phone      String
  codeHash   String
  expiresAt  DateTime
  attempts   Int      @default(0)
  usedAt     DateTime?
```

**Also build:**
- A seed script creating: 5 outlets, the 5 benefits with real values from `docs/product-definition.md` section 2, one administrator, one outlet staff user, three test members
- A migration revoking `UPDATE` and `DELETE` on `Redemption` for the application role (R7)

**Acceptance:**
- Migration applies cleanly
- Seed populates all five benefits with correct percentages and guest caps
- A raw `UPDATE` against `Redemption` as the app role is rejected by the database
- `billAmountMinor` is an integer everywhere — no floating point money

---

## Stage 2 — Authentication

**Read:** `docs/security-implementation.md` sections 3 and 4 in full. Implement them literally.

**Build:**
- Argon2id hashing with the exact parameters given (m=65536, t=3, p=2)
- Constant-time comparison everywhere
- OTP issue and verify: hashed at rest, 5-minute TTL, single use, max 5 attempts
- JWT access tokens with `iss`, `aud`, `sub`, `role`, `tv`, `jti`, short expiry
- Algorithm pinned server-side — never read `alg` from the token
- Opaque refresh tokens, hashed at rest, with family ID
- **Refresh reuse detection: replaying a spent token revokes the entire family**
- Token version check on every request
- Rate limiting: strict on OTP and login, per IP and per identifier
- Uniform responses and timing on login and activation — no account enumeration

**Endpoints:**
```
POST /auth/staff/login
POST /auth/member/request-otp
POST /auth/member/verify-otp
POST /auth/refresh
POST /auth/logout
POST /auth/logout-all
```

**Acceptance — each is a test:**
- A token with `alg: none` is rejected
- A token with a modified `role` claim is rejected
- An expired token is rejected
- A token with the wrong `aud` is rejected
- Replaying a used refresh token revokes the family and forces re-auth
- Incrementing `tokenVersion` invalidates existing access tokens
- OTP fails after 5 attempts
- Login timing does not differ measurably between existing and non-existent accounts

---

## Stage 3 — Authorization

**Read:** `docs/security-implementation.md` section 5 in full.

**Build:**
- A route registration wrapper requiring a `permission` field
- **An undeclared route throws at startup** (R17) — this is the single most important control in the build
- Role-to-permission mapping per the matrix in the security document
- Request-scoped principal resolution
- `scopeFor(principal)` helper applied inside every query's `where` clause
- 404 for out-of-scope records, never 403 (R18)

**Acceptance:**
- Registering a route without a `permission` field prevents the server starting
- An authorization matrix test covers every role against every endpoint, with declared expectations
- Fetching another member's record by ID as `outlet_staff` returns 404
- No handler loads a record and then checks permission afterwards — scope is in the query

---

## Stage 4 — Member lifecycle

**Read:** `docs/product-definition.md` section 8. `docs/wireframes.html` screens 1, 2, 11.

**Build:**
- Admin creates a member; membership number auto-assigned sequentially
- Claim code generated: ≥128 bits entropy, unrelated to membership number (R2), stored hashed, expiring
- Activation: claim code + phone → OTP → consent capture → membership claimed
- Claim code consumed atomically; a second attempt fails (R1)
- Consent recorded per channel with wording version (R15)
- Suspend and reinstate — never delete (R16)
- Resend claim code

**Endpoints:**
```
POST   /admin/members
GET    /admin/members
GET    /admin/members/:id
PATCH  /admin/members/:id
POST   /admin/members/:id/suspend
POST   /admin/members/:id/reinstate
POST   /admin/members/:id/resend-claim
POST   /member/claim
GET    /member/me
PATCH  /member/me/consent
```

**Acceptance:**
- A claim code cannot be used twice
- An expired claim code is rejected
- Claim codes are not derivable from the membership number
- Consent is stored per channel with a timestamp
- Suspension blocks redemption but preserves history
- `GET /admin/members` is unreachable by `outlet_staff` (R11)

---

## Stage 5 — Benefits

**Read:** `docs/product-definition.md` sections 2 and 7. `docs/wireframes.html` screens 4, 5, 14.

**Build:**
- Full CRUD, administrator-only
- Every value from the printed benefits sheet is a database field (R14)
- Publish and unpublish
- Version increment and attribution on every change
- Public read endpoint returning published benefits only

**Endpoints:**
```
GET    /benefits                  published only, member-facing
GET    /admin/benefits
POST   /admin/benefits
PATCH  /admin/benefits/:id
POST   /admin/benefits/:id/publish
```

**Acceptance:**
- **Changing the dining discount from 25% to 20% via `PATCH` changes what members see, with zero code changes.** This is the project's headline acceptance test
- No percentage, guest cap, phone number or term appears as a literal anywhere in application code
- Unpublished benefits are invisible to members
- Every change writes an audit entry naming the user

---

## Stage 6 — Identity codes

**Read:** `docs/security-implementation.md` section 7. `docs/wireframes.html` screen 7.

**Build:**
- Payload format: `v1.<memberRef>.<issuedAt>.<hmac>`
- `memberRef` is the opaque internal ID, **never** the membership number (R3)
- HMAC keyed from an environment secret (a key management service in production)
- Generation endpoint for the member app
- Verification helper: signature valid **and** `issuedAt` within the freshness window
- Window read from configuration, default 24 hours (R9)
- Verification returns the member — it never applies a discount (R10)

**Endpoints:**
```
GET  /member/me/identity-code
POST /verify/resolve            staff — accepts payload or membership number
```

**Acceptance:**
- A tampered payload is rejected
- A payload older than the window is rejected
- Changing the window in configuration changes the cutoff with no code change
- The payload contains no name, phone or membership number
- Resolving a payload returns member and entitlements but performs no state change

---

## Stage 7 — Redemption

**Read:** `docs/product-definition.md` section 6. `docs/wireframes.html` screens 9, 10, D6.

This stage contains the most business logic. Build carefully.

**Build:**
- Resolve member by scanned payload or exact membership number (R12)
- Return: member, status, entitled benefits, recent redemptions at this outlet
- Record a redemption with validation in this order:
  1. Member exists and is `ACTIVE` (R4)
  2. Benefit exists and is published
  3. `partySize` ≤ `maxGuests` where set (R5)
  4. `partySize` ≥ `minGuests` where set (R6)
  5. Idempotency key unused (R8)
- Reversal creates a new row with `reversesId` — the original is never touched (R7)
- Bill amount optional, stored in minor units as an integer
- Every record attributed to the authenticated staff user

**Endpoints:**
```
POST /verify/resolve
POST /verify/redemptions
POST /admin/redemptions/:id/reverse
GET  /admin/redemptions
GET  /member/me/redemptions
```

**Acceptance:**
- Spa redemption with 3 guests is rejected (cap is 2)
- Events redemption with 15 guests is rejected (minimum is 20)
- Redemption against a suspended member is rejected
- Submitting the same idempotency key twice creates one row and returns the original
- Reversal leaves the original row byte-identical
- A member cannot read another member's redemptions
- `outlet_staff` cannot list redemptions across members

---

## Stage 8 — Reporting

**Read:** `docs/security-implementation.md` section 6. `docs/wireframes.html` screens 13, D5.

**Build:**
- Server-side allowlist of metrics and dimensions — no client-supplied SQL or fragments
- Metrics: redemption count, distinct active members, total guests, estimated value
- Dimensions: month, benefit, outlet
- Lists: members who have never redeemed; members issued a card but never claimed the app
- **Cohort suppression: any result group below 5 returns "insufficient data" (R13)**
- Export restricted to administrator, rate-limited, audit-logged

**Endpoints:**
```
GET /admin/reports/summary
GET /admin/reports/by-benefit
GET /admin/reports/by-month
GET /admin/reports/dormant-members
GET /admin/reports/unclaimed
GET /admin/reports/export
```

**Acceptance:**
- An unknown metric or dimension name is rejected before any query is built
- A filter narrow enough to match 3 members returns suppression, not data
- Estimated value is computed from integer minor units — no floating point
- Export by a non-administrator is rejected and logged

---

## Stage 9 — Audit logging

**Read:** `docs/security-implementation.md` section 9.

**Build:**
- Audit write helper called from every sensitive path
- Logged actions: member viewed, member created, member suspended, verification lookup (success and failure), redemption recorded, redemption reversed, benefit changed, export performed, login, permission change, **every authorization denial**
- **A logger redaction layer preventing names, phones and emails from reaching application logs**
- Audit entries are insert-only

**Acceptance:**
- Viewing a member record writes an audit entry naming the viewer
- A failed verification lookup is recorded
- Grepping application log output for a seeded member's name returns nothing
- Audit rows cannot be updated or deleted by the application role

---

## Stage 10 — Member client

**Read:** `docs/wireframes.html` screens 1–8 and D1–D2.

**Build a React app with no styling.** Plain semantic HTML. The structure must match the wireframes; the appearance must not be considered.

Screens: claim, OTP verify, explore, benefits list, benefit detail, search, digital card, profile with own redemption history.

**Acceptance:**
- A member can activate with a claim code and reach their benefits
- The digital card displays a code that refreshes
- Benefit content comes entirely from the API — nothing hardcoded
- Profile shows the member's own redemptions only
- Zero CSS files exist in this app

---

## Stage 11 — Verification client

**Read:** `docs/wireframes.html` screens 9, 10, D6.

**Build:** staff login, scan or type lookup, member result with entitlements and recent use, benefit and party-size selection, optional bill amount, confirm.

**Acceptance:**
- Staff can complete a redemption end to end
- Guest-cap violations are rejected with a clear message
- There is no path from this app to a member list or search
- A suspended member displays as invalid before any benefit can be selected

---

## Stage 12 — Admin client

**Read:** `docs/wireframes.html` screens 11–14 and D3–D5.

**Build:** login with MFA, member list and detail, member creation with claim code issue, suspend and reinstate, benefit management, reports, redemption log, staff management.

**Acceptance:**
- An administrator can create a member and issue a claim code
- **An administrator can change a benefit percentage and see it reflected in the member client without a deployment**
- Reports render from live data
- A manager account cannot reach benefit editing or export

---

## Stage 13 — Integration & acceptance

**Build:** end-to-end tests covering the complete journeys.

**The primary acceptance journey:**
1. Administrator creates a member → claim code issued
2. Member activates with the code, verifies OTP, grants email consent
3. Member views benefits — five categories with correct values
4. Member opens the digital card, obtaining an identity payload
5. Staff resolve the payload at the spa
6. Staff record a redemption with 2 guests → accepted
7. Staff attempt a redemption with 3 guests → rejected
8. Redemption appears in the member's own history
9. Redemption appears in the admin member detail, attributed to the staff member
10. Redemption appears in reports
11. Administrator changes the dining discount from 25% to 20%
12. Member client reflects 20% with no restart or deployment

**Also verify:**
- Full authorization matrix passing
- All 18 business rules from section 6 have at least one test

---

## Stage 14 — Security review

**Read:** `docs/security-implementation.md` section 12 checklist in full.

Work through every item. For each: confirm it, or record in `PROGRESS.md` why it is deferred.

Then produce `SECURITY-REVIEW.md` listing each checklist item, its status, and where in the codebase it is enforced.

**Acceptance:** every item is either confirmed with a file reference or explicitly deferred with a reason.

---

# 8. Things that will go wrong

Known traps, listed so you avoid them:

- **Storing money as a float.** Always integer minor units.
- **Fetch-then-check authorization.** Scope belongs in the `where` clause.
- **Returning 403 for out-of-scope records.** It confirms existence. Return 404.
- **Hardcoding benefit percentages** during early development "to move faster." This breaks R14, the project's headline requirement.
- **Reading `alg` from the JWT header.** Pin it server-side.
- **Adding a member search endpoint for staff convenience.** Explicitly forbidden by R11.
- **Making redemptions updatable** because reversal seemed complicated. R7 is not optional.
- **Logging a member object** in a debug statement. The redaction layer exists for a reason.
- **Building a points system.** There isn't one. If you are writing `balance`, re-read section 2.

---

# 9. Start here

1. Confirm `docs/` contains the four current files listed in section 1
2. Open `docs/wireframes.html` in a browser and read the annotations
3. Read `docs/product-definition.md` end to end
4. Read `docs/security-implementation.md` sections 3, 4 and 5
5. Begin Stage 0
6. Create `PROGRESS.md` before writing any other code

Report back at the end of each stage with: what was built, which acceptance criteria pass, and any open questions encountered.