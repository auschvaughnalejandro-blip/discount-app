# Roadmap — from working logic to a shipped product

Last updated: 2026-07-30
Status: stages 0–14 complete; **16, 17, 18 and 19 now also complete**. 313 tests
passing. Stage 15's decisions are partly answered (Q1, Q5, Q6 closed; Q11 open) —
see PROGRESS.md and DECISIONS.md. Remaining: 20, 21, 22, 23, 24.

A separate security-hardening plan covering Stage 20 in more detail lives at
`~/.claude/plans/can-you-implement-a-agile-flurry.md`. It also adds audit-log
alerting and a secret-provider abstraction, and flags a real problem with
`docker-compose.yml`'s committed dev passwords given Stage 21 proposes reusing
that file shape in production.

`build_plan.md` took this from nothing to a tested backend and three working
clients. It stops at Stage 14 and says nothing about what comes after, because
its §0 rule 1 deliberately excluded everything a user would call "the app."

This file covers what remains. It continues the same stage numbering, keeps the
same rules about acceptance criteria and `PROGRESS.md`, and drops **only** rule
1 — styling is now in scope. Rules 2, 3, 4, 5 and 6 still apply.

---

# 0. Read this first: what is actually left

What exists is a correct, tested, well-secured engine with no bodywork. The
distribution of remaining effort is not intuitive:

| Area | State | Remaining effort |
|---|---|---|
| Data model, business rules, authorization, audit | Done, tested | ~none |
| API surface | Done, tested | Small additions only |
| Screen structure and content | Done, matches wireframes | ~none |
| Visual design | **Done** (Stage 17) — `packages/ui` + per-app theme/layout | Refinement only |
| QR image, camera scanning | **Done** (Stage 16) | ~none |
| Passcode delivery | **Done** (Stage 18) — email/SMTP, interim | Real SMS provider |
| Staff MFA | **Done** (Stage 19) — TOTP, replay-protected | Reset path; step-up auth |
| Headers, CORS, cookies, KMS, alerting | Does not exist | **Medium — Stage 20** |
| Deployment, TLS, backups | Does not exist | **Medium — Stage 21** |
| **Arabic / RTL** | Does not exist | **Medium, and needs a schema change** |
| Wallet pass, push | Does not exist | Genuinely Phase 2 |

Arabic remains the item most likely to be underestimated: the UI half is cheap
because Stage 17 used logical properties throughout, but benefit content lives in
single-language database columns and needs a translation table.

Stage 17's own remaining work is refinement, not construction — real photography
for the member benefit cards, and charts in the admin reports (load the `dataviz`
skill before writing chart code).

---

# 1. Stage 15 — Decisions before code

**Not an engineering task, and it gates the most work per hour of anything
here.** `product_vision.md` §11 lists ten open questions. `PROGRESS.md` records
which ones were answered with a documented assumption and which are still open.

Three actively block work:

- **Q1 — what does the existing QR code do?** The whole redemption model rests
  on the assumption that the code identifies the *member* and is scanned by
  staff. If it turns out to be a code displayed at each outlet and scanned by
  the member, Stage 16 is wasted and the verification page's purpose changes.
  **Confirm this before Stage 16.**
- **Q6 — which SMS provider?** Blocks Stage 18 and therefore blocks any real
  member signing in.
- **Q5 — MFA.** `security-implementation.md` §3 says mandatory "without
  exception"; nothing specifies the flow. Stage 19 proposes one. It needs
  approval, not invention.

Plus one question `build_plan.md` never had to answer:

**Q11 — installable web app, or native iOS/Android?** §11.8 asks and nobody
answered. This changes the shape of everything after Stage 17.

- **PWA** — keep the three React apps, style them, add a manifest and service
  worker. Members "install" from the browser. No app store review, no second
  codebase, no Apple Developer fees. Weak push on iOS.
- **Native (React Native)** — the member client is rebuilt. Real push, real
  wallet integration, an App Store presence. The API, admin and verify surfaces
  are untouched. Adds months.

**Recommendation: PWA for the pilot.** §8 of the definition says "member
downloads the app," which points native, but the API does not care either way —
this is one of the few remaining decisions that is cheaply reversible, and the
pilot does not need an App Store listing to prove the programme works. Revisit
after the pilot with real member feedback rather than a guess.

