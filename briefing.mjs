// The morning briefing: today's day view, plus what needs attention -
// attendance one missed session from the minimum, deadlines in the next two
// days, fees due within a week.
//
// Built entirely from the stored snapshot, so it costs no portal requests.
// A day with nothing to say produces no briefing at all, rather than a
// message every weekend that just says "nothing".

import { dayReply, isoPk } from './day.mjs';
import { collectDeadlines } from './deadlines.mjs';
import { unpaid } from './invoices.mjs';
import { slotsForDay } from './timetable.mjs';
import { pkNow } from './attendance.mjs';
import { attendanceBudget, budgetText } from './insights.mjs';
import { abbreviate, shortLabel } from './courses.mjs';

const NL = String.fromCharCode(10);
const STALE_HOURS = 12;

const fmtDue = (d) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Karachi', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
}).format(d);

// Returns the text, or null when the day is empty and needs no message.
export function briefingText(snapshot, { now = pkNow(), at = new Date(), doneState = {} } = {}) {
  const timetable = snapshot?.timetable ?? [];
  const classesToday = slotsForDay(timetable, now.dayIndex).length;

  // Deadlines due after today but within two days; today's own are already in
  // the day view. Ones marked "done" are left out.
  const horizon = at.getTime() + 2 * 864e5;
  const soon = collectDeadlines(snapshot)
    .filter((i) => !doneState[i.key]?.done)
    .filter((i) => isoPk(i.due) !== now.date && i.due.getTime() > at.getTime() && i.due.getTime() <= horizon);
  const dueToday = collectDeadlines(snapshot).filter((i) => isoPk(i.due) === now.date).length;

  // Exams tomorrow and the day after; today's are in the day view.
  const next2 = [1, 2].map((d) => isoPk(new Date(Date.parse(`${now.date}T00:00:00+05:00`) + d * 864e5)));
  const exams = (snapshot?.global?.datesheet ?? []).flatMap((t) => {
    const cols = (t.columns ?? []).map((c) => String(c).trim().toLowerCase());
    const [iDate, iClass, iTime] = ['date', 'class', 'time'].map((n) => cols.indexOf(n));
    if (iDate < 0) return [];
    return (t.rows ?? [])
      .filter((r) => next2.includes(String(r[iDate] ?? '').trim()))
      .map((r) => ({
        name: iClass >= 0 ? r[iClass] : '',
        when: `${next2.indexOf(String(r[iDate]).trim()) === 0 ? 'tomorrow' : 'in 2 days'}${iTime >= 0 ? ' ' + r[iTime] : ''}`,
      }));
  });

  // Anything under the minimum, or where missing the next session would put
  // it under. Flagging "only one session to spare" as well looked careful but
  // early in term it is true of every lab at 100%, and a warning that fires
  // every morning gets ignored.
  const risky = (snapshot?.courses ?? [])
    .map((c) => ({ c, b: attendanceBudget(c, timetable) }))
    .filter(({ b }) => b && (b.below || b.sessionsCanMiss === 0))
    .sort((x, y) => x.b.percent - y.b.percent);

  const today = Date.parse(`${now.date}T00:00:00+05:00`);
  const fees = unpaid(snapshot).filter((i) => {
    const due = Date.parse(`${i.dueDate}T00:00:00+05:00`);
    return !Number.isNaN(due) && (due - today) / 864e5 <= 7;
  });

  if (!classesToday && !dueToday && !soon.length && !exams.length && !risky.length && !fees.length) return null;

  const out = ['*Morning briefing*', '', dayReply(snapshot, now.dayIndex, 'exact', now)];

  if (soon.length || exams.length) {
    out.push('', '*Coming up*');
    for (const e of exams) out.push(`*${abbreviate(e.name) || e.name}* exam - ${e.when}`);
    for (const i of soon) out.push(`*${abbreviate(i.course) || i.code}* - ${i.name}  (${fmtDue(i.due)})`);
  }

  if (risky.length) {
    out.push('', '*Attendance*');
    for (const { c, b } of risky) {
      out.push(`*${shortLabel(c)}* ${b.percent}% - ${budgetText(b)}`);
    }
  }

  if (fees.length) {
    out.push('', '*Fees*');
    for (const f of fees) {
      const late = Date.parse(`${f.dueDate}T00:00:00+05:00`) < today;
      out.push(`${f.type || 'Challan'} Rs ${f.amount.toLocaleString('en-PK')} ${late ? '*OVERDUE* since' : 'due'} ${f.dueDate}`);
    }
  }

  const fetched = Date.parse(snapshot?.fetchedAt ?? '');
  if (Number.isFinite(fetched) && at.getTime() - fetched > STALE_HOURS * 3600e3) {
    out.push('', `_Portal data is from ${fmtDue(new Date(fetched))} - the last scrape may have failed._`);
  }

  return out.join(NL);
}
