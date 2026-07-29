# Security Implementation Specification

**Product:** Privilege Guest Program — member app, verification page, admin dashboard
**Version:** 2 — revised for confirmed scope
**Audience:** Engineering

---

# 0. What changed from version 1

The programme has no points currency and no independently owned tenants, so several sections are gone: points-ledger integrity, multi-tenant row-level isolation between competing businesses, and offline transaction queueing.

**One thing became considerably more important.** The membership is invitation-only and includes prominent individuals — the reference card in the programme materials is issued to a member of the Qatari ruling family.

The primary security concern is therefore **confidentiality of who the members are and where they have been**, not fraud against a points balance. A leaked membership list, or a record of which member visited the spa on which date, is a serious matter for the hotel entirely independent of any regulatory penalty.

Every access-control decision below follows from that.

---

# 1. Four principles

**Fail closed.** Any component that cannot determine whether an action is permitted denies it. A missing permission declaration is a denial.

**Never trust the client.** Not the body, not a header, not a value inside a token the client could have influenced. Role and scope are resolved server-side on every request.

**Authorize at the object, not the route.** Confirming a caller holds the *manager* role is not the same as confirming this record is one they may see. Nearly every real-world data leak lives in that gap.

**Minimum exposure.** Nobody sees a member record they do not need for the task in front of them. This is a small membership; there is no operational reason for broad access.

---

# 2. Threat model

| Actor | Motivation | Method | Primary controls |
|---|---|---|---|
| **Curious or paid-off staff** | Selling information about a prominent guest | Browsing member records or history | Staff see only the member in front of them; every lookup logged |
| **External attacker** | High-value membership list | Credential stuffing, injection, exposed endpoints | MFA, hardening, encryption, monitoring |
| **Opportunistic non-member** | 30–40% discounts | Presenting a copied code or a discarded invitation letter | Rotating payloads, single-use claim codes, staff verification |
| **Dishonest staff** | Applying discounts for friends | Recording redemptions that did not occur | Named accounts, attribution on every record, anomaly review |
| **Insider with admin access** | Bulk extraction | Export of the member list | Export restricted, individually logged, alerted |

**Note the ordering.** In version 1 the top threat was points fraud. Here it is disclosure.

---

# 3. Credential storage

## Passwords — dashboard and staff accounts

**Argon2id.** Not SHA-256, not MD5, not unsalted anything.

```
Argon2id
  memory      : 64 MB  (m = 65536)
  iterations  : 3
  parallelism : 2
  salt        : 16 bytes, cryptographically random, unique per user
  output      : 32 bytes
```

If no maintained Argon2 binding exists for the runtime, **bcrypt with a work factor of at least 12**. Nothing else is acceptable.

- Unique random salt per password. Never a global salt.
- Store algorithm and parameters alongside the hash, so parameters can be raised later and hashes upgraded transparently on next login.
- Add a **pepper** held in the key management service, not the database — a stolen dump alone is then not crackable.
- Verify with **constant-time comparison**. Library comparison functions do this; `==` does not.
- Minimum length rather than composition rules, screened against a breached-password list.
- **MFA is mandatory on every dashboard account**, without exception. Given what the member list contains, a single reused password should not be sufficient to reach it.

## Member authentication

Phone number and one-time passcode. No passwords for members.

- Codes generated with a cryptographically secure source, never `Math.random()`.
- **Stored hashed.** A leaked table of live codes is account takeover.
- 5-minute TTL, single use, deleted on successful verification.
- Constant-time comparison; maximum 5 attempts, then invalidate.
- Rate limited per number, per IP, and globally to prevent SMS-pumping fraud.

## Claim codes

The invitation code that activates a membership.

- **Single use.** Consumed atomically on first successful activation.
- Cryptographically random, at least 128 bits of entropy — never derived from the membership number, which is printed on a card and sequential.
- Stored hashed.
- Expires after a defined period; regenerable by an administrator.
- Bound to a specific member record on issue.
- Strict rate limiting on the activation endpoint, since a guessable claim code grants a genuine membership.

