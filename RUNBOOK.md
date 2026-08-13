# Runbook

How to run this, how to verify it works, and what every failure I have actually
hit means. Written for whoever picks this up next — including me, later.

---

## 1. Run the whole thing

Two commands, from the repository root:

```
npm run db start
npm run dev
```

That starts four processes — one backend, three frontends, sharing one database:

| | URL | Who it is for |
|---|---|---|
| Backend API | http://localhost:3000 | Where everything is recorded |
| Member app | http://localhost:5173 | Guests |
| Admin dashboard | http://localhost:5175 | The hotel |
| Outlet screen | http://localhost:5176 | The counter |

Give it about 20 seconds. The API and the Vite servers start together and compete
for CPU on first boot; an earlier check at 15 s reported the API down when it was
simply still starting. Ctrl-C stops all four together.

Seeded logins:

| Who | Where | Sign in with |
|---|---|---|
| Owner | :5175 | `admin@pgp.test` / `privilege-guest-dev-only` — plus a six-digit code, unless `STAFF_MFA_REQUIRED=false` (see below) |
| Member | :5173 | phone `+97455550001` or `+97455550003`, then the code |
| Outlet | :5176 | A device token issued under Admin → Outlets |

**Default local sign-in: exercise the real device-token path.**

1. Sign in to the admin dashboard and open **Outlets**.
2. Under an outlet's **Device sign-in**, label the physical station — for example,
   *Spa reception test browser* — and press **Issue device token**.
3. Copy the token from the one-time panel and paste it into :5176. It is not
   retrievable later because only its digest is stored.

This is the production mechanism and therefore the preferred local test. Reload
the outlet page: its httpOnly refresh cookie resumes the session without asking
for the standing token again. On localhost, cookie scope does not include the
port, so use a separate/private browser profile for the outlet screen and for each
additional outlet; otherwise the admin and outlet sessions can replace each
other's local development cookie. Production hostnames keep them separate.

There is no development session bundle or second sign-in box. Local testing uses
the same Admin-issued `pgo_…` credential and `/outlet/auth/token` exchange as
production. To have two outlets open at once — which is how you check that one
cannot see the other's work — issue a device for each outlet and use two browser
profiles, or one normal window and one private window. There is one app on one
URL; *which* outlet you are is decided by the authenticated device, not by the
address.

There is no manager or support login. `OUTLET_STAFF` is a live role again as of
2026-08-12 — it is what the outlet screen signs in as — but each principal is a
labelled physical device, not a named person, and it holds no administrator
permission whatsoever. A legacy MANAGER or SUPPORT row may remain only when an
old redemption points to it; migrations suspend it, revoke its sessions and the
application hides it.

**Administrator accounts are managed from the panel** — the **Administrators**
tab creates them, suspends them, resets a lost second factor and sets a password.
Outlet devices live under **Outlets** instead, and have no password or email login
to set.

Rotating or revoking a device takes effect immediately: it bumps `tokenVersion`
and revokes the refresh tokens, so a session already open dies rather than
lasting out its access token. You cannot suspend yourself, suspend the last
administrator, or reset your own second factor.

**Sessions now survive a reload.** The refresh token is an httpOnly cookie, so
closing a tab no longer means signing in again — a member sees a passcode about
once a month rather than every visit, and a counter does not need its standing
device token again during the same refresh window.

## Walking the request flow end to end

**Nobody approves anything.** A guest is entitled to every published benefit the
moment they join, so a request is a *notice*: it tells one outlet to expect them.
That outlet then confirms the visit or records that it never happened. All three
apps run at once on this machine, so the whole loop takes about a minute.

1. **Member app on :5173** — sign in with `+97455550003`, take the passcode from
   the email it sends. Open any benefit, add a note if you like, and press **Let
   the outlet know**. If more than one outlet honours that benefit it asks which
   one first. It then reads *The Spa knows you are coming*, with nothing to wait
   for.
2. **Outlet screen on :5176** — the notice is at the top of **Coming up**, oldest
   first, with the membership number and the note. It carries a gold edge because
   it arrived since the screen was last looked at.
3. **Press *Discount given*.** Fill in the guests if the benefit caps them. The
   redemption appears in the admin Redemptions log carrying the rate that was
   actually applied, and in the member's own *Recently used*.
4. **Or press *Did not come*.** Nothing is recorded, the guest is told it was not
   a refusal, and their benefit is still available.

