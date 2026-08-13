# Deployment

How this goes from `localhost` to something members and staff actually use.

Written to be followed in order. Stage numbers refer to `ROADMAP.md`.

> **Read `ROADMAP.md` §7 first** if you have not. It covers *where* to host and
> why, and the network topology this document implements. This file is the
> procedure.

---

# 0. The shape of it

Four things run. Three of them are static files.

```
                         Internet
                            │
                     ┌──────┴───────┐
                     │    Caddy     │  TLS, routing, access control
                     └──────┬───────┘
    my.<domain>   ──────────┤   public          member app (static)
    api.<domain>  ──────────┤   public          Fastify — staff routes restricted
    outlet.<domain> ────────┤   internal only   outlet screen (static)
    admin.<domain>  ────────┤   internal only   dashboard (static)
                            │
                     ┌──────┴───────┐
                     │  Fastify API │  one process, three audiences
                     └──────┬───────┘
                     ┌──────┴───────┐
                     │  PostgreSQL  │  never published, on any address
                     └──────────────┘
```

**The API is public and has to be.** Members open the app from home, from a
plane, from another country. What is restricted is not "the backend" but which
*routes* answer which *source addresses* — see §5.

**The outlet screen is internal.** `INTERNAL_CIDR` must contain the hotel's
staff/back-of-house VLAN and the VPN, not guest Wi-Fi. A counter tablet on
cellular is refused by design; put it back on the staff network or VPN. This is
defence in depth, not the credential: every physical counter device still needs
its own high-entropy token, and losing one device does not expose another.

**The outlet screen also needs TLS to do its main job.** `getUserMedia` refuses
outside a secure context, so the camera does not work over plain HTTP at all.
There is no configuration that changes this, and typing a membership number is
the documented fallback.

---

# 1. Before you touch a server

These have lead times and block a launch more often than code does.

- [ ] **A domain.** Four hostnames come off it (`my`, `api`, `admin`, `outlet`).
- [ ] **A hosting account in a Doha region.** Azure Qatar Central or Google Cloud
      `me-central1`. §9 of the product definition is blunt about why in-region
      matters: the membership list is "a record of named, prominent individuals
      and their movements." Verify the services you need are actually offered
      there — regional coverage is thinner than in primary regions.
- [ ] **A mail sender.** Gmail App Password works for a pilot (§6). A real SMS
      provider is the launch answer.
- [ ] **The staff VLAN and VPN source ranges.** Do not use the hotel's public or
      guest Wi-Fi range for `INTERNAL_CIDR`; verify a counter tablet actually
      egresses through one of the ranges you intend to permit.
- [ ] **A DPIA.** `SECURITY-REVIEW.md` records it as required before launch and
      explicitly not an engineering task.
- [ ] **Privacy policy and terms, at a public URL.** The member profile screen
      links to both and the content does not exist. Also required by both app
      stores.

---

# 2. Provision the server

One VM is enough. For a programme whose reference card is number three,
orchestration is a liability.

- **2 vCPU, 4 GB RAM, 40 GB disk.** Generous for hundreds of members.
- **Ubuntu 22.04 LTS or 24.04 LTS.**
- **Firewall: inbound 80 and 443 only.** Not 5432. Not 3000. If your provider
  offers a private network, put the database on it.
- **SSH by key, password authentication disabled.**

Install Docker and the compose plugin, then create a deploy user:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"    # log out and back in
```

## DNS

Four A records, all pointing at the VM:

```
my.<domain>      A    <server-ip>
api.<domain>     A    <server-ip>
admin.<domain>   A    <server-ip>
outlet.<domain>  A    <server-ip>
```

Caddy obtains certificates over HTTP-01, so **DNS must resolve before the first
start** or certificate issuance fails. Confirm with `dig +short my.<domain>`.

---

# 3. The database, and the one step that must not be skipped

## R7 depends on a role, not on code

`UPDATE` and `DELETE` on `Redemption` are revoked **at the database level** for
the application role. That revocation is what makes redemption immutability real
rather than a convention — application code cannot be talked out of it, and
neither can a compromised API process.

`docker/postgres/init/01-app-role.sh` creates that role, but **it only runs on
first initialisation of an empty data directory.** Point the API at a managed
Postgres, connect as the owner because that is what the connection string came
with, and R7 disappears silently. No test fails. No error appears. The guarantee
is simply gone.

So there are two connection strings and they are different roles:

| Variable | Role | Used by |
|---|---|---|
| `DATABASE_URL` | `pgp_app` | The API at runtime — **not** the owner |
| `DATABASE_MIGRATION_URL` | `pgp_owner` | `prisma migrate deploy`, and nothing else |

### If you use a managed Postgres

The init script will not run. Create the role by hand, once:

```sql
CREATE ROLE pgp_app LOGIN PASSWORD '<strong-password>';
GRANT CONNECT ON DATABASE pgp TO pgp_app;
GRANT USAGE ON SCHEMA public TO pgp_app;
REVOKE CREATE ON SCHEMA public FROM pgp_app;
```

Table grants come from the migrations, which run as the owner.

### Verify it, every time

This is a smoke test, not a formality — run it after every deploy that touches
the database:

```bash
docker compose -f docker-compose.prod.yml exec api \
  npx prisma db execute --url "$DATABASE_URL" \
  --stdin <<< 'UPDATE "Redemption" SET "partySize" = 99;'
