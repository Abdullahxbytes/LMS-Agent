// Figures derived from the stored snapshot: attendance budget, weighted
// standing against the class, the results history and the next class.
// Everything here is pure - no network, no state - so the chat commands and
// the morning briefing share one set of numbers.

import { slotsForDay, toMinutes } from './timetable.mjs';
import { pkNow } from './attendance.mjs';

export const MIN_ATTENDANCE = 75;

// How many more classes can be missed while staying at or above the minimum,
// or, already under it, how many must be attended in a row to get back.
//
// Worked in integers: k more misses is fine while
//   100 * attended >= MIN * (conducted + k)
// Leave counts against attendance just like Absent, and the portal's
// "attended" figure already reflects that.
//
// Labs fill several consecutive slots and each slot is a separate attendance
// row, so missing one lab costs three classes. perSession says how many
// classes one meeting of the course is, from the timetable.
export function attendanceBudget(course, timetable = [], min = MIN_ATTENDANCE) {
  const a = course?.attendance;
  if (!a || !Number.isFinite(a.conducted) || !Number.isFinite(a.attended)) return null;

  const surplus = 100 * a.attended - min * a.conducted;
  const canMiss = surplus >= 0 ? Math.floor(surplus / min) : 0;
  const mustAttend = surplus < 0 ? Math.ceil(-surplus / (100 - min)) : 0;

  const perDay = new Map();
  for (const s of timetable) {
    if (s.code !== course.code) continue;
    perDay.set(s.dayIndex, (perDay.get(s.dayIndex) ?? 0) + 1);
  }
  const perSession = Math.max(1, ...perDay.values());

  return {
    ...a,
    canMiss,
    mustAttend,
    perSession,
    sessionsCanMiss: Math.floor(canMiss / perSession),
    below: surplus < 0,
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : word.endsWith('s') ? 'es' : 's'}`;

// One line describing a budget, counted in sessions where a meeting is more
// than one class, since "skip one lab" is how the decision actually gets made.
export function budgetText(b, min = MIN_ATTENDANCE) {
  if (b.below) {
    const sessions = Math.ceil(b.mustAttend / b.perSession);
    const count = b.perSession > 1
      ? `${plural(sessions, 'session')} (${plural(b.mustAttend, 'class')})`
      : plural(b.mustAttend, 'class');
    return `under ${min}% - attend the next ${count} in a row to get back`;
  }
  if (b.canMiss === 0) return `cannot miss any more without going under ${min}%`;
  if (b.perSession > 1) {
    if (b.sessionsCanMiss === 0) {
      return `can miss ${plural(b.canMiss, 'class')} - less than one full session`;
    }
    return `can miss ${plural(b.sessionsCanMiss, 'more session')} (${plural(b.canMiss, 'class')})`;
  }
  return `can miss ${plural(b.canMiss, 'more class')}`;
}

// Weighted standing so far, you against the class average.
//
// A category's share of the course is its weight; within it, the score is
// total obtained over total available, which is how the portal computes its
// own category percentage (checked: 4+9+6 of 30 shows as 63.33%). The class
// average is put through the same arithmetic so the two are comparable.
//
// Only categories with something graded count, so early in term this covers
// a small slice of the course - graded says how much.
export function standing(course) {
  const parts = [];
  for (const cat of course?.marks ?? []) {
    if (cat.weight == null) continue;
    const items = (cat.items ?? []).filter((i) => i.maxMark > 0 && i.obtained != null);
    if (!items.length) continue;

    const max = items.reduce((n, i) => n + i.maxMark, 0);
    const you = items.reduce((n, i) => n + i.obtained, 0);
    const hasAvg = items.every((i) => i.classAverage != null);
    const avg = hasAvg ? items.reduce((n, i) => n + i.classAverage, 0) : null;

    parts.push({
      category: cat.category,
      weight: cat.weight,
      count: items.length,
      youPct: (100 * you) / max,
      avgPct: hasAvg ? (100 * avg) / max : null,
      youPts: (cat.weight * you) / max,
      avgPts: hasAvg ? (cat.weight * avg) / max : null,
    });
  }
  if (!parts.length) return null;

  const graded = parts.reduce((n, p) => n + p.weight, 0);
  const youPts = parts.reduce((n, p) => n + p.youPts, 0);
  const allAvg = parts.every((p) => p.avgPts != null);
  const avgPts = allAvg ? parts.reduce((n, p) => n + p.avgPts, 0) : null;

  return {
    parts,
    graded,
    youPts,
    avgPts,
    youPct: (100 * youPts) / graded,
    avgPct: allAvg ? (100 * avgPts) / graded : null,
  };
}

// The results page is one table alternating term summary rows (8 columns)
// with that term's course rows (4 columns), each block introduced by a
// "Course | Credit Hours | Grade Pts | Final Grade" header row.
export function parseResults(snapshot) {
  const terms = [];
  for (const t of snapshot?.global?.results ?? []) {
    const cols = (t.columns ?? []).map((c) => String(c).trim().toLowerCase());
    if (cols[0] !== 'term') continue;
    const at = (name) => cols.indexOf(name);
    const iSgpa = at('sgpa');
    const iCgpa = at('cgpa');
    const iAttempted = at('attempted ch');
    const iEarned = at('earned ch');
    const iCumulative = at('cumulative ch');

    let cur = null;
    for (const row of t.rows ?? []) {
      if (/^(spring|summer|fall|winter)\s*\d{4}$/i.test(String(row[0]).trim()) && row.length >= cols.length) {
        const num = (i) => (i >= 0 ? Number(row[i]) : NaN);
        cur = {
          term: String(row[0]).trim(),
          sgpa: num(iSgpa),
          cgpa: num(iCgpa),
          attempted: num(iAttempted),
          earned: num(iEarned),
          cumulative: num(iCumulative),
          courses: [],
        };
        terms.push(cur);
      } else if (cur && row.length >= 4 && !/^course$/i.test(String(row[0]).trim())) {
        cur.courses.push({
          name: row[0], credits: Number(row[1]), points: Number(row[2]), grade: row[3],
        });
      }
    }
  }
  return terms;
}

// Consecutive slots of one course on one day are a single sitting - a lab is
// three back-to-back slots - so they are joined into one block.
function blocksForDay(timetable, dayIndex) {
  const blocks = [];
  for (const s of slotsForDay(timetable, dayIndex)) {
    const last = blocks[blocks.length - 1];
    if (last && last.code === s.code && toMinutes(s.start) - toMinutes(last.end) <= 15) {
      last.end = s.end;
      last.slots += 1;
    } else {
      blocks.push({ ...s, slots: 1 });
    }
  }
  return blocks;
}

// The class running now or the next one to start, looking up to a week ahead,
// plus whatever else follows it on the same day.
export function nextClass(timetable = [], now = pkNow()) {
  for (let ahead = 0; ahead < 8; ahead += 1) {
    const dayIndex = (now.dayIndex + ahead) % 7;
    const blocks = blocksForDay(timetable, dayIndex)
      .filter((b) => ahead > 0 || toMinutes(b.end) > now.minutes);
    if (!blocks.length) continue;

    const [first, ...later] = blocks;
    const startsIn = ahead * 1440 + toMinutes(first.start) - now.minutes;
    return {
      block: first,
      ahead,
      startsIn,
      inProgress: ahead === 0 && toMinutes(first.start) <= now.minutes,
      later,
    };
  }
  return null;
}

// "2h 05m", "45m", "3d 2h" - for "starts in" lines.
export function minutesLabel(mins) {
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
  return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
}
