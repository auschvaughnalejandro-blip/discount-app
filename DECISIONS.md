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

---

**2026-07-30 — Q1 confirmed as built: the QR identifies the member.**
The client confirmed the code identifies the customer and is scanned by staff at an
outlet offering the deal. That is the assumption `product_vision.md` §6 recorded and
the one Stages 6, 7 and 11 were built against, so nothing changed. The alternative
reading — a code displayed at each outlet and scanned by the member — would have made
a 40% discount self-declared, and would have required rebuilding the verification page
around a different trust model. Recorded because "no change needed" is itself a result
worth being able to point at later.

---

**2026-07-30 — Q6 answered "Gmail over SMTP", implemented as email delivery, not SMS.**
Alternative: an email-to-SMS carrier gateway, or refuse the answer and wait for a real
SMS provider.
Gmail cannot send SMS. No public email-to-SMS gateway exists for Ooredoo or Vodafone
Qatar, and the US carrier gateways that once served this purpose have nothing to do with
`+974` numbers — so the literal request was not implementable. The substance was, by
treating email as the delivery channel: the phone number stays the identifier and the
thing a member types, and the server looks up that member's stored address.

**This is weaker than SMS and is interim.** §3 makes phone-plus-passcode the whole of a
member's authentication — there is no password — so whoever controls the mailbox controls
the membership. An SMS to a handset in the member's hand is a materially stronger channel.
The `CodeSender` interface in `src/notifications/code-sender.ts` exists so Twilio or
Unifonic is one new file and one environment variable.

Two consequences worth stating plainly:
- **An administrator must record a member's email at creation time** while this is the
  channel. The activation flow asks for the email in *phase 2*, after the OTP, so at
  phase 1 the only address available is whatever the hotel already had. Asking for it
  earlier would let anyone holding a discarded invitation letter probe for valid claim
  codes against their own address.
- Gmail's ~500/day limit and its willingness to throttle a burst are a pilot-scale
  arrangement, not a launch one.

---

**2026-07-30 — Q5: MFA required for ADMINISTRATOR, MANAGER and SUPPORT; not OUTLET_STAFF.**
Alternative: MFA on every staff account without exception.
`security-implementation.md` §3 says both "MFA is mandatory on every dashboard account,
without exception" and "MFA for any staff account that can reach more than the
verification page". The second is the specific statement and resolves the first: an
`OUTLET_STAFF` account reaches only the verification page and is therefore not a
dashboard account. §3 already covers those accounts separately — named individuals, no
shared logins, shift-length session expiry, instant revocation.

Taking the broader reading would have put a TOTP prompt on a shared counter tablet at
the start of every shift, which is the kind of control that gets worked around rather
than followed. The client's answer was "follow the security implementation guidelines",
so this is a reading of the document rather than a decision made around it.

Chosen shape: TOTP via `otplib`, not an SMS second factor — SMS would depend on Q6's
delivery, which is currently email, and a code mailed to a mailbox is not a second
*factor* when the first is also something-you-know. The TOTP secret is encrypted with
AES-256-GCM before it reaches the database, so a stolen dump alone yields no working
factors, matching the reasoning §3 applies to the password pepper. Ten single-use
recovery codes are hashed with the same Argon2id parameters as passwords, because a
manager locked out at 2am needs a route in that is not "telephone the developer".

---

**2026-07-30 — Stage 17: BUILD-PLAN §0 rule 1 retired, deliberately.**
Rule 1 ("no styling; ugly is correct at this stage") was a staging discipline for the
period when logic was being built, and it worked — the clients reached Stage 14 with
correct semantic markup and no design debt. Stage 17 lifted it.

`apps/api/test/no-styling.test.ts` was renamed to `client-invariants.test.ts` rather
than deleted. Three of its four assertion groups were about styling and are gone; two
were never about styling and are load-bearing, so they stay: R14 (the member client
hardcodes no benefit value) and §4 (no `localStorage`, no tokens in URLs). Silently
deleting the file would have dropped those with it, which is how a rule dies without
anyone deciding.

The immediate trigger was the QR quiet zone. `react-qr-code` renders modules edge to
edge, and the QR specification needs a four-module white margin for a scanner to locate
the symbol — so the first stylesheet was function, not decoration. Two new assertions
now guard exactly that: the quiet zone exists and is white, and error correction stays
at level M rather than the library's default of L. Both failures are invisible on screen
— the code still renders, it just stops scanning reliably at arm's length.

Approach: design tokens as CSS custom properties in `packages/ui`, consumed by all three
clients, with each app overriding only the semantic colour tokens. Not Tailwind, mainly
because of Stage 22: written with CSS logical properties throughout, Arabic RTL costs
one `dir` attribute rather than a per-class audit across three apps.

---

**2026-07-30 — Q11 (native vs installable web app) left open, and why nothing waited on it.**
The client's answer contained both options — "installable web app for the frontend of the
users" and "Native please". Rather than guess, Stage 16–19 work was chosen so that none
of it depends on the answer: the API, the verification page and the admin dashboard are
web under every scenario, and the member app's credential, delivery and MFA behaviour are
server-side. Only the member app's *presentation* forks, and even there the token layer
and the QR behaviour carry over.

---

**2026-07-30 — Stage 17 refinement: the admin dashboard gets an overview screen, and its
charts get built by measurement rather than by eye.**

ROADMAP §3 left two items open under Stage 17: "real photography for the member benefit
cards, and charts in the admin reports (load the `dataviz` skill before writing chart
code)". This closes the second.

**Why a new screen at all.** The dashboard opened on `members` — a hundred-row table —
and the six headline figures lived behind a `reports` tab. The densest view in the product
was the landing page, and the numbers that say whether the programme is working took a
deliberate click. Wireframes D5 specifies the figures; nothing specified where they sit.
`Overview` is now first in the rail and is where the app opens. It adds no new
measurement: it is the existing report endpoints arranged by how often they are consulted,
with each panel routing into the section that can act on it.

