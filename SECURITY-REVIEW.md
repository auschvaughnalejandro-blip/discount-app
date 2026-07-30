# Security Review

Every item in `docs/security-implementation.md` §12, with its status and where
it is enforced. Confirmed items cite the file that enforces them and the test
that proves it. Deferred items say what is missing and why, without hedging.

Reviewed: 2026-07-29 · against commit `c40c41c` · 239 tests passing

---

## Summary

| | Count |
|---|---|
| Confirmed | 23 |
| Partial | 3 |
| Deferred | 4 |
| **Total** | **30** |

Revised 2026-07-30: **MFA moved from deferred to confirmed** in Stage 19. The
count of deferred items is now four — httpOnly cookies + CSRF, KMS, alerting,
and security headers/CORS. All four are Stage 20 in ROADMAP.md.

Nothing here is marked confirmed on the strength of code alone. Where a test
proves it, the test is named; where the proof is a database privilege, the
privilege was exercised against a real database.

**The remaining deferred items are not oversights.** Each is an integration that
no reference document specifies (KMS, alerting) or deployment-shaped work that
Stage 21 settles (cookies/CSRF, headers/CORS). They are
listed with the same prominence as the confirmed ones because a review that
buries them is worth nothing.

---

## Credentials

### ☑ Argon2id (or bcrypt ≥ 12), per-user salts, parameters stored with hash
**Confirmed.** `apps/api/src/security/password.ts` — Argon2id at exactly the
§3 parameters: m=65536, t=3, p=2, 32-byte output. `@node-rs/argon2` generates a
fresh 16-byte cryptographically random salt per call and encodes the algorithm
and parameters into the returned hash string, so parameters can be raised later
and hashes upgraded on next login.

Deliberately **not** configurable by environment variable: a knob that can
weaken password hashing is a knob that eventually will.

### ☑ MFA enforced on every dashboard account
**CONFIRMED — Stage 19, 2026-07-30.** Was the most significant open item in
this review.

`POST /auth/staff/login` no longer returns tokens for an account that reaches
more than the verification page. It returns a challenge, signed for a **separate
JWT audience** (`src/security/mfa-challenge.ts`) so the existing audience check
rejects it anywhere an access token is expected — the separation is enforced by a
control that already existed rather than by a new rule someone has to remember.

**Scope.** §3 states both "mandatory on every dashboard account, without
exception" and "MFA for any staff account that can reach more than the
verification page". The second is the specific sentence and resolves the first:
ADMINISTRATOR, MANAGER and SUPPORT require it; OUTLET_STAFF, which reaches only
the verification page, does not — and §3 covers those accounts separately with
named individual logins, no shared accounts, shift-length expiry and instant
revocation. Recorded in DECISIONS.md rather than decided silently.

Enforced where:
- `src/security/mfa.ts` — TOTP (`otplib`), AES-256-GCM encryption of the secret
  at rest, recovery-code generation and Argon2id hashing, role scoping
- `src/security/mfa-challenge.ts` — the challenge token and its audience
- `src/routes/auth.ts` — the login gate and the three MFA endpoints

Properties verified by `test/mfa.test.ts` (24 tests) and the acceptance journey,
which now completes enrollment the way a real client must:
- A password alone reaches nothing on a dashboard account
- An un-enrolled account cannot skip enrollment — there is no branch to a token
- The stored secret is unreadable from a database dump alone, and a tampered
  ciphertext fails GCM authentication rather than decrypting to garbage
- A fresh IV per encryption, so two accounts sharing a secret is not visible
- Recovery codes are single-use, consumed atomically (`usedAt: null` in the
  where clause, so two concurrent presentations cannot both succeed)
- Verification is rate-limited per account, not per IP, so rotating source
  addresses does not buy a fresh budget against six digits
- **A TOTP code cannot be replayed.** A code stays cryptographically valid for
  its period plus skew tolerance — about 90 seconds — so the period a code was
  accepted in is recorded (`StaffUser.mfaLastUsedEpoch`) and anything at or
  before it is refused. §3 requires the member OTP to be single use and there is
  no principled reason a staff second factor should be weaker. Marked spent
  before any token is issued, so a concurrent replay loses the race.