Also close the cheap ones while you are in the room: Q2 (bill amounts — decides
whether the cost report exists), Q3 (expiry), Q4 (priority reservations and
events), Q7 (manager write access), Q8 (claim code lifetime), Q9 (Arabic —
assumed yes, see Stage 22), Q10 (the three numbers checked monthly — fastest way
to confirm reporting scope is right).

**Acceptance:** every §11 question has a recorded answer in `DECISIONS.md`, and
every `TODO(open-question)` comment in the codebase either resolves or gains a
reason to stay.

---

# 2. Stage 16 — QR rendering and camera scanning

The credential mechanism is finished and tested (`identity-codes.test.ts`). Both
ends of it are placeholders in presentation only: the member app prints the
payload as text, and the verify page has a paste box instead of a camera.

## Rendering the member's card

**Use `react-qr-code`.** Pure SVG, no canvas, no native dependency, a few kB.
Canvas-based renderers exist but SVG scales to any screen density without
blurring and needs no `devicePixelRatio` handling.

```
npm i react-qr-code --workspace @pgp/web-member
```

Settings that matter:

- **Error correction level `M`.** Not `H`. `H` adds ~30% more modules, which on
  a phone screen at 240px makes each module smaller and *harder* to scan. `H`
  earns its keep on printed labels that get dirty; a backlit screen held 20cm
  from a camera is the easy case.
- **Minimum 240px, and a 4-module quiet zone.** The library's default quiet zone
  is correct; do not crop it to save space.
- **Never render it on a dark or tinted background.** Whatever Stage 17's design
  system does elsewhere, the card's QR sits on pure white. This survives
  contrast-ratio arguments — scanners need luminance contrast, not brand
  contrast.
- **Raise screen brightness while the card is open** if the platform allows it.
  A dimmed phone in a bright restaurant is the single most common scan failure.

Replace the `<output>{code.payload}</output>` in `DigitalCard`
(`apps/web-member/src/App.tsx`). Keep the payload rendered as selectable text
somewhere on the screen as a fallback for a broken camera — but small, below the
image.

**Do not touch the 60-second refresh.** It is already inside the server's
freshness window. The QR must re-render on every refresh, which it will
automatically, since the payload is React state.

## Scanning on the verify page

**Use `@zxing/browser`.** The native `BarcodeDetector` API is tempting and
faster, but is unavailable in Safari — and §6 of the definition says staff use
"any device already behind the counter," which in a hotel is very often an iPad.
Progressive enhancement (`BarcodeDetector` when present, ZXing otherwise) is
fine but optional; ZXing alone is consistent and adequate.

```
npm i @zxing/browser --workspace @pgp/web-verify
```

Three things that will bite:

- **The camera requires a secure context.** `getUserMedia` refuses on plain
  HTTP. `localhost` counts as secure, so dev works, but **the verify page cannot
  work on a LAN IP without TLS** — this makes Stage 21 a prerequisite for
  testing on a real counter device, not an afterthought.
- **Ask for the rear camera** (`facingMode: 'environment'`) and handle the
  permission denial with a visible message, not a silent dead camera.
- **Stop the video track on unmount.** A camera light left on behind a hotel
  counter is a support call.

**Keep the paste box and keep the number entry.** Screen 9 note 2 requires
typing the membership number to work as well as scanning, because many members
present the printed card. The scanner is an addition, not a replacement.

**Acceptance:**
- The member card renders a scannable QR that changes when the payload refreshes
- A phone camera on the verify page resolves a member from that QR end to end
- Membership-number entry and payload paste both still work
- Denying camera permission produces a visible, actionable message

---

# 3. Stage 17 — Design system and styling

The largest remaining item, and the one that turns your screenshot into a
product. It is also lower-risk than it sounds: because the wireframe annotations
were followed literally, *what is on each screen and why* is already settled.
This is styling a known thing, not designing an unknown one.

## First: retire the test that forbids it

`apps/api/test/no-styling.test.ts` will fail on the first stylesheet. **Do not
delete the file.** It contains four groups of assertions and only three of them
are about styling:

