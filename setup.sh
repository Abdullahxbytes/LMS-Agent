#!/usr/bin/env bash
# One-shot setup for a new Linux or macOS machine.
#
#   bash setup.sh
#
# Installs the npm packages, makes sure a browser exists for the Microsoft
# login, and creates .env from the template. It does NOT install Node itself
# and it does NOT fill in your credentials - both are reported if missing.

set -euo pipefail
cd "$(dirname "$0")"

step() { printf '\n==> %s\n' "$1"; }
ok()   { printf '    %s\n' "$1"; }
warn() { printf '    %s\n' "$1"; }
die()  { printf '\nSETUP FAILED: %s\n' "$1" >&2; exit 1; }

# --- Node ------------------------------------------------------------------
# --env-file, which every npm script here relies on, needs Node 20.6+; the
# code also uses syntax that is only stable from 22 on.
step 'Checking Node.js'
command -v node >/dev/null 2>&1 \
  || die 'Node.js is not installed. Install Node 22 LTS (https://nodejs.org) and re-run.'
node_version=$(node -v); node_version=${node_version#v}
if [ "${node_version%%.*}" -lt 22 ]; then
  die "Node $node_version is too old - this project needs 22 or newer."
fi
ok "Node $node_version"

# --- npm packages ----------------------------------------------------------
# npm ci installs the exact versions in package-lock.json, which is what makes
# this reproducible. It refuses to run if the lockfile is out of step with
# package.json, so fall back rather than leaving the machine with nothing.
step 'Installing npm packages'
if ! npm ci >/dev/null 2>&1; then
  warn 'npm ci did not work (lockfile out of step); using npm install'
  npm install || die 'npm install failed. Check your internet connection.'
fi
ok 'Packages installed'

# --- a browser for the login ----------------------------------------------
# login.mjs drives a real browser through Microsoft OAuth. playwright-core
# ships no browser of its own, and a Linux box has no Edge, so download
# Chromium (~150MB, once). --with-deps pulls the shared libraries headless
# Chromium needs, which a bare server image will not already have.
step 'Installing a browser for the login'
if [ "$(uname -s)" = "Linux" ] && [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
  npx playwright-core install --with-deps chromium \
    || die 'Could not install Chromium. Check your internet connection.'
else
  npx playwright-core install chromium \
    || die 'Could not install Chromium. Check your internet connection.'
fi
ok 'Chromium installed'

# --- .env ------------------------------------------------------------------
step 'Checking .env'
if [ -f .env ]; then
  ok '.env already exists - leaving it alone'
else
  cp .env.example .env
  warn '.env created from the template - you must fill it in'
fi

# There is no Edge on Linux, so make sure login.mjs uses the Chromium we just
# installed rather than looking for a channel that is not there.
if ! grep -q '^PLAYWRIGHT_CHANNEL=' .env; then
  printf '\nPLAYWRIGHT_CHANNEL=\n' >> .env
  ok 'Set PLAYWRIGHT_CHANNEL= in .env so Chromium is used'
fi

# Report which required values are still blank, without printing any of them.
missing=()
for key in CUST_EMAIL CUST_PASSWORD; do
  value=$(grep -E "^$key=" .env | head -1 | cut -d= -f2- || true)
  [ -z "${value// /}" ] && missing+=("$key")
done

# --- what to do next -------------------------------------------------------
printf '\n----------------------------------------------------------\n'
if [ ${#missing[@]} -gt 0 ]; then
  printf 'Setup is done, but credentials are missing.\n'
  printf 'Open .env and fill in: %s\n\n' "$(IFS=', '; echo "${missing[*]}")"
fi
cat <<'NEXT'
Then, in order:
  npm run login     check the Microsoft login works here
  npm run scrape    take the first snapshot
  npm run pair      scan the QR code with WhatsApp
  npm run dev       start the bot

Only run one bot at a time across all your machines -
two sharing one WhatsApp account break each other.
NEXT
printf -- '----------------------------------------------------------\n'
