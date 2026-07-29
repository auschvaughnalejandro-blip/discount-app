# Decisions

Technical choices the specification did not dictate. Newest last.

---

**2026-07-29 — `tsx` for running TypeScript in development, no build step.**
Alternatives: `ts-node`, `tsc --watch` plus `node`, `swc`.
`tsx` runs the ESM/`NodeNext` sources directly and watches without an intermediate
`dist/`, which keeps the workspace-to-workspace import path honest. A production build
step is deferred — no stage's acceptance criteria require a compiled artefact yet.

---

**2026-07-29 — `@pgp/shared` resolves to TypeScript source, not a built `dist/`.**
Alternatives: build `shared` to `dist/` and point `main`/`types` there; TS project references.
Pointing `exports` at `./src/index.ts` means `tsx`, Vitest and `tsc --noEmit` all resolve
the same files with no build ordering between workspaces. The cost is that a compiled
production build of `api` will need `shared` bundled or pre-built; revisit if a build
step is added.

---

**2026-07-29 — `GET /health` is liveness only; `GET /health/ready` is readiness.**
Alternative: a single `/health` that queries the database.
Stage 0 requires "Fastify server that starts and serves `GET /health`" and separately
"Prisma initialised and connecting". Folding the database check into `/health` makes the
probe unable to distinguish a dead process from a dead database, and makes `npm test`
require a live database. Splitting them satisfies both requirements independently.

---

**2026-07-29 — The Prisma client connects lazily rather than at boot.**
Alternative: `$connect()` in an `onReady` hook.
Prisma connects on first query anyway. Lazy connection is what lets `/health` answer
during a database outage, which is the point of a liveness probe.

---

**2026-07-29 — Two database URLs: `DATABASE_URL` (app role) and `DATABASE_MIGRATION_URL` (owner role).**
Alternative: a single connection string.
R7 requires that `UPDATE` and `DELETE` on `Redemption` be revoked from the application
role, and Stage 9 requires the same for `AuditLog`. A revocation is meaningless if the
application connects as the schema owner, so the split has to exist before Stage 1
writes that migration.

---

**2026-07-29 — Argon2id parameters are pinned in code, not read from the environment.**
Alternative: `ARGON2_MEMORY_KIB` / `ARGON2_TIME_COST` / `ARGON2_PARALLELISM` in `.env`.
`docs/security-implementation.md` gives exact parameters (m=65536, t=3, p=2). Making them
environment-tunable adds a way to silently weaken password hashing via misconfiguration
and buys nothing. They are therefore absent from `.env.example`.

---

**2026-07-29 — `loadEnv` validates only the variables the current stage uses.**
Alternative: validate every variable in `.env.example` at startup from Stage 0.
Several variables have values that come from the (currently empty) reference documents.
Requiring them now would make the server unstartable for no benefit. Each stage extends
the Zod schema with the variables it introduces, so a missing secret still fails at
startup rather than at first use.

---

**2026-07-29 — Client apps are not scaffolded during Stage 0.**
Alternative: create `apps/web-member`, `apps/web-verify`, `apps/web-admin` as empty
workspaces now, matching BUILD-PLAN §4's directory listing.
§0 rule 5 says do not work ahead, and the three apps are Stages 10–12. The root
`workspaces` globs already cover `apps/*`, so nothing needs changing when they arrive.

---

**2026-07-29 — Membership numbers come from a PostgreSQL sequence, not application code.**
Alternatives: `MAX(memberNumber) + 1` in the application; a UUID rendered as digits.
R3 requires sequential public numbers. Computing the next value in application code
races: two administrators creating a member at the same moment both read the same
maximum. `member_number_seq` plus `next_member_number()` returning `PG-0004` makes
that impossible, and keeps the format in one place.

---

**2026-07-29 — `directUrl` in the Prisma datasource, so migrations run as the schema owner.**
Alternative: one connection string; or overriding `DATABASE_URL` in the migrate script.
R7 only means something if the application role is not the table owner — an owner
cannot be denied its own tables. Prisma Migrate uses `directUrl` when present, so
`DATABASE_URL` stays the least-privileged application role and migrations get the
owner without a wrapper script or an extra dependency.

---

