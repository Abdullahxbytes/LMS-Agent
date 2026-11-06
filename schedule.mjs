// Prints exactly when the bot will touch the portal, by simulating a day of
// ticks against the real timetable. Nothing is fetched and nothing is sent -
// this is here so the schedule can be checked without waiting for a class.
//
//   node schedule.mjs            today
//   node schedule.mjs Monday     a named day

import { readFileSync, existsSync } from 'node:fs';
import { slotsForDay, toMinutes } from './timetable.mjs';
import { abbreviate } from './courses.mjs';
import { FIRST_CHECK_AFTER, SECOND_CHECK_AFTER, dueChecks } from './attendance.mjs';

const TICK = Number(process.env.TICK_MINUTES ?? 5);
const SCRAPE_EVERY = Number(process.env.SCRAPE_EVERY_MINUTES ?? 45);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

if (!existsSync('out/snapshot.json')) {
  console.error('No out/snapshot.json yet - run: npm run scrape');
  process.exit(1);
}
const snapshot = JSON.parse(readFileSync('out/snapshot.json', 'utf8'));
const timetable = snapshot.timetable ?? [];

const arg = process.argv[2];
const dayIndex = arg
  ? DAYS.findIndex((d) => d.toLowerCase().startsWith(arg.toLowerCase()))
  : new Date(Date.now() + 5 * 3600000).getUTCDay(); // Pakistan is UTC+5

if (dayIndex < 0) {
  console.error(`Unknown day: ${arg}`);
  process.exit(1);
}

const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const slots = slotsForDay(timetable, dayIndex).slice().sort((a, b) => toMinutes(a.start) - toMinutes(b.start));

console.log(`\n${DAYS[dayIndex]} - ${slots.length} class(es)`);
console.log(`tick every ${TICK}m | full scrape every ${SCRAPE_EVERY}m | checks at +${FIRST_CHECK_AFTER}m and +${SECOND_CHECK_AFTER}m\n`);

if (!slots.length) {
  console.log('  no classes - only the periodic full scrape runs');
  process.exit(0);
}

for (const s of slots) {
  const lab = s.kind === 'Lab' ? ` [lab slot ${s.slotIndex + 1}]` : '';
  console.log(`  ${s.start}-${s.end}  ${(abbreviate(s.title) || s.code).padEnd(8)}${lab}  ${(s.title ?? '').slice(0, 40)}`);
}

// Replay the day one tick at a time, exactly as bot.mjs would, tracking the
// same "already checked this pass" state the real attendance pass keeps.
const seen = new Map();
const rows = [];
const first = toMinutes(slots[0].start);
const last = toMinutes(slots[slots.length - 1].start) + SECOND_CHECK_AFTER + TICK;

for (let m = first; m <= last; m += TICK) {
  const due = dueChecks(timetable, { minutes: m, dayIndex, date: 'sim' });
  const fetches = [];
  for (const { slot, pass } of due) {
    const key = `${slot.code}#${slot.slotIndex}`;
    if (seen.get(key) === pass || (seen.get(key) ?? 0) > pass) continue;
    seen.set(key, pass);
    fetches.push(`${abbreviate(slot.title) || slot.code} pass${pass} (class started ${hhmm(toMinutes(slot.start))})`);
  }
  if (fetches.length) rows.push([hhmm(m), fetches]);
}

console.log('\nAttendance checks:');
for (const [at, fetches] of rows) {
  console.log(`  ${at}  ${fetches.join(', ')}`);
}

const unique = new Set(slots.map((s) => s.code)).size;
console.log(`\n${rows.length} wake-up(s) that hit the portal, for ${slots.length} slot(s) across ${unique} course(s).`);
console.log('Every other tick is a clock check only - no network.');
console.log(`Outside class hours the portal is touched once every ${SCRAPE_EVERY}m.`);
