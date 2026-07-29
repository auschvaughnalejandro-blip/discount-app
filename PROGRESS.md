# Progress

Last updated: 2026-07-29
Current stage: 4 (complete) — next is Stage 5, Benefits

## Stages
- [x] 0 — Foundation
- [x] 1 — Data model
- [x] 2 — Authentication
- [x] 3 — Authorization
- [x] 4 — Member lifecycle
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

Files created:
- `package.json`, `tsconfig.base.json`, `.gitignore`, `.env.example`, `docker-compose.yml`
- `packages/shared/` — `package.json`, `tsconfig.json`, `src/index.ts`, `src/health.ts`
- `apps/api/` — `package.json`, `tsconfig.json`, `vitest.config.ts`, `prisma/schema.prisma`
- `apps/api/src/` — `server.ts`, `app.ts`, `config/env.ts`, `plugins/prisma.ts`, `routes/health.ts`
- `apps/api/test/health.test.ts`
- `PROGRESS.md`, `DECISIONS.md`

Also done:
- Moved the three reference documents from the repository root into `docs/` under
  the filenames the build plan uses. They were empty at the time; the content
  arrived later and Stage 1 was built against it.

Acceptance:
- `npm run dev` starts the API — PASS
- `GET /health` returns 200 — PASS
- `npm test` passes — PASS
- `npx prisma migrate dev` runs against the container — PASS in substance, with a
  caveat: see "Environment deviations" below. Migrations were applied with
  `prisma migrate deploy` against PostgreSQL 18, not the compose container.

Notes:
- `apps/web-member/`, `apps/web-verify/` and `apps/web-admin/` are not scaffolded.
  They belong to Stages 10–12; creating them now would be working ahead.
- `GET /health` is liveness and does not touch the database, so it can distinguish
  a dead process from a dead database. `GET /health/ready` runs `SELECT 1`.

### Stage 1 — Data model
Status: complete

Files created:
- `apps/api/prisma/schema.prisma` — 10 models, 6 enums
- `apps/api/prisma/migrations/20260729140000_init/migration.sql`
- `apps/api/prisma/migrations/20260729140100_redemption_immutability/migration.sql`
- `apps/api/prisma/seed.ts`
- `apps/api/test/data-model.test.ts`, `apps/api/test/setup.ts`
- `docker/postgres/init/01-app-role.sh` — creates the least-privileged app role
- `docker-compose.yml` updated: publishes on **5433**, not 5432, because a
  PostgreSQL instance already occupies 5432 on this machine

Acceptance:
- Migration applies cleanly — PASS (`prisma migrate deploy`, both migrations)
- Seed populates all five benefits with correct percentages and guest caps — PASS
- A raw `UPDATE` against `Redemption` as the app role is rejected by the database — PASS
  (`ERROR: permission denied for table Redemption`; `pgp_app` holds only SELECT and
  INSERT on that table)
- `billAmountMinor` is an integer everywhere — PASS (`integer`; no `real` or
  `double precision` column exists anywhere in the schema)

Verified by `apps/api/test/data-model.test.ts` — 15 tests, all passing. Full suite: 17.

Beyond the four criteria, the same migration also enforces:
- `DELETE` on `Member` revoked (R16 — members are suspended, never deleted)
- `UPDATE`/`DELETE` on `AuditLog` and `ConsentRecord` revoked
  (security-implementation.md §5 backstop, §9 append-only audit)
- A `member_number_seq` sequence and `next_member_number()` returning `PG-0004`,
  so numbers are sequential and generated in the database rather than the
  application, where two concurrent creates could collide (R3)
- CHECK constraints: outlet required on `OUTLET_STAFF` accounts and forbidden
  otherwise; party size positive; a reversal cannot point at itself; percentages
  within 0–100; `minGuests <= maxGuests`

Seeded benefit values, taken from product-definition.md §2 and the wireframes
benefit table — no percentage, cap or phone number appears in application code:

| key | discount | secondary | max | min | reservations |
|---|---|---|---|---|---|
| fnb | 25% | — (children 6–12: 50%, 0–6: 100%) | 6 | — | 4020 1720 |
| rooms | 30% | — | — | — | 4020 1666 |
| spa | 40% | Retail products 25% | 2 | — | 4020 1625 |
| events | 25% | Outside catering 20% | — | 20 | — |
| lifestyle | 30% | Pool day pass 25% | — | — | — |

### Stage 2 — Authentication
Status: complete

Files created:
- `apps/api/prisma/migrations/20260729150000_member_token_version/migration.sql`
  — adds `Member.tokenVersion` (see "Deviations from spec" below)
- `apps/api/src/security/` — `password.ts`, `tokens.ts`, `refresh-tokens.ts`,
  `otp.ts`, `rate-limit.ts`, `principal.ts`
