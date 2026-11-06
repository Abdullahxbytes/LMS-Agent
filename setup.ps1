# One-shot setup for a new Windows machine.
#
#   powershell -ExecutionPolicy Bypass -File setup.ps1
#
# Installs the npm packages, makes sure a browser exists for the Microsoft
# login, and creates .env from the template. It does NOT install Node itself
# and it does NOT fill in your credentials - both are reported if missing.

# Deliberately NOT 'Stop': Windows PowerShell turns anything a native command
# writes to stderr into a terminating error, and npm writes ordinary
# deprecation warnings there. Every external call below checks $LASTEXITCODE
# instead, which is the only reliable success signal.
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "`nSETUP FAILED: $m" -ForegroundColor Red; exit 1 }

# --- Node ------------------------------------------------------------------
# --env-file, which every npm script here relies on, needs Node 20.6+; the
# code also uses syntax that is only stable from 22 on.
Step 'Checking Node.js'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Die "Node.js is not installed. Get Node 22 LTS from https://nodejs.org and re-run this script."
}
$nodeVersion = (node -v).TrimStart('v')
$major = [int]($nodeVersion.Split('.')[0])
if ($major -lt 22) {
  Die "Node $nodeVersion is too old - this project needs 22 or newer. Install Node 22 LTS from https://nodejs.org and re-run."
}
Ok "Node $nodeVersion"

# --- npm packages ----------------------------------------------------------
# npm ci installs the exact versions in package-lock.json, which is what makes
# this reproducible. It refuses to run if the lockfile is out of step with
# package.json, so fall back rather than leaving the machine with nothing.
Step 'Installing npm packages'
npm ci
if ($LASTEXITCODE -ne 0) {
  Warn 'npm ci did not work (lockfile out of step); using npm install'
  npm install
  if ($LASTEXITCODE -ne 0) { Die 'npm install failed. Check your internet connection.' }
}
Ok 'Packages installed'

# --- a browser for the login ----------------------------------------------
# login.mjs drives a real browser through Microsoft OAuth. playwright-core
# ships no browser of its own: normally it drives the installed Edge, and if
# there is none we download Chromium instead (~150MB, once).
Step 'Checking for a browser to drive'
# Single quotes inside the JS on purpose: Windows PowerShell mangles double
# quotes when it hands an argument to a native executable, so a probe written
# with them reaches node as import(playwright-core) and always fails.
$probe = "import('playwright-core').then(p => p.chromium.launch({ channel: 'msedge' })).then(b => b.close()).then(() => process.exit(0)).catch(() => process.exit(1))"
node -e $probe
if ($LASTEXITCODE -eq 0) {
  Ok 'Microsoft Edge works - nothing to download'
} else {
  Warn 'Edge not usable here; downloading Chromium instead (~150MB, one time)'
  npx playwright-core install chromium
  if ($LASTEXITCODE -ne 0) { Die 'Could not download Chromium. Check your internet connection.' }
  # Tell login.mjs to stop asking for Edge on this machine.
  if (Test-Path .env) {
    if (-not (Select-String -Path .env -Pattern '^PLAYWRIGHT_CHANNEL=' -Quiet)) {
      Add-Content .env "`nPLAYWRIGHT_CHANNEL="
      Ok 'Set PLAYWRIGHT_CHANNEL= in .env so Chromium is used'
    }
  } else {
    $script:needsChannel = $true
  }
  Ok 'Chromium installed'
}

# --- .env ------------------------------------------------------------------
Step 'Checking .env'
if (Test-Path .env) {
  Ok '.env already exists - leaving it alone'
} else {
  Copy-Item .env.example .env
  if ($script:needsChannel) { Add-Content .env "`nPLAYWRIGHT_CHANNEL=" }
  Warn '.env created from the template - you must fill it in'
}

# Report which required values are still blank, without printing any of them.
$missing = @()
foreach ($key in @('CUST_EMAIL', 'CUST_PASSWORD')) {
  $line = Select-String -Path .env -Pattern "^$key=(.*)$" | Select-Object -First 1
  if (-not $line -or [string]::IsNullOrWhiteSpace($line.Matches[0].Groups[1].Value)) { $missing += $key }
}

# --- what to do next -------------------------------------------------------
Write-Host "`n----------------------------------------------------------"
if ($missing.Count -gt 0) {
  Write-Host 'Setup is done, but credentials are missing.' -ForegroundColor Yellow
  Write-Host "Open .env and fill in: $($missing -join ', ')"
  Write-Host ''
}
Write-Host 'Then, in order:'
Write-Host '  npm run login     check the Microsoft login works here'
Write-Host '  npm run scrape    take the first snapshot'
Write-Host '  npm run pair      scan the QR code with WhatsApp'
Write-Host '  npm run dev       start the bot'
Write-Host ''
Write-Host 'Only run one bot at a time across all your machines -' -ForegroundColor Yellow
Write-Host 'two sharing one WhatsApp account break each other.' -ForegroundColor Yellow
Write-Host '----------------------------------------------------------'
