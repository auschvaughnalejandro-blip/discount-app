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

That starts four processes — one backend, three frontends, all sharing one
database:

| | URL | Who it is for |
|---|---|---|
| Backend API | http://localhost:3000 | Where everything is recorded |
| Member app | http://localhost:5173 | Customers |
| Verification page | http://localhost:5174 | Staff at the counter |
| Admin dashboard | http://localhost:5175 | The business owner |

Give it about 20 seconds. The API and three Vite servers start together and
compete for CPU on first boot; an earlier check at 15 s reported the API down
when it was simply still starting. Ctrl-C stops all four together.

Seeded logins:

| Who | Where | Sign in with |
|---|---|---|
| Owner | :5175 | `admin@pgp.test` / `privilege-guest-dev-only`, then an authenticator code (no app? `npm run mfa:code`) |
| Outlet staff | :5174 | `fatima.a@pgp.test` / `privilege-guest-dev-only` |
| Member | :5173 | phone `+97455550001` or `+97455550003`, then the code |

## Testing a real QR scan

The obstacle is `getUserMedia`: **the camera only works in a secure context.**
`http://127.0.0.1` counts as secure; `http://192.168.x.x` does not. So the
verification page has to stay on localhost, or be behind real HTTPS.

That rules out the obvious setup (both apps on a phone) and leaves three that
work, cheapest first.

### 1. No camera — paste the payload (30 seconds, zero setup)

Tests the whole credential path: signing, freshness, resolution, entitlements,
guest caps. Everything except the lens.

1. Member app on :5173 → **Show card**. The payload is the small grey text under
   the QR (`v1.<uuid>.<unix>.<signature>`). Copy it.
2. Verification page on :5174 → **Or paste the code** → **Look up scanned code**.

The server treats a pasted payload and a scanned one identically, so if this
works the scanner has nothing left to prove but optics.

### 2. Laptop webcam pointed at a phone (the real scan)

The member app does **not** need a camera, so it can live on a plain-HTTP LAN
address. Only the verification page needs the secure context, and it keeps
localhost.

1. Start the stack with the dev servers open to the network:
   ```
   npm run dev:lan
   ```
   **Use the script, not `DEV_HOST=0.0.0.0 npm run dev`.** That form is bash
   syntax; in PowerShell — the default shell here — it does not set the variable
   and the stack comes up loopback-only, with no error to tell you so. The phone
   then simply cannot connect and the cause is invisible.

   `DEV_HOST` is opt-in and defaults to loopback (see the note in each
   `vite.config.ts`). It serves seeded member data, so don't leave it running on
   a network you don't trust.

   To confirm it worked, look for a `Network:` line in the Vite output — if you
   only see `Local:`, the variable didn't take.
2. Find this machine's address: `Get-NetIPAddress -AddressFamily IPv4`
3. **On the phone**, open `http://<that-address>:5173`, sign in, open the card.
4. **On the laptop**, open `http://127.0.0.1:5174`, sign in as outlet staff, press
   **Scan with camera**, and hold the phone up to the webcam.

If the camera button is missing, the page decided it is not in a secure context —
check you used `127.0.0.1` and not the LAN address.

### 3. A real tablet at a counter (needs HTTPS)

The only way to run the verification page on the device staff will actually use.
`DEV_HOST` alone is not enough — the tablet needs a valid certificate.

Quickest route is a tunnel, which supplies a real certificate and avoids the
self-signed warnings iOS makes painful:

```
cloudflared tunnel --url http://127.0.0.1:5174
```

Open the `https://…trycloudflare.com` URL it prints on the tablet. `mkcert` plus
Vite's `server.https` also works if you can install a local CA on the device.

This is worth doing once before launch: it is the only test that exercises a real
rear camera, real reception lighting, and a real member's screen brightness — the
three things that actually make scans fail.

### When a scan will not read

- **Phone dimmed.** The most common cause by a distance. The card requests a
  screen wake lock, but brightness itself is not something a web page can set.
- **Phone in dark mode with a tinted QR.** Cannot happen here — `digital-card.css`
  pins the quiet zone to `#ffffff` and a test enforces it — but it is the first
  thing to check if the styling is ever changed.
- **Glossy screen protector** throwing the webcam's own reflection back.
- **Payload older than `IDENTITY_CODE_WINDOW_HOURS`.** The card regenerates every
  60 seconds while open; a screenshot from yesterday is *meant* to fail.

**Signing in to the dashboard (Stage 19).** The password is step one of two.
`admin@pgp.test` reaches more than the verification page, so §3 requires a second
factor and the password alone returns a challenge, not tokens.

First time: the dashboard shows a QR. Scan it with any authenticator app (Google
Authenticator, 1Password, Aegis), enter the six-digit code, and **save the ten
recovery codes it then shows** — only their hashes are stored, so that screen is
the only time they exist. After that, sign-in asks for a code each time.

A code works once. Presenting the same one twice inside its 30-second window is
refused, so if you fat-finger a login, wait for the next code rather than
retrying the same one.

**No authenticator app? Print the codes instead.** In a second terminal:

```
npm run mfa:code                     # admin@pgp.test
npm run mfa:code -- manager@pgp.test
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

Outlet staff on :5174 are unaffected — `fatima.a@pgp.test` still signs in with a
password alone, because the verification page is not a dashboard.

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

Frees ports 3000, 5173, 5174 and 5175, then start again. It targets the process
actually holding each port rather than killing every node.exe on the machine.

## 1b. Verify it

```
npm test
```

**Everything green = the build is sound.** That is the real verification; the
manual checks below exist to catch what tests cannot see.

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
