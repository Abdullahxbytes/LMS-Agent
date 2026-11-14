// One day at a glance: classes, what is due, exams and course announcements.
// Used by the today / tomorrow / weekday commands and by the morning briefing.

import { collectDeadlines } from './deadlines.mjs';
import { slotsForDay } from './timetable.mjs';
import { pkNow } from './attendance.mjs';
import { abbreviate, shortLabel } from './courses.mjs';

const NL = String.fromCharCode(10);

export const DAY_ALIASES = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

// All three formatters are pinned to Pakistan time so the answer is the same
// whatever the host clock is set to.
export const isoPk = (d) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d);

export const timePk = (d) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', hour12: true,
}).format(d);

const prettyPk = (iso) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Karachi', weekday: 'long', day: '2-digit', month: 'short',
}).format(new Date(`${iso}T00:00:00+05:00`));

const colIdx = (columns, name) =>
  (columns ?? []).findIndex((c) => String(c).trim().toLowerCase() === name);

// How many days ahead a request lands.
//
// 'exact' is the literal next occurrence, counting today as itself - what
// `today` and `tomorrow` need.
//
// 'upcoming' is what a weekday NAME means. Today and tomorrow already have
// their own commands, so naming either one's weekday is a request for the one
// a week out: on a Monday, "monday" is next Monday and "tuesday" is next
// week's Tuesday. From the day after tomorrow onwards it is simply this
// week's - on a Monday, "wednesday" is two days away.
export function dayOffset(dayIndex, todayIndex, mode = 'exact') {
  const ahead = (dayIndex - todayIndex + 7) % 7;
  return mode === 'upcoming' && ahead <= 1 ? ahead + 7 : ahead;
}

function dateForDay(dayIndex, mode = 'exact', now = pkNow()) {
  const ahead = dayOffset(dayIndex, now.dayIndex, mode);
  const base = new Date(`${now.date}T00:00:00+05:00`);
  return { iso: isoPk(new Date(base.getTime() + ahead * 864e5)), ahead };
}

// Everything happening on one date: classes first, then what is due, then
// exams, then anything posted to the course noticeboards that day.
export function dayReply(snapshot, dayIndex, mode = 'exact', now = pkNow()) {
  const { iso, ahead } = dateForDay(dayIndex, mode, now);
  const when = ahead === 0 ? 'today' : ahead === 1 ? 'tomorrow' : `in ${ahead} days`;
  const out = [`*${prettyPk(iso)}*  (${when})`];

  // Everything is gathered before anything is printed. Silence about a day is
  // ambiguous - it reads the same as the bot having no data - so an empty day
  // says so explicitly, and a day with classes but nothing due says that on
  // one line directly under the timetable.
  const slots = slotsForDay(snapshot.timetable ?? [], dayIndex);

  const due = collectDeadlines(snapshot).filter((i) => isoPk(i.due) === iso);

  const exams = (snapshot.global?.datesheet ?? []).flatMap((t) => {
    const iDate = colIdx(t.columns, 'date');
    const iClass = colIdx(t.columns, 'class');
    const iTime = colIdx(t.columns, 'time');
    if (iDate < 0) return [];
    return (t.rows ?? [])
      .filter((r) => String(r[iDate] ?? '').trim() === iso)
      .map((r) => ({ name: iClass >= 0 ? r[iClass] : '', time: iTime >= 0 ? r[iTime] : '' }));
  });
  const notes = [];
  for (const c of snapshot.courses ?? []) {
    for (const t of c.tabs?.info ?? []) {
      const iDate = colIdx(t.columns, 'date');
      if (iDate < 0) continue;
      const iSubject = colIdx(t.columns, 'subject');
      const iDesc = colIdx(t.columns, 'description');
      for (const r of t.rows ?? []) {
        if (String(r[iDate] ?? '').trim() !== iso) continue;
        notes.push({
          code: c.code, course: c.name,
          subject: iSubject >= 0 ? r[iSubject] : '',
          desc: iDesc >= 0 ? String(r[iDesc] ?? '').trim() : '',
        });
      }
    }
  }
  if (!slots.length && !due.length && !exams.length && !notes.length) {
    out.push('', 'Nothing scheduled.');
    return out.join(NL);
  }

  if (slots.length) {
    out.push('', '*Classes*');
    for (const s of slots) out.push(`${s.start}-${s.end}  ${shortLabel(s)} (${s.kind})`);
  }

  // Sits right under the timetable, where the Due and Exams headings would
  // have been, so the absence is as plain as a listing would be.
  if (!due.length && !exams.length) out.push('', 'Nothing due, no exams.');

  if (due.length) {
    out.push('', '*Due*');
    for (const i of due) {
      out.push(`*${abbreviate(i.course) || i.code}* - ${i.name}`);
      out.push(timePk(i.due));
    }
  }

  if (exams.length) {
    out.push('', '*Exams*');
    for (const e of exams) out.push(`*${abbreviate(e.name) || e.name}* - ${e.time}`);
  }

  if (notes.length) {
    out.push('', '*Announcements*');
    for (const n of notes) {
      out.push(`*${abbreviate(n.course) || n.code}* - ${n.subject}`);
      if (n.desc) out.push(n.desc.length > 160 ? n.desc.slice(0, 157) + '...' : n.desc);
    }
  }

  return out.join(NL);
}