- A suspended account cannot complete sign-in in the window between password and
  second factor — the account is re-read at every step, because §3's "instant
  revocation" has to hold inside that window too.
- Every MFA event is audited: challenged, success, failure, enrolled, and
  recovery-code used as its own action, since spending a recovery code should
  stand out in the trail.

**Two things deliberately not built, and worth naming:**
1. **No MFA reset path for an account that has lost both its authenticator and
   its recovery codes.** That account is locked out permanently today. A reset is
   itself a security-sensitive operation — whoever can reset MFA can take over an
   administrator account — so it needs a deliberate design (dual control, or an
   out-of-band identity check) rather than a convenient endpoint.
2. **No step-up re-authentication for sensitive actions.** Export and benefit
   editing sit behind role permissions and the audit log, but not behind a fresh
   second factor. §3 does not require it; for a membership list of this
   sensitivity it is worth considering.

This is a genuine conflict between two authoritative documents rather than an
omission. `BUILD-PLAN.md` Stage 2 lists a closed set of six auth endpoints with
no MFA challenge among them, and no reference document specifies an MFA
library, enrollment flow, or challenge/response shape. Building one means
inventing a feature (forbidden by §0 rule 2) in order to satisfy a security
requirement (§0 rule 3). Recorded as PROGRESS.md **Q5** and carried as a
`TODO(open-question)` at the login handler and on the admin sign-in form.

**Needs a decision before any production use.** The member list is the asset
this whole system exists to protect, and it currently sits behind one password.

### ☑ OTPs and claim codes hashed, single-use, short TTL
**Confirmed.**
- OTP — `src/security/otp.ts`: HMAC-SHA256 keyed by `OTP_CODE_HMAC_SECRET`,
  5-minute TTL, consumed atomically, max 5 attempts. Issuing a new code
  supersedes any outstanding one, so an older forwarded code cannot remain
  usable alongside a fresh request.
- Claim codes — `src/security/claim-codes.ts`: SHA-256, consumed by an
  `updateMany` carrying `usedAt: null` so concurrent activations cannot both
  win. `CLAIM_CODE_TTL_HOURS` (default 720).

Tests: `auth.test.ts` (lockout after 5 attempts, including against the correct
code), `member-lifecycle.test.ts` (single use, expiry, atomic consumption under
concurrency).

### ☑ Claim codes independent of the printed membership number
**Confirmed.** 20 bytes from `randomBytes` — 160 bits, above the 128-bit floor
— encoded in Crockford base32. No derivation from `memberNumber` anywhere.

`member-lifecycle.test.ts` asserts the code contains neither the membership
number nor its numeric part, that 50 generated codes are all distinct, and that
the stored value is a hash rather than the code.

This is a **deliberate deviation from the wireframes**, which sketch a short
`PG- ____ - ____` placeholder worth roughly 40 bits. §0 rule 3 gives the
security document precedence on security matters. Recorded in DECISIONS.md.

### ☑ Constant-time comparison throughout
**Confirmed.**
- Passwords — `verify()` from `@node-rs/argon2` compares digests internally.
- OTP — `timingSafeEqual` over equal-length buffers (`src/security/otp.ts`).
- Identity payloads and verification sessions — `timingSafeEqual`, with an
  explicit length check first because `timingSafeEqual` throws on a mismatch.
- Refresh and claim codes — looked up by unique index on the hash, never by
  scanning and comparing, so no timing signal distinguishes a near miss.

### ☑ Uniform responses and timings on login, activation and reset
**Confirmed.** `POST /auth/staff/login` runs a real Argon2id verification on
both paths — against the account's own hash, or a fixed dummy hash for an
account that does not exist — before any branch that could differ in shape
returns. `verifyAgainstDummy()` in `src/security/password.ts`.

`POST /member/claim` returns one identical `invalid_claim` response for an
unknown code, an expired code, an already-used code, a wrong phone number and a
suspended member. `POST /auth/member/request-otp` answers identically whether or
not the number is registered.

