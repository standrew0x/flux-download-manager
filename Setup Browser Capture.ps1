$ErrorActionPreference = 'Stop'

try {
    $projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
    $extensionFolder = Join-Path $projectRoot 'browser-extension'
    $manifest = Join-Path $extensionFolder 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { throw "Flux Capture extension files are missing." }

    Set-Clipboard -Value $extensionFolder
    Start-Process explorer.exe -ArgumentList @($extensionFolder)

    $browserCandidates = @(
        @{ Name = 'Microsoft Edge'; Path = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"; Page = 'edge://extensions/' },
        @{ Name = 'Google Chrome'; Path = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"; Page = 'chrome://extensions/' },
        @{ Name = 'Google Chrome'; Path = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"; Page = 'chrome://extensions/' },
        @{ Name = 'Opera'; Path = "$env:LOCALAPPDATA\Programs\Opera\opera.exe"; Page = 'opera://extensions/' }
    )
    $opened = @()
    foreach ($browser in $browserCandidates) {
        if ((Test-Path -LiteralPath $browser.Path -PathType Leaf) -and ($opened -notcontains $browser.Name)) {
            Start-Process -FilePath $browser.Path -ArgumentList @($browser.Page)
            $opened += $browser.Name
        }
    }
    if (-not $opened.Count) { throw "No supported Chromium browser was found." }

    Add-Type -AssemblyName PresentationFramework
    $names = $opened -join ', '
    $message = "Flux opened the Extensions page in: $names.`n`nIn each browser:`n1. Turn on Developer mode.`n2. Click Load unpacked.`n3. Select the browser-extension folder that just opened.`n`nThe folder path is already copied to your clipboard."
    [System.Windows.MessageBox]::Show($message, 'Finish Flux Capture setup', 'OK', 'Information') | Out-Null
    exit 0
}
catch {
    Write-Host "Flux Capture setup failed:" -ForegroundColor Red
    Write-Host $_.Exception.Message
    exit 1
}