```

**Expected: `ERROR: permission denied for table Redemption`.**

If that command succeeds, immutability is not in force and the audit trail is
worth nothing. Stop and fix the role before going further.

---

# 4. Configure

Copy `.env.example` to `.env` on the server and fill it in. **Never commit it.**

Generate every secret freshly — the development values in the repository are
development values:

```bash
openssl rand -hex 32   # JWT_SIGNING_KEY
openssl rand -hex 32   # PASSWORD_PEPPER
openssl rand -hex 32   # OTP_CODE_HMAC_SECRET
openssl rand -hex 32   # MFA_SECRET_ENCRYPTION_KEY  (must be exactly 64 hex chars)
```

Settings that differ from development, and why:

| Variable | Production value | Reason |
|---|---|---|
| `NODE_ENV` | `production` | Stricter defaults across the service |
| `OTP_DELIVERY_CHANNEL` | `smtp` | Otherwise no member can sign in |
| `TRUST_PROXY` | `true` | **See below** |
| `API_HOST` | `0.0.0.0` | So Caddy can reach it inside the compose network |

## Google Sheets mirror (optional)

This is an outbound, derived reporting surface, not a database replacement and
not a backup. Leave `GOOGLE_SHEETS_SYNC_ENABLED=false` until all of these are
true:

- the hotel has approved Google Workspace for member-number and movement data,
  including any cross-border/data-residency implications;
- a dedicated production workbook exists with link sharing disabled;
- named hotel administrators have Viewer access, and only the dedicated service
  account has Editor access;
- the Google Sheets API is enabled in the service account's Cloud project; and
- the private key is held in the deployment secret store, not committed or
  baked into the image.

Use a different workbook and service identity in staging. Set the five
`GOOGLE_SHEETS_*` variables documented in `.env.example`. The private-key value
is base64 of the downloaded JSON credential's `private_key` field, not of the
whole JSON document; base64 is an encoding, not protection.

Before enabling the schedule, perform one reconciliation using Compose's
environment (the production image deliberately contains no `.env` file):

```bash
docker compose -f docker-compose.prod.yml run --rm api \
  node --import tsx apps/api/scripts/sheets-sync.ts
