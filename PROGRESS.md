# Progress

Last updated: 2026-07-29
Current stage: 0 (complete) — Stage 1 blocked, see "Open questions blocking work"

## Stages
- [x] 0 — Foundation
- [ ] 1 — Data model
- [ ] 2 — Authentication
- [ ] 3 — Authorization
- [ ] 4 — Member lifecycle
- [ ] 5 — Benefits
- [ ] 6 — Identity codes
- [ ] 7 — Redemption
- [ ] 8 — Reporting
- [ ] 9 — Audit logging
- [ ] 10 — Member client
- [ ] 11 — Verification client
- [ ] 12 — Admin client
- [ ] 13 — Integration & acceptance
- [ ] 14 — Security review

## Stage log

### Stage 0 — Foundation
Status: complete

Files created:
- `package.json`, `tsconfig.base.json`, `.gitignore`, `.env.example`, `docker-compose.yml`
- `packages/shared/` — `package.json`, `tsconfig.json`, `src/index.ts`, `src/health.ts`
- `apps/api/` — `package.json`, `tsconfig.json`, `vitest.config.ts`, `prisma/schema.prisma`
- `apps/api/src/` — `server.ts`, `app.ts`, `config/env.ts`, `plugins/prisma.ts`, `routes/health.ts`
- `apps/api/test/health.test.ts`
- `PROGRESS.md`, `DECISIONS.md`

Also done:
- Moved the three (currently empty) reference documents from the repository root into
  `docs/` under the filenames the build plan uses:
  `product_vision.md` → `docs/product-definition.md`,
  `security_implementation.md` → `docs/security-implementation.md`,
  `wireframes.html` → `docs/wireframes.html`.
  `build_plan.md` was left at the root, unrenamed, because it was open in the editor.

Acceptance:
- `npm run dev` starts the API — PASS
- `GET /health` returns 200 — PASS (covered by `apps/api/test/health.test.ts`)
- `npm test` passes — PASS
- `npx prisma migrate dev` runs against the container — **NOT VERIFIED**, see Q5

Notes:
- `apps/web-member/`, `apps/web-verify/` and `apps/web-admin/` are **not** scaffolded.
  They belong to Stages 10–12 and creating them now would be working ahead
  (BUILD-PLAN §0 rule 5). The root `workspaces` globs (`apps/*`, `packages/*`) will
  pick them up when their stages arrive.
- `prisma/schema.prisma` contains a generator and datasource only. The data model
  is Stage 1.
- `GET /health` is a liveness probe and deliberately does not touch the database, so
  it can distinguish a dead process from a dead database. `GET /health/ready` is the
  readiness probe that runs `SELECT 1`.

## Open questions blocking work

- [x] **Q1 — All three authoritative reference documents are empty (0 bytes).**
  `docs/product-definition.md`, `docs/security-implementation.md` and
  `docs/wireframes.html` contain no content. BUILD-PLAN §1 lists all three as
  "CURRENT — authoritative", and §9 step 1 requires confirming `docs/` contains them
  before starting.
  **Blocks:** Stages 1–14. Every stage from 1 onward reads its requirements from one
  of these files — the benefit percentages and guest caps (Stage 1 seed, Stage 5),
  the Argon2/JWT/OTP/rate-limit parameters (Stage 2), the role-to-permission matrix
  (Stage 3), the claim and consent flow (Stage 4), every screen (Stages 10–12) and
  the §12 security checklist (Stage 14).
  **Not proceeding**, because filling these gaps means inventing the specification,
  which BUILD-PLAN §0 rule 2 forbids. Awaiting the document contents.

- [ ] **Q2 — `docs/foundations-four-things.md` is absent.** Listed in §1 as background.
  Non-blocking, but it is context the plan expects to be read.

- [ ] **Q3 — `docs/security-architecture.md` and `docs/build-plan.md` are absent.**
  Both are marked STALE in §1, but §1 says the threat-model and legal sections of
  `security-architecture.md` still apply. Those will be needed at Stage 14.

- [ ] **Q4 — Docker is not installed on this machine.** `docker-compose.yml` is written
  per Stage 0, but `npm run db:up` cannot run here, so the container path is unverified.

- [ ] **Q5 — No database credentials.** PostgreSQL 18 is installed natively and listening
  on `127.0.0.1:5432` with `scram-sha-256` authentication, but no superuser password is
  available in this environment, so the `pgp_owner`/`pgp_app` roles and the `pgp` database
  have not been created. Consequently `npx prisma migrate dev` has not been run.
  Resolve by either installing Docker (then `npm run db:up`) or supplying credentials for
  the local instance.

## Deviations from spec

- Stage 0's fourth acceptance criterion (`npx prisma migrate dev` against the container)
  is unmet for environmental reasons only — see Q4 and Q5. No code change is expected
  to be needed once a database is reachable.
