// Inbound chat commands. Everything answers from the stored snapshot rather
// than hitting the portal, so replies are instant and work even when the
// portal is down. The exceptions are login/cookie/refresh, and get, which
// fetches the file asked for.

import { refreshSession } from './login.mjs';
import { collectDeadlines, markDone } from './deadlines.mjs';
import { unpaid } from './invoices.mjs';
import { pkNow } from './attendance.mjs';
import { setSession, looksLikeSession } from './session.mjs';
import { checkSession, SessionExpired } from './portal.mjs';
import { abbreviate, headingLines, shortLabel, findCourses } from './courses.mjs';
import { DAY_ALIASES, dayReply } from './day.mjs';
import {
  MIN_ATTENDANCE, attendanceBudget, budgetText, standing, parseResults, nextClass, minutesLabel,
} from './insights.mjs';
import { materialsOf, searchMaterials, liveMaterials, downloadMaterial } from './materials.mjs';
import { briefingText } from './briefing.mjs';

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


const NL = String.fromCharCode(10);

const HELP = [
  '*Commands*',
  '',
  '*marks* [course] - with class averages',
  '*attendance* [course] - % per course',
  '*due* - upcoming deadlines',
  '*today* / *tomorrow* - the day ahead',
  '*monday* ... *sunday* - any coming weekday',
  '*exams* - datesheet',
  '*fees* - unpaid challans',
  '*next* - the next class',
  '*skip* [course] - classes you can still miss',
  '*standing* [course] - weighted marks vs class',
  '*gpa* [term] - SGPA / CGPA history',
  '*materials* [course] - course files',
  '*get* <course> <n> - receive a file',
  '*briefing* - the morning briefing now',
  '*done* [item] - stop reminders',
  '*login* - refresh the portal session',
  '*cookie* <value> - set the session id',
  '*refresh* - re-scrape now',
  '',
  'A course can be a short form, a name or a code:',
  'marks PDC  /  attendance ai  /  marks CS3432',
].join(String.fromCharCode(10));

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const fixed = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d).replace(/\.0+$/, '') : '-');
const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// An exact hit on code, short form or full name beats a partial one, so
// "pdc" means PDC rather than PDC and PDC Lab when a single course is needed.
function pickCourses(snapshot, query, { exactOnly = false } = {}) {
  const q = squash(query);
  if (!q) return [];
  const all = snapshot?.courses ?? [];
  const exact = all.filter((c) => [c.code, c.name, abbreviate(c.name)].some((v) => squash(v) === q));
  if (exact.length || exactOnly) return exact;
  return findCourses(snapshot, query);
}

function skipReply(snapshot, query) {
  const rows = findCourses(snapshot, query)
    .map((c) => ({ c, b: attendanceBudget(c, snapshot.timetable ?? []) }))
    .filter(({ b }) => b)
    .sort((x, y) => (x.b.below === y.b.below ? x.b.canMiss - y.b.canMiss : x.b.below ? -1 : 1));
  if (!rows.length) return query ? `No attendance found for "${query}".` : 'No attendance data yet.';

  const blocks = rows.map(({ c, b }) => `*${shortLabel(c)}* ${b.percent}%  (${b.attended}/${b.conducted})`
    + NL + budgetText(b));
  return [`*Attendance budget*  (minimum ${MIN_ATTENDANCE}%)`, '', blocks.join(NL + NL), '',
    '_Counted as of now; every class you attend adds to it._'].join(NL);
}

