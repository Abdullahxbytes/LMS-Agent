# CUST Portal Agent

Watches the CUST student portal and reports changes. Built to notify over
WhatsApp and answer questions about marks, deadlines and materials.

Portal: Odoo 15, `https://odoo.cust.edu.pk`, database `cust_production`.
The student area is a custom module (`odoocms_student_portal`, by AARSOL),
server-rendered with QWeb.

## Setting up on a new machine

**[SETUP.md](SETUP.md) is the step-by-step walkthrough**, written for Linux
Mint. What follows is the short version.

Three things deliberately do **not** travel through git: `.env` (credentials),
`auth_info/` (the WhatsApp pairing) and `out/` (scraped academic data).

```sh
git clone https://github.com/Abdullahxbytes/LMS-Agent.git
cd LMS-Agent

bash setup.sh                                        # Linux / macOS
powershell -ExecutionPolicy Bypass -File setup.ps1   # Windows
```

**On Linux Mint, install Node first.** Mint's apt package is far too old
(Mint 21 ships Node 12, Mint 22 ships Node 18; this needs 22+), so
`apt install nodejs` will not do. Use nvm, which needs no root:

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
```

Then, as a separate paste (not `exec $SHELL`, which discards anything pasted
after it):

```sh
source ~/.bashrc
nvm install 22
nvm alias default 22
```

While downloading Chromium, Playwright prints *"your OS is not officially
supported ... downloading fallback build"*. That is expected on Mint and is
not an error - Playwright maps Mint onto the matching Ubuntu build (Mint 21
to ubuntu22.04, Mint 22+ to ubuntu24.04).

The setup script installs the npm packages at their locked versions, makes
sure there is a browser for the Microsoft login (it drives an installed Edge
where there is one, and downloads Chromium where there is not), and creates
`.env` from the template. It will not overwrite an existing `.env`, and it
reports which values are still blank without printing any of them.

It does **not** install Node - that has to be Node 22 or newer, from
<https://nodejs.org>, because every script here uses `--env-file`.

Then fill in `CUST_EMAIL` and `CUST_PASSWORD` in `.env`, and:

```sh
npm run login            # verifies the Microsoft login works
npm run scrape           # first snapshot; nothing is diffed against it
npm run pair             # scan the QR with WhatsApp
npm run dev              # start the bot
```

`npm run pair` must be run again on each machine. The pairing is tied to a
device and cannot be copied across: WhatsApp issues one set of Signal keys per
linked device, and sharing `auth_info/` between two machines corrupts the key
store on both.

**Only one instance may run at a time.** Two bots sharing the same WhatsApp
identity get one of them kicked off (disconnect 440) and leave both unable to
decrypt messages - on the phone that shows up as "Waiting for this message".
`out/bot.lock` guards against this on a single machine, but it cannot see
another laptop, so stop the bot here before starting it there.

Needs Node 22+ (for `--env-file`) and either Microsoft Edge installed or
`PLAYWRIGHT_CHANNEL=` set with Chromium available for the login browser.

## Authentication

Student accounts sign in through Microsoft OAuth and have **no usable local
Odoo password**, so form login against `/web/login` always fails. The portal
is authenticated with an Odoo `session_id` cookie, obtained automatically.

`login.mjs` drives a headless browser through the real OAuth flow:

    /web/login -> login.microsoftonline.com -> email -> password
               -> /auth_oauth/microsoft/signin -> session_id

Set `CUST_EMAIL` and `CUST_PASSWORD` in `.env` and run `npm run login`. The
cookie is stored in `out/session.json`, which takes precedence over
`CUST_SESSION`. The bot calls this by itself whenever a scrape reports an
expired session, so normally there is nothing to do.

Two findings that cost real debugging time:

- Odoo hands a `session_id` to **anonymous** visitors as soon as `/web/login`
  loads. Finding a cookie proves nothing; it has to be tested against the
  portal. `checkSession()` does that.
- The OAuth callback sets `session_id` **twice** in one response. Playwright's
  `response.headers()` collapses repeated headers and the real cookie is lost;
  `response.headersArray()` keeps both. Without this the login appears to
  succeed and then fails verification.

The browser is only needed for login, not for scraping. Locally it drives the
installed Edge via `playwright-core` (no browser download). On a Linux host,
set `PLAYWRIGHT_CHANNEL=` (empty) and run `npx playwright install chromium`.

`cookie <value>` remains as a manual fallback, and `CUST_SESSION` in `.env`
still works if `out/session.json` is absent.

The tenant is **Managed** (`12b221b3-0464-4223-89e5-888835778b58`), so Azure AD
checks the password directly with no ADFS hop. If MFA is ever enabled, the
login detects the prompt and reports it rather than hanging.

Direct model access via `/web/dataset/call_kw` is **denied** for student
accounts, so data comes from parsing rendered HTML.

## Routes

Per course, where `<id>` is the opaque course id from `/student/enrolled/courses`:

| Route | Contents |
| --- | --- |
| `/student/course/gradebook/<id>` | per-assessment marks, max, **class average** |
| `/student/course/assessment/<id>` | assessments with date and due date |
| `/student/course/submission/<id>` | submissions with start and due date |
| `/student/course/material/<id>` | uploaded course materials |
| `/student/course/info/<id>` | course announcements / news |
| `/student/course/attendance/<id>` | per-lecture attendance |
| `/student/course/outline/<id>` | syllabus (static; not polled) |

Global: `/student/results` (transcript, SGPA/CGPA, PLO attainment),
`/student/exam/datesheet`, `/student/notifications`, `/student/attendance`,
`/student/class/schedule`, `/student/transcript`, `/student/invoices`,
`/student/profile`.

Pluralised variants (`/materials/`, `/assessments/`) return 404.

## Gradebook shape

One flat table alternating widths, which is why it needs a dedicated parser:

- 2 columns: a category row, e.g. `Quiz 15.0 %` / `55.00`
- 5 columns: that category's items, e.g. `Quiz 1 | 10.0 | 8.00 | 7.11 | 80.00`
  (name, max mark, obtained, class average, percent)

## Dates

Portal timestamps carry no timezone and are Pakistan time (UTC+5). `diff.mjs`
parses them with an explicit `+05:00` offset — parsing naively would shift every
deadline by 5 hours once deployed on a UTC host.

## Files

| File | Purpose |
| --- | --- |
| `scrape.mjs` | fetches all pages, writes `out/snapshot.json` |
| `diff.mjs` | compares two snapshots into notification events; deadline look-ahead |
| `timetable.mjs` | parses the weekly class timetable with exact slot times |
| `attendance.mjs` | per-slot attendance watcher (absence alerts) |
| `invoices.mjs` | unpaid challan alerts and due-date reminders |
| `deadlines.mjs` | submission/assessment reminders at 5h, 3h, 1h; "done" suppression |
| `whatsapp.mjs` | Baileys transport; pairs with your own WhatsApp account |
| `commands.mjs` | inbound chat commands, answered from the stored snapshot |
| `portal.mjs` | authenticated fetch for live lookups between scrapes |
| `bot.mjs` | orchestrator: schedules everything, holds the connection |
| `probe-session.mjs` | verifies a session cookie and lists available routes |
| `dryrun.mjs` | replays a past class slot against live data, no WhatsApp |

## Usage

```bash
npm install
node --env-file=.env probe-session.mjs      # check the cookie works
node --env-file=.env scrape.mjs             # write out/snapshot.json
node diff.mjs out/previous.json out/snapshot.json
```

`out/` holds personal academic data and is gitignored, as is `.env`.

## Notes

A full scrape is ~70 requests of roughly 1 MB each (the pages inline their CSS
and fonts). Poll every 1-2 hours rather than every few minutes.

## Attendance watching

The timetable lives at `/student/class/schedule`, rendered with the CodyHouse
schedule component: each class is an anchor carrying `data-start` and
`data-end`. Classes are 50 minutes and slots sit about an hour apart.

Teachers normally mark attendance in the first 10-15 minutes, so each slot is
checked at **start + 20 min**. Some mark it mid-class or at the end, so a slot
still unmarked is checked again at **start + 80 min**. Because slots are an hour
apart, each scan naturally doubles as the second look at the previous slot.

**Only a status other than `Present` is reported.** The portal uses
**`Leave`** as well as `Absent`, and *Leave still counts against the
attendance percentage* - 9 Present + 1 Leave out of 10 shows as 90%.
Matching only on "Absent" silently misses these.

A slot a teacher never marks leaves everyone **Present**, so an unmarked
slot is not reported. It is still re-checked on the second pass, because
attendance marked late may turn out to be an absence.

Per-course totals are read from the page's own "Number of classes
Conducted / Attended / Attendance Percentage" line rather than recomputed
from rows, so the figures always agree with the portal.

Labs occupy three consecutive slots and each is attended separately, producing
three attendance rows for that date. Rows appear in slot order, so slot *n* of a
course on a given day maps to the *n*-th row for that date - this is what
`slotIndex` tracks.

State is keyed `date|code|slotIndex` so nothing is reported twice across runs.

## Invoices

`/student/invoices` lists challans. An issued-but-unpaid challan has status
**`Draft`**, not "Unpaid" - `invoices.mjs` treats anything other than `Paid`
as outstanding. Alerts fire on a newly issued unpaid challan, and reminders at
7, 3, 1 and 0 days before the due date, then daily once overdue.

## Deadline reminders

Submissions and assessments carry a `Due Date`. Each item is reminded at
**5h, 3h and 1h** before it is due, once per window. An item discovered
inside a window does not fire the earlier ones retroactively.

Replying **`done`** marks the most recently reminded item finished and stops
its reminders. `done <text>` targets a specific item, and asks which one if
the text matches more than one.

## Running the bot

```bash
npm run dev      # local: reads .env
npm start        # deployed: reads real environment variables
```

### Pairing

Baileys is pinned to **6.7.24**, the stable line. npm's `latest` tag points
at `7.0.0-rc14`, a release candidate whose pairing is unreliable.

Pair with the dedicated tool, not the bot - it keeps pairing problems
separate from portal logs:

```bash
npm run pair           # QR code (recommended)
npm run pair -- --code # 8-character pairing code instead
```

**QR** is the more reliable of the two. Scan the *lowest* code in the
terminal: they refresh every ~20 seconds and earlier ones are dead.

**Pairing code** needs `PAIR_NUMBER` in `.env`, in full international form
with no `+` or spaces (e.g. `923001234567`). The code expires in about a
minute, so have WhatsApp open at **Linked Devices -> Link a Device -> Link
with phone number** *before* you run it.

A rejected pairing leaves an unregistered `creds.json` behind, and every
later run then fails instantly with a 401 before showing anything. Both
`pair.mjs` and the transport clear that automatically now.
Pairing is saved in `auth_info/` and survives restarts.

### If pairing fails

Right after a successful scan WhatsApp closes the socket with code **515
(`restartRequired`)**. This is normal: the credentials are already saved and
the socket just has to be rebuilt. Treating it as a failure and showing a
fresh QR makes pairing look like it never worked - the symptom is scanning
once, being asked to set a screen lock, and landing back on a scanner that
will not read anything.

If it still fails, check that `auth_info/` contains a `creds.json` after the
first scan. An empty `auth_info/` means nothing was ever persisted; delete
the directory and pair again, preferably with a pairing code.

Messages go to your own WhatsApp chat, so no second number is needed. The
bot tracks the ids of messages it sends so it does not reply to itself.

One process holds the connection and runs every schedule: a tick every
5 minutes drives attendance checks and deadline reminders, a full scrape
runs every 2 hours, and invoice reminders go out once a day after 09:00.
`scrape.mjs` runs as a child process so a failure cannot take the bot down.

### Commands

Send these as ordinary WhatsApp messages in your own chat (the one the bot
messaged you from).

| Command | What it does |
| --- | --- |
| `help` | list the commands |
| `marks [course]` | marks with class averages; filter by code or name |
| `attendance` | percentage per course, flags anything under 75% |
| `due` | upcoming submission and assessment deadlines |
| `today` / `tomorrow` | class schedule for that day |
| `exams` | final exam datesheet |
| `fees` | unpaid challans |
| `done [item]` | stop reminders for a deadline |
| `cookie <value>` | replace the portal session id |
| `refresh` | re-scrape the portal now |

### Course names

Courses can be given as a short form, a name, a partial name or a code -
`marks PDC`, `marks parallel`, `marks CS3432` all work. Short forms are
derived from the title rather than hardcoded, so a new semester needs no
changes: initials of the significant words, with `Lab` kept as a suffix
(`Parallel and Distributed Computing Lab` -> `PDC Lab`).

A query of three characters or fewer must start a word or match a short form,
because plain substring matching made `nc` match `Intellige(nc)e`.

Timetables show the short form only; everything else leads with the name.

### Replacing the session from your phone

When the portal session dies the bot messages you. Copy a fresh
`session_id` from a browser and send `cookie <value>`. It is checked
against the portal before being saved, so a bad paste is rejected rather
than silently breaking every later poll.

The value is stored in `out/session.json`, which takes precedence over
`CUST_SESSION` and survives restarts. That file holds a live credential;
`out/` is gitignored.

## Still to build

- Persistent snapshot storage (Supabase) instead of local files
- Hosting on a Render background worker (~$7/month)
