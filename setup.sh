#!/usr/bin/env bash
# One-shot setup for a new Linux or macOS machine. Tested against Linux Mint.
#
#   bash setup.sh
#
# Installs the npm packages, downloads a browser for the Microsoft login, and
# creates .env from the template. It does NOT install Node itself and it does
# NOT fill in your credentials - both are reported if missing.

set -euo pipefail
cd "$(dirname "$0")"

step() { printf '\n==> %s\n' "$1"; }
ok()   { printf '    %s\n' "$1"; }
warn() { printf '    %s\n' "$1"; }
die()  { printf '\nSETUP FAILED: %s\n' "$1" >&2; exit 1; }

# --- which machine is this -------------------------------------------------
step 'Checking the system'
distro='unknown'
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  distro="$(. /etc/os-release && printf '%s %s' "${NAME:-?}" "${VERSION_ID:-}")"
fi
ok "$distro ($(uname -m))"

# --- Node ------------------------------------------------------------------
# Every npm script here uses --env-file, which needs Node 20.6+; the code also
# relies on syntax only stable from 22 on.
#
# Mint's apt repository carries a much older Node than this needs (Mint 21
# ships 12.x, Mint 22 ships 18.x), so `apt install nodejs` is not enough and
# the advice below deliberately points elsewhere.
step 'Checking Node.js'
if ! command -v node >/dev/null 2>&1; then
  die "Node.js is not installed.

On Linux Mint, do NOT use 'apt install nodejs' - its version is too old.
Use nvm, which needs no root:

  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  exec \$SHELL
  nvm install 22

Then re-run this script."
fi

node_version=$(node -v); node_version=${node_version#v}
if [ "${node_version%%.*}" -lt 22 ]; then
  die "Node $node_version is too old - this project needs 22 or newer.

On Linux Mint, apt's nodejs package will not be new enough. Use nvm:

  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  exec \$SHELL
  nvm install 22

Then re-run this script."
fi
ok "Node $node_version"
command -v npm >/dev/null 2>&1 || die 'npm is missing even though node is present. Reinstall Node.'

# --- npm packages ----------------------------------------------------------
# npm ci installs the exact versions in package-lock.json, which is what makes
# this reproducible. It refuses to run when the lockfile is out of step with
# package.json, so fall back rather than leaving the machine with nothing.
step 'Installing npm packages'
if ! npm ci; then
  warn 'npm ci did not work (lockfile out of step); using npm install'
  npm install || die 'npm install failed. Check your internet connection.'
fi
ok 'Packages installed'

# --- the browser -----------------------------------------------------------
# login.mjs drives a real browser through Microsoft OAuth. playwright-core
# ships no browser of its own and Linux has no Edge, so Chromium is
# downloaded (~190MB, once).
#
# Playwright knows Linux Mint and maps it onto the matching Ubuntu build
# (Mint 21 -> ubuntu22.04, Mint 22+ -> ubuntu24.04). It prints "your OS is not
# officially supported ... downloading fallback build" while doing so, which
# is expected here and not an error.
step 'Downloading Chromium for the login'
npx playwright-core install chromium \
  || die 'Could not download Chromium. Check your internet connection.'
ok 'Chromium installed'

# Headless Chromium needs shared libraries that a desktop install mostly has
# but a minimal one does not. This is a separate step on purpose: it needs
# root, it can fail for reasons that have nothing to do with us (an apt lock,
# no sudo rights), and the browser is already usable without it on a normal
# Mint desktop. So a failure here is a warning, not the end of the run.
step 'Checking system libraries for headless Chromium'
if [ "$(uname -s)" != "Linux" ]; then
  ok 'Not Linux - nothing to do'
elif npx playwright-core install-deps chromium; then
  ok 'System libraries are in place'
else
  warn 'Could not install the system libraries automatically.'
  warn 'This is usually fine on a Mint desktop. If "npm run login" later'
  warn 'fails with a missing .so file, run this yourself:'
  # PATH is passed through on purpose: a Node installed by nvm lives under the
  # user's home directory, and sudo replaces PATH with a fixed system one, so
  # a plain "sudo npx" fails with "npx: command not found".
  warn '    sudo env "PATH=$PATH" npx playwright-core install-deps chromium'
fi

# --- .env ------------------------------------------------------------------
step 'Checking .env'
if [ -f .env ]; then
  ok '.env already exists - leaving it alone'
else
  cp .env.example .env
  warn '.env created from the template - you must fill it in'
fi

# There is no Edge on Linux, so point login.mjs at the Chromium just
# installed rather than at a channel that is not there.
if grep -q '^PLAYWRIGHT_CHANNEL=' .env; then
  ok 'PLAYWRIGHT_CHANNEL already set'
else
  printf '\n# No Edge on Linux - empty means use the bundled Chromium.\nPLAYWRIGHT_CHANNEL=\n' >> .env
  ok 'Set PLAYWRIGHT_CHANNEL= in .env so Chromium is used'
fi

# Report which required values are still blank, without printing any of them.
missing=()
for key in CUST_EMAIL CUST_PASSWORD; do
  value=$(grep -E "^$key=" .env | head -1 | cut -d= -f2- || true)
  if [ -z "${value//[[:space:]]/}" ]; then
    missing+=("$key")
  fi
done

# --- what to do next -------------------------------------------------------
printf '\n----------------------------------------------------------\n'
if [ "${#missing[@]}" -gt 0 ]; then
  printf 'Setup is done, but credentials are missing.\n'
  printf 'Open .env and fill in: %s\n\n' "$(IFS=,; printf '%s' "${missing[*]}")"
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
