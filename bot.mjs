// Orchestrator: polls the portal, reports what changed, answers questions.
//
// One process holds the WhatsApp connection and runs every schedule, so a
// single Render background worker is enough.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';

import { connectWhatsApp, muteSignalNoise } from './whatsapp.mjs';
import { refreshSession } from './login.mjs';
import { handleCommand } from './commands.mjs';
import { diffSnapshots } from './diff.mjs';
import { diffInvoices, invoiceReminders } from './invoices.mjs';
import { deadlineReminders } from './deadlines.mjs';
import { runAttendancePass, pkNow, dueChecks } from './attendance.mjs';
import { attendanceRows, SessionExpired } from './portal.mjs';
import { briefingText } from './briefing.mjs';

const SNAP = 'out/snapshot.json';
const LOCK = 'out/bot.lock';

// Two instances sharing auth_info/ corrupt the Signal key store: WhatsApp
// kicks one off (disconnect 440), both keep writing, and afterwards neither
// side can decrypt the other's messages - which shows up on the phone as
// "Waiting for this message". A lock file is cheap insurance.
function takeLock() {
  mkdirSync('out', { recursive: true });
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, 'utf8').trim());
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    if (alive && pid !== process.pid) {
      console.error('Another bot is already running (pid ' + pid + ').');
      console.error('Stop it first - two instances break the WhatsApp pairing.');
      process.exit(1);
    }
  }
  writeFileSync(LOCK, String(process.pid));
  const release = () => { try { rmSync(LOCK, { force: true }); } catch { /* already gone */ } };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { release(); process.exit(0); });
  }
}
takeLock();

const STATE = 'out/state.json';
const TICK_MINUTES = Number(process.env.TICK_MINUTES ?? 5);
const SCRAPE_EVERY_MINUTES = Number(process.env.SCRAPE_EVERY_MINUTES ?? 45);
const INVOICE_HOUR = 9;

// The periodic scrape only runs during waking hours. Nothing is posted to the
// portal at 4am, so polling it then is pure load for no news - this cuts the
// daily request count by about a third. Pakistan time, and the window wraps
// past midnight.
//
// This bounds only the scheduled scrape. Attendance checks around a class, the
// deadline reminders and anything typed in chat are unaffected.
const ACTIVE_FROM = process.env.ACTIVE_FROM ?? '07:00';
const ACTIVE_UNTIL = process.env.ACTIVE_UNTIL ?? '00:30';

// Morning briefing, Pakistan time. "off" disables it. It goes out on the
// first tick after this time, which falls after the 07:00 scrape, and not at
// all if the bot only comes up hours later - a briefing at 2pm is just noise.
const BRIEFING_AT = process.env.BRIEFING_AT ?? '07:30';
const BRIEFING_LATEST_HOURS = 4;

const hhmm = (value) => {
  const [h, m] = String(value).split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
};

export function withinActiveHours(now) {
  const from = hhmm(ACTIVE_FROM);
  const until = hhmm(ACTIVE_UNTIL);
  // A window ending after midnight (07:00 -> 00:30) is the normal case here,
  // so "inside" means either side of the wrap rather than between the two.
  return from <= until
    ? now.minutes >= from && now.minutes < until
    : now.minutes >= from || now.minutes < until;
}

const log = (...a) => console.log(new Date().toISOString(), ...a);
const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);

mkdirSync('out', { recursive: true });

let state = readJson(STATE, { attendance: {}, deadlines: {}, invoiceDays: {}, lastScrapeAt: 0 });
state.briefingDays ??= {};
let snapshot = readJson(SNAP, { courses: [], global: {}, timetable: [] });
const saveState = () => writeFileSync(STATE, JSON.stringify(state, null, 2));

let send = async (t) => log('[not connected]', t);
let sendDocument = async () => { throw new Error('WhatsApp not connected yet'); };
let connected = false;
const NL = String.fromCharCode(10);
const OUTBOX = 'out/outbox.json';
// Alerts can fire while WhatsApp is disconnected - a revoked pairing, a
// network drop, a restart. Keeping the queue only in memory lost them,
// while the state file had already recorded them as delivered, so they were
// never generated again. On disk they survive until they are really sent.
const outbox = readJson(OUTBOX, []);
const saveOutbox = () => writeFileSync(OUTBOX, JSON.stringify(outbox, null, 2));
const notify = async (text) => { outbox.push(text); saveOutbox(); };

