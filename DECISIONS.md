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