Three things worth trying, because they are the rules that matter:

- **Announce twice in a minute.** The second is refused with a 429. Then restart
  the API and try again — still refused, because the throttle counts rows rather
  than living in memory.
- **Try to confirm the same notice twice.** The second attempt is refused —
  `already_closed`. One notice, one discount.
- **Open the outlet screen for a different outlet** (issue a second device token,
  or use a separate development session) and look for the same notice. It is not
  there, and confirming it by id returns 404 rather than 403 — the row's existence
  is not that outlet's business.

## Walking the card scan end to end

For a guest who never opens the app — which is the whole point of the card back.

1. **Member app on :5173** — open **Profile → membership card**. The code is
   below the card, with the payload printed underneath as selectable text.
2. **Outlet screen on :5176** — **Look up a card**, then either press **Scan a
   card** and point the camera at the phone, or paste that payload, or type
   `PG-0003`.
3. **The guest's entitlements appear**, filtered to what this outlet can honour —
   the spa screen does not offer the restaurant's discount. Press **Discount
   given** on one.
4. **Check the member app.** It is in *Recently used*, from the same table as
   every other visit.

**The camera needs a secure context.** `localhost` counts; a LAN address does not.
Testing a real scan on a counter tablet therefore needs TLS. The scanner says
which case it is in rather than showing a dead black rectangle, and typing the
membership number always works.

Worth trying: **scan, then wait ten minutes and record.** Refused — the
verification session binding the scan to the recording has expired, and staff are
told to scan again. And **scan on one outlet screen, then try to record from
another** — also refused, because the session is bound to the account that made it.

## Managing outlet devices

Admin dashboard → **Outlets** is the normal provisioning and offboarding path.
For each outlet:

- **Email notices to** is optional. Empty means nobody is emailed and the outlet
  works from its own screen. The address is only a notification destination: it
  cannot sign in, is not copied onto a device principal and is not a recovery
  channel. Outlet authentication is device-token-only.
- Under **Device sign-in**, enter a physical label such as *Steakhouse counter
  tablet* and press **Issue device token**. Use one row per physical device, not
  one shared token per outlet.
- Copy the plaintext from the one-time panel immediately. The API stores only a
  SHA-256 digest and cannot display it again. The UI keeps it only in component
  memory long enough to copy; it does not put it in web storage or a URL.
- **Rotate** replaces a possibly exposed token, increments the account's token
  version and revokes its refresh family. Copy the replacement from the new
  one-time panel. The old token and existing sessions stop working.
- **Revoke** is for a lost, retired or reassigned device. It destroys the standing
  credential and revokes every derived session. It is deliberately not
  reversible; issue a fresh device row if the hardware returns.

The table shows when each token was issued and last used. A blank **Last used**
means provisioned but never signed in. Device labels are retained as the actor on
immutable redemption history, so name the station rather than the person on shift.

The network is an additional boundary in production: `INTERNAL_CIDR` must name
the staff/back-of-house VLAN and VPN. Guest Wi-Fi is not a staff network, even
inside the hotel, and must not be included. A tablet on cellular is refused by
design; reconnect it to the staff VLAN or VPN instead of widening the range.

**Signing in to the dashboard (Stage 19).** The password is step one of two.
Every administrator account requires a second factor, so the password alone
returns a challenge, not tokens.

First time: the dashboard shows a QR. **This is the one QR left in the product** —
it carries an `otpauth://` URI for an authenticator app, and has nothing to do
with members. Scan it with any authenticator (Google Authenticator, 1Password,
Aegis), enter the six-digit code, and **save the ten recovery codes it then
shows** — only their hashes are stored, so that screen is the only time they
exist. After that, sign-in asks for a code each time.

A code works once. Presenting the same one twice inside its 30-second window is
refused, so if you fat-finger a login, wait for the next code rather than
retrying the same one.

**No authenticator app, developing locally? Turn the code off.** In
`apps/api/.env`:

```
STAFF_MFA_REQUIRED=false
```

Sign in with email and password only. Nothing is deleted — enrollment,
verification, recovery codes and the replay check all still work — so setting it
back to `true` needs no re-enrollment.

**The API refuses to start with this false while `NODE_ENV=production`.** §3
requires a second factor on every dashboard account without exception, and this
switch exists to spare a developer a second terminal window, not to make that
requirement optional. A password-only sign-in is audited as `auth.mfa.skipped`
rather than `auth.login.success`, so those rows are findable if the switch ever
ends up somewhere it should not be.