**Two defects found while doing it, both silent.**

1. *Suppressed figures were rendering as a raw sentinel.* `api.summary()` was typed
   `Record<string, unknown>` and the tiles did `String(summary['redemptions'])`. When a
   cohort falls under `REPORT_MIN_COHORT_SIZE` the server returns the string
   `insufficient_data` (R13), so the dashboard printed `insufficient_data` into a KPI tile.
   Verified against the live database, where all four cohort figures are currently
   suppressed — so this was the normal state, not an edge case. The summary and group
   payloads are now typed, with the sentinel in the type (`Figure = number |
   'insufficient_data'`), which is what makes the old code unwritable rather than merely
   wrong. Every figure renders through one component that cannot emit the sentinel.
2. *`dormant-members` and `unclaimed` were typed as returning `MemberRow`*, which declares
   `appClaimed`, `totalUses` and `lastUsedAt` as required. The server sends none of the
   three. Nothing rendered them yet, so nothing failed; anything that did would have shown
   `undefined`. Split out as `ReportMember`.

**Chart decisions, and why they are decisions.** Benefit names are *nominal* — reordering
Spa and Rooms changes nothing — so every bar wears the same hue and the chart carries no
legend, because it plots one series that its caption names. Five hues would spend the
identity channel restating what bar length already shows; shading darker-where-bigger
would double-encode the value. Programme reach is a meter rather than a doughnut: two
slices of a circle is the hardest way to read a proportion, and the percentage ends up
printed in the middle regardless.

The bar chart is a real `<table>`, so the accessible view and the visual one are the same
object rather than two artefacts to keep in step: a row header carries the benefit, the
cell carries the bar and the number as text.

**Measured, not eyeballed.** `--c-primary-soft` was the obvious candidate for the
unfilled track and measures **1.13:1** against a white panel — invisible. The track steps
in `charts.css` (`#7bbfb1` light, `#21574e` dark) were picked by scanning candidates for
the ≥2:1 the track needs while staying clearly subordinate to the 4.29:1 fill. Bar fill,
axis text, gridlines and both warn inks were checked the same way; all pass.

**No trend chart, deliberately.** `/admin/reports/by-month` exists and no client surfaces
it, so a monthly chart is available cheaply — but it is *new* information rather than a
reorganisation of what the dashboard already had, and it would be entirely suppressed at
current data volume. Left as the obvious next addition rather than folded in here.

**Not fixed, noted:** dark mode is reachable only through `prefers-color-scheme`.
`[data-theme='light']` forces light, but there is no `[data-theme='dark']` that forces
dark against a light OS. That is consistent with the app having no theme toggle, and it
made the dark rendering awkward to verify — it needed the media block extracted and
applied unconditionally. If a toggle is ever added, this asymmetry is the thing to fix.

---

**2026-08-06 — the discount rate is recorded on the redemption, not read back from the
benefit.**

`Redemption` gained `discountPctApplied` and `benefitVersion`
(`migrations/20260806120000_redemption_rate_snapshot`), both NOT NULL and both written at
the moment a redemption is recorded.

Until now nothing stored what a member was actually given. `est_value_minor` computed
`billAmountMinor * b."discountPct" / 100` through a join to `Benefit`, and both history
screens read that same live percentage. R14 exists specifically so an administrator can
change that percentage without a deployment — which means the two features were in direct
conflict, and the conflict was silent:

- Moving dining from 25% to 20% restated **every month already reported**. Nothing
  errored; the numbers simply became different numbers.
- A member's own history said they had been given 20% on a visit where they were given
  25% — a figure they can check against a receipt, and the worst place to be wrong.

The rate someone was given is a fact about that visit. Storing it as a property of the
benefit's current configuration was the actual defect; the reporting query was only where
it showed.

**No default on the column, deliberately.** A default would let a creation site omit the
rate and still write a row, which is exactly how the wrong rate gets stored. Every site
that creates a redemption now has to state one, and the typecheck named all five when the
column landed.

**A reversal copies the original's rate rather than re-reading the benefit.** The negated
amount only cancels the original if both are valued at the same percentage; re-reading a
rate that changed in between would leave a residue in every total, and a reversal that
does not fully reverse is worse than no reversal. Tested by changing the rate between the
redemption and its reversal and asserting the pair sums to zero.

**The backfill does not recover history.** Existing rows were filled from the benefit as
it stood, which is the value the reports were already using — so no existing figure moved.
This migration stops the *next* edit from rewriting the past; it cannot undo edits already
made.

**Still true, and out of reach from here:** nothing verifies the discount was applied at
the till. The API records that a benefit was granted; the money is handled by the hotel's
own POS, with no connection between the two. That is a POS integration, not a schema
change — see the questions for hotel IT in this session's notes.

---

**2026-08-08 — the guest QR is removed, and a benefit request replaces it.**

Q1 — open since Stage 1, and recorded in PROGRESS.md as blocking — is answered. The client
does not want a scanned credential. A member asks for a benefit in the app, an
administrator approves it, and the outlet applies the discount when the guest arrives and
gives their name.

**What was deleted.** `src/security/identity-codes.ts`, `src/routes/identity.ts`,
`test/identity-codes.test.ts`, the `payload` branch of `POST /verify/resolve`, the QR on
the member's card, the camera scanner on the verification page, `react-qr-code` from
`web-member`, `@zxing/browser` from `web-verify`, and the `digital-card.css` that existed
solely to give the symbol its quiet zone.

**What was kept, deliberately.** `react-qr-code` stays in `web-admin`. It renders the
`otpauth://` URI a staff member scans into their authenticator app at MFA enrollment —
a different mechanism that happens to share a rendering library, and load-bearing for
§3's mandatory second factor. Removing it because the word "QR" matched would have locked
every administrator out of the dashboard.

