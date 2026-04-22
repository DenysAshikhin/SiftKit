[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int]$BenchmarkPid
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-ListenerPids {
    param(
        [Parameter(Mandatory = $true)]
        [int[]]$Ports
    )

    $pids = New-Object 'System.Collections.Generic.HashSet[int]'
    $output = & netstat -ano -p tcp
    foreach ($line in $output) {
        foreach ($port in $Ports) {
            if ($line -match (":{0}\s" -f $port)) {
                $parts = ($line -split '\s+') | Where-Object { $_ -ne '' }
                if ($parts.Count -gt 0) {
                    $pidText = $parts[-1]
                    $listenerPid = 0
                    if ([int]::TryParse($pidText, [ref]$listenerPid) -and $listenerPid -gt 0) {
                        $null = $pids.Add($listenerPid)
                    }
                }
            }
        }
    }
    return @($pids)
}

function Stop-Ports {
    param(
        [Parameter(Mandatory = $true)]
        [int[]]$Ports
    )

    $pids = @(Get-ListenerPids -Ports $Ports)
    foreach ($processId in $pids) {
        try {
            & taskkill /PID $processId /T /F | Out-Null
        }
        catch {
        }
    }
}

while (Get-Process -Id $BenchmarkPid -ErrorAction SilentlyContinue) {
    Start-Sleep -Seconds 2
}

Start-Sleep -Seconds 2
Stop-Ports -Ports @(4765, 8097)