| Assertion group | Action |
|---|---|
| No stylesheet files exist | **Remove** |
| No `className` / `style=` attribute | **Remove** |
| No styling dependency in package.json | **Remove** |
| Member client hardcodes no benefit value (R14) | **Keep — still load-bearing** |
| Clients use no `localStorage` / tokens in URLs (§4) | **Keep — still load-bearing** |

Rename the file to something honest, like `client-invariants.test.ts`, and
record the change in `DECISIONS.md` with the reason: rule 1 was a staging
discipline for stages 0–14, and it has now served its purpose. Silently deleting
a guard is how a rule dies without anyone deciding.

## Approach: design tokens + CSS Modules in a shared package

Create `packages/ui`, consumed by all three clients:

```
packages/ui/
├── tokens.css          CSS custom properties — the whole design language
├── reset.css
└── src/
    ├── Button.tsx + Button.module.css
    ├── Card.tsx
    ├── Field.tsx
    ├── Badge.tsx
    └── index.ts
```

**Why plain CSS with custom properties and CSS Modules, and not Tailwind:**

1. **Arabic and RTL (Stage 22).** With CSS logical properties
   (`margin-inline-start`, `padding-inline`, `inset-inline-start`, `border-start-*`)
   RTL costs approximately nothing — one `dir="rtl"` on `<html>` and the layout
   mirrors itself. Utility-class frameworks handle RTL, but you end up managing
   it per class across three apps.
2. **The brand is bespoke.** This is a luxury hotel programme whose members
   include a member of the Qatari ruling family. The look needs to be specific,
   not assembled from defaults.
3. **Three apps, one language.** Tokens in one file, imported three times, means
   changing the gold changes it everywhere.

**Use logical properties from the first line of CSS.** Retrofitting them later
across three apps is miserable, and it is free to do now.

## The three apps want genuinely different things

They share tokens and primitives; they do not share layout.

**Member app — phone-first, and the only one anyone outside the hotel sees.**
Restrained and expensive-feeling. Benefit categories as real cards with imagery
(§4 says "visual cards"). The membership number stays prominent — screen 3 note
1 exists because that is the thing staff ask for. The digital card should feel
like an object: full-bleed, high contrast, instantly recognisable from across a
reception desk so it reads as the plastic card's equivalent.

**Verify page — a tool, used under pressure, one-handed, in seconds.**
Optimise for glanceability over beauty. **Valid / NOT VALID must be readable at
arm's length** — huge type, unmistakable colour, and *not colour alone*, because
a colour-blind staff member applying a 40% discount to a suspended membership is
exactly the failure this screen exists to prevent. Large tap targets. The
"Confirm and record" button must be impossible to hit by accident.

**Admin dashboard — desktop, dense, data-first.** Real tables with sortable
columns, sticky headers, readable numbers. Reports need actual charts. This is
the app where information density beats whitespace.

## Charts in the admin dashboard

The reporting endpoints already return live data. When it comes time to render
it, **load the `dataviz` skill before writing the first line of chart code** —
it covers palette, form selection and accessibility in a way that will keep the
six report types looking like one system instead of six.

## Keep the accessibility you already have

The current markup is genuinely good: real `<button>` elements, `<label>`
associated with every input, `role="alert"` on errors, `aria-current` on the
active tab, `<fieldset>`/`<legend>` on grouped controls. **Styling must not
regress this.** Do not replace a `<button>` with a `<div onClick>` to make it
easier to style. Verify keyboard navigation and visible focus rings on every
screen before calling the stage done.

**Acceptance:**
- All three clients styled, no screen unstyled
- One token file drives all three
- Every screen usable at 360px wide (member/verify) without horizontal scroll
- Valid / NOT VALID distinguishable without colour
- Keyboard navigation and visible focus on every interactive element
- `client-invariants.test.ts` still passes — R14 and the storage rules intact
- Contrast meets WCAG AA throughout

---

# 4. Stage 18 — SMS delivery

Right now `POST /auth/member/request-otp` hashes and stores a code and sends it
nowhere. In development it prints to the terminal (`DEV_OTP_ECHO`). **No member
can sign in without this stage.**