`IDENTITY_CODE_HMAC_SECRET` was renamed to `VERIFICATION_SESSION_HMAC_SECRET` rather than
deleted: the verification session — which binds a recorded redemption to a member the
staff account actually looked up — shared that key and still needs one. Keeping the old
name would have left the config describing a feature that no longer exists.

**A guard replaces the guard.** `client-invariants.test.ts` used to assert the QR had a
quiet zone and error-correction level M. It now asserts the opposite: no guest-facing
surface declares a QR or barcode dependency, renders a QR, or opens a camera, and no route
exposes an identity code. `web-admin` is excluded by name, with the reason written down.
Deleting a test because the feature went away leaves nothing to stop it coming back.

**The new shape.** `BenefitRequest` — PENDING → APPROVED or DECLINED → FULFILLED.
`Benefit.outletKind` routes an approval to the outlet that honours it, as data rather than
a mapping in code, so reassigning a benefit is an UPDATE like changing its percentage
(R14). Two CHECK constraints make the impossible states unrepresentable: a decided request
must name its decider, and a fulfilled one must point at a redemption.

**Three rules worth stating.**

1. *A member cannot approve their own request.* `requests:create` is a MEMBER permission
   and `requests:decide` is a STAFF one, so this is not a check inside the handler that
   could be deleted — a member token cannot reach the decide route at all.
2. *An approval cannot be spent twice.* Fulfilment is an `updateMany` conditional on
   `status = 'APPROVED'`, and `redemptionId` is unique. Two counters submitting at once
   cannot both win.
3. *An approval is not a discount.* Fulfilment still writes a Redemption, which is still
   the only record that a benefit was given, still immutable, and still carries the rate
   that was actually applied.

**The one place R11 was relaxed, and why it is not a relaxation.** `OUTLET_STAFF` gained
`requests:read-outlet`, which returns member *names* — the only such list this role can
reach. It is not the enumeration R11 forbids: it contains the handful of members who asked
to come to this outlet and were approved by someone else. They put themselves on it. There
is still no search, no browse, and no way to reach a member who did not.

**Still open, and it is the client's to answer:** how often a member may use a benefit.
Nothing limits it. "See if they already redeemed it" implies a limit that does not exist —
once ever, once a year, once per stay are all representable and none is chosen. The queue
shows an administrator what a member has asked for before, so the judgement is possible;
the rule is not.

---

**2026-08-08 — the verification page is deleted. Two applications, not three.**

The client confirmed there is no counter application: an administrator records every
redemption from the dashboard. `apps/web-verify` is gone, along with `POST /verify/resolve`,
`POST /verify/redemptions`, `GET /verify/requests`, the verification-session module and its
secret, and the `verify.<domain>` host.

**Recording moved to `POST /admin/redemptions`, and gained a required `outletId`.**
The old endpoint took the outlet from the caller's token, which only worked because outlet
staff are bound to one. An administrator is at a desk, not standing in the spa, so nothing
can infer it — and a redemption attributed to the wrong outlet is worse than one attributed
to none, because it is wrong in a report that looks right. An account that *is* bound to an
outlet still records for that one and no other: the principal's binding is taken first, so a
bound account cannot redirect a redemption by asking.

**The verification session went with it, and that is a genuine reduction in control.**
It existed to stop outlet staff acting on a member they had not just looked up, because that
role cannot list members. Every role that can now record — administrator and manager — holds
`members:read` outright, so the session was binding a caller to something they could reach
anyway. Reinstating it would be theatre. If a counter application returns, the session must
return with it.

**`OUTLET_STAFF` holds no permissions at all.** Not filtered, not scoped — empty. The role
and its accounts stay because `Redemption.staffUserId` on every historical row points at
one, and dropping the enum value would orphan them. Granting it something "for later" is how
a role with no users ends up holding member data.

**MANAGER gained `redemptions:record`.** They could already approve a request; being unable
to mark one used would leave a queue that one role fills and nobody can finish.

**What the deletion cost, stated plainly.** Nobody at the outlet records anything now. The
"used" entry is written by whoever is at the dashboard, from what they were told — so the
timestamp is when it was *recorded*, not when the guest was served, and a redemption that
nobody reports simply never gets written. That is the trade the client chose, and it is the
right one for a programme this size; it stops being right the moment the volume makes
second-hand reporting unreliable.

**Still open, and now more pressing:** how often a member may use a benefit. Nothing limits
it. With a counter that had a list in front of it, an obvious repeat was at least visible to
someone; from a dashboard it is a query nobody runs.

---

**2026-08-08 — Stage 25: the four things that were documented as done and were not.**

Four items, all of which had configuration, documentation or a database column already in
place and no code reading them.

**1. `/api` was proxied nowhere.** Both clients hardcode `const BASE = '/api'`; in
development Vite proxies it. The production Caddyfile had exactly one `reverse_proxy`, on
`api.<domain>`, while `my.` and `admin.` did `try_files → index.html` — so every API call
in production would have returned the HTML document, and the apps would have appeared to
load and then silently fail. The Dockerfile comment claimed "proxied by Caddy". It was not.

Fixed with an `(api_proxy)` snippet imported by both client hosts. `handle` rather than a
bare matcher, because `try_files` would otherwise win.

*And a hole opened while fixing it:* proxying `/api/*` on `my.<domain>` would have exposed
`/api/admin/*` from the public internet, making the CIDR restriction on `admin.<domain>`
one URL away from decorative. The restriction now lives **inside the shared snippet**, so
it is safe to import anywhere rather than safe only where somebody remembered to pair it
with a guard.

**2. `TRUST_PROXY` was set everywhere and read nowhere.** In `.env.example`, in
`docker-compose.prod.yml`, called mandatory in DEPLOYMENT.md — and absent from
`config/env.ts`, with Fastify's `trustProxy` left at its default. Behind Caddy that means
every per-IP rate limit shares one bucket and every audited address is the proxy's. Both
controls present in the code, neither doing anything.