- `apps/api/src/routes/auth.ts` — all 6 endpoints
- `apps/api/test/tokens.test.ts`, `apps/api/test/auth.test.ts`
- `apps/api/prisma/seed.ts` refactored to call `src/security/password.ts`
  instead of duplicating the Argon2id parameters inline

Endpoints, all live: `POST /auth/staff/login`, `POST /auth/member/request-otp`,
`POST /auth/member/verify-otp`, `POST /auth/refresh`, `POST /auth/logout`,
`POST /auth/logout-all`.

Acceptance — each is a test, all passing (`apps/api/test/tokens.test.ts` +
`apps/api/test/auth.test.ts`, 9 tests together):
- A token with `alg: none` is rejected — PASS
- A token with a modified `role` claim is rejected — PASS (signature check fails)
- An expired token is rejected — PASS
- A token with the wrong `aud` is rejected — PASS
- Replaying a used refresh token revokes the family and forces re-auth — PASS
  (verified the *legitimately rotated successor* also stops working, not just
  the replayed token itself)
- Incrementing `tokenVersion` invalidates existing access tokens — PASS, via
  `resolvePrincipal` (new; see below)
- OTP fails after 5 attempts — PASS (locks out even the correct code afterward)
- Login timing does not differ measurably between existing and non-existent
  accounts — PASS, best-effort (ratio < 3x over 5 iterations; a real Argon2id
  verification runs on both paths, against the account's own hash or a fixed
  dummy hash)

Full suite: 26 tests passing (9 new Stage 2 + 17 from Stages 0–1).

Beyond the 8 listed criteria, also built:
- `resolvePrincipal()` (`src/security/principal.ts`) — the Stage 2 build list's
  own "Token version check on every request" line item. Verifies the JWT, then
  confirms the subject is still `ACTIVE` and `tv` matches the subject's current
  DB value. Stage 3 layers permission/scope checks on top of this; it does not
  duplicate it.
- Rate limiting (in-memory, per-process, per IP and per identifier) on login
  and both OTP endpoints, per security-implementation.md §3/§4/§8.
- Uniform, generic error responses across all failure branches (wrong
  password, wrong OTP, revoked/expired/reused refresh token) — no branch
  reveals which specific thing was wrong.

### Stage 3 — Authorization
Status: complete

Files created:
- `apps/api/src/security/permissions.ts` — the permission catalogue and role matrix
- `apps/api/src/security/scope.ts` — `scopeFor*` fragments and `scopedWhere`
- `apps/api/src/plugins/authorization.ts` — R17 boot check + principal resolution
- `apps/api/src/plugins/error-handler.ts` — 401/403/404/400 mapping
- `apps/api/src/errors.ts`
- `apps/api/test/authorization.test.ts` (39 tests), `apps/api/test/fetch-then-check.test.ts`

Acceptance:
- Registering a route without a `permission` field prevents the server starting — PASS.
  Enforced by an `onRoute` hook, which fires for *every* route however it is
  registered — including a plain `app.get()` that bypasses any helper. A wrapper
  you must remember to call is exactly the control that fails under deadline.
  A misspelled permission fails startup too.
- An authorization matrix test covers every role against every endpoint, with
  declared expectations — PASS. `EXPECTED_ROLE_ACCESS` in the test declares the
  allowed roles for all 17 permissions independently of the implementation, and
  a test asserts the two agree *and* that neither has an entry the other lacks —
  so adding a permission without deciding who holds it is a test failure.
  Exercised over real HTTP as well as against the table.
- Fetching another member's record by ID as `outlet_staff` returns 404 — PASS,
  and 403 at the route level, since `outlet_staff` holds no `members:read` at
  all (R11 — "not filtered, absent"). The 404-not-403 behaviour for a caller who
  *does* hold the permission but is out of scope is covered separately: an
  out-of-scope member and a nonexistent one return byte-identical responses.
- No handler loads a record and then checks permission afterwards — PASS, via
  `fetch-then-check.test.ts`, which scans `src/routes` for Prisma reads of
  scoped models and requires a scope fragment in the same statement. Three
  pre-authentication reads in `auth.ts` are exempted with written reasons.

Full suite: 68 tests passing.

**A real defect was found and fixed while writing these tests.**
security-implementation.md §5 illustrates scoping as
`where: { id: req.params.id, ...scopeFor(principal) }`. That spread is only safe
while the scope fragment shares no keys with the base query — and a member's
scope is `{ id: <their own id> }`, which collides. The later spread wins, so the
id the caller asked about was silently replaced by the caller's own id: the
query then succeeded and returned the caller's own record for *any* id they
asked about, a 200 where the answer had to be 404. Replaced with
`scopedWhere(base, scope)`, which composes with `AND` and cannot clobber.
A regression test demonstrates the old behaviour and pins the new one.

