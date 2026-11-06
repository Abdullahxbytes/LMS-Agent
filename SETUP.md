# Setting up on the Linux Mint laptop

A full walkthrough, from a fresh Mint install to the bot answering messages.
Roughly 20 minutes, most of it downloads.

The short version is in [README.md](README.md); this is the long one, with
what each step is for and what to do when it goes wrong.

Before starting, stop the bot on the Windows machine. Two bots sharing one
WhatsApp account break each other's encryption — see
[Only one at a time](#only-one-bot-at-a-time).

---

## What you need

- The Linux Mint laptop, on the internet
- Your phone, with WhatsApp installed and working
- Your CUST Microsoft email and password
- A GitHub account with access to the repo (it is private)

---

## Step 1 — Install git and curl

Open a terminal (`Ctrl` + `Alt` + `T`) and run:

```sh
sudo apt update
sudo apt install -y git curl
```

It will ask for your Mint login password. Both are usually present already;
this just makes sure.

---

## Step 2 — Install Node 22

**Do not use `apt install nodejs`.** Mint's package is far too old — Mint 21
ships Node 12 and Mint 22 ships Node 18. This project needs Node 22 or newer:
most commands use Node's `--env-file` flag (which needs 20.6+), and the code
uses syntax that is only stable from 22 on. `setup.sh` refuses to continue on
anything below 22.

Use nvm, which installs Node under your home directory and needs no root.
**Run this on its own first:**

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
```

Then, as a **separate** paste:

```sh
source ~/.bashrc
nvm install 22
nvm alias default 22
```

The split matters. The installer only adds nvm to `~/.bashrc`; your current
shell will not know the `nvm` command until that file is re-read. Do not
replace `source ~/.bashrc` with `exec $SHELL` — that swaps out the running
shell, and any lines you pasted after it get thrown away with the old
process, leaving you with nvm installed and no Node.

The `alias default` line makes Node 22 the version every new terminal gets —
without it, opening a fresh terminal tomorrow would find no `node` at all.

Check it worked:

```sh
node -v
```

You want `v22.something` or higher. If you get "command not found", close the
terminal, open a new one, and try again.

---

## Step 3 — Get the code

The repo is **private**, so GitHub will ask who you are. The easiest way is
GitHub's own CLI:

```sh
sudo apt install -y gh
gh auth login
```

Choose **GitHub.com**, then **HTTPS**, then **Login with a web browser**. It
shows you an eight-character code; press Enter, paste the code into the
browser page that opens, and approve.

Then clone:

```sh
cd ~
gh repo clone Abdullahxbytes/LMS-Agent
cd LMS-Agent
```

If `gh` is not available on your Mint version, use a Personal Access Token
instead: create one at <https://github.com/settings/tokens> with the `repo`
scope, then

```sh
git clone https://github.com/Abdullahxbytes/LMS-Agent.git
```

and paste the token when it asks for a password. (Your GitHub account
password will not work — GitHub stopped accepting those for git.)

---

## Step 4 — Run the setup script

```sh
bash setup.sh
```

This does four things:

1. Checks Node is 22+
2. Installs the npm packages at the exact versions in `package-lock.json`
3. Downloads Chromium for the Microsoft login (~190MB, once)
4. Creates `.env` from the template

**You will see this, and it is not an error:**

```
BEWARE: your OS is not officially supported by Playwright;
downloading fallback build for ubuntu24.04-x64
```

Playwright has no Mint-labelled build, so it uses the matching Ubuntu one.
**On Mint 21 that line says `ubuntu22.04-x64` instead** — both are correct;
Playwright maps Mint 21 to ubuntu22.04 and Mint 22+ to ubuntu24.04.

It may ask for your password when installing system libraries for Chromium.
If that part fails it only warns; the browser still works on a normal Mint
desktop.

The script finishes by telling you what is still missing.

---

## Step 5 — Fill in your credentials

```sh
nano .env
```

Set these two lines:

```
CUST_EMAIL=your.email@cust.edu.pk
CUST_PASSWORD=your-password
```

Save with `Ctrl` + `O`, Enter, then `Ctrl` + `X`.

Leave `CUST_SESSION` and `PAIR_NUMBER` empty — the first is obtained
automatically by logging in, the second is only for pairing by code instead
of by QR.

Leave the `PLAYWRIGHT_CHANNEL=` line exactly as the script wrote it. Empty is
correct on Linux: it means "use the Chromium you just downloaded" rather than
looking for Microsoft Edge, which does not exist here.

`.env` is listed in `.gitignore`, so your password cannot be committed by
accident.

---

## Step 6 — Test the portal login

```sh
npm run login
```

This opens Chromium invisibly, signs into `odoo.cust.edu.pk` through
Microsoft with the credentials you just entered, and stores the resulting
session cookie in `out/session.json`.

Success looks like:

```
opening the portal login page
entering email
entering password
cookie: facd7720... accepted=true
stored in out/session.json
```

`accepted=true` is the part that matters — it means the portal accepted the
cookie, not merely that one was issued.

If it fails, see [Troubleshooting](#troubleshooting) below.

---

## Step 7 — Take the first snapshot

```sh
npm run scrape
```

This reads every course page and saves `out/snapshot.json`. It takes about a
minute and prints one line per course.

This first snapshot is a **baseline** — nothing is compared against it, so
nothing is announced. Changes are only reported from the second scrape on.

---

## Step 8 — Link WhatsApp

```sh
npm run pair
```

A QR code appears in the terminal. On your phone:

**WhatsApp → Settings → Linked devices → Link a device**

Point it at the terminal. If several QR codes have scrolled past, scan the
**lowest** one — they refresh roughly every 20 seconds.

When it works you get a test message in your own WhatsApp chat and the
terminal says `Paired.`

This pairing lives in `auth_info/` and is specific to this laptop. It cannot
be copied from the Windows machine — WhatsApp issues one set of encryption
keys per linked device, and sharing them corrupts both.

---

## Step 9 — Start the bot

```sh
npm run dev
```

You should see:

```
connecting (initial), linked=true
tick every 5m, full scrape every 45m
accepting commands from: ...
-> CUST portal agent is online. Send "help" for commands.
```

Message yourself `help` on WhatsApp. You should get the command list back
within a second or two.

Try `attendance`, `today`, `due`, `marks PDC`.

`Ctrl` + `C` stops it.

---

## Step 10 — Keep it running after you close the terminal

`npm run dev` dies when the terminal closes. For a trial run, `screen` is the
simplest fix:

```sh
sudo apt install -y screen
screen -S lms
npm run dev
```

Press `Ctrl` + `A` then `D` to detach — the bot keeps running. To come back:

```sh
screen -r lms
```

Also stop the laptop from sleeping, or it stops scraping when the lid closes:
**Menu → Power Management → set "When the lid is closed" to "Do nothing"**,
and set blank-screen/suspend to Never while on mains power.

---

## Only one bot at a time

This matters more than it sounds. Two bots signed into the same WhatsApp
account get one of them disconnected (code 440), and because both keep
writing encryption keys, afterwards **neither** can decrypt messages. On your
phone that shows up as "Waiting for this message".

`out/bot.lock` prevents two on the same machine, but it cannot see across
laptops. So: stop the Windows one before starting the Mint one.

---

## Troubleshooting

**`npm run login` says `accepted=false`**
Usually a wrong password. Run `npm run login -- --show` to watch the browser
and see what Microsoft is actually saying. Note that automatic login needs an
account without two-factor authentication.

**`npm run login` fails with a missing `.so` library**
The Chromium system libraries did not install. Run:

```sh
sudo env "PATH=$PATH" npx playwright-core install-deps chromium
```

The `env "PATH=$PATH"` part is not decoration. Because Node was installed
with nvm it lives under your home directory, and `sudo` throws that away and
uses a fixed system PATH — so a plain `sudo npx ...` fails with
`sudo: npx: command not found`. Re-running `bash setup.sh` also works.

**`npm run scrape` exits saying the session expired**
Run `npm run login` again. The bot normally does this by itself.

**No QR code appears, and it says the credentials already exist**
The stored pairing is stale. Clear it and start over:
```sh
npm run pair -- --reset
```

**"Another bot is already running"**
A previous run did not shut down cleanly:
```sh
pkill -f bot.mjs
rm -f out/bot.lock
```

**The phone shows "Waiting for this message"**
Two instances have corrupted the pairing. Unlink the device on your phone,
then:
```sh
rm -rf auth_info
npm run pair
```

**`node: command not found`**
If it is a brand-new terminal, nvm was not made the default — run
`nvm alias default 22` and open another one. If it is the same terminal you
installed nvm in, you skipped `source ~/.bashrc`; run that first. If `nvm`
itself is not found either, the install did not finish — re-run the curl
line from Step 2.

---

## Things you do not need to do

**You do not need to set the laptop's timezone.** All scheduling is pinned to
`Asia/Karachi` in the code, so class times and deadlines are right even if
the system clock is on another zone.

**You do not need to copy anything from the Windows machine.** The portal
data re-scrapes itself and the WhatsApp pairing has to be made fresh here.
The one exception is continuity: the Mint laptop's first scrape becomes its
baseline, so anything that changed on the portal between the last Windows run
and this first one is not announced. If that matters, copy `out/snapshot.json`
and `out/state.json` across by USB — never through git, since `state.json`
also records which deadline reminders you have already dismissed.

---

## Checking the attendance schedule

To see exactly when the bot will check attendance on a given day, without
touching the network:

```sh
npm run schedule           # today
node schedule.mjs Monday   # any named day
```

It replays the real timetable and prints each portal wake-up.