## Staff accounts

- Named individual accounts. **No shared outlet logins ever** — an unattributed redemption record is worthless for both audit and deterrence.
- Sessions expire on a shift-length timer.
- Instant revocation from the dashboard.
- MFA for any staff account that can reach more than the verification page.

## Account enumeration

Login, activation and reset return **identical responses and comparable timings** whether or not the identifier exists. On a membership this exclusive, confirming that a given phone number belongs to a member is itself a disclosure.

---

# 4. Token architecture

## Shape

**Short-lived JWT access token, long-lived opaque refresh token.**

A JWT cannot be individually revoked without building the server-side state it was meant to avoid. So:

| | Access token | Refresh token |
|---|---|---|
| Format | Signed JWT | Opaque random string |
| Lifetime | 10 min (dashboard), 15 min (verification page), 30 min (member app) | 30 days sliding (member), 12 hours (staff) |
| Server state | None | Hashed, with family ID |
| Revocable | By expiry and token version | Immediately |

Staff refresh lifetimes are deliberately short. A member's session persisting is a convenience; a staff session persisting on a shared device is an exposure.

## Signing

- **EdDSA (Ed25519) or RS256.** HS256 acceptable only within a single deployable.
- **Pin the algorithm server-side.** Never read `alg` from the token — that is how `alg: none` and RS256-to-HS256 confusion attacks work.
- Keys in the key management service, rotated on schedule, with a `kid` so old tokens verify during rollover.

## Claims

```json
{
  "iss": "privilege-guest",
  "aud": "admin-api",
  "sub": "usr_01H...",
  "role": "outlet_staff",
  "oid": "out_spa",
  "tv":  4,
  "jti": "jwt_01H...",
  "iat": 1753800000,
  "exp": 1753800600
}
```

- `iss` and `aud` are **validated**, not merely present. A token minted for the member app must not be accepted by the admin API.
- `tv` is a **token version** on the user record. Incrementing it invalidates every outstanding access token for that user — the mechanism behind logout-everywhere, role change, and emergency revocation.
- `jti` gives each token an identity for audit correlation.

## Rotation and reuse detection

Every refresh issues a new token and invalidates the old one; each chain carries a **family ID**.

**If a spent refresh token is presented again, revoke the whole family and force re-authentication.** A legitimate client never replays one. This turns a silent compromise into a detected one.

## Client storage

- **Dashboard and verification page:** `httpOnly; Secure; SameSite=Strict` cookies. **Never `localStorage`** — any XSS flaw becomes total account theft. Cookie auth requires CSRF protection: SameSite plus a double-submit token on state-changing requests.
- **Member app:** iOS Keychain, Android Keystore. Never plain preferences.
- No tokens in URLs. They reach logs, history and referrer headers.

## Forced re-authentication

Increment token version and revoke refresh families on: password change, role change, staff offboarding, membership suspension, suspected compromise, and user-initiated logout-everywhere.

---

# 5. Authorization

## Deny by default, enforced at boot

Every route declares its required permission. A route with no declaration **fails application startup**.

```ts
route.get('/members/:id', {
  permission: 'members:read',
  scope: 'global',
}, handler)

// A route with no `permission` key throws at registration.
// Forgetting to protect an endpoint becomes a build failure,
// not a hole discovered in production.
```

This is the single highest-value control here. The realistic failure is not a broken check — it is a new endpoint shipped under deadline with no check at all.

## Role matrix

| Role | Can reach | Explicitly cannot |
|---|---|---|
| `administrator` | Everything: members, benefits, reports, staff, exports | — |
| `manager` | Member list, member detail, reports | Edit benefits, manage staff, export |
| `outlet_staff` | Verification page only | **Member list, search, reports, any member not just scanned** |
| `support` | Single member by exact ID | Listing, browsing, exporting |

## The staff restriction, implemented