**Keeping the code but still no app? Print it instead.** In a second terminal:

```
npm run mfa:code                     # admin@pgp.test
```

It reads the account's stored secret, decrypts it and prints a fresh code every
30 seconds until you stop it — the same thing an authenticator app does, in a
terminal. Leave it running while you sign in and use the newest code shown. The
code changes on that cadence because that is what a TOTP code is; it is not
renewing your session, and has nothing to do with staying signed in.

If it says **NO SECRET STORED YET**, enrollment has not started: sign in with the
password first, and the screen that shows the QR is what stores the secret. Codes
start printing within a second of that happening, so the order you do these in
does not matter.

Two things it is deliberately not. It is **not** an echo inside the staff
sign-in path — nothing was added there, because a TOTP code is a function of the
clock rather than something a request issues, so a code printed at sign-in would
expire while you read it, and the replay check would then refuse it on the retry.
And it is **not** available outside development: the script exits unless
`NODE_ENV=development`, and being a script nobody invokes, it cannot be left
switched on by accident the way a flag can.

Every administrator account needs a second factor. No other staff role can sign
in or receive a session.

If you get locked out in development, clear the enrollment and start over:

```
psql "$DATABASE_MIGRATION_URL" -c   'UPDATE "StaffUser" SET "mfaSecret"=NULL, "mfaEnrolledAt"=NULL, "mfaLastUsedEpoch"=NULL;'
```

There is deliberately no such path in the product — see SECURITY-REVIEW.md.

**Signing in as a member.** With `OTP_DELIVERY_CHANNEL=smtp` and the `SMTP_*`
values set, the one-time passcode is emailed to the address on the member's
record — Stage 18; see DECISIONS.md for why email and not SMS. The default,
`none`, generates a code and delivers it nowhere, so nobody can sign in.

There is no terminal fallback. A member with no email address on record cannot
receive a code at all — add one from the admin dashboard first. When a code does
not arrive, the API logs the delivery outcome (`member message delivery failed`,
with a reason); the HTTP response is deliberately identical either way, because
confirming that a number belongs to a member is itself a disclosure (§3).

**First run only**, if there is no database yet:

```
npm run db setup
cd apps\api && npm run migrate && npm run seed
```

`npm run db` also takes `status`, `stop` and `reset`.

### If a window shows `EADDRINUSE` and then goes quiet

Only one process can hold a port. A dev server left running -- from a closed
terminal, a crash, or a stray background process -- makes the next one exit
immediately. Its window then sits there showing nothing, which looks exactly
like the application being broken.

```
npm run stop
```

Frees ports 3000, 5173 and 5175, then start again. It targets the process
actually holding each port rather than killing every node.exe on the machine.

## 1b. Verify it

```
npm test
```

**Everything green = the build is sound.** That is the real verification; the
manual checks below exist to catch what tests cannot see.

---

## 1c. Google Sheets mirror (optional)

PostgreSQL is the authoritative record. The workbook is a read-only convenience
for hotel administrators and is rebuilt in full; edits to its five managed tabs
are overwritten. Normal API writes never wait for Google.

The integration is off by default. Before enabling it:

1. Confirm the hotel approves Google Workspace for member-number and movement
   data, including the applicable data-residency arrangement.
2. Create a dedicated workbook with link sharing off. Share it directly with
   named administrators as **Viewer**, and with the dedicated service account as
   **Editor**. Do not use "anyone with the link".
3. Enable the Google Sheets API for that service account's Cloud project.
4. Put the workbook ID, service-account email and base64 private key in
   `apps/api/.env`. Never commit the JSON key or paste it into a log or ticket.

PowerShell can extract the two values from Google's downloaded JSON key without
trying to preserve a multiline PEM value in `.env`:

```powershell
$account = Get-Content -Raw C:\secure\pgp-sheets-service-account.json | ConvertFrom-Json
$account.client_email
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($account.private_key))
```

Set the three `GOOGLE_SHEETS_*` credential values, then test one reconciliation
from the repository root:

```text
npm run sheets:sync
```

It should report counts for `_Sync`, `Members`, `Benefits`, `Outlets` and
`Redemptions`. Check `_Sync` has a current UTC time, then set
`GOOGLE_SHEETS_SYNC_ENABLED=true` to run immediately at API readiness and every
five minutes thereafter. A second identical run replaces the same managed
ranges; it never appends duplicates or changes unrelated worksheets.

