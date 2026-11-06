// Inbound chat commands. Everything answers from the stored snapshot rather
// than hitting the portal, so replies are instant and work even when the
// portal is down.

import { refreshSession } from './login.mjs';
import { collectDeadlines, markDone } from './deadlines.mjs';
import { unpaid } from './invoices.mjs';
import { slotsForDay } from './timetable.mjs';
import { pkNow } from './attendance.mjs';
import { setSession, looksLikeSession } from './session.mjs';
import { checkSession } from './portal.mjs';
import { abbreviate, headingLines, shortLabel, findCourses } from './courses.mjs';

const fmt = (d) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Karachi', weekday: 'short', day: '2-digit',
  month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
}).format(d);

const money = (n) => `Rs ${n.toLocaleString('en-PK')}`;
const LOW_ATTENDANCE = 75;

function marksReply(snapshot, query) {
  const courses = findCourses(snapshot, query).filter((c) => (c.marks ?? []).length);
  if (!courses.length) return query ? `No marks found for "${query}".` : 'Nothing graded yet.';

  const out = [];
  for (const c of courses) {
    const lines = [headingLines(c)];
    for (const cat of c.marks) {
      const head = `${cat.category}${cat.weight != null ? ` (${cat.weight}%)` : ''}`;
      lines.push(cat.obtainedPercent != null ? `${head}: ${cat.obtainedPercent}%` : `${head}: -`);
      for (const i of cat.items) {
        const vs = i.classAverage != null
          ? `  avg ${i.classAverage} ${i.obtained >= i.classAverage ? '(above)' : '(below)'}` : '';
        lines.push(`   ${i.name}: ${i.obtained}/${i.maxMark}${vs}`);
      }
    }
    out.push(lines.join('\n'));
  }
  return out.join('\n\n');
}

function attendanceReply(snapshot, query) {
  const courses = findCourses(snapshot, query).filter((c) => c.attendance);
  if (!courses.length) return 'No attendance data yet.';

  // Two short lines per course rather than aligned columns. WhatsApp renders
  // in a proportional font, so padded columns never line up anyway, and on a
  // phone they wrap into something unreadable.
  const blocks = courses
    .sort((a, b) => a.attendance.percent - b.attendance.percent)
    .map((c) => {
      const a = c.attendance;
      const warn = a.percent < LOW_ATTENDANCE ? '  <- BELOW 75%' : '';
      return `*${shortLabel(c)}* - ${a.percent}%  (${a.attended}/${a.conducted})${warn}`
        + NL + (c.name ?? '');
    });

  const low = courses.filter((c) => c.attendance.percent < LOW_ATTENDANCE);
  const out = ['*Attendance*', '', blocks.join(NL + NL)];
  if (low.length) out.push('', `Warning: ${low.length} course(s) below 75%.`);
  return out.join(NL);
}

function dueReply(snapshot) {
  const now = Date.now();
  const items = collectDeadlines(snapshot).filter((i) => i.due.getTime() > now).slice(0, 10);
  if (!items.length) return 'No upcoming submission or assessment deadlines.';
  return items.map((i) => {
    const hrs = (i.due - now) / 3600000;
    const left = hrs < 48 ? `${hrs.toFixed(0)}h` : `${(hrs / 24).toFixed(0)}d`;
    return `*${abbreviate(i.course) || i.code}* - ${i.name}` + NL + i.course + NL + `   ${fmt(i.due)}  (in ${left})`;
  }).join('\n');
}

function examsReply(snapshot) {
  const rows = (snapshot.global?.datesheet ?? []).flatMap((t) => t.rows ?? []);
  if (!rows.length) return 'No exam datesheet published.';

  const day = (iso) => {
    const d = new Date(`${iso}T00:00:00+05:00`);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Karachi', weekday: 'short', day: '2-digit', month: 'short',
    }).format(d);
  };

  const blocks = rows.map((r) => `*${abbreviate(r[1]) || r[1]}* - ${day(r[3])}`
    + NL + `${r[4]}` + NL + `${r[1]}`);
  return ['*Exams*', '', blocks.join(NL + NL)].join(NL);
}

function feesReply(snapshot) {
  const list = unpaid(snapshot);
  if (!list.length) return 'No unpaid challans.';
  return list.map((i) => `*${i.type}* ${i.term}\n${money(i.amount)} due ${i.dueDate}\nChallan ${i.id}`).join('\n\n');
}

const DAY_ALIASES = {
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
const isoPk = (d) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d);