**2026-07-29 — The app role is created in the Docker init script; grants live in a migration.**
Alternative: create the role inside the migration too.
Creating the role in a migration would put its password in version control. The
init script reads it from a compose environment variable instead. The migration
only GRANTs and REVOKEs, guarded so it is a no-op where the role does not exist —
which is why the Stage 1 test asserts the rejection rather than assuming it.

---

**2026-07-29 — Five outlets, one per `OutletKind`.**
Alternatives: the four outlets named in the wireframes (Crust, Olea, The Spa,
Entrance), which leaves events and rooms with nowhere to record a redemption.
The build plan calls for five. Chose Crust (DINING), The Spa (SPA), Rooms &
Residence (ROOMS), Meetings & Events (EVENTS) and Entrance (OTHER, for valet), so
every benefit has somewhere to be redeemed. Olea is dropped to stay at five; the
real outlet list is client data to be entered through the dashboard.

---

**2026-07-29 — CHECK constraints for invariants Prisma cannot express.**
Alternative: enforce these only in application code at Stage 7.
`minGuests`/`maxGuests` coherence, positive party size, percentages within 0–100,
an outlet on exactly the `OUTLET_STAFF` role, and a reversal not pointing at itself
are all cheap in the database and cannot then be bypassed by a bug in a handler.
Stage 7 still validates R5 and R6 per benefit — these are a backstop, not the rule.

---

**2026-07-29 — Argon2id parameters appear in the seed ahead of Stage 2.**
Alternative: seed a placeholder hash and leave all hashing to Stage 2.
The seed has to create a usable administrator, which means a real hash. It uses the
exact parameters from security-implementation.md §3 (m=65536, t=3, p=2, 32-byte
output). The pepper that §3 also requires is deferred to Stage 2 and marked
`TODO(stage-2)`; seeded hashes must be regenerated when it lands.

---

**2026-07-29 — `Algorithm` imported as a type, with an annotated constant.**
Alternative: disable `verbatimModuleSyntax`, or write a bare `2`.
`@node-rs/argon2` exports `Algorithm` as an ambient `const enum`, which
`verbatimModuleSyntax` cannot import as a value. `const ARGON2ID: Algorithm = 2`
keeps the value checked against the enum rather than being an unexplained number,
without weakening the compiler settings for the whole workspace.

---

**2026-07-29 — Compose publishes PostgreSQL on host port 5433.**
Alternative: the default 5432.
This machine already runs a PostgreSQL 18 service on 5432, so the compose stack
would fail to bind. 5433 avoids the collision; the container still listens on 5432
internally.

---

**2026-07-29 — Integration tests require a database rather than mocking Prisma.**
Alternative: mock the Prisma client so `npm test` runs anywhere.
The Stage 1 acceptance criteria are statements about the database — that a REVOKE
is effective, that a column is an integer, that a CHECK constraint fires. A mock
cannot verify any of them; it would only assert that the test author remembered the
rule. `test/health.test.ts` still runs without a database.

---

**2026-07-29 — Added `Member.tokenVersion`, beyond BUILD-PLAN.md's Stage 1 schema.**
Alternative: leave it StaffUser-only, as literally specified.
security-implementation.md §4 lists membership suspension among the events that must
force re-authentication via token version, and calls tv "the mechanism behind
logout-everywhere, role change, and emergency revocation" generally, not staff-only.
Per prime directive #3, the security document wins conflicts on security matters.
Recorded as a deviation in PROGRESS.md rather than a silent schema change.

---

**2026-07-29 — HS256 for access tokens, not EdDSA/RS256.**
Alternative: generate an Ed25519 keypair and use EdDSA, as §4 prefers.
§4 explicitly permits HS256 "within a single deployable." This build is one Fastify
process serving all three surfaces (member, verify, admin) — a single deployable —
so the explicit exception applies. Revisit if the API is ever split into separate
deployables serving different audiences, at which point asymmetric signing lets each
verify tokens without holding the signing secret.

---

**2026-07-29 — `resolvePrincipal` built now, not deferred to Stage 3.**
Alternative: leave the token-version check for Stage 3's authorization wrapper.
The Stage 2 build list itself includes "Token version check on every request" as a
line item, separate from Stage 3's "route registration wrapper requiring a
permission field" and "scopeFor(principal) ... applied inside every query." Building
token validity resolution (signature + expiry + tv match) now, and leaving
permission/scope strictly to Stage 3, follows the plan's own division rather than
inventing one.