**Provider.** Twilio to start — best documentation, works from anywhere, one
afternoon to integrate. Regional alternatives worth pricing for volume:
Unifonic (GCC-focused), or bulk SMS directly from Ooredoo or Vodafone Qatar.

**Build it behind an interface.** One `SmsSender` type with a `send(phone, body)`
method, one Twilio implementation, one dev implementation that keeps the existing
terminal echo, chosen by env var. Swapping provider later is then one file, which
matters because the provider decision may well be made on price after a month of
real traffic.

**Qatar specifics to sort out early, because they have lead times:**
- Alphanumeric sender ID registration — carriers in the region generally require
  pre-registration of the sender name, and this is not instant
- Confirm delivery to `+974` numbers and to the roaming foreign numbers that
  members of this programme will often carry
- Arabic-script message bodies use UCS-2 encoding, which halves the per-segment
  character budget from 160 to 70

**Do not weaken the OTP handling to debug delivery.** The plaintext code is
never logged, never persisted in the clear and never returned by the API. That
is deliberate. Debug with provider-side delivery logs.

**Acceptance:**
- A real handset receives the code and completes sign-in on a deployed instance
- Provider failure surfaces as a clear user-facing error, not a silent hang, and
  does not reveal whether the phone number is a known member
- The dev terminal echo still works locally and remains impossible to enable in
  production
- Delivery failures are logged without the phone number in plaintext (§9)

---

# 5. Stage 19 — Staff MFA

Closes **Q5**, the most significant deferred item in `SECURITY-REVIEW.md`.
`security-implementation.md` §3: "MFA is mandatory on every dashboard account,
without exception." Today `POST /auth/staff/login` succeeds on a password alone.

`StaffUser.mfaSecret` already exists as the extension point (Stage 1 put it
there). Proposed design — **needs approval per Stage 15, since no reference
document specifies a flow:**

- **TOTP via `otplib`.** No SMS second factor: it depends on Stage 18's provider
  and SMS is the weakest common second factor. Authenticator apps are free,
  offline, and already on every staff phone.
- **Enrollment shows a QR** containing an `otpauth://totp/...` URI — which reuses
  Stage 16's renderer, so **do Stage 16 first.**
- **Encrypt `mfaSecret` at rest** with a key from the secret manager (Stage 20),
  not the database.
- **Single-use recovery codes**, hashed with the same Argon2id parameters as
  passwords. A hotel manager locked out of the dashboard at 2am needs a route in
  that is not "phone the developer."
- **Enrollment is forced on first login**, not optional. "Without exception"
  means the un-enrolled state cannot reach anything.
- **Rate-limit and lock out verification attempts** exactly as the OTP path
  already does — six digits is brute-forceable otherwise.

Applies to `web-admin` and `web-verify` both. Every staff account is a dashboard
account.

**Acceptance:**
- Password alone reaches nothing on either staff surface
- A fresh staff account must enrol before it can act
- A used recovery code cannot be reused
- Brute-forcing the TOTP triggers the lockout
- The stored secret is unreadable from a database dump alone

---

# 6. Stage 20 — Hardening for a public network

Everything built so far assumed `localhost`. These are the five deferred items
from `SECURITY-REVIEW.md`, and each is a launch blocker for a membership list of
this sensitivity.

**Security headers and CORS** — `@fastify/helmet` and `@fastify/cors`. HSTS with
preload, `nosniff`, `frame-ancestors: none`, a real CSP. CORS as an explicit
origin allowlist per client app, never a wildcard, never reflecting `Origin`.

**httpOnly cookies and CSRF** — `@fastify/cookie` plus
`@fastify/csrf-protection`. Move the refresh token into an
`httpOnly; Secure; SameSite=Strict` cookie. §4 requires this and the clients
currently hold tokens in memory instead. Memory was the right call over
`localStorage` — and the invariant test enforces that it stays that way — but
cookies are what the spec asks for, and `SameSite=Strict` plus a CSRF token is
what makes them safe. Note the access token can stay in memory; it is the
long-lived refresh token that matters here.

**Secret management** — the Argon2id pepper, `IDENTITY_CODE_HMAC_SECRET` and the
JWT signing secret move to the platform secret manager. §3 explicitly says the
pepper must not live in the database. Also: give the JWT secret a `kid` now, even
with one key, so rotation later does not need a flag day.