Tested: `auth.test.ts` compares **medians** over a warmed-up sample rather than
means, because the property is a systematic difference and the mean lets one
scheduling stall decide the result. `member-lifecycle.test.ts` asserts the
expired and unknown responses are byte-identical.

**Honest limit:** the timing test catches the dummy-hash branch going missing.
It is not sensitive enough to detect a fine-grained timing oracle, and does not
claim to be.

---

## Tokens

### ☑ Access tokens ≤ 30 min; staff refresh ≤ 12 hours
**Confirmed.** `src/config/env.ts`: member app 30 min, verification page 15 min,
dashboard 10 min; staff refresh 12 h, member refresh 30 days. Exactly §4's
table. The surface is derived from role, since `OUTLET_STAFF` is the only role
that reaches the verification page.

### ☑ Algorithm pinned; `iss` and `aud` validated
**Confirmed.** `src/security/tokens.ts` — `ACCESS_TOKEN_ALGORITHM` is a module
constant passed to `jwtVerify` as `algorithms: [...]`. The token header is never
consulted, so `alg: none` and RS256→HS256 confusion both fail before signature
verification is attempted. `issuer` and `audience` are passed as expectations,
not read and compared afterwards.

The audience required is chosen by the **route's own permission**, not by
anything in the token, so a member-app token presented to a staff route fails
audience validation rather than being inspected first
(`src/plugins/authorization.ts`).

Tests: `tokens.test.ts` — `alg: none` with a well-formed payload, a tampered
`role` claim, expiry, and wrong audience, all rejected.

**Note:** HS256, not the EdDSA/RS256 §4 prefers. §4 permits this explicitly
"within a single deployable", which this is — one Fastify process serving all
three surfaces. Revisit if the API is ever split. DECISIONS.md.

### ☑ Token version checked; rotation with reuse detection
**Confirmed.** `resolvePrincipal()` (`src/security/principal.ts`) re-reads the
subject on every request and rejects a token whose `tv` no longer matches, even
though the token remains correctly signed and unexpired.

`rotateRefreshToken()` (`src/security/refresh-tokens.ts`): a spent token
presented again revokes the entire family. The consuming `UPDATE` carries
`usedAt: null`, so a lost race is treated as a replay rather than silently
succeeding.

`auth.test.ts` verifies the **legitimately rotated successor also stops
working** — not just that the replayed token is rejected. That is what "forces
re-authentication" means.

### ☐ Cookies `httpOnly; Secure; SameSite`; CSRF protection present
**DEFERRED.** §4 requires `httpOnly; Secure; SameSite=Strict` cookies for the
dashboard and verification page, plus a double-submit CSRF token on
state-changing requests. The API returns tokens in the response body and the
clients authenticate with `Authorization: Bearer`.

**Mitigation in place:** no client stores a token in `localStorage` or
`sessionStorage`. All three hold it in a module-scoped variable — unreadable by
an injected script and gone when the tab closes, which on a shared back-office
machine is the better default anyway. The cost is a sign-in on every reload.

**Residual risk:** Bearer tokens in JavaScript memory remain reachable by an XSS
payload executing in the same context. Cookies would move them out of reach
entirely. This is a server-side change (set-cookie on login, read cookie in the
authorization plugin, add CSRF) and should be made before production.

### ☑ No tokens in `localStorage` or URLs
**Confirmed, and enforced by test.** `no-styling.test.ts` strips comments from
every client source file and asserts no `localStorage`, `sessionStorage` or
`document.cookie` usage, and no token in a query string. All three clients
mention `localStorage` in comments explaining why they avoid it, which is why
the check strips comments rather than plain-grepping.

Every authenticated call sends `Authorization: Bearer`. A documented claim
would have decayed the first time someone added a "remember me" checkbox.

---

## Authorization

### ☑ Every route declares a permission; undeclared routes fail at startup
**Confirmed — and this is the strongest control in the build.**

`src/plugins/authorization.ts` registers an `onRoute` hook that throws unless
the route declares `config.permission`. The hook fires for **every** route
however it is registered, including a plain `app.get()` that bypasses any helper
— which is the point. A registration wrapper only protects routes that remember
to call it, and §5 names precisely that failure: "a new endpoint shipped under
deadline with no check at all".

