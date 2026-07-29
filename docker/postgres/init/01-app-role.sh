#!/bin/bash
# Creates the least-privileged role the application connects as.
#
# It deliberately does NOT own the schema. Migrations run as POSTGRES_USER
# (the owner); the application runs as pgp_app. Without that split, the
# REVOKE in the redemption_immutability migration would have no effect —
# a table owner cannot be denied access to its own table.
#
# Table-level grants are applied by that migration, not here, because the
# tables do not exist yet at initdb time.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE ROLE pgp_app LOGIN PASSWORD '${PGP_APP_PASSWORD}';
  GRANT CONNECT ON DATABASE "${POSTGRES_DB}" TO pgp_app;
  GRANT USAGE ON SCHEMA public TO pgp_app;

  -- Not a superuser, cannot create databases or roles, and cannot create new
  -- objects in the schema it uses.
  REVOKE CREATE ON SCHEMA public FROM pgp_app;
EOSQL
