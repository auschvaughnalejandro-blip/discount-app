<#
.SYNOPSIS
  Stops whatever is holding the project's ports.

.DESCRIPTION
  Only one process can listen on a port. A dev server left running -- from a
  closed terminal, a crash, or a stray background process -- makes the next one
  exit with EADDRINUSE. Its window then sits there showing nothing, which looks
  exactly like the application being broken.

  Killing the process that holds the port is NOT enough. `tsx watch` and Vite
  supervise a child and restart it the moment it dies, so the port is
  immediately re-bound and the next server still cannot start. The supervisor
  has to go first.

  So: find the process holding the port, walk UP its parent chain while the
  parents are still node/npm/cmd (that is, still part of this dev server rather
  than the user's shell or Explorer), and kill the whole tree from the top.

  Targets only the processes attached to these four ports. It does not kill
  every node.exe on the machine, which would also take out unrelated work.

.EXAMPLE
  npm run stop
#>
[CmdletBinding()]
param(
  [int[]]$Ports = @(3000, 5173, 5174, 5175)
)

$ErrorActionPreference = 'Stop'

# Names that count as "part of a dev server" when walking up the tree. The walk
# stops at anything else -- notably explorer.exe and the user's own terminal.
$SupervisorNames = @('node', 'npm', 'cmd', 'conhost', 'powershell', 'pwsh')

function Get-PortOwner {
  param([int]$Port)

  $owners = @()
  $lines = netstat -ano -p TCP | Where-Object { $_ -match 'LISTENING' -and $_ -match ":$Port\s" }
  foreach ($line in $lines) {
    $fields = ($line -split '\s+') | Where-Object { $_ -ne '' }
    if ($fields.Count -ge 5) { $owners += [int]$fields[-1] }
  }
  return $owners | Sort-Object -Unique
}

function Get-TopmostSupervisor {
  param([int]$ProcessId)

  $current = $ProcessId
  $guard = 0

  while ($guard -lt 10) {
    $guard++

    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $current" -ErrorAction SilentlyContinue
    if (-not $proc -or -not $proc.ParentProcessId) { break }

    $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.ParentProcessId)" -ErrorAction SilentlyContinue
    if (-not $parent) { break }

    $parentName = [System.IO.Path]::GetFileNameWithoutExtension($parent.Name)
    if ($SupervisorNames -notcontains $parentName) { break }

    # Never walk up into the shell this script is running from, or we would
    # kill the terminal that invoked us.
    if ($parent.ProcessId -eq $PID) { break }

    $current = [int]$parent.ProcessId
  }

  return $current
}

$killed = @()

foreach ($port in $Ports) {
  $owners = Get-PortOwner -Port $port

  if ($owners.Count -eq 0) {
    Write-Host ("  port {0,-5} free" -f $port)
    continue
  }

  foreach ($owner in $owners) {
    $top = Get-TopmostSupervisor -ProcessId $owner

    $name = 'unknown'
    try { $name = (Get-Process -Id $top -ErrorAction Stop).ProcessName } catch { }

    # /T takes the children with it, so the supervised server dies alongside
    # the supervisor and cannot be restarted.
    #
    # Run through cmd with output discarded there. Letting taskkill's stderr
    # reach PowerShell turns each line into an ErrorRecord, which with
    # ErrorActionPreference = Stop aborts this script partway through the port
    # list -- and it writes to stderr routinely, for children that already
    # exited as part of the same tree.
    cmd /c "taskkill /F /T /PID $top >nul 2>&1"
    $exitCode = $LASTEXITCODE

    if ($exitCode -eq 0) {
      Write-Host ("  port {0,-5} stopped {1} tree (pid {2})" -f $port, $name, $top)
      $killed += $top
    } else {
      # Often benign: the tree came down with an earlier port's kill.
      Write-Host ("  port {0,-5} kill reported {1} for pid {2}" -f $port, $exitCode, $top)
    }
  }
}

# Supervisors can take a moment to release the socket.
Start-Sleep -Milliseconds 1200

$stillHeld = @()
foreach ($port in $Ports) {
  if ((Get-PortOwner -Port $port).Count -gt 0) { $stillHeld += $port }
}

Write-Host ''
if ($stillHeld.Count -eq 0) {
  Write-Host 'All ports free.'
} else {
  Write-Host ('Still held: {0}. Run it once more, or reboot.' -f ($stillHeld -join ', '))
  exit 1
}