**Edge rate limiting** — `@fastify/rate-limit` in front of the application-level
limits already in `src/security/rate-limit.ts`. The existing ones are per-account;
this one is per-IP, and they defend different things.

**Alerting** — §9 requires alerts on repeated failed member lookups, refresh-token
reuse and authorization denials. The audit log already records all three; nothing
watches it. Minimum viable version: a scheduled query over `AuditLog` that emails
an administrator on threshold breach. Sentry for exceptions.

**Acceptance:** each of the five items in `SECURITY-REVIEW.md` moves from
DEFERRED to confirmed with a file reference, and the document is updated. An
external header scan of the deployed API passes cleanly.

---

# 7. Stage 21 — Deployment

## Where to host

**Host in Qatar.** §9 of the definition is unusually blunt about why: the
membership list is "a record of named, prominent individuals and their
movements," and a leak would be serious independent of any regulatory penalty.
Qatar's data protection law is already cited in the codebase comments around
consent. In-region hosting removes a whole class of cross-border transfer
argument before anyone has it.

Both Microsoft Azure and Google Cloud operate Doha regions (Azure Qatar Central;
Google Cloud `me-central1`). AWS's nearest are the UAE and Bahrain. **Verify
current region availability and which services you need are actually offered
there** — regional service coverage is thinner than in primary regions and
changes over time.

## Recommended shape for the pilot

**One VM, Docker Compose, Caddy in front.** For a programme whose reference card
is number three, orchestration is a liability, not an asset.

```
Internet
   ↓ (443, TLS via Caddy + Let's Encrypt)
Caddy  ──→  my.<domain>       →  web-member static bundle
       ──→  verify.<domain>   →  web-verify static bundle
       ──→  admin.<domain>    →  web-admin static bundle
       ──→  api.<domain>      →  Fastify (reverse proxy)
                                   ↓
                              PostgreSQL (managed, or container + volume)
```

- 2 vCPU / 4 GB is generous for hundreds of members
- Caddy handles TLS renewal with no cron job and no manual steps
- The three clients are static bundles after `vite build` — no Node at runtime
- Roughly $30–60/month all in

Managed containers (Azure Container Apps, Cloud Run) plus managed Postgres is the
alternative. More moving parts, more cost, scales without thought. Not needed
yet, and easy to move to later since everything is already containerised.

## Who can reach what — the network topology

The instinct is "put the backend on an intranet so only the hotel's devices can
see it." That cannot work as stated, and the reason is worth being precise about.

**The API must be on the public internet.** Members open the app from home, from
a plane, from another country. Every screen they touch — benefits, digital card,
history — is an API call. An API reachable only from hotel wifi is an app that
only works while you are standing in the lobby.

What *can* be restricted is not "the backend" but **which routes are reachable
from where**. There are three audiences and they need three different exposures:

| Surface | Who | Reachable from | Why |
|---|---|---|---|
| Member app + its API routes | Members | **Anywhere** | They are not at the hotel |
| Verification page | Outlet staff | **Hotel network only** | Staff are at a counter, by definition |
| Admin dashboard + `/admin/*` | Managers, owner | **Hotel network or VPN** | The membership list |

One API process still serves all three. The separation is done at the reverse
proxy in front of it, by hostname and source address:

```
                        Internet
                           │
                    ┌──────┴───────┐
                    │    Caddy     │
                    └──────┬───────┘
   my.<domain>  ───────────┤  public — the member app (static bundle)
   api.<domain> ───────────┤  public — but /admin/* IP-restricted (see below)
   verify.<domain> ────────┤  hotel network + VPN only
   admin.<domain> ─────────┤  hotel network + VPN only
                           │
                    ┌──────┴───────┐
                    │  Fastify API │ ← one process, three audiences
                    └──────┬───────┘
                    ┌──────┴───────┐
                    │  PostgreSQL  │ ← never exposed; loopback or private net
                    └──────────────┘
```

Restricting a hostname in Caddy is a few lines — `@internal remote_ip` plus a
`respond 403` for everything else. Two rules that matter:

