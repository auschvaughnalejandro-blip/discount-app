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
| Owner | :5175 | `admin@pgp.test` / `privilege-guest-dev-only` |
| Outlet staff | :5174 | `fatima.a@pgp.test` / `privilege-guest-dev-only` |
| Member | :5173 | phone `+97455550001` or `+97455550003`, then the code |

**Signing in as a member.** There is no SMS provider (PROGRESS.md Q6), so the
one-time passcode is printed to the terminal running `npm run dev`:

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