// One drain at a time. The tick, a chat refresh and onReady can all flush at
// once, and two loops both sending outbox[0] and then both shifting would
// deliver one message twice and drop the next one unsent. A caller arriving
// mid-drain just waits for it: the loop reads the live queue, so anything
// queued meanwhile goes out in the same drain.
let flushInFlight = null;
function flushOutbox() {
  if (!flushInFlight) {
    flushInFlight = drainOutbox().finally(() => { flushInFlight = null; });
  }
  return flushInFlight;
}

async function drainOutbox() {
  // The first tick runs before WhatsApp finishes connecting. Draining into
  // the placeholder sender would log each message and drop it; leave them
  // queued and onReady will flush as soon as the socket is up.
  if (!connected) return;

  while (outbox.length) {
    const text = outbox[0];
    try {
      await send(text);
    } catch (e) {
      // Keep it at the head of the queue and try again on the next tick.
      log('send failed, still queued:', e.message);
      return;
    }
    outbox.shift();
    saveOutbox();
    await new Promise((r) => setTimeout(r, 800)); // avoid a burst of messages
  }
}

// scrape.mjs runs as a child so a crash or an expired session cannot take the
// bot down with it; exit code 2 means the cookie needs replacing.
function runScrape() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scrape.mjs'], {
      env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ ok: code === 0, expired: code === 2, err }));
  });
}

// touchCycle=false scrapes without restarting the periodic clock. A refresh
// asked for from chat should hand back fresh data without silently pushing the
// next scheduled scrape 45 minutes into the future.
//
// Only one scrape runs at a time. Two overlapping ones both diffed against the
// same previous snapshot and announced every change twice; a hung portal let
// them pile up one per tick. A request arriving mid-scrape joins it and gets
// its result. The clock is reset only by a caller that asked for it and only
// when the scrape succeeded, so a chat refresh joined by the scheduled cycle
// still counts as that cycle's scrape.
let syncInFlight = null;

async function fullSync({ announce = true, touchCycle = true } = {}) {
  if (syncInFlight) {
    log('scrape already running - joining it');
  } else {
    syncInFlight = doFullSync({ announce }).finally(() => { syncInFlight = null; });
  }
  const { ok, message } = await syncInFlight;
  if (ok && touchCycle) {
    state.lastScrapeAt = Date.now();
    saveState();
  }
  return message;
}

async function doFullSync({ announce }) {
  log('scraping...');
  const result = await runScrape();

  if (result.expired) {
    // Log in again rather than asking for a cookie by hand. Only one attempt:
    // if the credentials are wrong, retrying would risk locking the account.
    log('session expired - logging in again');
    try {
      await refreshSession({ log });
    } catch (e) {
      await notify('*Session expired and automatic login failed.*' + NL + e.message
        + NL + NL + 'Send: cookie <value>   with a fresh session id to carry on.');
      return { ok: false, message: 'Session expired; automatic login failed: ' + e.message };
    }

    const retry = await runScrape();
    if (!retry.ok) {
      await notify('*Logged in again, but the scrape still failed.*');
      return { ok: false, message: 'Logged in, but the scrape failed.' };
    }
    log('recovered with a fresh session');
    result.ok = true;
  }
  if (!result.ok) {
    log('scrape failed:', result.err.slice(0, 300));
    return { ok: false, message: 'Scrape failed.' };
  }

  const previous = snapshot;
  snapshot = readJson(SNAP, snapshot);

  if (announce && (previous.courses ?? []).length) {
    const events = [...diffSnapshots(previous, snapshot), ...diffInvoices(previous, snapshot)];
    for (const e of events) await notify(e.text);
    log(`diff produced ${events.length} event(s)`);
    saveState();
    return { ok: true, message: `Synced. ${events.length} change(s).` };
  }

  saveState();
  return { ok: true, message: 'Synced.' };
}

async function attendanceTick() {
  const now = pkNow();
  if (!dueChecks(snapshot.timetable ?? [], now).length) return;

  const byCode = new Map((snapshot.courses ?? []).map((c) => [c.code, c]));
  const { events, state: next } = await runAttendancePass({
    timetable: snapshot.timetable ?? [],
    now,
    state: state.attendance,
    fetchAttendance: async (code) => {
      const course = byCode.get(code);
      return course ? attendanceRows(course.id) : [];
    },
  });

  state.attendance = next;
  for (const e of events) await notify(e.text);
  if (events.length) log(`attendance: ${events.length} alert(s)`);
}

async function deadlineTick() {
  const { events, state: next } = deadlineReminders(snapshot, new Date(), state.deadlines);
  state.deadlines = next;
  for (const e of events) await notify(e.text);
}

async function invoiceTick() {
  const now = pkNow();
  if (now.minutes < INVOICE_HOUR * 60 || state.invoiceDays[now.date]) return;
  state.invoiceDays[now.date] = true;
  for (const r of invoiceReminders(snapshot, now.date)) await notify(r.text);
}

