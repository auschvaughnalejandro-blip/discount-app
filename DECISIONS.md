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

---

**2026-07-29 — R17 enforced by an `onRoute` hook, not a route-registration wrapper.**
Alternative: export a `registerRoute()` helper that requires a `permission` argument,
as security-implementation.md §5's snippet implies.
A wrapper only protects routes that remember to use it — a plain `app.get()` slips
straight past, which is precisely the failure §5 describes ("a new endpoint shipped
under deadline with no check at all"). Fastify's `onRoute` hook fires for every route
registered after it regardless of how, so there is no bypass to remember. Routes
declare `config: { permission }`, which is Fastify's own typed mechanism for
per-route metadata and needs no module augmentation of the route-options type.

---

**2026-07-29 — `scopedWhere(base, scope)` instead of spreading the scope fragment.**
Alternative: the literal `where: { id: req.params.id, ...scopeFor(principal) }` from §5.
The spread is only safe while the fragment shares no keys with the base query. It
shares `id` — a member's scope is `{ id: <their own id> }` — and the later spread
wins, so the requested id was silently replaced by the caller's own. Every lookup
then returned the caller's own record instead of 404. `AND` composition cannot
clobber: both conditions must hold, so an out-of-scope id yields no rows. Same
intent as §5, without the collision. Caught by a test, and pinned by a regression
test that demonstrates the old behaviour.

---

**2026-07-29 — 403 for a route the role cannot use; 404 only for out-of-scope records.**
Alternative: 404 everywhere, reading R18 maximally.
§5's reasoning for 404 is specifically "a 403 confirms the record exists" — it is
about records. Which endpoints exist is not a secret (they are in the client bundle
and the API surface), so a 403 on a route leaks nothing. Records get 404, and an
out-of-scope record is byte-identical to a nonexistent one. §11 accepts either for
the `outlet_staff` list case ("must 404 or 403 on every one").

---

**2026-07-29 — The role matrix is written out exhaustively, including administrator.**
Alternative: give `ADMINISTRATOR` a wildcard, since §5 says "everything".
A wildcard means every permission added later is granted to that role silently, at
the moment it is defined rather than when someone decides it should be. Listing all
15 makes each grant a deliberate edit, and the matrix test fails if the catalogue and
the expectations drift apart.

---

**2026-07-29 — Criterion 4 ("no fetch-then-check") is enforced by scanning source.**
Alternative: rely on code review, or on the Stage 14 security review.
It is a property of how handlers are written, not something a running server can be
asked about — but it is also the single mistake §5 spends the most words warning
about, and the one you make while writing an endpoint rather than while auditing one.
`fetch-then-check.test.ts` scans `src/routes` for Prisma reads of scoped models and
requires a scope fragment in the same statement, with an explicit exempt list carrying
written reasons. At Stage 3 it has almost nothing to check; its value starts at Stage 4.

---

**2026-07-29 — The timing test compares medians over a warmed-up sample.**
Alternative: the mean of a cold 5-iteration sample (what Stage 2 shipped).
It flaked under load. The property under test is a *systematic* difference between
the two login paths; a single scheduling stall is noise, and the mean lets one
outlier decide the result. Median over 7 iterations after a warm-up (the first
Argon2id call pays for native module load and the lazily-built dummy hash) is stable
across repeated runs. The 3x bound is deliberately loose — it catches the dummy-hash
branch going missing, not a fine-grained timing oracle, and the test says so.

---

**2026-07-29 — `POST /member/claim` has two phases rather than two endpoints.**
Alternative: add `POST /member/claim/verify`, or reuse `/auth/member/verify-otp`.
product-definition.md §8's flow is `claim code + phone → OTP → consent → claimed`,
which is two wireframe screens and so two round trips, but BUILD-PLAN.md's endpoint
list has one route. The endpoint branches on whether an OTP is present. Reusing
`/auth/member/verify-otp` was rejected because it deliberately serves only *claimed*
members and has no consent capture. The claim code is re-sent in phase 2 and consumed
only there, so an abandoned phase 1 — a mistyped phone number — does not burn the
member's one invitation.

---

**2026-07-29 — Claim codes are 160 bits, not the `PG- ____ - ____` the wireframe sketches.**
Alternative: match the wireframe's short, typeable placeholder.
security-implementation.md §3 requires at least 128 bits and forbids deriving the code
from the membership number. The wireframe's placeholder is roughly 40 bits, which is
guessable at the rate an activation endpoint could be driven. Prime directive #3 gives
the security document precedence on security matters, so the code is 20 random bytes
in Crockford base32 (32 characters, hyphen-grouped for printing). Crockford excludes
I, L, O and U, and the input is normalised for case, spacing and the usual
1/I, 0/O confusions, so a code read off a letter and retyped still matches.

---

**2026-07-29 — Claim codes hashed with SHA-256, not Argon2id or HMAC.**
Alternative: HMAC with a server secret, as OTP codes use.
Same reasoning as refresh tokens: 160 bits of server-generated randomness cannot be
brute forced at any hash speed, so a slow hash defends nothing. HMAC would add a
second secret to manage for no gain over a plain hash here — the OTP case is different
because a 6-digit code IS brute-forceable from a stolen table, and the key is what
prevents that.

---

**2026-07-29 — Consent records a declined channel explicitly.**
Alternative: write a row only when consent is granted.
§10 requires consent "captured per channel, unticked by default, stored with timestamp
and wording version". Writing nothing for a refusal makes "declined" and "never asked"
indistinguishable a year later, which is exactly the question a complaint would raise.
Both channels are required in the claim payload so an omission is never silently read
as consent.

---

**2026-07-29 — Suspension increments `tokenVersion` and revokes refresh families.**
Alternative: set `status = SUSPENDED` and let the status check catch it.
A status check alone leaves an already-issued access token valid until it expires —
up to 30 minutes for a member. §4 lists membership suspension among the events that
must force re-authentication, and the mechanism it names is the token version.
Refresh tokens are separate server-side state and are revoked explicitly, or the
member could mint a fresh access token seconds later.

---

**2026-07-29 — `resend-claim` supersedes any outstanding code.**
Alternative: allow several live codes per member.
The predictable support request is a member who lost their invitation letter
(wireframes D4 note 5). If issuing a replacement left the original valid, the lost
letter would stay usable — which is the threat single-use codes exist to close.

---

**2026-07-29 — Tests set a known OTP rather than recovering the issued one.**
Alternative: brute-force the 6-digit space against the stored HMAC; or have the
endpoint return the code outside production.
Returning the code, even in development, weakens the control the OTP exists to
provide and creates a flag someone will eventually set in the wrong environment.
Brute-forcing worked but cost ~1.5s per call and pushed four tests past the timeout.
Overwriting the stored hash with the hash of a chosen code gives the test exactly
the knowledge a real SMS gateway would have had, and the endpoint still runs its
genuine verification path — constant-time compare, single use, attempt counting.

---

**2026-07-29 — The fetch-then-check guard resolves a `where` passed as a variable.**
Alternative: require every scope fragment to be written inline at the call site.
The member list builds one `where` and shares it between `count` and `findMany`;
forcing it inline would mean duplicating the expression, and a guard that pushes code
toward duplication gets disabled. The guard now resolves a `where` identifier back to
its assignment within a 25-line lookbehind — short on purpose, because a scope fragment
defined far from the query it guards is hard to review. Relaxing a security check is
how it becomes a no-op, so the analyzer was split out and given eight tests fixing what
it must still catch, including the exact fetch-then-check shape §5 warns about.