1. **Restrict `/admin/*` on the public API hostname too**, not only the
   `admin.<domain>` frontend. Otherwise the dashboard UI is internal but the
   endpoints it calls are still answering the whole internet, and the restriction
   is decorative.
2. **The database is never published.** Not on a public address, not on a
   restricted one. The API talks to it over loopback or a private network. This
   is the single most common way a system like this leaks.

### The consequence for outlet-staff MFA

Stage 19 exempted `OUTLET_STAFF` from MFA, following §3's "MFA for any staff
account that can reach more than the verification page." **That exemption assumes
the verification page is not on the open internet.**

Password-only authentication, on a public endpoint, reaching member records, is a
materially worse position than the one that decision was made in. So:

- If `verify.<domain>` is restricted to the hotel network — the exemption stands,
  and §3's named-accounts-plus-shift-expiry treatment is proportionate.
- If it ends up public for any reason — **extend MFA to `OUTLET_STAFF`.** It is a
  one-line change (`MFA_REQUIRED_ROLES` in `src/security/mfa.ts`), and the
  reasoning that justified the exemption no longer holds.

Decide this deliberately at deploy time rather than discovering later which of
the two you ended up in.

## The deployment gotcha that will silently break R7

**The `pgp_app` least-privileged role must exist in production, and the API must
connect as it.**

`UPDATE` and `DELETE` on `Redemption` are revoked *at the database level* for
that role. That REVOKE is what makes redemption immutability real rather than a
convention. `docker/postgres/init/01-app-role.sh` creates the role — but that
script only runs on first initialisation of an empty Docker volume. **Provision
a managed Postgres, connect as the owner because it is what the connection string
came with, and R7 disappears silently.** No test fails. No error appears. The
guarantee is just gone.

Run the role creation as an explicit, verified step of provisioning, and add a
production smoke check that a raw `UPDATE` against `Redemption` is rejected.

## The rest of the deployment checklist

- **Write a Dockerfile for the API — there isn't one.** Multi-stage on
  `node:20-alpine`, `prisma generate` at build time. The API currently runs
  through `tsx` even in `start`; compile with `tsc` for production instead, so a
  syntax error fails the build rather than the boot.
- **Docker is not installed on the dev machine** (`PROGRESS.md`). The compose
  file has never actually run. Expect to debug it the first time — do that
  locally, not against the server.
- **`prisma migrate deploy` as an explicit release step**, never automatically on
  container boot. Two containers starting together both running migrations is a
  bad afternoon.
- **PostgreSQL version:** compose pins 15-alpine, the dev machine used 18.
  Pick one and use it in both places.
- **Backups: nightly `pg_dump`, encrypted, off the box.** Then **restore one into
  a scratch database and confirm it works.** An untested backup is not a backup,
  and this database is the programme's only record.
- Uptime monitoring on `/health` (liveness) and `/health/ready` (database) —
  they were deliberately built to distinguish a dead process from a dead
  database, so alert on them separately.
- Log aggregation with the §9 redaction layer verified *in production output*,
  not just in tests.
- **CI — still deferred per `SECURITY-REVIEW.md`.** GitHub Actions running
  typecheck plus the full suite against a Postgres service container, required
  before merge. Cheap, and it is what stops stage 0–14's guarantees eroding.
- Staging environment that mirrors production. Do not test on the instance
  holding real member data.

**Acceptance:**
- All four surfaces reachable over HTTPS on real hostnames
- A raw `UPDATE` against `Redemption` in production is rejected by the database
- A backup has been restored successfully into a scratch database
- `/health/ready` alerts fire when the database is stopped
- The full acceptance journey from `build_plan.md` Stage 13 passes against the
  deployed instance, not just locally

---

# 8. Stage 22 — Arabic and RTL

§11.9 assumes both languages. **This is larger than it looks, because benefit
content lives in the database.**

**The UI layer is the easy half.** `i18next` + `react-i18next`, a `dir` attribute
on `<html>`, and — if Stage 17 used logical properties throughout — the layout
mirrors itself for free.

**The content layer needs a schema change.** `Benefit.title` and `Benefit.terms`
are single-language columns today. Every benefit title, terms text and secondary
label needs an Arabic counterpart. Two options:

- Add `titleAr`, `termsAr`, `secondaryLabelAr` columns — simpler, but bakes "two
  languages, forever" into the schema