---

**2026-07-29 — Refresh tokens hashed with SHA-256, not Argon2id.**
Alternative: use the same Argon2id parameters as passwords, for consistency.
A refresh token is 256 bits of server-generated randomness, not a low-entropy
human-chosen secret — brute-forcing it is infeasible regardless of hash speed, so
Argon2id's deliberate slowness defends nothing here and would add real per-request
latency. Passwords and OTP codes use slow/keyed hashing because they must resist
guessing; refresh tokens don't need that property, only unlinkability from a DB leak,
which SHA-256 already provides.

---

**2026-07-29 — OTP codes hashed with HMAC-SHA256, not Argon2id.**
Alternative: Argon2id, matching passwords.
A 6-digit OTP is a ~20-bit space — trivially brute-forced offline at any hash speed,
so a slow hash buys nothing. The real defenses are the 5-minute TTL and 5-attempt
lockout (security-implementation.md §3), both of which exist regardless of hash
choice. HMAC (keyed by `OTP_CODE_HMAC_SECRET`) still prevents rainbow-table matching
against a leaked table without the server secret.

---

**2026-07-29 — In-memory rate limiter, no new dependency.**
Alternative: `@fastify/rate-limit`, or a Redis-backed store.
§3/§4/§8 need limiting on two independent dimensions at once (per IP *and* per
identifier) on the same route, which a single off-the-shelf plugin instance doesn't
directly express. A ~40-line fixed-window module was simpler to get exactly right
than configuring two overlapping instances of a general-purpose plugin. Known
limitation, stated in the module's own comment: in-memory means limits reset on
restart and don't share state across processes — revisit before running more than
one API instance.

---

**2026-07-29 — Rate limit thresholds are a documented assumption.**
Alternative: leave them unset until a number is specified somewhere.
security-implementation.md says "strict" repeatedly but never gives a number. Per
BUILD-PLAN §0 rule 4, implemented reasonable defaults (20 login attempts / 15 min per
IP, 5 per identifier; similar for OTP) rather than blocking Stage 2 on a number no
document supplies. Recorded in PROGRESS.md open questions (Q pending numbering) as
tunable, not final.

---

**2026-07-29 — MFA is not enforced on staff login (Stage 2 gap, flagged not silently resolved).**
Alternative: build a minimal TOTP challenge anyway, using a reasonable library.
security-implementation.md §3 makes MFA mandatory "without exception," but
BUILD-PLAN.md's Stage 2 endpoint list is closed at 6 endpoints with no MFA challenge
endpoint, and no library, enrollment UX, or challenge shape is specified anywhere.
Inventing one would violate rule 2 ("do not invent features") to satisfy rule 3
("security wins") — the two prime directives conflict here, unlike the
`Member.tokenVersion` case where security-implementation.md just filled a gap
BUILD-PLAN.md left open. Recorded as PROGRESS.md Q5 and flagged directly to the user,
rather than picked silently in either direction.

---

**2026-07-29 — Password pepper stored in an environment variable, not a KMS.**
Alternative: skip the pepper entirely until a KMS exists.
§3 requires a pepper "held in the key management service, not the database." No KMS
exists anywhere in this build's stack or reference documents. An environment variable
is the nearest available equivalent — it is at least not colocated with the password
hashes it protects, which is the property the pepper exists for. `PASSWORD_PEPPER`
in `.env.example` documents this as a placeholder, not a production-ready mechanism.

---

**2026-07-29 — SMS delivery is unimplemented; the OTP code is never exposed.**
Alternative: log the OTP to the console in non-production, or return it in the API
response when NODE_ENV !== 'production', to make manual testing possible.
No SMS provider is named in any reference document — this is a genuine integration
gap, not a design choice within Stage 2's scope. Either workaround weakens the same
control the OTP exists to provide (a leaked/logged live code is account takeover,
per §3) for the sake of convenience. Tests reach the hashed code through the
database/module layer instead, matching the access a real SMS gateway would have
had. Recorded as PROGRESS.md Q6.