Throwing during `onRoute` rejects plugin registration, which `ready()` and
`listen()` both surface, so the process exits rather than serving an
unprotected endpoint. A misspelled permission fails startup too.

`authorization.test.ts` proves all three: omitted, misspelled, and valid.

### ☑ No list or search endpoint reachable by `outlet_staff`
**Confirmed.** `OUTLET_STAFF` holds exactly two permissions —
`verify:resolve` and `redemptions:record`. It holds no `members:list`,
`members:read`, `reports:*` or `redemptions:list`, so those routes refuse it at
the permission check before any query is built. Absent, not filtered (R11).

The verification client contains no list or search call in its API module at
all, so the button does not exist to be found.

Tests: `authorization.test.ts` (the role holds exactly those two and nothing
else), `member-lifecycle.test.ts` and `redemption.test.ts` (403 over HTTP).

### ☑ Lookup requires an exact identifier; no partial matching
**Confirmed.** `POST /verify/resolve` accepts exactly one of a scanned payload
or an exact membership number, and uses `findUnique` on an equality match. No
`contains`, `startsWith`, `mode: insensitive` or name search exists anywhere in
the route. `redemption.test.ts` asserts a prefix of a real membership number
returns 404.

### ☑ Verification sessions expire within minutes
**Confirmed.** `src/security/verification-session.ts` — an HMAC over
(staffUserId, memberId, issuedAt), issued by `/verify/resolve` and required by
`/verify/redemptions`, default TTL 300 s.

**This was missing and was found by the fetch-then-check guard during Stage 7.**
Without it, `POST /verify/redemptions` accepted any member id an `outlet_staff`
account sent, whether or not they had ever resolved that member. Tested for
expiry, wrong member, wrong staff account and forged signature.

### ☑ Lookup rate limits enforced
**Confirmed.** 30 lookups per staff account per hour
(`RATE_LIMIT_VERIFY_PER_STAFF_MAX`), keyed on the authenticated subject rather
than IP, since §5's concern is a staff member walking the sequence. Membership
numbers are sequential and printed on cards, so an unlimited lookup endpoint is
an enumeration tool.

**Partial on alerting** — see the alerting item below.

### ☑ Queries scoped in `WHERE`; out-of-scope returns 404
**Confirmed.** `src/security/scope.ts` provides `scopeFor*` fragments and
`scopedWhere`. An out-of-scope record and a nonexistent one return
byte-identical responses (`authorization.test.ts`).

**A real defect was found and fixed here.** §5 illustrates scoping as
`where: { id: params.id, ...scopeFor(principal) }`. That spread is only safe
while the fragment shares no keys with the base query — and a member's scope is
`{ id: <their own id> }`, so the later spread wins and the id the caller asked
about is silently replaced by their own. Every lookup returned the caller's own
record instead of 404: a 200 where the answer had to be 404, failing open while
looking correct. Replaced with `scopedWhere`, which composes with `AND` and
cannot clobber. A regression test demonstrates the old behaviour explicitly.

`fetch-then-check.test.ts` scans `src/routes` for Prisma reads of scoped models
without a scope fragment, with an exempt list carrying written reasons. It has
caught a real issue in every stage since it was written.

### ☑ Authorization matrix passing in CI
**Confirmed in the suite; CI itself is deferred.** `authorization.test.ts`
declares the allowed roles for all 17 permissions independently of the
implementation and asserts the two agree *and* that neither has an entry the
other lacks — so adding a permission without deciding who holds it is a test
failure. Exercised over real HTTP as well as against the table.

No CI pipeline is configured in this repository. The tests run locally with
`npm test`.

---

## Data

### ☑ `UPDATE`/`DELETE` revoked on redemptions at database level
**Confirmed, and exercised against a real database.** The application connects
as `pgp_app`, which holds only `SELECT` and `INSERT` on `"Redemption"`.
Migration `20260729140100_redemption_immutability`.