The mirror intentionally excludes member names, phones, emails, request notes,
consents, audit/IP data, claim codes, OTPs, password hashes, MFA data and tokens.
Use the authenticated admin dashboard to view personal details or make changes.

Common failures:

- `permission` / HTTP 403: share the workbook with the exact service-account
  email as Editor.
- `spreadsheet_not_found` / HTTP 404: copy only the ID between `/d/` and `/edit`.
- `quota` / HTTP 429: leave the existing workbook alone and retry later.
- Invalid base64/PEM: encode the JSON document's `private_key` value, not the
  whole JSON file.

A sync failure makes the workbook stale and logs a category only; PostgreSQL and
the application remain available. Re-run `npm run sheets:sync` after correcting
the cause. With more than one API replica, disable the in-process schedule and
run this command from one external scheduler to prevent competing publishers.

---

## 2. Layers, and what each one proves

Verify in this order. A failure at layer *n* makes layers above it meaningless,
so stop and fix rather than continuing.

| # | Check | Command | Proves |
|---|---|---|---|
| 1 | Database reachable | `scripts\dev-db.ps1 status` | Cluster up on 5434 |
| 2 | Schema current | `cd apps\api && npm run migrate` | Migrations apply |
| 3 | Types sound | `npm run typecheck` | No type errors under strict mode |
| 4 | Units + integration | `npm test` | All rules hold |
| 5 | Server boots | `cd apps\api && npm run dev` | Wiring, env, plugin order |
| 6 | End to end | `scripts\smoke.ps1` | The real journey over HTTP |

Layer 5 matters on its own: **the test suite builds the app in-process, so it
can pass while `npm run dev` fails.** Startup-only faults — a missing env var,
plugin ordering, the R17 boot check — surface only at layer 5.

---

## 3. Known failure modes

Every one of these has actually happened here.

### `npm : File ... npm.ps1 cannot be loaded because running scripts is disabled`
PowerShell execution policy. Use Command Prompt, or call `npm.cmd` instead of
`npm`. Scripts in `scripts/` need `powershell -ExecutionPolicy Bypass -File`.

### `Invalid environment configuration: DATABASE_URL: expected string, received undefined`
The process is not loading `apps/api/.env`. Run from `apps/api`, not the repo
root — `dev`, `start` and `seed` all pass `--env-file=.env`, which resolves
relative to the working directory. Tests load it via `test/setup.ts` instead.

### A `--flag` passed to an npm script never arrives

`npm run <script> -- --flag` from the repository root goes through a second
`npm run … --workspace`, and npm parses the leading `--` as **its own** config —
so the flag is consumed and `process.argv` never sees it. You get
`npm warn Unknown cli config "--flag"` and a script that behaves as though you
passed nothing. A bare word survives, which is why `mfa:code <email>` always
worked and hid this.

Every wrapper in the root `package.json` that takes arguments now ends in `--`,
which fixes it. If you add another, end it the same way.

### `EPERM: operation not permitted, rename ... query_engine-windows.dll.node`

`npm run stop` first — a running API holds the Prisma engine DLL, and `prisma
generate` cannot replace a file Windows has open. The stop script targets only the
project's own four ports and leaves unrelated node processes alone.
A running Node process holds the Prisma client open, so `prisma generate`
cannot replace it. Stop the dev server first. If it persists:
`Get-Process node | Stop-Process -Force`.

### `ERROR: syntax error at or near "<U+FEFF>"` when a migration applies
A UTF-8 BOM at the start of `migration.sql`, from PowerShell's
`Out-File -Encoding utf8`. Strip it: `sed -i '1s/^\xEF\xBB\xBF//' migration.sql`.
Write migration SQL with the Write tool or `bash`, never `Out-File`.

### A `.ps1` script dies with `The string is missing the terminator`
Non-ASCII characters (em dashes, curly quotes) in a script Windows PowerShell
5.1 reads as ANSI. Keep `scripts/*.ps1` pure ASCII, or save with a BOM.

### `relation "member" does not exist` from psql, but the app works
PowerShell mangled the quoting. Prisma's tables are `"Member"`, case-sensitive.
Put the SQL in a file and use `psql -f`, rather than `-c` with nested quotes.