function standingReply(snapshot, query) {
  const rows = findCourses(snapshot, query)
    .map((c) => ({ c, s: standing(c) }))
    .filter(({ s }) => s);
  if (!rows.length) return query ? `Nothing graded yet for "${query}".` : 'Nothing graded yet.';

  // Several courses: one compact line each. One course: the breakdown.
  if (rows.length > 1) {
    const lines = rows.map(({ c, s }) => {
      const vs = s.avgPct != null ? ` vs avg ${fixed(s.avgPct, 0)}% (${s.youPct >= s.avgPct ? '+' : ''}${fixed(s.youPct - s.avgPct, 0)})` : '';
      return `*${shortLabel(c)}* ${fixed(s.youPct, 0)}%${vs}` + NL + `   ${fixed(s.graded, 0)}% of the course graded`;
    });
    return ['*Standing so far*', '', lines.join(NL), '', '_standing <course> for the breakdown_'].join(NL);
  }

  const { c, s } = rows[0];
  const out = [headingLines(c), `Graded so far: ${fixed(s.graded, 0)}% of the course`, ''];
  const avg = s.avgPts != null ? `  |  class avg ${fixed(s.avgPts)}/${fixed(s.graded, 0)} (${fixed(s.avgPct, 0)}%)` : '';
  out.push(`*You: ${fixed(s.youPts)}/${fixed(s.graded, 0)} (${fixed(s.youPct, 0)}%)*${avg}`, '');
  for (const p of s.parts) {
    const pAvg = p.avgPct != null ? `, avg ${fixed(p.avgPct, 0)}%` : '';
    out.push(`${p.category} (${fixed(p.weight, 0)}%): you ${fixed(p.youPct, 0)}%${pAvg}  [${p.count}]`);
  }
  return out.join(NL);
}

function gpaReply(snapshot, query) {
  const terms = parseResults(snapshot);
  if (!terms.length) return 'No results on record yet.';

  const q = String(query ?? '').trim().toLowerCase();
  if (q) {
    const term = /^(last|latest|recent)$/.test(q)
      ? terms[terms.length - 1]
      : terms.find((t) => squash(t.term).includes(squash(q)));
    if (!term) return `No term matching "${query}". Terms: ${terms.map((t) => t.term).join(', ')}`;
    const lines = term.courses.map((c) => `${c.grade.padEnd(2)}  ${c.name} (${fixed(c.credits, 0)} CH)`);
    return [`*${term.term}*`, `SGPA ${fixed(term.sgpa, 2)}  |  CGPA ${fixed(term.cgpa, 2)}`, '', ...lines].join(NL);
  }

  const last = terms[terms.length - 1];
  const lines = terms.map((t) => `${t.term}: SGPA ${fixed(t.sgpa, 2)}, CGPA ${fixed(t.cgpa, 2)}`);
  return [`*CGPA ${fixed(last.cgpa, 2)}*  (${fixed(last.cumulative, 0)} credit hours)`, '', ...lines, '',
    '_gpa <term> or gpa last for the grades_'].join(NL);
}

function nextReply(snapshot) {
  const now = pkNow();
  const n = nextClass(snapshot.timetable ?? [], now);
  if (!n) return 'No classes in the timetable.';

  const { block: b } = n;
  const day = n.ahead === 0 ? 'today' : n.ahead === 1 ? 'tomorrow' : DAY_NAMES[b.dayIndex];
  const head = n.inProgress
    ? `*Now* - ends ${b.end}`
    : `*Next class* in ${minutesLabel(n.startsIn)}`;
  const out = [head, `*${shortLabel(b)}* (${b.kind})  ${b.start}-${b.end} ${day}`];
  if (b.title) out.push(b.title);
  if (b.teacher) out.push(b.teacher);
  if (n.later.length) {
    out.push('', `Later ${day}: ` + n.later.map((l) => `${shortLabel(l)} ${l.start}`).join(', '));
  }
  return out.join(NL);
}

function materialsList(course) {
  const files = materialsOf(course);
  if (!files.length) return `${headingLines(course)}${NL}No files uploaded.`;
  const label = shortLabel(course);
  return [headingLines(course), '',
    ...files.map((f) => `${f.sr}. ${f.name}`), '',
    `_Send: get ${label} <number>_`].join(NL);
}

