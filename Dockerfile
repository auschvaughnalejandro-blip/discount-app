# Privilege Guest Program — production image.
#
# Two targets from one file, because both need the same npm workspace install
# and doing it twice would double the build and let the two drift:
#
#   --target api  → the Fastify server
#   --target web  → Caddy, with the three static client bundles baked in
#
# Build from the repository root; the workspace root package.json and lockfile
# are what make `npm ci` reproducible.

# ── Base ────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS base
WORKDIR /app
# Prisma's engines need libc compatibility on Alpine, and dumb-init gives the
# API a real PID 1 so SIGTERM reaches it and `app.close()` runs its shutdown
# hooks rather than the process being killed outright.
RUN apk add --no-cache libc6-compat dumb-init


# ── Dependencies ────────────────────────────────────────────────────────────
# Only manifests are copied here, so this layer is cached until a dependency
# actually changes — source edits do not trigger a reinstall.
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY apps/api/package.json apps/api/
COPY apps/web-member/package.json apps/web-member/
COPY apps/web-verify/package.json apps/web-verify/
COPY apps/web-admin/package.json apps/web-admin/
RUN npm ci


# ── Build ───────────────────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/ apps/

# Generate the Prisma client before typechecking — the schema is the source of
# the types `src/` is checked against.
RUN npx prisma generate --schema apps/api/prisma/schema.prisma

# The API runs from TypeScript via tsx rather than compiled output, because
# `packages/shared` exports `.ts` directly and giving it an emit step is a
# separate change. Running the typecheck here recovers the property that
# compiling would have bought: a type or syntax error fails the *build*, not the
# first request in production.
RUN npm run typecheck

# The three clients are static after this. Vite inlines nothing secret — the
# API is reached at a relative /api path, proxied by Caddy.
RUN npm run build --workspace @pgp/web-member \
 && npm run build --workspace @pgp/web-verify \
 && npm run build --workspace @pgp/web-admin


# ── API runtime ─────────────────────────────────────────────────────────────
FROM base AS api
ENV NODE_ENV=production

# Production dependency tree only: no vitest, no vite, no typescript.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY apps/api/package.json apps/api/
RUN npm ci --omit=dev --workspace @pgp/api --include-workspace-root \
 && npm cache clean --force

COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY apps/api/ apps/api/

# The generated client, rather than regenerating it here — one source of truth
# for what the running code was built against.
COPY --from=build /app/node_modules/.prisma /app/node_modules/.prisma
COPY --from=build /app/node_modules/@prisma /app/node_modules/@prisma

# Never bake configuration into the image. `.dockerignore` excludes .env, and
# this is the belt to that braces: a stray file cannot ship secrets.
RUN rm -f apps/api/.env .env

# `node` (uid 1000) ships with the image. Nothing here needs to write to disk,
# so the filesystem can be mounted read-only in compose.
USER node

EXPOSE 3000
# Liveness only. `/health/ready` touches the database, and a database blip
# should not make Docker restart a perfectly healthy API process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
# `npm start` runs tsx against src/server.ts. `--env-file` is deliberately not
# used: compose supplies the environment, so there is no .env inside the image.
CMD ["node", "--import", "tsx", "apps/api/src/server.ts"]


# ── Static site runtime ─────────────────────────────────────────────────────
FROM caddy:2-alpine AS web
# Each client is served from its own hostname; see docker/caddy/Caddyfile.
COPY --from=build /app/apps/web-member/dist /srv/member
COPY --from=build /app/apps/web-verify/dist /srv/verify
COPY --from=build /app/apps/web-admin/dist  /srv/admin
COPY docker/caddy/Caddyfile /etc/caddy/Caddyfile
