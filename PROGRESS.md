# Progress

Last updated: 2026-07-29
Current stage: 1 (complete) — next is Stage 2, Authentication

## Stages
- [x] 0 — Foundation
- [x] 1 — Data model
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
- Moved the three reference documents from the repository root into `docs/` under
  the filenames the build plan uses. They were empty at the time; the content
  arrived later and Stage 1 was built against it.

Acceptance:
- `npm run dev` starts the API — PASS
- `GET /health` returns 200 — PASS
- `npm test` passes — PASS
- `npx prisma migrate dev` runs against the container — PASS in substance, with a
  caveat: see "Environment deviations" below. Migrations were applied with
  `prisma migrate deploy` against PostgreSQL 18, not the compose container.

Notes:
- `apps/web-member/`, `apps/web-verify/` and `apps/web-admin/` are not scaffolded.
  They belong to Stages 10–12; creating them now would be working ahead.
- `GET /health` is liveness and does not touch the database, so it can distinguish
  a dead process from a dead database. `GET /health/ready` runs `SELECT 1`.

### Stage 1 — Data model
Status: complete

Files created:
- `apps/api/prisma/schema.prisma` — 10 models, 6 enums
- `apps/api/prisma/migrations/20260729140000_init/migration.sql`
- `apps/api/prisma/migrations/20260729140100_redemption_immutability/migration.sql`
- `apps/api/prisma/seed.ts`
- `apps/api/test/data-model.test.ts`, `apps/api/test/setup.ts`
- `docker/postgres/init/01-app-role.sh` — creates the least-privileged app role
- `docker-compose.yml` updated: publishes on **5433**, not 5432, because a
  PostgreSQL instance already occupies 5432 on this machine

Acceptance:
- Migration applies cleanly — PASS (`prisma migrate deploy`, both migrations)
- Seed populates all five benefits with correct percentages and guest caps — PASS
- A raw `UPDATE` against `Redemption` as the app role is rejected by the database — PASS
  (`ERROR: permission denied for table Redemption`; `pgp_app` holds only SELECT and
  INSERT on that table)
- `billAmountMinor` is an integer everywhere — PASS (`integer`; no `real` or
  `double precision` column exists anywhere in the schema)

Verified by `apps/api/test/data-model.test.ts` — 15 tests, all passing. Full suite: 17.

Beyond the four criteria, the same migration also enforces:
- `DELETE` on `Member` revoked (R16 — members are suspended, never deleted)
- `UPDATE`/`DELETE` on `AuditLog` and `ConsentRecord` revoked
  (security-implementation.md §5 backstop, §9 append-only audit)
- A `member_number_seq` sequence and `next_member_number()` returning `PG-0004`,
  so numbers are sequential and generated in the database rather than the
  application, where two concurrent creates could collide (R3)
- CHECK constraints: outlet required on `OUTLET_STAFF` accounts and forbidden
  otherwise; party size positive; a reversal cannot point at itself; percentages
  within 0–100; `minGuests <= maxGuests`

Seeded benefit values, taken from product-definition.md §2 and the wireframes
benefit table — no percentage, cap or phone number appears in application code:

| key | discount | secondary | max | min | reservations |
|---|---|---|---|---|---|
| fnb | 25% | — (children 6–12: 50%, 0–6: 100%) | 6 | — | 4020 1720 |
| rooms | 30% | — | — | — | 4020 1666 |
| spa | 40% | Retail products 25% | 2 | — | 4020 1625 |
| events | 25% | Outside catering 20% | — | 20 | — |
| lifestyle | 30% | Pool day pass 25% | — | — | — |

## Open questions blocking work

None blocking. The four items below are recorded per BUILD-PLAN §0 rule 4 and
carry `TODO(open-question)` comments where they touch code.

- [ ] **Q1 — product-definition.md §11.1: what does the existing QR code do?**
  Documented assumption implemented: the code identifies the *member* and is
  scanned by staff (the second of the two possibilities), per §6 which states the
  specification assumes it. Affects Stage 6 and Stage 7.

- [ ] **Q2 — §11.3: will staff record bill amounts?**
  `billAmountMinor` is nullable and optional, so the build works either way. If the
  answer is no, the "estimated value given" figure in Stage 8 reporting disappears.

- [ ] **Q3 — §11.5: does membership expire or renew?**
  Assumed not. There is no expiry column on `Member`. Noted in `prisma/seed.ts`.

- [ ] **Q4 — §11.2: do priority reservations and member events belong in the app?**
  Both are promised in the invitation letter but absent from the benefits table.
  Not built. Affects Stages 5 and 10.

## Environment deviations

- **Docker is not installed on this machine.** `docker-compose.yml` and
  `docker/postgres/init/01-app-role.sh` are written and are the intended path, but
  unverified. Stage 1 was instead verified against a temporary PostgreSQL 18.4
  cluster created with `initdb` in the scratch directory and listening on 127.0.0.1:5434,
  with `pgp_owner` and `pgp_app` roles created to mirror the compose setup exactly.
  That cluster is disposable; `apps/api/.env` currently points at it.
- **PostgreSQL 18 rather than 15.** The stack table says "PostgreSQL 15+", so 18
  satisfies it, but the compose file pins `postgres:15-alpine`. Nothing in the
  schema or migrations is version-specific.
- **Compose publishes on 5433.** Port 5432 is taken by an existing PostgreSQL
  service on this machine.
- `npm test` now requires a reachable database — `apps/api/test/data-model.test.ts`
  is an integration test. `test/health.test.ts` still runs without one.

## Deviations from spec

- None.