- Add a `BenefitTranslation` table keyed by benefit and locale — **recommended**;
  a third language is then a row, not a migration

Either way the admin benefit editor needs both language fields, and R14 still
applies: an administrator changing Arabic terms must not need a deployment. The
existing `version` and `updatedByUserId` audit trail should cover translations
too.

Also decide: Arabic-Indic vs Western numerals for percentages and membership
numbers; Gregorian vs Hijri dates in member-facing history; and which language
the SMS templates use — probably per member, driven by a preference on the
profile.

**Acceptance:**
- Every screen readable and correctly mirrored in Arabic
- No hardcoded English string in any client
- An administrator can edit Arabic benefit content without a deployment
- Language preference persists across sessions
- Arabic SMS bodies deliver correctly (the UCS-2 segment limit from Stage 18)

---

# 9. Stage 23 — App stores, install, push and wallet

## Getting into the two stores — they are not the same problem

**Google Play: cheap.** A Trusted Web Activity wraps the existing PWA and Play
accepts it. The app is genuinely the site, verified by a digital asset link, with
no browser chrome. Days of work, not weeks.

**Apple App Store: not cheap, and a wrapper alone is a rejection risk.** Apple
does not accept PWAs at all, and guideline 4.2 ("Minimum Functionality") rejects
apps that are a repackaged website. An app needs to do something a browser
cannot.

Two realistic routes, and the first is much cheaper than it looks:

1. **Capacitor** — wraps the *existing* React app in a native shell and adds real
   native capabilities to it: push notifications, Face ID / biometric unlock on
   the digital card, Wallet pass, native camera. That is no longer a thin wrapper,
   which is both what makes it pass review and what makes it worth shipping.
   **One codebase.** The member app you already have keeps working as a website
   at the same time.
2. **React Native** — a genuine rebuild of the member client. Better if the app
   grows well beyond the current eight screens. Months, and a second codebase to
   keep in step with the API.

**Recommendation: Capacitor.** The eight member screens are not doing anything
that needs a native rendering layer, and the native features that would justify
App Store presence (push, biometrics, wallet) are exactly what Capacitor exposes.
Reach for React Native only if Q4's in-app reservations and event RSVPs turn the
member app into something much larger.

Either route needs, before submission: an Apple Developer account (annual fee), a
Google Play developer account (one-off), a privacy policy at a public URL, App
Privacy / Data Safety declarations describing what is collected, screenshots at
several device sizes, and review turnaround measured in days. **These are calendar
time, not engineering time** — start the accounts early, because certificate and
enrolment delays are what actually holds a launch.

## Install without a store

Already built. `vite-plugin-pwa` in `apps/web-member`: manifest, icons, service
worker. A member adds it to their home screen and it launches as an app.

**Do not cache the identity payload.** It rotates every 60 seconds and the server
checks freshness, so a cached credential fails at a spa reception with no useful
error. It is `NetworkOnly` explicitly, with four assertions in
`client-invariants.test.ts` guarding that, because the service worker is disabled
in development and none of these failures are visible there.

Benefit content and the member's own profile are `NetworkFirst`, so an offline
member can still read their terms while R14 still holds — an administrator's
change is never overridden by a stale cache.

## Push and wallet

**Push notifications** for benefit changes and event invitations (§10 Phase 2).
Web Push covers Android and desktop; iOS requires a home-screen-installed PWA and
is limited. If push matters commercially, that is the argument for Capacitor.

**Wallet pass — genuinely Phase 2, and do not underestimate it.** §3 lists it as
"proposed, pending approval". The catch: this card's QR **rotates**, so the pass
must be updated remotely via APNs, which needs a pass type certificate and a web
service implementing Apple's update protocol. Issuing a pass with a longer-lived
credential is the alternative and weakens exactly the property §5 says matters
most. Decide deliberately; do not drift into it.

# 9b. Stage 23 (original notes)

Shape depends entirely on Q11 from Stage 15. Assuming PWA:

- `vite-plugin-pwa` for the member app: manifest, icons, service worker
- **Do not cache the identity payload in the service worker.** It rotates every
  60 seconds and a stale cached credential fails validation — a confusing bug to
  diagnose. Explicitly exclude that endpoint from any caching strategy.
