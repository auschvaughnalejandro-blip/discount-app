<#
.SYNOPSIS
  Stops whatever is holding the project's ports.

.DESCRIPTION
  Only one process can listen on a port. When a dev server is left running --
  from a closed terminal, a crashed window, or a stray background process --
  the next one to start fails with EADDRINUSE and exits. Its window then sits
  there showing nothing, which looks exactly like the application being broken.

  This frees the four ports the project uses, and nothing else. It targets the
  process actually holding each port rather than killing every node.exe on the
  machine, which would also take out unrelated work.

.EXAMPLE
  npm run stop
  npm run stop -- 3000
#>
[CmdletBinding()]
param(
  [int[]]$Ports = @(3000, 5173, 5174, 5175)
)

$ErrorActionPreference = 'Stop'

$freed = 0

foreach ($port in $Ports) {
  $owners = @()

  # Get-NetTCPConnection is unavailable in some shells; netstat always works.
  $lines = netstat -ano -p TCP | Where-Object { $_ -match "LISTENING" -and $_ -match ":$port\s" }
  foreach ($line in $lines) {
    $fields = ($line -split '\s+') | Where-Object { $_ -ne '' }
    if ($fields.Count -ge 5) { $owners += $fields[-1] }
  }

  $owners = $owners | Sort-Object -Unique

  if ($owners.Count -eq 0) {
    Write-Host ("  port {0,-5} free" -f $port)
    continue
  }

  foreach ($processId in $owners) {
    $name = 'unknown'
    try { $name = (Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch { }

    try {
      Stop-Process -Id $processId -Force -ErrorAction Stop
      Write-Host ("  port {0,-5} stopped {1} (pid {2})" -f $port, $name, $processId)
      $freed++
    } catch {
      Write-Host ("  port {0,-5} could NOT stop pid {1}: {2}" -f $port, $processId, $_.Exception.Message)
    }
  }
}

Start-Sleep -Milliseconds 500

$stillHeld = @()
foreach ($port in $Ports) {
  $lines = netstat -ano -p TCP | Where-Object { $_ -match "LISTENING" -and $_ -match ":$port\s" }
  if ($lines) { $stillHeld += $port }
}

Write-Host ''
if ($stillHeld.Count -eq 0) {
  Write-Host "All ports free. Start again with: npm run dev"
} else {
  Write-Host ("Still held: {0}. Try again, or reboot." -f ($stillHeld -join ', '))
  exit 1
}
