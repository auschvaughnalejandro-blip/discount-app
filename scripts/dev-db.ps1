<#
.SYNOPSIS
  Manages the local PostgreSQL cluster used for development and integration tests.

.DESCRIPTION
  The build plan's intended database is the Docker Compose stack (`npm run db:up`).
  Docker is not installed on this machine, so this script runs an equivalent
  cluster directly from the PostgreSQL binaries already installed here.

  It listens on port 5434 -- not 5432, which the machine-wide PostgreSQL service
  already occupies, and not 5433, which docker-compose.yml publishes on.

  Two roles are created, mirroring the compose setup exactly:
    pgp_owner  owns the schema; migrations and the seed run as this role
    pgp_app    the application role, denied UPDATE/DELETE on Redemption (R7)

  The split is the point: an owner cannot be denied access to its own tables,
  so R7 only means something because the application is not the owner.

.EXAMPLE
  .\scripts\dev-db.ps1 status
  .\scripts\dev-db.ps1 start
  .\scripts\dev-db.ps1 stop
  .\scripts\dev-db.ps1 setup     # create the cluster from scratch
  .\scripts\dev-db.ps1 reset     # destroy and rebuild, then migrate + seed
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'status', 'setup', 'reset')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'

$PgBin = 'C:\Program Files\PostgreSQL\18\bin'
$Root = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $Root '.devdb\pgdata'
$LogFile = Join-Path $Root '.devdb\pg.log'
$Port = 5434

$OwnerPassword = 'ownerpw'
$AppPassword = 'apppw'

function Assert-PostgresInstalled {
  if (-not (Test-Path (Join-Path $PgBin 'pg_ctl.exe'))) {
    throw "PostgreSQL binaries not found at $PgBin. Install PostgreSQL 15+ or use Docker (`npm run db:up`)."
  }
}

function Get-ServerRunning {
  if (-not (Test-Path $DataDir)) { return $false }
  & "$PgBin\pg_ctl.exe" -D $DataDir status *> $null
  return $LASTEXITCODE -eq 0
}

function Start-Server {
  if (Get-ServerRunning) { Write-Host 'Already running.'; return }

  $arguments = @(
    '-D', "`"$DataDir`"",
    '-o', "`"-p $Port -c listen_addresses=127.0.0.1`"",
    '-l', "`"$LogFile`"",
    'start'
  )
  Start-Process -FilePath "$PgBin\pg_ctl.exe" -ArgumentList $arguments -NoNewWindow -Wait
  Start-Sleep -Seconds 2

  if (Get-ServerRunning) {
    Write-Host "Running on 127.0.0.1:$Port"
  } else {
    throw "Failed to start. See $LogFile"
  }
}

function Stop-Server {
  if (-not (Get-ServerRunning)) { Write-Host 'Not running.'; return }
  & "$PgBin\pg_ctl.exe" -D $DataDir -m fast stop | Out-Null
  Write-Host 'Stopped.'
}

function Invoke-Psql {
  param([string]$Database, [string]$Sql)

  $env:PGPASSWORD = $OwnerPassword
  $output = & "$PgBin\psql.exe" -h 127.0.0.1 -p $Port -U pgp_owner -d $Database -v ON_ERROR_STOP=1 -c $Sql 2>&1
  if ($LASTEXITCODE -ne 0) { throw "psql failed: $output" }
  return $output
}

function New-Cluster {
  Assert-PostgresInstalled

  if (Test-Path $DataDir) {
    throw "$DataDir already exists. Use 'reset' to destroy and rebuild it."
  }

  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  $passwordFile = Join-Path $env:TEMP 'pgp-init-pw.txt'
  $OwnerPassword | Out-File -FilePath $passwordFile -Encoding ascii -NoNewline

  try {
    & "$PgBin\initdb.exe" -D $DataDir -U pgp_owner --pwfile=$passwordFile `
      --encoding=UTF8 --auth-local=trust --auth-host=scram-sha-256 | Out-Null
  } finally {
    Remove-Item $passwordFile -ErrorAction SilentlyContinue
  }

  Start-Server

  Invoke-Psql -Database 'postgres' -Sql 'CREATE DATABASE pgp OWNER pgp_owner;' | Out-Null

  # Mirrors docker/postgres/init/01-app-role.sh. Table-level grants are applied
  # by the redemption_immutability migration, since the tables do not exist yet.
  $roleSql = @"
CREATE ROLE pgp_app LOGIN PASSWORD '$AppPassword';
GRANT CONNECT ON DATABASE "pgp" TO pgp_app;
GRANT USAGE ON SCHEMA public TO pgp_app;
REVOKE CREATE ON SCHEMA public FROM pgp_app;
"@
  Invoke-Psql -Database 'pgp' -Sql $roleSql | Out-Null

  Write-Host 'Cluster created with roles pgp_owner and pgp_app.'
  Write-Host ''
  Write-Host 'Next: apply migrations and seed --'
  Write-Host '  cd apps\api'
  Write-Host '  npm run migrate'
  Write-Host '  npm run seed'
}

function Reset-Cluster {
  if (Get-ServerRunning) { Stop-Server }
  if (Test-Path $DataDir) {
    Remove-Item -Recurse -Force (Split-Path $DataDir)
    Write-Host 'Destroyed.'
  }
  New-Cluster
}

switch ($Action) {
  'start' { Assert-PostgresInstalled; Start-Server }
  'stop' { Stop-Server }
  'setup' { New-Cluster }
  'reset' { Reset-Cluster }
  'status' {
    if (Get-ServerRunning) {
      Write-Host "Running on 127.0.0.1:$Port"
      Write-Host "  DATABASE_URL=postgresql://pgp_app:$AppPassword@127.0.0.1:$Port/pgp?schema=public"
    } else {
      Write-Host 'Not running.'
      if (-not (Test-Path $DataDir)) {
        Write-Host "No cluster at $DataDir -- run: .\scripts\dev-db.ps1 setup"
      } else {
        Write-Host 'Run: .\scripts\dev-db.ps1 start'
      }
    }
  }
}
