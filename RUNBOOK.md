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

That starts three processes — one backend, two frontends, sharing one database:

| | URL | Who it is for |
|---|---|---|
| Backend API | http://localhost:3000 | Where everything is recorded |
| Member app | http://localhost:5173 | Guests |
| Admin dashboard | http://localhost:5175 | The hotel |

Give it about 20 seconds. The API and both Vite servers start together and
compete for CPU on first boot; an earlier check at 15 s reported the API down
when it was simply still starting. Ctrl-C stops all three together.

Seeded logins:

| Who | Where | Sign in with |
|---|---|---|
| Owner | :5175 | `admin@pgp.test` / `privilege-guest-dev-only`, then an authenticator code (no app? `npm run mfa:code`) |
| Member | :5173 | phone `+97455550001` or `+97455550003`, then the code |

There is no counter application and no manager, support or outlet-staff login.
Every redemption is recorded by an administrator from the panel. A legacy
non-administrator database row may remain only when an old redemption points to
it; migrations suspend it, revoke its sessions and the application hides it.

**Administrator accounts are managed from the panel** — the **Administrators**
tab creates them, suspends them, resets a lost second factor and sets a
password. Suspending takes effect immediately: it bumps `tokenVersion` and
revokes the refresh tokens, so a session already open dies rather than lasting
out its access token. You cannot suspend yourself, suspend the last
administrator, or reset your own second factor.

**Sessions now survive a reload.** The refresh token is an httpOnly cookie, so
closing a tab no longer means signing in again — a member sees a passcode about
once a month rather than every visit.

## Walking the request flow end to end

There is no QR and no camera. A member asks for a benefit in the app, an
administrator approves it, and the outlet applies the discount when the guest
arrives. Both user-facing apps are open at once on this machine, so the whole loop
takes about a minute.

1. **Member app on :5173** — sign in with `+97455550003`, take the passcode from
   the `npm run otp:code` window. Open any benefit, add a note if you like, and
   press **Ask to use this benefit**. It changes to *Waiting for approval*.
2. **Admin dashboard on :5175** — sign in, open **Requests**. The ask is at the
   top of the queue, oldest first, with the member's number and note. Press
   **Approve**.
3. **Still on :5175** — switch the queue to **Approved, not yet used**. When the
   guest turns up, press **Mark as used**, choose the outlet, and fill in the
   guests and the bill total.
4. **Record it.** The request moves to *Used* and the redemption appears in the
   Redemptions log carrying the rate that was actually applied.

Two things worth trying because they are the rules that matter:

- **Approve, then try to record the same approval twice.** The second attempt is
  refused — `approval_not_valid`. One approval, one discount.
- **Fill in the bill total.** Optional to the API, load-bearing for everything
  downstream: without it, finance has nothing to match the row against in their
  own system.

A member who never asked is still served — record a redemption with no
`requestId` and it stands on its own.

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

**No authenticator app? Print the codes instead.** In a second terminal:

```
npm run mfa:code                     # admin@pgp.test
```

It reads the account's stored secret, decrypts it and prints a fresh code every
30 seconds until you stop it — the same thing an authenticator app does, in a
terminal. Leave it running while you sign in and use the newest code shown.

If it says **NO SECRET STORED YET**, enrollment has not started: sign in with the
password first, and the screen that shows the QR is what stores the secret. Codes
start printing within a second of that happening, so the order you do these in
does not matter.

Two things it is deliberately not. It is **not** a `DEV_OTP_ECHO` for staff —
nothing was added to the sign-in path, because a TOTP code is a function of the
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

**Signing in as a member.** The default `OTP_DELIVERY_CHANNEL=none`
means nothing is mailed, so the one-time passcode is printed to the terminal
running `npm run dev`. (Set it to `smtp` with the `SMTP_*` values to deliver by
email instead — Stage 18; see DECISIONS.md for why email and not SMS.)

It appears between the JSON log lines, as real text:

```
  ══════════════════════════════════════════
   VERIFICATION CODE  (development only)

   phone ending  ••••••0001
   CODE          920515

  ══════════════════════════════════════════
```

Written straight to stdout, not through pino — a logger serialises to one JSON
line, so a multi-line block would arrive as literal `
` escapes: present,
unreadable, useless. The phone shows its last four digits only, because §9
forbids phone numbers in logs and this is still a log.

Type that into the app. It only prints when `DEV_OTP_ECHO=true` **and**
`NODE_ENV=development`; both gates must pass, and only the exact string `true`
counts. `dev-otp.test.ts` fixes that behaviour.

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

### `EPERM: operation not permitted, rename ... query_engine-windows.dll.node`
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
Shared state. Two known sources:
- **Rate limiting** is in-memory and per process. Call `resetRateLimits()` in
  `afterEach`.
- **The seeded fixtures** are shared. Tests that mutate `PG-0001..0003` or the
  five benefits must restore them; prefer creating your own row.

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
