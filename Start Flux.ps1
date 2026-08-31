$ErrorActionPreference = 'Stop'

try {
    $projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
    $serverPath = Join-Path $projectRoot 'server.js'
    if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
        throw "Flux server was not found at $serverPath"
    }

    $nodeCommand = Get-Command node.exe -ErrorAction Stop
    $nodeVersionText = & $nodeCommand.Source --version
    $nodeMajor = [int](($nodeVersionText -replace '^v', '').Split('.')[0])
    if ($nodeMajor -lt 24) {
        throw "Flux requires Node.js 24 or newer. Found $nodeVersionText."
    }

    $logRoot = Join-Path $env:LOCALAPPDATA 'Flux Download Manager\logs'
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    $stdoutLog = Join-Path $logRoot 'server.out.log'
    $stderrLog = Join-Path $logRoot 'server.error.log'
    $argumentLine = '"' + $serverPath + '" --open'

    $process = Start-Process `
        -FilePath $nodeCommand.Source `
        -ArgumentList $argumentLine `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutLog `
        -RedirectStandardError $stderrLog `
        -PassThru

    Start-Sleep -Milliseconds 900
    if ($process.HasExited -and $process.ExitCode -ne 0) {
        $details = if (Test-Path -LiteralPath $stderrLog) { (Get-Content -LiteralPath $stderrLog -Raw).Trim() } else { '' }
        if (-not $details) { $details = "Node exited with code $($process.ExitCode)." }
        throw $details
    }
    exit 0
}
catch {
    Write-Host "Flux failed to launch:" -ForegroundColor Red
    Write-Host $_.Exception.Message
    exit 1
}
