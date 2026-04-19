# setup-signing.ps1 — one-shot Android signing keystore generator.
#
# What this does:
#   1. Verifies keytool is on PATH (bundled with any JDK).
#   2. Creates a release keystore (prompts for 2 passwords).
#   3. Extracts the SHA-1 fingerprint you need for Google Cloud Console.
#   4. Base64-encodes the keystore for the GitHub Actions secret.
#   5. Prints a copy/paste summary of EXACTLY what to register where.
#
# Usage (from PowerShell):
#   cd mobile
#   powershell -ExecutionPolicy Bypass -File scripts/setup-signing.ps1
#
# Output files (kept OUT of git, gitignored):
#   - hr-monitor-release.keystore       (the keystore itself; back this up!)
#   - hr-monitor-release.keystore.b64   (base64 text for GH secret)
#   - sha1.txt                          (plain SHA-1 line)

$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host '=== HR Monitor Android signing setup ===' -ForegroundColor Cyan
Write-Host ''

# Check keytool availability. First try PATH; if not there, look in every
# common JDK install location so the user doesn't have to fight Windows PATH
# after a fresh JDK install (new env vars only show up in new shells).
function Find-Keytool {
    $onPath = Get-Command keytool -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    $roots = @(
        'C:\Program Files\Eclipse Adoptium',
        'C:\Program Files\Java',
        'C:\Program Files\Microsoft',
        'C:\Program Files\Amazon Corretto',
        'C:\Program Files\Zulu',
        'C:\Program Files (x86)\Java'
    )
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        $found = Get-ChildItem $root -Recurse -Filter 'keytool.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { return $found.FullName }
    }

    $javaHome = $env:JAVA_HOME
    if ($javaHome -and (Test-Path (Join-Path $javaHome 'bin\keytool.exe'))) {
        return (Join-Path $javaHome 'bin\keytool.exe')
    }
    return $null
}

$keytool = Find-Keytool
if (-not $keytool) {
    Write-Host 'ERROR: keytool not found.' -ForegroundColor Red
    Write-Host ''
    Write-Host 'Install a JDK (not the Eclipse IDE) with:'
    Write-Host '  winget install --id EclipseAdoptium.Temurin.21.JDK -e'
    Write-Host ''
    Write-Host 'Then close + reopen PowerShell and rerun this script.'
    exit 1
}
Write-Host ('keytool found: ' + $keytool) -ForegroundColor Green

$keystorePath = Join-Path $PSScriptRoot '..' 'hr-monitor-release.keystore' | Resolve-Path -ErrorAction SilentlyContinue
if (-not $keystorePath) { $keystorePath = Join-Path $PSScriptRoot '..' 'hr-monitor-release.keystore' }

if (Test-Path $keystorePath) {
    Write-Host ''
    Write-Host ('WARNING: keystore already exists at ' + $keystorePath) -ForegroundColor Yellow
    $choice = Read-Host 'Overwrite? typing yes destroys the old keystore and all APKs signed with it (y/N)'
    if ($choice -ne 'y' -and $choice -ne 'Y' -and $choice -ne 'yes') {
        Write-Host 'Aborted.'
        exit 0
    }
    Remove-Item $keystorePath -Force
}

Write-Host ''
Write-Host '--- Step 1: generating keystore ---' -ForegroundColor Cyan
Write-Host 'You will be prompted for:'
Write-Host '  - a store password (used to unlock the keystore file)'
Write-Host '  - a key password (used to unlock the signing key inside)'
Write-Host 'Use the same password for both; remember it; put it in a password manager.'
Write-Host 'Name/organization/etc questions can be anything — they go in the cert subject line.'
Write-Host ''

& $keytool -genkey -v `
    -keystore $keystorePath `
    -alias hr-monitor `
    -keyalg RSA `
    -keysize 2048 `
    -validity 10000

if ($LASTEXITCODE -ne 0) {
    Write-Host 'keytool failed. Fix the error above and rerun.' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '--- Step 2: extracting SHA-1 fingerprint ---' -ForegroundColor Cyan
Write-Host ''

$listOutput = & $keytool -list -v -keystore $keystorePath -alias hr-monitor 2>&1 | Out-String
$sha1Line = ($listOutput -split "`n" | Where-Object { $_ -match '^\s*SHA1:' } | Select-Object -First 1).Trim()

if (-not $sha1Line) {
    Write-Host 'Could not parse SHA-1 from keytool output. Full output above.' -ForegroundColor Red
    exit 1
}

$sha1 = ($sha1Line -replace '^SHA1:\s*', '').Trim()
$sha1File = Join-Path (Split-Path $keystorePath) 'sha1.txt'
Set-Content -Path $sha1File -Value $sha1 -NoNewline

Write-Host ('SHA-1: ' + $sha1) -ForegroundColor Green
Write-Host ('Saved to ' + $sha1File)

Write-Host ''
Write-Host '--- Step 3: base64 encoding keystore for GitHub secret ---' -ForegroundColor Cyan

$b64File = Join-Path (Split-Path $keystorePath) 'hr-monitor-release.keystore.b64'
$bytes = [IO.File]::ReadAllBytes($keystorePath)
[IO.File]::WriteAllText($b64File, [Convert]::ToBase64String($bytes))
Write-Host ('Base64 written to ' + $b64File) -ForegroundColor Green

Write-Host ''
Write-Host '=== Setup complete. Next: register with Google + GitHub ===' -ForegroundColor Cyan
Write-Host ''
Write-Host '1) Google Cloud Console: https://console.cloud.google.com/apis/credentials'
Write-Host '   - Your existing HR Monitor project'
Write-Host '   - Create Credentials -> OAuth 2.0 Client ID -> Android'
Write-Host '   - Package name: com.nakauri.hrmonitor'
Write-Host ('   - SHA-1:       ' + $sha1)
Write-Host '   - Save. (no client ID to copy back — Google matches by package + SHA-1)'
Write-Host ''
Write-Host '2) GitHub repo Secrets: https://github.com/Nakauri/hr-monitor/settings/secrets/actions'
Write-Host '   Create four repository secrets with these exact names + values:'
Write-Host ''
Write-Host '     ANDROID_KEYSTORE_BASE64'
Write-Host ('       value: paste the ENTIRE contents of ' + $b64File)
Write-Host '     ANDROID_KEYSTORE_PASSWORD'
Write-Host '       value: the store password you chose above'
Write-Host '     ANDROID_KEY_ALIAS'
Write-Host '       value: hr-monitor'
Write-Host '     ANDROID_KEY_PASSWORD'
Write-Host '       value: the key password you chose above'
Write-Host ''
Write-Host 'After both are set, push any change to main and the next APK will'
Write-Host 'be signed with this keystore. Google Sign-In on the phone will work.'
Write-Host ''
Write-Host 'KEEP hr-monitor-release.keystore SAFE. Back it up.' -ForegroundColor Yellow
Write-Host 'Losing it means you can never update the app on devices that already have it installed.' -ForegroundColor Yellow