### The login-timing test fails
Two different causes, and they need opposite fixes:
- **`Test timed out in 5000ms`** — not an assertion failure. The test performs
  16 Argon2id hashes at ~250ms each. Its timeout is already raised to 60s;
  if this returns, the machine is heavily loaded.
- **`ratio=... expected < 3`** — a real signal. The dummy-hash branch in
  `verifyAgainstDummy` has probably stopped running, which would make a
  nonexistent account resolve an order of magnitude faster than a real one and
  reintroduce the account-enumeration oracle §3 forbids.

### A test fails only when the whole suite runs, but passes alone
Shared state. Three known sources:
- **Rate limiting** is in-memory and per process. Call `resetRateLimits()` in
  `afterEach`.
- **The seeded fixtures** are shared. Tests that mutate `PG-0001..0003` or the
  five benefits must restore them; prefer creating your own row.
- **The TOTP replay guard**, which is the one that looks like a real bug. See
  below.

### `acceptance-journey.test.ts` fails with `expected 401 to be 200`, then passes on its own
The second factor, doing exactly its job.

`StaffUser.mfaLastUsedEpoch` records the period of the last code the account used,
and a code at or before it is refused **even when cryptographically valid** — that
is what stops one observed over a shoulder being replayed inside its window. The
refusal is a 401 from `/auth/staff/mfa/verify`, which surfaces as
`signInStaff`'s `expect(...).toBe(200)` failing at step 1, and every later step
then fails for lack of a token.

This is not flakiness in the usual sense. It happens when the seeded administrator
signs in **twice inside the same 30-second window** — most often because you ran
the full suite and then immediately re-ran one file, which is precisely what you do
when investigating a failure.

**Wait half a minute and run it again.** If it passes, that was this. Nothing to
fix — and specifically, do not "fix" it by weakening the replay check.

### `Unscoped read of a scoped model in a route handler`
`fetch-then-check.test.ts` found a Prisma read of a member, redemption, consent
or claim-code row without a scope fragment. **Do not exempt it to make the test
pass.** Either put the scope in the `WHERE` clause:

```ts
where: scopedWhere({ id: req.params.id }, scopeForMember(principal))
```

or, if it is genuinely unscopeable (pre-authentication, where establishing who
the caller is *is* the point), add it to `EXEMPT` with a written reason.

### `Route GET /... does not declare a permission`
Working as designed (R17). Every route needs `config: { permission: ... }`, or
an explicit `'public'`. This is a startup failure on purpose — a route with no
declaration is a hole, and it should stop the server rather than serve traffic.

---

## 4. Traps that do not announce themselves

The dangerous class: things that pass every test while being wrong.

### Spreading a scope fragment
`security-implementation.md` §5 illustrates
`where: { id: params.id, ...scopeFor(principal) }`. **This is unsafe** and was a
real bug here. A member's scope is `{ id: <their own id> }`, so the spread
collides on `id` and the later value wins — every lookup returns the caller's
own record instead of 404. Always compose with `scopedWhere`, which uses `AND`.

### Money through a float
`billAmountMinor` is an integer in minor units. A single `parseFloat` anywhere
in a total silently reintroduces rounding error. Percentages travel as strings
end to end for the same reason.

### A benefit value creeping into code
R14 is the acceptance test for the whole project. `benefits.test.ts` scans
`src/` for the reservation numbers, titles and labels, plus a benefit key next
to a percentage. If that test fails, a value has been hardcoded — fix the code,
never the test.

### 403 where 404 is required
An out-of-scope *record* must be indistinguishable from one that does not
exist (R18) — a 403 confirms it exists. A *route* the caller's role cannot use
is a 403, which leaks nothing. The distinction is deliberate.

---

## 5. What is not covered by tests

Stated so nobody mistakes a green suite for completeness.

- **No MFA on staff login.** §3 requires it; the endpoint list has nowhere to
  put it. PROGRESS.md Q5.
- **No SMS or email delivery.** OTPs are generated and hashed; nothing sends
  them. PROGRESS.md Q6.
- **Secrets are environment variables, not a KMS.** §3 and §7 both call for a
  key management service.
- **Rate limiting is in-memory**, so it resets on restart and is not shared
  across processes. Fine for one instance; needs a shared store beyond that.
- **Docker is unverified.** `docker-compose.yml` is written and is the intended
  path, but Docker is not installed here — the local cluster stands in for it.
