// Attendance watcher.
//
// Teachers usually mark attendance in the first 10-15 minutes, so each slot is
// checked 20 minutes after it starts. Some mark it mid-class or at the end, so
// any slot still unmarked is checked again an hour later. Only absences are
// reported - being present is the expected case and needs no message.

import { abbreviate } from './courses.mjs';

const NL = String.fromCharCode(10);
import { slotsForDay, toMinutes } from './timetable.mjs';

export const FIRST_CHECK_AFTER = 20;   // minutes after a slot starts
export const SECOND_CHECK_AFTER = 80;  // one hour after the first check

// Everything is reasoned about in Pakistan time regardless of host timezone.
export function pkNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'long',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    dayIndex: DAYS.indexOf(parts.weekday),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

// Attendance rows look like [srNo, "2026-09-24", "Present", fine].
function recordsOn(rows, dateStr) {
  return rows
    .filter((r) => r.some((c) => c === dateStr))
    .map((r) => r.find((c) => /^(Present|Absent|Leave|Late)$/i.test(c?.trim() ?? '')) ?? null);
}

// A lab fills several consecutive slots; its rows appear in slot order.
export function statusForSlot(rows, dateStr, slotIndex) {
  const found = recordsOn(rows, dateStr);
  if (slotIndex >= found.length) return 'Unmarked';
  return found[slotIndex] ?? 'Unmarked';
}

export function stateKey(dateStr, slot) {
  return `${dateStr}|${slot.code}|${slot.slotIndex}`;
}

// Which slots are due for a look right now, and whether this is the second one.
export function dueChecks(timetable, now) {
  const out = [];
  for (const slot of slotsForDay(timetable, now.dayIndex)) {
    const start = toMinutes(slot.start);
    if (Number.isNaN(start)) continue;
    const since = now.minutes - start;
    if (since >= FIRST_CHECK_AFTER) {
      out.push({ slot, pass: since >= SECOND_CHECK_AFTER ? 2 : 1, minutesSinceStart: since });
    }
  }
  return out;
}

/**
 * Runs one pass. `fetchAttendance(courseCode)` must resolve to that course's
 * attendance rows. `state` persists across runs so nothing is reported twice.
 */
export async function runAttendancePass({ timetable, fetchAttendance, now = pkNow(), state = {} }) {
  const events = [];
  const cache = new Map();

  for (const { slot, pass, minutesSinceStart } of dueChecks(timetable, now)) {
    const key = stateKey(now.date, slot);
    const prior = state[key];
    if (prior?.resolved) continue;
    // An unmarked slot stays unresolved until the second pass. Without this
    // it would be re-fetched on every tick for the whole hour in between;
    // the design is two checks per slot - at +20min and at +80min.
    if (prior?.pass === pass) continue;

    if (!cache.has(slot.code)) cache.set(slot.code, await fetchAttendance(slot.code));
    const rows = cache.get(slot.code) ?? [];
    const status = statusForSlot(rows, now.date, slot.slotIndex);

    // Short form first - it is how the subject is actually referred to.
    const abbr = abbreviate(slot.title);
    const title = slot.title ?? slot.code;
    const when = `${slot.start}-${slot.end}`;

    if (status === 'Unmarked') {
      // A teacher who never marks a slot leaves everyone present, so an
      // unmarked slot is not news. It is still re-checked on the second
      // pass, because attendance marked late may turn out to be an absence.
      state[key] = { status, resolved: pass === 2, checks: (prior?.checks ?? 0) + 1, pass };
    } else if (/^present$/i.test(status)) {
      state[key] = { status, resolved: true, notified: false, pass };
    } else {
      // Anything other than Present costs attendance, so it is all reported
      // as an absence. The portal's own wording is kept in the body, because
      // 'Leave' and 'Absent' may need different follow-up with a teacher.
      const labSlot = slot.kind === 'Lab' ? ' (lab slot ' + (slot.slotIndex + 1) + ')' : '';
      const wording = /^present$/i.test(status) ? '' : status.toLowerCase();
      events.push({
        kind: 'not-present', slot, status,
        // Kept to short lines: a single heading carrying the short form and
        // the full title runs past 55 characters and wraps badly on a phone.
        text: '[ABSENT] *' + (abbr || slot.code) + '*'
            + NL + title
            + NL + slot.day + ' ' + when + labSlot
            + NL + 'Marked ' + wording + ' by ' + (slot.teacher ?? 'teacher') + '.'
            + (/^leave$/i.test(status) ? NL + 'Counts against your attendance.' : ''),
      });
      state[key] = { status, resolved: true, notified: true, pass };
    }
  }
  return { events, state };
}