A second defect: the authorization `preHandler` also runs for unmatched paths,
where there is no route config to read — so every unknown URL returned 403
instead of 404. Fixed, with a test.

Also built (not in the Stage 3 list, but required by the above):
- An error handler mapping `HttpError` subclasses, `ZodError` → 400, and
  anything else → 500 with the detail logged rather than returned. Before this,
  a malformed request body produced a 500; it now produces a 400.

### Stage 4 — Member lifecycle
Status: complete

Files created:
- `apps/api/src/security/claim-codes.ts`
- `apps/api/src/routes/admin-members.ts` — the seven admin endpoints
- `apps/api/src/routes/member.ts` — claim, me, consent
- `apps/api/test/member-lifecycle.test.ts` (18 tests)

Acceptance:
- A claim code cannot be used twice — PASS. Consumption is an
  `updateMany` carrying `usedAt: null` in its WHERE clause, so two concurrent
  activations cannot both match; a test fires both at once and asserts exactly
  one wins and exactly one row is marked used.
- An expired claim code is rejected — PASS, and expired / unknown /
  already-used / wrong-phone all return a byte-identical response. Which part
  was wrong is what someone holding a discarded invitation letter wants to learn.
- Claim codes are not derivable from the membership number — PASS. 160 bits of
  `randomBytes`, Crockford base32, sharing no structure with `PG-nnnn`; stored
  as SHA-256, never in plaintext.
- Consent is stored per channel with a timestamp — PASS, including a *declined*
  channel, which is recorded explicitly so that an absent row and a refusal
  never look the same later. Withdrawal appends a new row; the grant stays.
- Suspension blocks redemption but preserves history — PARTIAL, and honestly so.
  Suspension is implemented and tested: the row and its consent history survive,
  `tokenVersion` is incremented and refresh-token families revoked, so a live
  session dies immediately (verified: a valid, unexpired access token stops
  working and its refresh token cannot mint a replacement). **The redemption half
  cannot be tested yet — there is no redemption endpoint until Stage 7.** R4 is
  listed against Stage 7 in BUILD-PLAN §6, and the check belongs there.
- `GET /admin/members` is unreachable by `outlet_staff` (R11) — PASS, 403 at the
  route level, since that role holds no member-reading permission at all.

Full suite: 94 tests passing.

Notes:
- **`POST /member/claim` has two phases.** §8's flow is
  `claim code + phone → OTP → consent → claimed`, which is two wireframe screens
  and therefore two calls, but BUILD-PLAN.md lists one endpoint. Rather than
  invent a second, the one endpoint branches on whether an OTP is present. The
  claim code is required again in phase 2 and only consumed there, so an
  abandoned phase-1 call does not burn the member's invitation.
- The claim code is returned to the administrator exactly once, at issue, to
  print on the letter. Only its hash is stored, so it is not retrievable
  afterwards — losing it means `/resend-claim`, which also supersedes any
  outstanding code so a discarded letter stops working.

**The Stage 3 fetch-then-check guard earned its place immediately**: it failed on
first run against this stage's new code, flagging four reads. Three were
legitimate (two pre-authentication, one transitively scoped) and one — a
`ConsentRecord` read by `memberId` — was rewritten to read through the scoped
member instead. The guard was also taught to resolve a `where` passed as a
variable, and given eight tests of its own proving that relaxation did not turn
it into a no-op.

## Open questions blocking work

None blocking Stage 5. One new item from Stage 4:

- [ ] **Q8 — claim code lifetime is a chosen default, not a specified one.**
  security-implementation.md §3 requires expiry "after a defined period" and
  product-definition.md §8 is silent on the length. `CLAIM_CODE_TTL_HOURS`
  defaults to 720 (30 days), assuming a posted invitation letter. Configurable,
  so changing it needs no code change.

One item from Stage 3:

- [ ] **Q7 — the `manager` role's write access to members is inferred, not stated.**
  security-implementation.md §5's "can reach" column lists screens ("Member list,
  member detail, reports"); its "explicitly cannot" column names exactly three
  prohibitions (edit benefits, manage staff, export). product-definition.md §7
  says "Members and reports; no benefit or staff configuration", and §7's Members
  section includes creating and suspending. Implemented as **full member
  operations + reports, no benefits/staff/export**, which satisfies every explicit
  prohibition in both documents and matches the Stage 12 acceptance test.
  If read-only was intended, remove the four write permissions from `MANAGER` in
  `src/security/permissions.ts` — nothing else changes, and the matrix test will
  point at the expectations that need updating.