Outlet staff must never be able to enumerate the membership. This needs real enforcement, not a hidden menu item:

- **There is no list endpoint available to the `outlet_staff` role.** Not filtered — absent.
- Lookup requires an **exact** membership number or a scanned code. No partial matching, no wildcard, no name search.
- The result is bound to a **short-lived verification session** — staff can act on that member for a few minutes, then the context expires.
- **Rate limited hard**: a handful of lookups per staff member per hour. Membership numbers are sequential and printed on cards, so an unlimited lookup endpoint is an enumeration tool.
- Failed lookups against non-existent numbers are logged and alerted — that pattern is someone probing.

## Never derive authority from the request

**Scope the query; do not fetch and then check.**

```ts
// WRONG — record loaded before authorization is decided.
// Errors, timing and logs can all leak its existence.
const m = await db.members.findById(req.params.id)
if (!can(req.principal, m)) throw new Forbidden()

// RIGHT — the query cannot return a record the caller may not see
const m = await db.members.findFirst({
  where: { id: req.params.id, ...scopeFor(req.principal) }
})
if (!m) throw new NotFound()
```

Return **404, not 403**, for anything out of scope. A 403 confirms the record exists.

**Privilege elevation is verified server-side.** A client-supplied `approved: true` is not an authorization decision.

## Database backstop

Even without competing tenants, defence in depth is worth the small cost. The application role holds **no `DELETE` on members or redemptions**, and no `UPDATE` on redemptions. Destructive operations require a separate migration role.

---

# 6. Reporting endpoints

**No client-supplied SQL, ever — including fragments.** Metrics and dimensions come from a server-side allowlist mapping identifiers to validated expressions.

```ts
const METRICS = {
  redemptions: 'count(*)',
  guests:      'sum(party_size)',
  est_value:   'sum(bill_amount_minor * discount_pct / 100)',
} as const
```

Anything absent from the map is rejected before a query is built.

**Suppress small cohorts.** This matters more here than in a large programme. With a membership of dozens, a report filtered to one benefit, one outlet and one week may describe exactly one person. Enforce a **minimum cohort size of 5** below which the endpoint returns "insufficient data" rather than a number.

Without this, aggregate reporting becomes an indirect route to individual member movements — precisely what section 0 says we are protecting.

**Exports are a separate permission**, administrator-only, rate-limited, individually audited, and alerted in real time.

---

# 7. Codes

## Member identity payload

```
v1.<member_ref>.<issued_at>.<hmac>
```

- `member_ref` is an **opaque random identifier**, never the printed PG number, which is sequential and guessable.
- HMAC over the full payload, keyed from the key management service.
- `issued_at` refreshed whenever the app regenerates the code. The verification page rejects payloads older than a configured window — defeating forwarded screenshots.
- **Identifies only.** Entitlement is resolved server-side against the member record. Possession of the code never itself applies a discount.

## Why rotation matters here

A 40% spa discount and 30% off room rates are worth real money. A static code circulated in a group chat would be used. The rotation window is a **tunable setting**, not a hardcoded constant: start around 24 hours, monitor verification failures at outlets, and adjust.

## Redemption records

- **Idempotency key required** on creation, so a retried submission does not double-record.
- Records are **immutable**: `UPDATE` and `DELETE` revoked at database level for the application role.
- Corrections are compensating entries attributed to the authorising user.
- Every record carries: member, benefit, outlet, party size, staff member, device, timestamp.

---

# 8. API hardening

- **Schema validation at the edge**, rejecting unknown fields rather than ignoring them — mass-assignment flaws come from silently accepting extra keys.
- **Parameterised queries only.** No string concatenation into SQL anywhere, including reporting.
- **Rate limiting** by class: strictest on OTP, activation and member lookup; moderate on writes; generous on reads. Applied per IP *and* per principal.
- **CORS allowlist** of exact origins. Never `*`, never reflect `Origin`.
- **Security headers:** HSTS with preload, `nosniff`, `X-Frame-Options: DENY`, strict CSP without `unsafe-inline`.
- **No personal data in URLs.**
- **Certificate pinning** in the member app.
- **Pagination caps** so no endpoint can be coerced into returning the full membership.