async function briefingTick() {
  if (/^off$/i.test(BRIEFING_AT)) return;
  const now = pkNow();
  const from = hhmm(BRIEFING_AT);
  if (state.briefingDays[now.date]) return;
  if (now.minutes < from || now.minutes > from + BRIEFING_LATEST_HOURS * 60) return;
  if (!(snapshot.courses ?? []).length) return;

  // Recorded as decided even on an empty day, so the check is not repeated
  // every tick until noon.
  state.briefingDays[now.date] = true;
  // Only the last two weeks are kept; the file would otherwise grow forever.
  for (const day of Object.keys(state.briefingDays)) {
    if (Date.parse(now.date) - Date.parse(day) > 14 * 864e5) delete state.briefingDays[day];
  }

  const text = briefingText(snapshot, { now, doneState: state.deadlines });
  if (text) {
    await notify(text);
    log('morning briefing queued');
  } else {
    log('morning briefing: nothing to report today');
  }
}

// setInterval does not wait for an async callback. A tick still busy with a
// slow scrape or a login would otherwise be joined by the next one, and two
// attendance passes reading the same state could both report one absence.
let ticking = false;

async function tick() {
  if (ticking) {
    log('previous tick still running - skipping this one');
    return;
  }
  ticking = true;
  try {
    await tickOnce();
  } finally {
    ticking = false;
  }
}

async function tickOnce() {
  try {
    const due = Date.now() - (state.lastScrapeAt ?? 0) > SCRAPE_EVERY_MINUTES * 60000;
    // The quiet window must not leave a fresh install with nothing to answer
    // from: with no snapshot yet, scrape whatever the hour.
    const haveData = (snapshot.courses ?? []).length > 0;
    if (due && (withinActiveHours(pkNow()) || !haveData)) await fullSync();
    await attendanceTick();
    await deadlineTick();
    await invoiceTick();
    await briefingTick();
    saveState();
    await flushOutbox();
  } catch (e) {
    if (e instanceof SessionExpired) {
      try {
        await refreshSession({ log });
        log('session refreshed mid-tick');
      } catch (le) {
        await notify('*Session expired and automatic login failed.*' + NL + le.message);
        await flushOutbox();
      }
    } else {
      log('tick error:', e.stack ?? e.message);
    }
  }
}

// Old messages from before this device was linked cannot be decrypted. Hide
// the per-message noise and report a single count instead, so a sudden spike
// later is still visible.
let undecryptable = 0;
let warnedUndecryptable = false;
muteSignalNoise(() => {
  undecryptable += 1;
  // One or two of these right after pairing is normal. A steady stream means
  // the Signal session with the phone is broken and messages are not getting
  // through in either direction, so say so loudly rather than counting
  // quietly - that mistake cost a lot of debugging.
  if (undecryptable >= 3 && !warnedUndecryptable) {
    warnedUndecryptable = true;
    log('WARNING: cannot decrypt incoming messages. The pairing is damaged.');
    log('Fix: unlink this device on your phone, delete auth_info/, run: npm run pair');
  }
});
setInterval(() => {
  if (!undecryptable) return;
  log('skipped ' + undecryptable + ' undecryptable message(s) - each one is a message that did not get through');
  undecryptable = 0;
}, 60000).unref();

const wa = await connectWhatsApp({
  authDir: process.env.AUTH_DIR ?? 'auth_info',
  // The bot never pairs - that is pair.mjs's job. Without this it inherits
  // PAIR_NUMBER from .env and requests a pairing code, which overwrites
  // creds.me and makes an already-paired device look unpaired.
  pairNumber: null,
  log,
  onReady: ({ send: s, sendDocument: d }) => {
    send = s;
    sendDocument = d;
    connected = true;
    notify('CUST portal agent is online. Send "help" for commands.');
    flushOutbox();
  },
  onMessage: (text) => handleCommand(text, {
    snapshot, state,
    // Files go straight out rather than through the outbox: they are a reply
    // to a request made just now, and the outbox persists text only.
    sendFile: (file) => sendDocument(file),
    // A refresh from chat always scrapes, even outside active hours, and
    // leaves the periodic clock where it was.
    refresh: async () => {
      const msg = await fullSync({ announce: true, touchCycle: false });
      await flushOutbox();
      return msg;
    },
  }),
});

log(`tick every ${TICK_MINUTES}m, full scrape every ${SCRAPE_EVERY_MINUTES}m`
  + ` between ${ACTIVE_FROM} and ${ACTIVE_UNTIL} PKT`);
setInterval(tick, TICK_MINUTES * 60000);
tick();