function materialsReply(snapshot, query) {
  if (query) {
    const courses = pickCourses(snapshot, query);
    if (!courses.length) return `No course matching "${query}".`;
    return courses.map(materialsList).join(NL + NL);
  }
  const lines = (snapshot.courses ?? [])
    .map((c) => ({ c, files: materialsOf(c) }))
    .filter(({ files }) => files.length)
    .map(({ c, files }) => `*${shortLabel(c)}* - ${files.length} file${files.length === 1 ? '' : 's'}`
      + NL + `   latest: ${files[files.length - 1].name}`);
  if (!lines.length) return 'No course files uploaded.';
  return ['*Course files*', '', lines.join(NL), '', '_materials <course> to list, get <course> <n> to receive_'].join(NL);
}

// A live portal call that logs in again once if the session has died.
async function withSession(fn) {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof SessionExpired)) throw e;
    await refreshSession({ log: () => {} });
    return fn();
  }
}

// Sends a course file as a WhatsApp document.
//   get pdc 3          the 3rd file of PDC, as numbered by "materials pdc"
//   get amdahl         a file found by words in its name or description
//   get pdc            the list of PDC's files
// "get" is ordinary English, and this chat doubles as a notepad, so when
// nothing at all matches, `get` stays silent like any other note would.
async function fileReply(snapshot, arg, { sendFile, quiet }) {
  const query = String(arg ?? '').trim();
  if (!query) return quiet ? null : 'Send: get <course> <number>, e.g. get PDC 3. See: materials';

  let target = null;
  const numbered = /^(.*\S)\s+#?(\d+)$/.exec(query);
  if (numbered) {
    const courses = pickCourses(snapshot, numbered[1]);
    if (courses.length > 1) {
      return 'Which course?' + NL + courses.map((c) => `get ${shortLabel(c)} ${numbered[2]}`).join(NL);
    }
    if (courses.length === 1) target = { course: courses[0], sr: Number(numbered[2]) };
  }

  if (!target) {
    const course = pickCourses(snapshot, query, { exactOnly: true });
    if (course.length === 1) return materialsList(course[0]);

    const hits = searchMaterials(snapshot, query);
    if (!hits.length) return quiet ? null : `No course file matching "${query}". See: materials`;
    if (hits.length > 1) {
      const shown = hits.slice(0, 8).map((h) => `get ${shortLabel(h.course)} ${h.sr}  - ${h.name}`);
      const more = hits.length > 8 ? [`...and ${hits.length - 8} more`] : [];
      return [`${hits.length} files match:`, ...shown, ...more].join(NL);
    }
    target = { course: hits[0].course, sr: hits[0].sr, name: hits[0].name };
  }

  if (!sendFile) return 'Sending files is not available here.';

  const live = await withSession(() => liveMaterials(target.course));
  // By name when known, since numbering can shift if a file is removed.
  const row = (target.name && live.find((r) => r.name === target.name))
    ?? live.find((r) => r.sr === target.sr);
  if (!row) return `${shortLabel(target.course)} has no file ${target.sr}. See: materials ${shortLabel(target.course)}`;

  const file = await withSession(() => downloadMaterial(row.href, row.name));
  await sendFile({ ...file, caption: `${shortLabel(target.course)} - ${row.name}` });
  // The document is the reply.
  return null;
}


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

export async function handleCommand(text, { snapshot, state, refresh, sendFile } = {}) {
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
    case 'next': case 'class':
      return nextReply(snapshot);
    case 'skip': case 'bunk': case 'budget':
      return skipReply(snapshot, arg);
    case 'standing': case 'total': case 'totals':
      return standingReply(snapshot, arg);
    case 'gpa': case 'cgpa': case 'sgpa': case 'results': case 'result':
      return gpaReply(snapshot, arg);
    case 'materials': case 'material': case 'files':
      return materialsReply(snapshot, arg);
    case 'get':
      return await fileReply(snapshot, arg, { sendFile, quiet: true });
    case 'file': case 'download':
      return await fileReply(snapshot, arg, { sendFile, quiet: false });
    case 'briefing': case 'brief': case 'morning':
      return briefingText(snapshot, { doneState: state?.deadlines ?? {} })
        ?? 'Nothing on today - no classes, nothing due, nothing to flag. No briefing would be sent.';
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