---

# 9. Logging and audit

**Application logs** contain **no member names, phone numbers or email addresses.** Log the opaque member reference only. Enforce with a redaction layer on the logger rather than by convention.

**Audit log** — separate, append-only, restricted:

- Every member record viewed, and by whom
- Every verification lookup, successful or not
- Every export
- Every benefit change
- Every membership created, suspended or reinstated
- Every authentication event and permission change
- Every authorization denial

**Who viewed which member's history is itself sensitive information**, and the hotel should be able to answer that question.

**Alert on:** repeated failed member lookups, refresh-token reuse, bulk export, out-of-hours administrative access, a staff account exceeding normal lookup volume, and any spike in authorization denials.

---

# 10. Data protection

Full treatment sits in the architecture document. The implementation-relevant obligations:

- **Consent is captured per channel, unticked by default**, stored with timestamp and wording version, and withdrawable with immediate effect everywhere.
- **Deletion requests are honoured by anonymisation**, not row removal — identifying attributes are irreversibly hashed and the link to redemption history severed, so aggregate reporting survives.
- **A data protection impact assessment is required before launch.** Failing to carry one out carries an administrative fine of up to QAR 1,000,000 on its own.
- **Hosting region must be decided before infrastructure is built**, given restrictions on transferring personal data outside Qatar.
- **No special-category data.** Note that spa treatment records can imply health information — record that a spa benefit was used, not what treatment was taken.

That last point is easy to miss and worth stating in review.

---

# 11. Testing

**An authorization matrix in CI: every role against every endpoint**, with declared expected outcomes. The build fails on any deviation.

Also automated:

- `outlet_staff` attempting any list or search endpoint — must 404 or 403 on every one
- Member lookup by sequential enumeration — must rate-limit and alert
- Token manipulation: `alg: none`, altered `role`, expired, wrong audience, tampered signature
- Refresh reuse triggering family revocation
- Claim code reuse — must fail on second attempt
- Stale identity payload — must be rejected by verification
- Small-cohort suppression on every reporting endpoint
- Redemption idempotency under duplicate submission

---

# 12. Engineering checklist

**Credentials**
- [ ] Argon2id (or bcrypt ≥ 12), per-user salts, parameters stored with hash
- [ ] MFA enforced on every dashboard account
- [ ] OTPs and claim codes hashed, single-use, short TTL
- [ ] Claim codes independent of the printed membership number
- [ ] Constant-time comparison throughout
- [ ] Uniform responses and timings on login, activation and reset

**Tokens**
- [ ] Access tokens ≤ 30 min; staff refresh ≤ 12 hours
- [ ] Algorithm pinned; `iss` and `aud` validated
- [ ] Token version checked; rotation with reuse detection
- [ ] Cookies `httpOnly; Secure; SameSite`; CSRF protection present
- [ ] No tokens in `localStorage` or URLs

**Authorization**
- [ ] Every route declares a permission; undeclared routes fail at startup
- [ ] No list or search endpoint reachable by `outlet_staff`
- [ ] Lookup requires an exact identifier; no partial matching
- [ ] Verification sessions expire within minutes
- [ ] Lookup rate limits enforced and alerting on failures
- [ ] Queries scoped in `WHERE`; out-of-scope returns 404
- [ ] Authorization matrix passing in CI

**Data**
- [ ] `UPDATE`/`DELETE` revoked on redemptions at database level
- [ ] Idempotency keys on redemption creation
- [ ] Identity payload rotating; window configurable
- [ ] Small-cohort suppression on all reporting
- [ ] No member names in application logs; redaction layer in place
- [ ] Audit log separate, append-only, alerting live
- [ ] Exports administrator-only and individually logged