- Cache benefit content for offline reading. A member in a restaurant basement
  with no signal should still see their terms.
- **Push notifications** for benefit changes and event invitations (§10 Phase 2).
  Web Push works on Android and desktop; iOS requires the PWA to be
  home-screen-installed and is more limited. If push matters commercially, that
  is the argument for going native — and it belongs in the Q11 discussion.

**Wallet pass — genuinely Phase 2, and don't underestimate it.** §3 lists it as
"proposed, pending approval." `passkit-generator` handles Apple; Google Wallet
has its own API. The catch: this card's QR **rotates**, so the pass must be
updated remotely via APNs push, which needs an Apple Developer account, a pass
type certificate, and a web service endpoint implementing Apple's update
protocol. Alternatively issue the pass with a longer-lived credential — but that
weakens exactly the property §5 says matters most. Decide deliberately; do not
drift into it.

---

# 10. Stage 24 — Pre-launch, non-engineering

These do not require code and are frequently discovered too late.

- **DPIA.** `SECURITY-REVIEW.md` flags it as required before launch and
  explicitly not an engineering task. §10 of the security spec mandates it.
  Given §9's confidentiality analysis, this one is real, not a formality.
- **Privacy policy and terms content.** The profile screen links to both. The
  content does not exist. Needs someone who can speak to Qatari data protection
  law.
- **Consent wording version.** `ConsentRecord.wordingVersion` exists so the exact
  text a member agreed to is reconstructable. Whatever text ships at launch needs
  recording as version 1.
- **Staff training on the verify page**, especially: a NOT VALID membership means
  do not apply the discount, and party size is not optional.
- **Data retention policy.** Redemptions are immutable and audit logs are
  append-only, so "how long do we keep this" has no answer in code yet.
- **Restore drill**, with someone other than the author following the runbook.
- **Pilot narrow: one outlet, ten members, four weeks.** Not five outlets on day
  one. §11.4 asks how many members exist today — if the reference card is number
  three, the whole programme is small enough that a careful pilot costs nothing
  and catches everything.

---

# 11. Suggested sequencing

Dependencies, not a schedule — I have deliberately not put week numbers on this,
because Stage 17's size depends on how much design direction exists and Stage 15
depends on client availability.

```
Stage 15  Decisions ──────────────┬──────────────────────────┐
                                  │                          │
Stage 16  QR + scanning ──────────┤                          │
                    │             │                          │
Stage 17  Design system ──────────┤                          │
                                  │                          │
Stage 18  SMS ────────────────────┤                          │
                                  │                          │
Stage 19  Staff MFA ──────────────┤  (needs 16 for enrol QR) │
                                  │                          │
Stage 20  Hardening ──────────────┤                          │
                                  ↓                          │
Stage 21  Deployment ─────────────┬── unblocks camera testing┘
                                  │      (HTTPS requirement)
Stage 22  Arabic + RTL ───────────┤   (much cheaper if 17 used
                                  │    logical properties)
Stage 23  Install / push ─────────┤
                                  ↓
Stage 24  Pre-launch ────────→  Pilot  ────→  Full launch
```

**Three ordering constraints worth respecting:**

1. **Stage 15 before Stage 16.** If Q1 is answered the other way, the
   verification page's whole purpose changes and the scanner work is wasted.
2. **Stage 16 before Stage 19.** MFA enrollment needs the QR renderer.
3. **Stage 21 partly before finishing Stage 16.** Camera access needs a secure
   context, so the scanner cannot be tested on a real counter device until there
   is TLS on a real hostname. Deploy early and unfinished rather than late and
   complete.

**Do Stage 17 in parallel with 18–20 if there is more than one person.** It
touches only the clients; SMS, MFA and hardening touch only the API. That is the
one genuinely parallelisable split in this plan.

---

# 12. If you only do one thing next

**Stage 16's QR rendering.** It is small, it depends on nothing, the credential
mechanism underneath it is already finished and tested, and it converts "paste
this string into that box" into something you can demonstrate with a phone in
your hand. That demo is what makes Stage 15's conversation with the client
productive — and Stage 15 is what unblocks everything else.