Off by default, deliberately: a directly-exposed API must *not* believe `X-Forwarded-For`,
or a caller picks their own rate-limit bucket and forges their own audit trail.

**3. The export was JSON.** §6 and §9 treat bulk export as the most sensitive action in the
system, and it returned a payload the one audience it exists for — finance — could not
open. Now `text/csv` with a `Content-Disposition` filename, carrying `discount_pct` (the
rate applied on that visit, not the benefit's rate today) and a computed `discount_value`.
Whole currency in the file, integer minor units in the database. Quoting is unconditional
and there is a BOM, because an outlet called "Crust, Doha" would otherwise shift every
column after it, and Excel reads a UTF-8 file without a BOM as the local codepage.

**4. Staff management did not exist.** `StaffUser.tokenVersion` and `status` were the
mechanism behind §3's "instant revocation from the dashboard", both worked, and no endpoint
reached either — so offboarding somebody was a manual `UPDATE` against production. For a
system whose threat model is a leaked membership list, that was the most serious thing in
the repository.

`/admin/staff` now covers create, suspend, reinstate, set-password and reset-MFA, plus
`/auth/staff/password` for changing your own. Suspension bumps `tokenVersion` **and**
revokes refresh tokens, so a live session dies immediately rather than surviving the
remaining minutes of its access token — there is a test that holds a valid token across a
suspension and asserts it stops working.

**Three refusals worth stating.** You cannot suspend yourself, you cannot suspend the last
active administrator, and you cannot reset your own second factor. The first two stop the
dashboard being locked by one click. The third is the enforceable half of PROGRESS.md's
"requires more than one administrator": a two-person approval flow means permanent lockout
at a hotel with one administrator, which is the exact situation recovery codes exist for.
Never-your-own achieves the part that matters — a stolen session cannot clear the factor
protecting it, because clearing one always takes a different account.

**Breached-password screening** (§3, "screened against a breached-password list") uses
HIBP's k-anonymity range API: five characters of the SHA-1 leave this process, several
hundred suffixes come back, the comparison happens locally. It **fails open** on a network
error and logs that it did — an outage must not stop somebody changing a password, because
the passwords people most urgently want to change are the ones already compromised.
Verified against the live service: `Password123!` is refused.

---

**2026-08-08 — the refresh token moves to an httpOnly cookie.**

§4 asked for `httpOnly; Secure; SameSite=Strict` and got a module-scoped variable, because
the alternative on the table was `localStorage` — where a single XSS flaw becomes total
account theft for every member who ever opened the app.

Memory was the right call and it cost a sign-in on every page reload: a reload tears the
page down and takes the variable with it. Members would have asked why it kept logging them
out, and they would have been right.

The cookie is held by the browser rather than the page, so it survives a reload and
`document.cookie` cannot see it — persistence without giving up the property that made
memory worth the friction. Both clients now call `resumeSession()` on mount; without that
the cookie would sit unused and nothing would have changed.

**No CSRF token, and why that is not an omission.** Three things close the gap together:
`SameSite=Strict` means the browser does not send it cross-site at all; `Path=/auth/refresh`
means no other route can be driven by holding it; and the refresh response is unreadable
cross-origin. The worst remaining outcome is a forced rotation that logs somebody out — a
nuisance, not a compromise. **A CSRF token becomes necessary the moment any state-changing
route authenticates by cookie.** None does: everything else takes a bearer token in a
header, which a cross-site request cannot set.

`Secure` is off outside production, because on `http://localhost` the browser drops the
cookie silently and development looks broken for a reason no error mentions.

The body still carries the token as well, so a native shell with a keystore and no cookie
jar keeps working — and so this change does not log out every existing session on deploy.

---

**2026-08-09 — PostgreSQL remains authoritative; Google Sheets is a sanitised,
one-way operational mirror.**

Hotel management wants a spreadsheet because filtering and sharing a familiar
view is easier than operating a database. Replacing PostgreSQL was rejected:
the programme depends on transactions, uniqueness, idempotency, immutable
redemptions, relationships and security records that Sheets cannot enforce.

The API instead publishes a repeatable-read full snapshot every five minutes,
outside all request handlers. Google latency or failure can make the workbook
stale but cannot fail a member creation, approval or redemption. Managed tabs
are replaced atomically; manual edits are overwritten; unrelated tabs are left
alone. PostgreSQL remains the recovery source and the Sheet is not a backup.

This is treated as a standing bulk export. The existing export policy therefore
holds: membership numbers may leave the system, member names/phones/emails may
not. Request free text, consents, audit/IP records and every authentication or
credential table are also excluded. Human workbook users are Viewers, link
sharing is off, and only the dedicated service identity is an Editor. Every
successful publication creates a system-attributed `report.exported` audit row
with tab counts only.

Automatic sync is disabled by default. Enabling production remains an
operational/privacy decision: the hotel must approve its Google Workspace and
data-residency arrangement, restrict workbook sharing, and place the service
credential in its secret manager. The current in-process timer assumes the
documented single API instance; horizontal scaling requires one external
scheduler or leader election.

---

**2026-08-09 — the product has two applications and one hotel-facing account
type.**

The client confirmed the required product is the member guest app plus the
administrator panel. Manager, support, outlet-staff and counter/verification
surfaces are not required. This decision supersedes every earlier active-product
role matrix and staff-verification design in this file and the older planning
documents.

Every account created from the panel is an `ADMINISTRATOR`, every administrator
uses MFA, and only administrators may authenticate or refresh a hotel-facing
session. The role selector is removed rather than merely hidden, and the server
sets the role instead of trusting a request field.

Legacy enum values and rows are retained only where deleting them would break
historical attribution (for example, a redemption recorded by an old outlet
account). A migration suspends those rows and revokes their sessions. Login,
refresh, principal resolution, permissions and account-management routes also
reject them independently. They are not converted into administrators, because
doing so would turn a later reinstatement into privilege escalation.

---

**2026-08-12 — the benefit request stops being a petition; the outlets confirm
their own visits.**

The client's IT asked that a guest's request go straight to the outlet with no
administrator approving or declining it. That reads at first like a conflict with
the hotel's own description of an outlet screen where staff "approve or reject",
and it is not. They are two different events, and this system already had two
different rows for them:

- `BenefitRequest` is the guest announcing themselves.
- `Redemption` is the immutable record that a discount was given.

The removed step is the administrator in the middle. What the outlet does is not
permission — it is **confirmation of use**, which writes the Redemption. Its
counterpart is not a refusal but *the guest never came*.

So a request is now a **notice**, created already usable and addressed to one
outlet. `PENDING → APPROVED → FULFILLED` becomes `SENT → FULFILLED`, with
`NOT_USED` as the other ending. `PENDING`, `APPROVED` and `DECLINED` remain in
the enum on historical rows only — the same treatment the retired `Role` values
already get, so nothing is rewritten and no audit entry is falsified. The
`decided*` columns keep their names in the database and are mapped to `closed*`
in code, so the rename cost no migration.

**Why not simply create requests as `APPROVED` and change nothing else.** That
was a smaller diff by a wide margin and it was rejected: it would put the word
"approved" in the audit log and in the hotel's spreadsheet for something nobody
approved. In a system whose entire value is a record the hotel can trust, a
convenient lie in that record is the most expensive kind of shortcut.

**The one-per-minute throttle is a database count, not the in-memory limiter.**
`rate-limit.ts` resets on every deploy and holds a separate allowance per
process. Counting rows on `requestedAt` survives both, and the index it needs —
`[memberId, requestedAt]` — was already on the table. A test holds a restart
across it.

**A notice names its outlet, and the guest chooses it.** `Benefit.outletKind` is
a *kind*, and a hotel has several restaurants — so "the outlet that was told" was
undefined as specified. Broadcasting to every outlet of the kind would mean
duplicate messages and a race over who confirms. The guest already knows where
they are going, so they say; the picker appears only when more than one outlet
honours the benefit, and the server fills it in otherwise.

**A notice nobody confirms is closed automatically after 24 hours**, as
`NOT_USED` with no `closedByUserId`. Attributing a clock's decision to an account
would name somebody who never touched it — the same falsification the original
`decision_complete` CHECK existed to prevent, pointing the other way. The
constraint was replaced by name to allow exactly that one case.

---

**2026-08-12 — outlet accounts return, authenticating through Google. This
partly reverses Stage 27.**

Stage 27 (2026-08-09) recorded that the product has two applications and one
hotel-facing account type, and suspended `OUTLET_STAFF` behind a database CHECK.
An outlet screen requires that to be reversed. The client chose the mechanism:
each outlet signs in with its own Google account, and nothing else can.

**Only the first half of Stage 27 is reversed.** There is a third surface, but
there is still exactly one kind of account a *named person* holds:
`ADMINISTRATOR`. An outlet account is a shared credential for a room, labelled
after the room ("Steakhouse counter"), and no administrator permission reaches
it. `StaffUser_only_administrators_active` was dropped and replaced by
`StaffUser_only_live_roles_active`, which still refuses MANAGER and SUPPORT — a
narrowing recorded in the migration history rather than an absence somebody has
to notice.

**Three things had to be true for delegating to Google to deliver anything.**

1. **It is real OAuth, not a Gmail address in our password field.** The shortcut
   buys none of the benefit, because we would still hold the password. The ID
   token is verified against Google's published keys, with issuer, audience,
   nonce and `email_verified` all checked. `jose` was already a dependency.
2. **Google authenticates; we authorize.** Google says *which account*. It does
   not say that the account may work an outlet queue — that is a row in our
   database. Both gates must pass: the address is on the hotel's domain, *and* it
   is an active `OUTLET_STAFF` row bound to an active outlet. A hotel employee
   with a valid work address who is not in that table gets nothing.
3. **The account is shared, so this is outlet-level security.** One mailbox used
   by everyone on shift means the password is known to several people and will be
   written down, and 2FA on a shared account is awkward enough that hotels
   commonly turn it off — which would quietly cancel the benefit being bought.

**What this cannot enforce, stated plainly: whether their 2FA is switched on.**
Google does not disclose that to a relying application. So "as secure as their
Google account" is true and unenforceable by us. The strongest available
substitute is refusing every account outside the hotel's own domain
(`GOOGLE_WORKSPACE_DOMAIN`, checked against the `hd` claim) and leaving the
policy to the hotel's Workspace administrator.

**A Workspace domain is materially better than consumer Gmail**, and the
`OUTLET_SIGNIN_ALLOWLIST` fallback is explicitly weaker. With a domain, the check
is one server-side rule against a claim Google signed; without one it is a
hand-maintained list of addresses that drifts. A domain account can also be
suspended by hotel IT the day somebody leaves, has readable login history, and
does not die with an ex-employee's recovery phone. Notices carrying a membership
number to a hotel-controlled mailbox are the hotel handling its own guest data;
the same message to a personal Gmail is guest data sent to an account nobody
controls.

**Attribution weakens, deliberately.** A redemption recorded at an outlet names
the room, not the person. The alternative — per-person accounts on a shared iPad
— was not on offer, and a per-device PIN can be added later if anybody asks "who
did this?" `Redemption.staffUserId` is unchanged and still non-null, because an
outlet account *is* a `StaffUser`; `StaffUser.outletId` already existed for
historical outlet actors and simply came back into use. That avoided a nullable
actor column on the immutable table, a CHECK constraint, and a fallback in every
reader that prints who recorded a visit.

`passwordHash` is now nullable, paired with a new `authMethod` column and a CHECK
that a PASSWORD account has a hash and a GOOGLE account does not. Stated as its
own column rather than inferred from a null hash, because an outlet account has
neither a password nor a Google subject until its first sign-in — so "no hash"
alone could not tell a Google account from a broken row. The Google subject is
recorded on first use and pinned thereafter: a later sign-in presenting the same
address with a different subject is refused, which is what a mailbox deleted and
recreated by somebody else looks like.

---

**2026-08-12 — WhatsApp was considered and rejected. Notices go by email and to
the outlet's own screen.**

IT's original request was that a notice reach "the WhatsApp number of the
outlet". Automatic WhatsApp means Meta's Cloud API, which carries a verified
business account, a dedicated number not already on consumer WhatsApp,
**pre-approved message templates** for every business-initiated message, and a
per-message fee. The free `wa.me` link everybody thinks of needs a human to press
it and so cannot deliver a notification at all.

The client's own conclusion, and the right one: **ditch it.** The destination is
the outlet's screen — no external service, no per-message cost, and it still works
when the connection to Meta does not. The email is a nudge on top, through the
SMTP transport Stage 18 already built.

**The notice is the message.** The Messages tab and the queue are one list, so
there is no second store to reconcile and no way for the two to disagree. A
`seenAt` column carries the unread marker, and is the closest thing to a delivery
receipt that does not depend on email arriving.

**One deliberate departure from §9.** Every other message this system sends
carries no membership number, name or benefit — a member's personal inbox is not
a place to restate who they are. An outlet notice carries the membership number
and the benefit, because it is useless without them. That is a difference of
audience, not of principle: the recipient is an internal operational mailbox at
the hotel, and the guest's *name* is still never sent.

**The guest's free-text note is off by default** (`OUTLET_NOTIFY_INCLUDE_NOTE`).
The standing export policy excludes request free text from anything leaving the
system, and a guest can type their own name into that box — so enabling it makes
"we never send names" false. The outlet sees the note on its screen regardless.
Turning it on is the hotel's decision and belongs in this file when it happens.

---

**2026-08-12 — Q1 is reversed: there is a QR again, and it is static.**

PROGRESS.md Q1 was answered on 2026-08-08 with "there is no QR", and the whole
scanned credential was deleted — module, route, camera and both dependencies.
IT has asked for it back so a Privilege Guest need not open the app at all. The
deleted code was recovered from `2f44daf~1` rather than rewritten.

**The card carries the code in ink, so it cannot rotate.** The original design
(§7) defeated a forwarded screenshot with a freshness window and a payload
reissued every 60 seconds. A printed payload has one timestamp for the life of the
card, so a freshness window either rejects the card on day two or is not a
freshness window at all.

`v2.<member_ref>.<hmac>` is therefore static, and says so in the version prefix
rather than pretending to a freshness it does not have. `v1` remains implemented
and verifiable, so rotation can be reinstated later without reprinting a card or
updating a scanner.

**Why a static code is acceptable: it identifies and grants nothing** (R10).
Resolving it returns who the member is and what the programme offers them.
Applying a discount still requires an authenticated outlet session, and recording
one still writes an immutable attributed row. The code is therefore no stronger
and no weaker than the membership number already printed in plain text on the
front of the same card, which staff can and do type in by hand. **If possession
of the payload alone ever becomes worth something, this decision has to be
revisited** — that is the condition, and `v1` exists so it can be.

The payload is derived from the member's opaque internal id, never the sequential
`PG-` number (R3), so no member can generate a neighbour's from their own. It is
computed rather than stored: there is no column to migrate, nothing to keep in
sync with the printed card, and no table whose leak would hand somebody a set of
working payloads. Rotating `IDENTITY_CODE_HMAC_SECRET` invalidates every code at
once, which is the only recovery a printed credential can have.

The scanner lives inside the signed-in outlet screen rather than on a standalone
page. Beyond the obvious convenience, it means resolving a member and recording a
visit are two calls in one already-authenticated session, so the short-lived
verification session binding them is simpler than the old standalone page's.

**A camera needs a secure context.** `getUserMedia` refuses on plain HTTP;
`localhost` counts and a LAN address does not. Testing a scan on a real counter
tablet therefore needs TLS, which makes the deployment stage a prerequisite for
accepting this rather than something that follows it. The scanner says so, and
typing the membership number always works.

---

**2026-08-12 — per-device tokens become the default outlet authentication;
Google remains optional compatibility. This supersedes the default chosen in the
earlier 2026-08-12 Google decision without rewriting it.**

Building the Google path made its operational dependencies concrete: a live OAuth
client and exact redirect URI, hotel Workspace mailboxes, a shared-account 2FA
policy, and coordination with the hotel's Workspace administrator. None can be
completed by deploying this application. A counter device instead receives its
own application credential, which the programme administrator can issue and
revoke without another system or another team.

**One token per physical device, not one per outlet.** `pgo_` tokens contain 256
bits of cryptographically random entropy. They are not human-chosen passwords and
are stored only as a unique SHA-256 digest, which gives one indexed lookup without
leaving plaintext in the database. The standing credential is accepted only by
`POST /outlet/auth/token`; success exchanges it for the ordinary short access
token and rotating httpOnly refresh-cookie session. Queue, lookup and redemption
routes never accept the standing token directly.

This makes the blast radius the device's one outlet. A lost spa tablet can be
revoked without signing out another spa counter, and its token cannot reach the
restaurant's work. It does not recover person-level attribution: the immutable
redemption names the labelled station, not whoever happened to hold it. That is
the same honest outlet-level attribution accepted in the Google decision.

**This is one factor, accepted explicitly for the pilot.** The staff network is
not counted as a second factor and the interface makes no such claim. A short
per-device PIN remains a possible follow-up if the hotel wants another factor;
shipping no PIN is preferable to inheriting shared-Google 2FA that operations
would likely disable while believing the application had stronger assurance.

**Plaintext is a one-time administrative handoff.** Admin → Outlets returns a new
token only when a device is issued or rotated. The interface holds it in component
memory, offers explicit copy/manual selection, warns that it cannot be recovered,
and does not write it to web storage or a URL. Rotation replaces the digest,
increments `tokenVersion` and revokes the refresh family. Revocation also destroys
the standing digest and is deliberately irreversible; recovered hardware gets a
new device row so a possibly copied token is never brought back to life. The old
row remains because historical redemptions point to it.

**The hotel network is defence in depth, not authentication.** The outlet hostname
now shares the `INTERNAL_CIDR` edge restriction with the administrator surface.
That variable must contain only staff/back-of-house ranges and the VPN — never
guest Wi-Fi merely because it is inside the building. A tablet on cellular is
refused by design. Source address reduces exposure; the per-device token is still
what identifies and authorizes the station.

**Google is retained, not deleted.** Existing `GOOGLE` outlet accounts, OAuth
routes, domain/allowlist gates and subject pinning continue to work, but appear as
an optional secondary path. A deployment using only device tokens leaves the
three `GOOGLE_OAUTH_*` values empty. This preserves a migration path for hotels
that later choose Workspace without making Workspace a prerequisite for opening
the outlet screen.

The legacy local session-minter remains development-only and is renamed
`npm run outlet:dev-session` so nobody mistakes its access/refresh pair for the
new standing device credential. Normal local testing should issue a real device
token through the admin panel and exercise the production exchange route.

---

**2026-08-12 — outlet authentication is device-token-only; email is notification
metadata. This supersedes both Google compatibility and the development session
minter above without rewriting their decision history.**

The client clarified that an outlet “account” means the labelled counter device,
not a mailbox. Every outlet session therefore begins with a real Admin-issued
`pgo_…` credential at `POST /outlet/auth/token`. There is no Google button, OAuth
callback, email/password login, allowlist, Google-account provisioner or secondary
authentication path for an outlet. Historical schema or migration vocabulary may
remain where database history requires it; it does not constitute a live login
option.

**The outlet's email has exactly one job: notifications.** `Outlet.notifyEmail` is an
optional SMTP destination for guest notices. It is not copied into `StaffUser`,
matched during authentication, placed on an identity allowlist or used to recover
a token. Empty means the outlet relies on its own queue. Changing the notification
address changes no principal, permission or session. Google's Sheets service
account configuration is unrelated and remains solely for the reporting mirror.

**Local login is deliberately the production login.** The session-bundle helper
and Development sign-in panel are removed. A developer issues a labelled device
under Admin → Outlets and pastes its one-time token into the normal outlet form.
This keeps the tested handoff honest and prevents an access/refresh JWT bundle
from being mistaken for the long-lived device credential operators must rotate or
revoke. Multiple local outlets use multiple device rows and separate browser
profiles, exactly as multiple counters do in production.

---

**2026-08-12 — the dashboard refreshes through one shared promise; and
`STAFF_MFA_REQUIRED` exists as a local-development switch that production refuses
to honour.**

Two changes to how an administrator session behaves, from one report: "if I stay
on the admin panel for too long I suddenly get a warning saying authentication
required."

**The session bug was concurrency, not expiry.** Refresh tokens rotate single-use,
and §4 requires that presenting a spent one revoke the whole family — from the
server a replay is indistinguishable from theft. The admin dashboard was the only
client refreshing per-request rather than through one shared in-flight promise,
and it is also the only one whose landing screen opens with five requests at once.
So ten minutes after every sign-in, when the access token expired, all five came
back 401 together and rotated the same cookie in parallel: the first won, the
other four were read as replay, and the family died — taking the winner's fresh
token with it. A twelve-hour refresh token was being destroyed by a ten-minute
access token, every time, and the dashboard then sat there rendering
"Authentication required." into eight panels because clearing the token did not
change the `signedIn` state the tree renders from.

The server was left alone deliberately. Widening rotation to tolerate a
"recently spent" token would weaken §4's theft detection to compensate for a
client defect, and the member and outlet clients had the single-flight guard
already — the dashboard was the outlier, not the rule. `client-invariants.test.ts`
now asserts the guard statically for all three, plus that each client contains
exactly one call site for `/auth/refresh`: the defect compiled perfectly, so a
typecheck can never be what catches its return.

Two adjacent defects in the same code, fixed with it: the 401 retry recursed with
no depth guard, so a 401 no refresh could fix would refresh-and-retry for as long
as the server kept refusing; and "Sign out" called only `clearTokens`, dropping
the access token while leaving the refresh cookie intact — so the next page load
resumed the session and signed the administrator straight back in. On a shared
back-office machine that button was not ending a session, only hiding it. It now
calls `/auth/logout`, and `clearTokens` is no longer exported.

**`STAFF_MFA_REQUIRED` answers a fair question about a real cost.** The second
factor is TOTP, so a developer without the secret in an authenticator app runs
`npm run mfa:code` in a second terminal and reads a number that rolls over every
thirty seconds — on every sign-in, all day, to protect fictional members on
127.0.0.1. Worth noting because the same panel was read as "something that renews
the login token every 30 seconds": it is not, and the session bug above was the
actual cause of being logged out.

Defaults to true; anything but the exact string `false` is true, so a typo fails
closed; and `loadEnv` refuses to return at all if it is false while
`NODE_ENV=production`. A boot failure rather than a warning, because §3 admits no
exception and a misconfigured production API must not be reachable with one factor
for however long it takes somebody to read a log. Nothing is deleted when it is
off — enrollment, verification, recovery codes and the replay check all remain, so
switching back needs no migration and no re-enrollment. A password-only sign-in
audits as `auth.mfa.skipped`, never `auth.login.success`: "an administrator signed
in" and "an administrator signed in without a second factor" are different events,
and a trail that recorded them identically would hide the only rows that could
evidence a misconfiguration after the fact.

The alternative was deleting MFA outright, which was declined. §3's requirement is
about a stolen or phished administrator password reaching the internet, and that
threat does not go away because the second factor is inconvenient to a developer —
it only stops applying on a laptop, which is exactly the scope this switch has.

---

**2026-08-19 — Lifecycle notices ("the outlet has been told", "your benefit was
recorded") now go over SMS too, reversing the "170× buys nothing here" call made
when `sms-sender.ts` was written.**
Alternative: leave lifecycle notices on email only, as `sms-sender.ts` originally
argued — none of them are security-critical, so the per-message cost was judged not
worth it.

The client asked directly for SMS at three points in the member journey: the
invitation code, the sign-in/activation passcode, and being told a benefit request
was sent and a redemption was recorded. The first two were already SMS from Stage
18 onward — this decision only concerns the third, `LifecycleDelivery`
(`request-submitted`, `request-not-used`, `redemption-recorded`), which the SMS
sender had always routed straight to the SMTP fallback alongside outlet notices.

**Cost is still real and unchanged — roughly 170× email per the carrier's
published rate.** That was true when the original call was made and is true now;
what changed is not the number but whose call it is to spend it, and the client
made it. Nothing here removes the counter-argument, it overrides it.

**The routing split is by whether a phone number exists to reach, not by
purpose.** `OutletDelivery` still has no phone at all — an outlet is a mailbox —
so it is unconditionally the fallback sender's job. A `LifecycleDelivery` carries
the same `phone` field a `CodeDelivery` does, so `sms-sender.ts` now attempts SMS
for both and falls back to `smtp-sender.ts` only when there is no phone on record
or the carrier rejects the message. Falling back is safe here in a way it is not
for a passcode: §3's requirement that a sign-in response stay identical regardless
of delivery outcome does not apply to a benefit notice, so losing nothing to a bad
phone number is a strict improvement over the old email-only path, not a new risk.

**The message bodies are a new template family, not a reuse of `passcodeBody`.**
A passcode body is fixed text plus a code and is covered by `assertSingleSegment`
at startup. A lifecycle body embeds `benefitTitle` and `outletName`, which are
administrator-authored and unbounded in practice (`title` allows 200 characters) —
no startup assertion can guarantee one segment for a value nobody has typed yet.
Instead `truncate()` bounds every rendering (40 characters for a title, 30 for an
outlet name), and a separate `qarPlain()` formats the saved amount as plain ASCII
rather than through `Intl.NumberFormat` — the ICU currency formatter can insert a
non-breaking space that would silently force the whole message to UCS-2 and halve
the segment budget, the same class of invisible-cost bug the ASCII-only ellipsis
in `truncate()` avoids.

---

**2026-08-19 — The Apps Script port gets administrator MFA, closing the gap it
had carried as a documented limitation, and loses the self-service outlet token
path it had gained as a convenience.**
Alternative for the first: leave administrators single-factor, as the port's own
README argued — "hand-rolling TOTP is possible but it is security code and
belongs in a reviewed change of its own."

That argument was about sequencing, not about whether to do it, and this is that
separate change. The trigger is the port going live rather than staying a
demonstration: a single password now stands between the open internet and the
whole membership list, and §3's requirement about a stolen or phished
administrator password does not care which build is serving.

**TOTP, not an emailed code, for the reason `security/mfa.ts` already gives:**
a code sent to a mailbox is not a second *factor* when the first is also
something-you-know. That reasoning is unchanged by the runtime, so the shape
matches the PostgreSQL build — mandatory for every active administrator, ±1
period of skew, ten single-use recovery codes, and the accepted period recorded
so a code cannot be replayed inside its ~90-second window.

**The one place parity is not reachable is secret storage, and it is recorded as
a reduction rather than papered over.** `security/mfa.ts` encrypts each secret
with AES-256-GCM so a stolen dump yields nothing usable. Apps Script exposes no
symmetric cipher at all, so the equivalent is not available. Instead the secret
never enters the Sheet: it lives in Script Properties, which a workbook editor
or exporter cannot read and only someone who can open the script project can.
That relocates the secret out of the exportable surface rather than encrypting
it in place — strictly weaker than the PostgreSQL build, strictly stronger than
a column in `Staff`, and the same trade the port already makes on redemption
immutability.

**The challenge between password and second factor is a cache entry, not a
token with a different audience.** The PostgreSQL build separates the two with a
distinct JWT audience, enforced by a check somebody has to remember to write.
Here the separation is structural: a challenge exists only in `CacheService`
under its own key prefix and is never written to `Sessions`, so `requireSession`
cannot resolve one no matter what is handed to it. Cheaper and harder to get
wrong, which is the right trade for the surface it protects.

**`requestOutletToken` was removed outright rather than gated.** It let anyone
who knew an outlet's registered address self-provision an *active* counter
device token, emailed to that address, with no administrator in the loop — so
read access to an outlet mailbox was enough to enroll a tablet that can record
redemptions. It was added as a convenience over "an administrator hands the
token over in person", and that convenience is not worth an enrollment path that
bypasses the approval step it replaces. `issueOutletToken`, behind
`requireStaff`, is now the only way a device is enrolled.

**A `TEMP_resetStaffPasswords` wrapper went with it.** It was left behind to be
runnable from the editor's function dropdown and marked "delete after use", but
a top-level function without a trailing underscore is reachable by anyone
holding the web app URL — meaning a stranger could scramble the administrator
password at will. That is a denial-of-service hole that costs nothing to close.

Verification is by RFC 6238's Appendix B vectors against the hand-rolled HOTP
(all six, including the counter above 2^32 where a bit-shift would silently
misbehave) plus an end-to-end pass over the flow with the Apps Script services
stubbed: password alone yields no session, a challenge is refused as a session,
codes and challenges are single-use, recovery codes are single-use and tolerant
of case and spacing, and the owner reset returns an account to enrollment.