```

Verify all five managed tabs and their row counts, confirm `_Sync` has a current
UTC timestamp, and confirm no member name, phone or email appears. Then set
`GOOGLE_SHEETS_SYNC_ENABLED=true` and redeploy. The current single API process
runs one reconciliation immediately and then at the configured interval. If the
API is horizontally scaled, use one external scheduler instead; otherwise every
replica will publish the same workbook.

The Sheets worker requires outbound HTTPS to Google's Sheets endpoints. Failure
is isolated: application writes continue in PostgreSQL, the prior workbook stays
visible, and the worker retries on its next interval.

## Outlet sign-in — one token per device

The outlet screen has no human password, email login or Google option. Its only
credential is a separate, server-generated token for every physical tablet or
counter computer. The API
stores only its SHA-256 digest; the plaintext exists in one administrator response
and must be copied to the intended device immediately. The standing token is
exchanged for the same short-lived access token and rotating httpOnly refresh
session used by the rest of the staff surface. It is never sent on queue, lookup
or redemption requests.

An outlet may separately have an **Email notices to** address. That address is a
best-effort notification destination for new guest notices, not a `StaffUser`,
login identifier, allowlist entry or recovery channel. Empty means the outlet
works from its screen without email; it does not affect authentication.

After the first administrator signs in:

1. Open **Admin → Outlets** and choose the outlet.
2. Under **Device sign-in**, enter a physical label such as *Spa reception iPad*
   and press **Issue device token**.
3. Copy the token from the one-time panel into the outlet screen. Do not put it in
   `.env`, a ticket, a chat transcript or the device URL. It cannot be retrieved
   later because the database has only its digest.
4. Repeat for every physical device. Do not share one outlet-wide token: separate
   rows are what let a lost tablet be disabled without taking the other counters
   offline.

The same panel is the lifecycle control:

- **Rotate** when a token may have been copied or exposed. The old standing token
  and every refresh session derived from it stop working; the replacement is
  shown once.
- **Revoke** when a device is lost, retired or reassigned. Revocation is one-way
  and ends its sessions. A recovered device receives a newly issued row rather
  than bringing a possibly copied token back to life.
- **Last used** distinguishes a provisioned device that has never connected from
  one in active service. Device labels become the outlet-level actor on immutable
  redemption history, so name the station, not the person on shift.

Test issuance, reload/resume, rotation and revocation before handover. A reload
must resume through the secure cookie without asking for the standing token
again; the rotated or revoked session must then fail on its next authenticated
request.

There is no development-only session minter or bypass. Local acceptance uses the
same Admin-issued `pgo_…` token and `/outlet/auth/token` exchange as production,
so a copied access/refresh bundle cannot be mistaken for a standing credential.

## The card code secret

`IDENTITY_CODE_HMAC_SECRET` keys the code printed on the back of every physical
card and shown in the app.

**Rotating it invalidates every printed card at once.** That is also the only
recovery a printed credential has, so it is a deliberate trade — but it means the
value must be in the secret manager and backed up before a print run, not
generated casually at deploy time. §7 asks for a key management service; there is
none in this build, and this is the same compromise already made for
`PASSWORD_PEPPER`.

## `TRUST_PROXY` is not optional behind Caddy

Fastify sees the proxy's address, not the client's, unless it is told to read
`X-Forwarded-For`. Leave it off and **every per-IP rate limit bucket collapses
into one**, and every `ipAddress` in the audit log records the proxy. Both
controls silently stop working while appearing to be present.

Turn it on only when something trustworthy actually sets that header — which
Caddy does, and which a directly-exposed API does not.

---

# 5. Access control

## 5.1 What is public

`my.<domain>` and `api.<domain>`. Members are not at the hotel.

## 5.2 What is internal

`admin.<domain>`, `outlet.<domain>`, and both `/admin/*` and `/outlet/*` on the
public API host.

Set `INTERNAL_CIDR` in `.env` to the hotel's staff network range, plus your VPN
range:

```
INTERNAL_CIDR=203.0.113.0/24 10.8.0.0/24
```

Use the staff/back-of-house range, not guest Wi-Fi. Confirm this with hotel IT
rather than assuming every address used inside the building is trusted. A tablet
using cellular is outside these ranges and receives 403 by design; the remedy is
the staff network or VPN, not widening `INTERNAL_CIDR` to a public carrier range.

The per-device token remains the primary authentication control. The network
rule reduces exposure and does not turn source IP into identity.

**Restrict `/admin/*` on the API host as well as the dashboard's own hostname.**
Restricting only the frontend leaves the endpoints it calls answering the whole
internet, and the restriction becomes decorative. The Caddyfile does both.

## 5.3 Every administrator account needs a second factor

Every named `ADMINISTRATOR` account requires MFA. `OUTLET_STAFF` is also live,
but only as a labelled, outlet-scoped device principal authenticated by its
one-time-issued token; it cannot reach the dashboard, member list, reports or
another outlet's work. Historical MANAGER and SUPPORT rows remain suspended and
inert so old redemptions keep their original attribution.

---

# 6. Deploy

```bash
git clone <repo> /opt/pgp && cd /opt/pgp
cp .env.example .env && "$EDITOR" .env      # §4

docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d db
docker compose -f docker-compose.prod.yml run --rm api npm run migrate -w @pgp/api
docker compose -f docker-compose.prod.yml up -d
```

**Migrations are a separate, explicit step.** Never run them automatically on
container boot: two containers starting together both running migrations is a bad
afternoon.

Seeding is for development. In production the first administrator is created by
hand, once — and note the gap in `PROGRESS.md`: **there are no staff management
endpoints yet**, so creating and offboarding staff is currently a manual database
operation. That is suggested Stage 25 and it should land before launch, because
§3's "instant revocation from the dashboard" cannot otherwise be performed.

---

# 7. Verify the deployment

Not a checklist to skim. Each of these has failed silently in a real system.

```bash
# 1. TLS on all four hosts, valid certificate (403 is expected for internal
#    hosts when this is run from outside; ssl_verify_result must still be 0)
for h in my api admin outlet; do
  curl -sS -o /dev/null -w "$h %{http_code} %{ssl_verify_result}\n" \
    "https://$h.<domain>/"
done

# 2. Security headers present
curl -sSI https://api.<domain>/health | grep -iE 'strict-transport|nosniff|frame'

# 3. The internal hosts refuse an outside address
curl -sS -o /dev/null -w "%{http_code}\n" https://admin.<domain>/   # expect 403
curl -sS -o /dev/null -w "%{http_code}\n" https://outlet.<domain>/  # expect 403
curl -sS -o /dev/null -w "%{http_code}\n" https://api.<domain>/admin/members  # expect 403
curl -sS -o /dev/null -w "%{http_code}\n" https://api.<domain>/outlet/me      # expect 403

# 4. CORS does not answer a stranger
curl -sSI -H 'Origin: https://evil.example' https://api.<domain>/health \
  | grep -i access-control-allow-origin        # expect no output

# 5. Liveness and readiness are distinguishable
curl -sS https://api.<domain>/health          # process alive
curl -sS https://api.<domain>/health/ready    # database reachable
```

Then, by hand:

- [ ] **R7 holds** — the raw `UPDATE` in §3 is refused.
- [ ] **A member can sign in.** A real handset receives a real code.
- [ ] **An administrator can complete MFA** and lands on the dashboard.
- [ ] **A counter device can sign in with a newly issued token**, reload without
      re-entering it, and reach only its own outlet. Rotate it and verify the old
      token/session fails; then issue and revoke a disposable device and verify
      that session fails too.
- [ ] **The outlet boundary is real.** From guest Wi-Fi and cellular,
      `outlet.<domain>` returns 403. From the staff VLAN or VPN it loads. Do not
      accept “inside the hotel” as evidence if the test device is on guest Wi-Fi.
- [ ] **The full Stage 13 acceptance journey passes against the deployed
      instance**, not just locally.
- [ ] **No member name, phone or email appears in the container logs.** Grep for
      a seeded member's name in `docker compose logs api` and expect nothing.

---

# 8. Backups

PostgreSQL is the programme's authoritative record. The Google Sheet is
rebuildable derived data and must never be treated as a backup. Redemptions are
immutable and audit logs are append-only, which protects against tampering and
does nothing about a lost disk.

```bash
# Nightly, encrypted, off the box.
docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U pgp_owner pgp | age -r "$AGE_RECIPIENT" > "backup-$(date +%F).sql.age"
```

**Then restore one into a scratch database and confirm it works.** An untested
backup is not a backup. Do this before launch and again quarterly, with someone
other than the person who wrote the script following the runbook.

Retention has no answer in code yet — see the pre-launch list in `ROADMAP.md`.

---

# 9. Operating it

**Monitoring.** Alert on `/health` and `/health/ready` *separately*. They were
built to distinguish a dead process from a dead database, which is only useful if
they are watched independently. When the Sheets mirror is enabled, also alert if
`_Sync.last_successful_sync_utc` is older than twice the configured interval or
the API repeatedly logs `Google Sheets mirror update failed`.

**Logs.** `docker compose logs -f api`. The §9 redaction layer strips names,
phones and emails — verify that in production output, not only in tests.

**Updating.**

```bash
git pull
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml run --rm api npm run migrate -w @pgp/api
docker compose -f docker-compose.prod.yml up -d
```

Members hold a service worker, so the member app updates on next launch
(`registerType: 'autoUpdate'`). Nothing needs to be pushed to them.

**Certificates** renew themselves. Caddy handles it with no cron job.

---

# 10. Still outstanding

Deployment does not close these. They are tracked where they belong.

| Item | Where |
|---|---|
| Security headers, CORS, httpOnly cookies + CSRF, edge rate limiting | Stage 20 |
| Secrets in a KMS rather than `.env` | Stage 20 / `SECURITY-REVIEW.md` |
| Alerting on the audit log | Stage 20 / §9 |
| CI running the suite on every merge | `SECURITY-REVIEW.md` |
| **Staff management — no way to offboard a staff member** | `PROGRESS.md`, Stage 25 |
| Real SMS instead of email | Stage 18 caveat, `DECISIONS.md` |
| Arabic and RTL | Stage 22 |
| App Store and Play Store | Stage 23 |

The Caddyfile in this repository sets security headers on both **static**
hosts. Stage 20's helmet configuration covers the API. Both are needed: the API
serves JSON and is a defence-in-depth case, while the two single-page apps are
the actual XSS surface.