The split matters: migrations run as the schema owner via Prisma's `directUrl`,
because an owner cannot be denied its own tables and the revocation would
otherwise be theatre.

```
=== UPDATE that redemption as the app role ===
ERROR:  permission denied for table Redemption
=== DELETE a member as the app role ===
ERROR:  permission denied for table Member
```

`data-model.test.ts` also confirms `DELETE` revoked on `"Member"` (R16) and
`UPDATE`/`DELETE` revoked on `"AuditLog"` and `"ConsentRecord"`, and that a
rejected write leaves the row byte-identical.

### ☑ Idempotency keys on redemption creation
**Confirmed.** Unique index on `Redemption.idempotencyKey`. A repeat returns the
original; the same key with different content returns 409 rather than silently
returning the original, because that would hide a client bug. Two identical
submissions in flight at once resolve to one row.

The lookup is **scoped to the caller's outlet** — the key is client-supplied, so
an unscoped lookup would let a guessed key disclose another outlet's redemption
(member id, benefit, party size, bill amount). Found by the fetch-then-check
guard during Stage 7.

### ☑ Identity payload rotating; window configurable
**Confirmed.** `v1.<memberRef>.<issuedAt>.<hmac>`, signed over all three parts
together so neither the reference nor the timestamp can be swapped alone.
Signature is verified **before** freshness — checking age first means reasoning
about a timestamp an attacker chose. Future-dated payloads are rejected too, or
they would never expire.

`IDENTITY_CODE_WINDOW_HOURS` (default 24). `identity-codes.test.ts` asserts the
module contains no baked-in 24, since a default there would make the setting a
lie, and that the same payload is accepted or rejected purely by moving the
configured window.

The payload carries the opaque internal id, never the printed `PG-` number.

### ☑ Small-cohort suppression on all reporting
**Confirmed.** `src/reporting/suppression.ts`, minimum 5 — the one threshold §6
states outright.

The cohort is **distinct members, not rows**: four redemptions by one member is
a cohort of one, and it is the member the report must not identify. The cohort
size is withheld along with the figures, since "3 members" is the same
disclosure stated outright.

Verified against a purpose-built benefit used by exactly three members, then by
taking that cohort to five and watching the real figure appear.

### ☑ No member names in application logs; redaction layer in place
**Confirmed, and verified against a real running server.**

`src/logging/redaction.ts` uses two mechanisms because either alone leaves a
gap: pino's `redact` paths for shapes it logs itself, and a serializer that
walks whatever a caller passes and strips anything named like personal data at
any depth. The second is what makes `log.info({ member })` safe — the call
nobody anticipates, made while debugging something else. Opaque references
(`id`, `memberNumber`, `outletId`) pass through, or redaction would remove the
identifiers that make an entry useful.

`audit.test.ts` drives a real pino instance configured exactly as the app
configures its own, logs a whole member record three ways, and finds no name,
phone or email while the opaque id survives.

Beyond the suite: the dev server was brought up, members listed over HTTP, and
its actual log output grepped for all four seeded member names. None present.

### ☑ Audit log separate, append-only
**Confirmed.** `UPDATE` and `DELETE` on `"AuditLog"` are revoked from the
application role, so a caller cannot rewrite its own trail. The §9 action list
is covered: member viewed / listed / created / updated / suspended / reinstated
/ claimed, claim code issued, consent changed, verification lookups both ways,
redemptions recorded and reversed, benefit changes, exports, every
authentication event, and **every authorization denial**.

Entries carry the membership number, never the name. A failed login does not
record the attempted email — that would write attacker-chosen strings, and
occasionally a real address typed into the wrong box, into the trail.

**Alerting is deferred** — see below.

### ☑ Exports administrator-only and individually logged
**Confirmed.** `reports:export` is held by `ADMINISTRATOR` alone. Rate limited
per user (5 per 24 h), and a throttled attempt is logged *before* it is
refused, because a burst is itself the signal.

The export returns **membership numbers, never names** — an export is the most
sensitive artefact this system produces and should not be a ready-made list of
named individuals. `reporting.test.ts` asserts no `fullName`, `phone` or
`email` field appears in any exported row.

