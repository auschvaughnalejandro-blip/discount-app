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
    api.<domain>  ──────────┤   public          Fastify — /admin/* restricted
    verify.<domain> ────────┤   internal only   verification page (static)
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

---

# 1. Before you touch a server

These have lead times and block a launch more often than code does.

- [ ] **A domain.** Four hostnames come off it (`my`, `api`, `verify`, `admin`).
- [ ] **A hosting account in a Doha region.** Azure Qatar Central or Google Cloud
      `me-central1`. §9 of the product definition is blunt about why in-region
      matters: the membership list is "a record of named, prominent individuals
      and their movements." Verify the services you need are actually offered
      there — regional coverage is thinner than in primary regions.
- [ ] **A mail sender.** Gmail App Password works for a pilot (§6). A real SMS
      provider is the launch answer.
- [ ] **A DPIA.** `SECURITY-REVIEW.md` records it as required before launch and
      explicitly not an engineering task.
- [ ] **Privacy policy and terms, at a public URL.** The member profile screen
      links to both and the content does not exist. Also required by both app
      stores.
- [ ] **Decide the verification page's exposure.** See §5.3 — it changes whether
      outlet staff need MFA.

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
verify.<domain>  A    <server-ip>
admin.<domain>   A    <server-ip>
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
openssl rand -hex 32   # IDENTITY_CODE_HMAC_SECRET
openssl rand -hex 32   # MFA_SECRET_ENCRYPTION_KEY  (must be exactly 64 hex chars)
```

Settings that differ from development, and why:

| Variable | Production value | Reason |
|---|---|---|
| `NODE_ENV` | `production` | Gates the dev OTP echo, among others |
| `DEV_OTP_ECHO` | `false` | Printing passcodes to a log is the whole risk |
| `OTP_DELIVERY_CHANNEL` | `smtp` | Otherwise no member can sign in |
| `TRUST_PROXY` | `true` | **See below** |
| `API_HOST` | `0.0.0.0` | So Caddy can reach it inside the compose network |

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

`verify.<domain>`, `admin.<domain>`, and `/admin/*` on the public API host.

Set `INTERNAL_CIDR` in `.env` to the hotel's network range, plus your VPN range:

```
INTERNAL_CIDR=203.0.113.0/24 10.8.0.0/24
```

**Restrict `/admin/*` on the API host as well as the dashboard's own hostname.**
Restricting only the frontend leaves the endpoints it calls answering the whole
internet, and the restriction becomes decorative. The Caddyfile does both.

## 5.3 The decision that changes MFA scope

Stage 19 exempted `OUTLET_STAFF` from MFA, following §3's "MFA for any staff
account that can reach more than the verification page". **That exemption assumes
the verification page is not on the open internet.**

- **Verify page internal-only** → the exemption stands. §3's named accounts,
  shift-length expiry and instant revocation are proportionate.
- **Verify page public for any reason** → **extend MFA to `OUTLET_STAFF`.** Add
  it to `MFA_REQUIRED_ROLES` in `src/security/mfa.ts`. Password-only
  authentication on a public endpoint reaching member records is a materially
  worse position than the one that decision was made in.

Choose deliberately now rather than discovering later which one you are in.

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
# 1. TLS on all four hosts, valid certificate
for h in my api verify admin; do
  curl -sS -o /dev/null -w "$h %{http_code} %{ssl_verify_result}\n" \
    "https://$h.<domain>/"
done

# 2. Security headers present
curl -sSI https://api.<domain>/health | grep -iE 'strict-transport|nosniff|frame'

# 3. The internal hosts refuse an outside address
curl -sS -o /dev/null -w "%{http_code}\n" https://admin.<domain>/   # expect 403
curl -sS -o /dev/null -w "%{http_code}\n" https://api.<domain>/admin/members  # expect 403

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
- [ ] **The camera works on a real counter tablet.** This is the first point at
      which it can be tested at all — `getUserMedia` needs a secure context, so
      until now the scanner has only run on `localhost`.
- [ ] **The full Stage 13 acceptance journey passes against the deployed
      instance**, not just locally.
- [ ] **No member name, phone or email appears in the container logs.** Grep for
      a seeded member's name in `docker compose logs api` and expect nothing.

---

# 8. Backups

The database is the programme's only record. Redemptions are immutable and audit
logs are append-only, which protects against tampering and does nothing about a
lost disk.

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
they are watched independently.

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

The Caddyfile in this repository sets security headers on the three **static**
hosts. Stage 20's helmet configuration covers the API. Both are needed: the API
serves JSON and is a defence-in-depth case, while the three single-page apps are
the actual XSS surface.