Two items from Stage 2 are flagged directly below,
not buried — they represent real gaps against `security-implementation.md`,
not routine open questions.

- [ ] **Q5 — MFA is not enforced on login, despite §3: "MFA is mandatory on
  every dashboard account, without exception."** `StaffUser.mfaSecret` exists
  as the schema extension point (Stage 1), but BUILD-PLAN.md's Stage 2 endpoint
  list has no MFA challenge endpoint, and no MFA library, enrollment flow, or
  challenge/response shape is specified in any reference document. Building
  one would mean inventing a feature outside what's specified (BUILD-PLAN §0
  rule 2) rather than following a documented assumption. `POST
  /auth/staff/login` currently succeeds on password alone.
  **This is the one place in Stage 2 where BUILD-PLAN.md's closed endpoint
  list and security-implementation.md's "without exception" requirement
  point in different directions**, and prime directive #3 says the security
  document wins on security matters — so this is recorded as a gap needing a
  decision, not a silent resolution. Blocks full §3/§12 compliance; does not
  block Stage 3.

- [ ] **Q6 — No SMS provider is named anywhere in the reference documents.**
  `POST /auth/member/request-otp` generates and stores a hashed OTP
  (`src/security/otp.ts`) but nothing sends it anywhere. The plaintext code
  is never logged, persisted in the clear, or returned by the API — doing so
  to work around the missing provider would itself be a security regression.
  Tests reach the code directly through the database/module layer, the way a
  real SMS gateway would have been the only other recipient. Needs an SMS
  provider decision before the member OTP flow is usable end-to-end outside
  tests.

The four items below carry forward from Stage 1, recorded per BUILD-PLAN §0
rule 4, with `TODO(open-question)` comments where they touch code.

- [ ] **Q1 — product-definition.md §11.1: what does the existing QR code do?**
  Documented assumption implemented: the code identifies the *member* and is
  scanned by staff (the second of the two possibilities), per §6 which states the
  specification assumes it. Affects Stage 6 and Stage 7.

- [ ] **Q2 — §11.3: will staff record bill amounts?**
  `billAmountMinor` is nullable and optional, so the build works either way. If the
  answer is no, the "estimated value given" figure in Stage 8 reporting disappears.

- [ ] **Q3 — §11.5: does membership expire or renew?**
  Assumed not. There is no expiry column on `Member`. Noted in `prisma/seed.ts`.

- [ ] **Q4 — §11.2: do priority reservations and member events belong in the app?**
  Both are promised in the invitation letter but absent from the benefits table.
  Not built. Affects Stages 5 and 10.

## Environment deviations

- **Docker is not installed on this machine.** `docker-compose.yml` and
  `docker/postgres/init/01-app-role.sh` are written and are the intended path, but
  unverified. Stage 1 was instead verified against a temporary PostgreSQL 18.4
  cluster created with `initdb` in the scratch directory and listening on 127.0.0.1:5434,
  with `pgp_owner` and `pgp_app` roles created to mirror the compose setup exactly.
  That cluster is disposable; `apps/api/.env` currently points at it.
- **PostgreSQL 18 rather than 15.** The stack table says "PostgreSQL 15+", so 18
  satisfies it, but the compose file pins `postgres:15-alpine`. Nothing in the
  schema or migrations is version-specific.
- **Compose publishes on 5433.** Port 5432 is taken by an existing PostgreSQL
  service on this machine.
- `npm test` now requires a reachable database — `apps/api/test/data-model.test.ts`
  is an integration test. `test/health.test.ts` still runs without one.

## Deviations from spec

- **Added `Member.tokenVersion`, not in BUILD-PLAN.md's Stage 1 schema.**
  That schema gives `tokenVersion` to `StaffUser` only. But
  security-implementation.md §4 "Forced re-authentication" lists **membership
  suspension** alongside staff password/role change as an event that must
  invalidate outstanding access tokens, and token version is stated as "the
  mechanism behind" that invalidation. Without the field on `Member`, Stage 4's
  suspend action (and Stage 2's own `/auth/logout-all` for members) would have
  no way to invalidate an already-issued member access token before it
  naturally expires. Per BUILD-PLAN §0 rule 3 ("security rules are not
  negotiable... where any document conflicts with it on a security matter, it
  wins"), added the field via
  `migrations/20260729150000_member_token_version`. See DECISIONS.md.
- **HS256, not EdDSA/RS256, for access token signing.**
  security-implementation.md §4 allows this explicitly: "HS256 acceptable
  only within a single deployable." This build is one Fastify process serving
  all three surfaces — a single deployable. See DECISIONS.md.
- Everything else built to spec. Q5 (MFA) and Q6 (SMS delivery) above are
  gaps, not silent deviations — both are flagged, not built around.