---

## Items §12 lists that are deferred

### ☐ Pepper held in a key management service
**DEFERRED.** §3 requires the password pepper in a KMS, "not the database", so a
stolen dump alone is not crackable. No KMS exists in this build's stack or in
any reference document. `PASSWORD_PEPPER` is an environment variable — at least
not colocated with the hashes it protects, which is the property the pepper
exists for, but not the mechanism §3 asks for.

The same applies to `IDENTITY_CODE_HMAC_SECRET` (§7) and `JWT_SIGNING_KEY`.

### ☐ Key rotation with `kid` so old tokens verify during rollover
**DEFERRED.** §4 requires keys "rotated on schedule, with a `kid`". Single
static signing key; no `kid` header, no rollover path. Rotating the key today
invalidates every outstanding token at once.

### ☐ Alerting in real time
**DEFERRED.** §9 requires alerts on repeated failed member lookups, refresh-token
reuse, bulk export, out-of-hours administrative access, a staff account
exceeding normal lookup volume, and any spike in authorization denials.

Every one of those events **is recorded** with a distinct audit action, so the
data to alert on exists. Nothing consumes it. No alerting destination is named
in any reference document.

### ☐ Security headers, CORS allowlist, certificate pinning
**DEFERRED.** §8 requires HSTS with preload, `nosniff`,
`X-Frame-Options: DENY`, a strict CSP without `unsafe-inline`, an exact-origin
CORS allowlist, and certificate pinning in the member app.

None are configured. In development the clients reach the API through a Vite
proxy, so requests are same-origin and no CORS policy is exercised — which means
this gap is invisible locally and will appear immediately on first deployment.
`CORS_ORIGIN_*` variables are named in `.env.example` but unread.

**This is the item most likely to be forgotten**, because everything works
without it right up until it is deployed.

### ☐ Data protection impact assessment
**DEFERRED — not an engineering task.** §10 requires a DPIA before launch, and
notes that failing to carry one out carries an administrative fine of up to
QAR 1,000,000 on its own, independent of any breach. §10 also requires the
hosting region to be settled before infrastructure is built, given restrictions
on transferring personal data outside Qatar.

Neither is decided. Both are blocking for launch rather than for development.

---

## Partial items

### ◐ Deletion by anonymisation
§10 requires deletion requests to be honoured by irreversible anonymisation
rather than row removal, severing the link to redemption history so aggregate
reporting survives. The schema supports it — members are never deleted (R16),
and the application role holds no `DELETE` on `"Member"` — but **no
anonymisation endpoint exists.** `BUILD-PLAN.md` does not list one in any stage.

### ◐ No special-category data
§10 warns that spa treatment records can imply health information, and requires
recording only that a spa benefit was used, not which treatment. **Satisfied by
construction:** `Redemption` has no treatment or description column, and no
endpoint accepts one. Marked partial rather than confirmed only because nothing
actively prevents a future migration from adding such a column — the guard is
the schema as it stands, not a test.

### ◐ Pagination caps
§8 requires that no endpoint can be coerced into returning the full membership.
`MEMBER_LIST_MAX_PAGE_SIZE` (100) caps the member list and the redemption log.
`GET /member/me/redemptions` is capped at 100 and the export at 5000 rows.
Partial because the export cap is high enough that "the full membership" is
effectively reachable by an administrator — which is the intent of an export,
but means the cap is not doing protective work there.

---

## What I would fix first

In order, if this were going to production:

1. **MFA on dashboard accounts.** The member list is the asset; it is behind one
   password. This needs a decision, not more code.
2. **Security headers and a CORS allowlist.** Invisible in development, needed
   from the first deployment.
3. **httpOnly cookies for the staff surfaces**, with CSRF. Moves tokens out of
   reach of XSS entirely.
4. **Alerting.** The events are all recorded; nothing watches them, which makes
   the audit log forensic rather than preventive.
5. **A KMS**, retiring three environment-variable secrets.

Items 2 and 3 are ordinary deployment work. Item 1 is a conflict between the
build plan and the security specification, and needs someone to resolve it.
