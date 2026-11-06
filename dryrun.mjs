// End-to-end check with no WhatsApp: live portal fetch, real parsing,
// replaying a past class slot where attendance was marked "Leave".
import { readFileSync } from 'node:fs';
import { runAttendancePass } from './attendance.mjs';
import { deadlineReminders } from './deadlines.mjs';
import { invoiceReminders } from './invoices.mjs';
import { attendanceRows } from './portal.mjs';

const snapshot = JSON.parse(readFileSync('out/snapshot.json', 'utf8'));
const byCode = new Map(snapshot.courses.map((c) => [c.code, c]));
const fetchAttendance = async (code) => {
  const c = byCode.get(code);
  if (!c) return [];
  const rows = await attendanceRows(c.id);
  return rows;
};

// Friday 30 Oct 2026, 15:40 PKT.
// CS3431 lab slot 3 (16:19) is 26 min in - its first pass.
const now = { date: '2026-10-30', dayIndex: 5, minutes: 16 * 60 + 45 };
console.log(`--- replaying ${now.date} 16:45 PKT (live portal data) ---`);

const state = {};
const { events } = await runAttendancePass({ timetable: snapshot.timetable, fetchAttendance, now, state });
if (!events.length) console.log('(no alerts)');
for (const e of events) console.log('\n' + e.text);

console.log('\nslot states:', JSON.stringify(state, null, 1));

console.log('\n--- deadline reminders now ---');
const d = deadlineReminders(snapshot, new Date(), {});
console.log(d.events.length ? d.events.map((e) => e.text).join('\n') : '(none due)');

console.log('\n--- invoice reminders on 2026-11-06 ---');
const inv = invoiceReminders(snapshot, '2026-11-06');
console.log(inv.length ? inv.map((e) => e.text).join('\n') : '(none)');