const timePk = (d) => new Intl.DateTimeFormat('en-GB', {
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
function dayReply(snapshot, dayIndex, mode = 'exact') {
  const { iso, ahead } = dateForDay(dayIndex, mode);
  const when = ahead === 0 ? 'today' : ahead === 1 ? 'tomorrow' : `in ${ahead} days`;
  const out = [`*${prettyPk(iso)}*  (${when})`];

  const slots = slotsForDay(snapshot.timetable ?? [], dayIndex);
  if (slots.length) {
    out.push('', '*Classes*');
    for (const s of slots) out.push(`${s.start}-${s.end}  ${shortLabel(s)} (${s.kind})`);
  }

  const due = collectDeadlines(snapshot).filter((i) => isoPk(i.due) === iso);
  if (due.length) {
    out.push('', '*Due*');
    for (const i of due) {
      out.push(`*${abbreviate(i.course) || i.code}* - ${i.name}`);
      out.push(timePk(i.due));
    }
  }

  const exams = (snapshot.global?.datesheet ?? []).flatMap((t) => {
    const iDate = colIdx(t.columns, 'date');
    const iClass = colIdx(t.columns, 'class');
    const iTime = colIdx(t.columns, 'time');
    if (iDate < 0) return [];
    return (t.rows ?? [])
      .filter((r) => String(r[iDate] ?? '').trim() === iso)
      .map((r) => ({ name: iClass >= 0 ? r[iClass] : '', time: iTime >= 0 ? r[iTime] : '' }));
  });
  if (exams.length) {
    out.push('', '*Exams*');
    for (const e of exams) out.push(`*${abbreviate(e.name) || e.name}* - ${e.time}`);
  }

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
  if (notes.length) {
    out.push('', '*Announcements*');
    for (const n of notes) {
      out.push(`*${abbreviate(n.course) || n.code}* - ${n.subject}`);
      if (n.desc) out.push(n.desc.length > 160 ? n.desc.slice(0, 157) + '...' : n.desc);
    }
  }

  // Only the heading means the day is empty.
  if (out.length === 1) out.push('', 'Nothing scheduled.');
  return out.join(NL);
}

const NL = String.fromCharCode(10);

const HELP = [
  '*Commands*',
  '',
  '*marks* [course] - with class averages',
  '*attendance* [course] - % per course',
  '*due* - upcoming deadlines',
  '*today* / *tomorrow* - the day ahead',
  '*monday* ... *sunday* - any weekday',
  '*exams* - datesheet',
  '*fees* - unpaid challans',
  '*done* [item] - stop reminders',
  '*login* - refresh the portal session',
  '*cookie* <value> - set the session id',
  '*refresh* - re-scrape now',
  '',
  'A course can be a short form, a name or a code:',
  'marks PDC  /  attendance ai  /  marks CS3432',
].join(String.fromCharCode(10));


// Lets the session be replaced from the phone instead of editing .env and
// restarting. The candidate is verified against the portal before it is
// stored, so a bad paste cannot silently break every later poll.
async function cookieReply(arg, refresh) {
  const value = (arg || '').trim().replace(/^session_id=/, '');

  if (!value) {
    return ['Send: cookie <session_id>',
            '',
            'Open the portal in a browser while logged in, then:',
            'F12 -> Storage (Firefox) or Application (Chrome)',
            '-> Cookies -> odoo.cust.edu.pk -> session_id',
            'Copy the Value and send it here.'].join('\n');
  }
  if (!looksLikeSession(value)) {
    return `That is not a session id - expected 40 hex characters, got ${value.length}.`;
  }
  if (!(await checkSession(value))) {
    return 'The portal rejected that cookie. Copy a fresh one while logged in.';
  }

  setSession(value);
  const ok = 'Session updated and verified.';
  return refresh ? `${ok}\n\n${await refresh()}` : ok;
}

// Triggers the browser login on demand. Useful when the portal has logged the
// session out but the scraper has not noticed yet.
async function loginReply(refresh) {
  try {
    await refreshSession({ log: () => {} });
  } catch (e) {
    return 'Login failed: ' + e.message;
  }
  const ok = 'Logged in with Microsoft; session refreshed.';
  return refresh ? ok + NL + NL + (await refresh()) : ok;
}

export async function handleCommand(text, { snapshot, state, refresh } = {}) {
  const raw = (text ?? '').trim();
  const [word, ...rest] = raw.split(/\s+/);
  const cmd = (word ?? '').toLowerCase();
  const arg = rest.join(' ');

  switch (cmd) {
    case 'help': case 'commands': case '?':
      return HELP;
    case 'marks': case 'grade': case 'grades': case 'gradebook':
      return marksReply(snapshot, arg);
    case 'attendance': case 'att':
      return attendanceReply(snapshot, arg);
    case 'due': case 'deadline': case 'deadlines': case 'submissions':
      return dueReply(snapshot);
    case 'exam': case 'exams': case 'datesheet':
      return examsReply(snapshot);
    case 'fee': case 'fees': case 'invoice': case 'invoices': case 'challan':
      return feesReply(snapshot);
    case 'today':
      return dayReply(snapshot, pkNow().dayIndex);
    case 'tomorrow':
      return dayReply(snapshot, (pkNow().dayIndex + 1) % 7);
    case 'done':
      return markDone(snapshot, state?.deadlines ?? {}, raw).message;
    case 'login': case 'relogin':
      return await loginReply(refresh);
    case 'cookie': case 'session':
      return await cookieReply(arg, refresh);
    case 'refresh': case 'sync':
      if (!refresh) return 'Refresh is not available here.';
      return await refresh();
    default:
      // A weekday name gives that day's classes, deadlines and announcements,
      // always looking forward past tomorrow.
      if (Object.hasOwn(DAY_ALIASES, cmd)) return dayReply(snapshot, DAY_ALIASES[cmd], 'upcoming');

      // Not a command. The bot lives in a personal chat that also gets used
      // as a notepad - forwarded files, links, notes to self - so anything
      // unrecognised is ignored rather than answered with a help dump.
      return null;
  }
}
