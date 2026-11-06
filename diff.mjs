// Compares two portal snapshots and turns the differences into messages.
// This is what makes notifications work: anything new in the diff is news.

import { headingLines, abbreviate } from './courses.mjs';

const NL = String.fromCharCode(10);
const MAX_LISTED = 8;

const COURSE_TABS = {
  assessment: { icon: '[assessment]', noun: 'assessment' },
  submission: { icon: '[submission]', noun: 'submission' },
  material:   { icon: '[material]',   noun: 'material' },
  info:       { icon: '[announcement]', noun: 'announcement' },
};

// A row identifies itself by its contents.
//
// The portal does NOT return rows in a stable order - the same assessment
// list comes back shuffled between two scrapes minutes apart - and it numbers
// rows by their position in that shuffle. Including that serial in the key
// made every reordered row look brand new, which is why a course would
// re-announce its whole assessment list on every poll. The leading serial is
// therefore dropped, so a row is identified only by what it actually says.
const rowKey = (r) => {
  const cells = (r ?? []).map((c) => String(c ?? '').trim());
  if (/^[0-9]+$/.test(cells[0] ?? '')) cells.shift();
  return cells.slice(0, 5).join(' | ');
};

function tableRows(tabs, tab) {
  const t = tabs?.[tab];
  if (!Array.isArray(t)) return [];
  return t.flatMap((x) => x.rows ?? []);
}

function diffMarks(prev, next, course, events) {
  const index = (marks) => {
    const m = new Map();
    for (const cat of marks ?? []) {
      for (const it of cat.items ?? []) m.set(`${cat.category}::${it.name}`, { ...it, category: cat.category });
    }
    return m;
  };
  const before = index(prev?.marks);
  const after = index(next.marks);
  const head = headingLines(course);

  for (const [key, it] of after) {
    const old = before.get(key);
    const score = `${it.obtained}/${it.maxMark} (${it.percent}%)`;
    const avg = it.classAverage != null ? NL + `class avg ${it.classAverage}` : '';

    if (!old) {
      events.push({ kind: 'mark', priority: 1, text: `[marks] ${head}${NL}${it.name}: ${score}${avg}` });
    } else if (old.obtained !== it.obtained) {
      events.push({ kind: 'mark', priority: 1, text: `[marks updated] ${head}${NL}${it.name}: ${old.obtained} -> ${score}${avg}` });
    }
  }

  // Category totals move when a teacher finalises a component.
  for (const cat of next.marks ?? []) {
    const old = (prev?.marks ?? []).find((c) => c.category === cat.category);
    if (old && old.obtainedPercent !== cat.obtainedPercent && cat.obtainedPercent != null) {
      events.push({
        kind: 'mark', priority: 2,
        text: `[total] *${abbreviate(course.name) || course.code}* ${cat.category}`
          + NL + `${old.obtainedPercent ?? '-'}% -> ${cat.obtainedPercent}%`,
      });
    }
  }
}

// Portal timestamps carry no timezone. They are Pakistan time (UTC+5);
// parsing them naively would shift every deadline on a UTC server.
const PK_OFFSET = '+05:00';
export function parsePk(value) {
  const m = /^([0-9]{4}-[0-9]{2}-[0-9]{2})(?:[ T]([0-9]{1,2}:[0-9]{2}))?/.exec(String(value ?? '').trim());
  if (!m) return NaN;
  const time = (m[2] ?? '00:00').padStart(5, '0');
  return Date.parse(`${m[1]}T${time}:00${PK_OFFSET}`);
}

export function formatPk(date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Karachi', weekday: 'short', day: '2-digit',
    month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(date);
}

// Several new rows in one tab usually arrive together - a teacher uploading a
// week of slides, or the portal exposing a whole assessment list at once.
// One message per row turns that into a burst of notifications, so rows that
// share a heading are merged into a single message.
function collapse(raw) {
  const order = [];
  const groups = new Map();

  for (const e of raw) {
    if (!e.group) { order.push(e); continue; }
    let g = groups.get(e.group);
    if (!g) { g = { ...e, lines: [] }; groups.set(e.group, g); order.push(g); }
    g.lines.push(e.line);
  }

  return order.map((e) => {
    if (!e.lines) return e;
    const shown = e.lines.slice(0, MAX_LISTED);
    const hidden = e.lines.length - shown.length;
    const body = [
      e.heading,
      e.lines.length === 1 ? `New ${e.noun}:` : `${e.lines.length} new ${e.noun}s:`,
      ...shown.map((l) => '- ' + l),
    ];
    if (hidden > 0) body.push(`...and ${hidden} more`);
    return { kind: e.kind, priority: e.priority, text: `${e.icon} ${body.join(NL)}` };
  });
}

export function diffSnapshots(prev, next) {
  const events = [];
  const prevCourses = new Map((prev?.courses ?? []).map((c) => [c.id, c]));

  for (const course of next.courses ?? []) {
    const old = prevCourses.get(course.id);
    diffMarks(old, course, course, events);
    const heading = headingLines(course);

    for (const [tab, meta] of Object.entries(COURSE_TABS)) {
      const before = tableRows(old?.tabs, tab);
      // A tab that failed to load comes back empty. Treating that as "every
      // row is new" would re-announce the whole tab on the next good scrape,
      // so a tab with no previous rows at all is taken as a baseline.
      if (!before.length) continue;

      const seen = new Set(before.map(rowKey));
      for (const row of tableRows(course.tabs, tab)) {
        if (seen.has(rowKey(row))) continue;
        const cells = row.filter((c) => c && c.trim() && !/^[0-9]+$/.test(c));
        if (!cells.length) continue;
        events.push({
          kind: tab, priority: tab === 'info' ? 2 : 1,
          group: `${course.id}:${tab}`,
          icon: meta.icon, noun: meta.noun, heading,
          line: cells.join(' | '),
        });
      }
    }
  }

  // Global pages: exam datesheet and notifications.
  for (const key of ['datesheet', 'notifications']) {
    const before = (prev?.global?.[key] ?? []).flatMap((t) => t.rows ?? []);
    if (!before.length) continue;
    const seen = new Set(before.map(rowKey));
    for (const row of (next.global?.[key] ?? []).flatMap((t) => t.rows ?? [])) {
      if (seen.has(rowKey(row))) continue;
      const cells = row.filter((c) => c && c.trim() && !/^[0-9]+$/.test(c));
      if (!cells.length) continue;
      events.push({ kind: key, priority: 2, text: `[${key}]${NL}${cells.join(' | ')}` });
    }
  }

  return collapse(events).sort((a, b) => a.priority - b.priority);
}

// Deadlines are not a diff - they are a scheduled look-ahead.
export function upcomingDeadlines(snapshot, withinDays = 3) {
  const now = Date.now();
  const limit = now + withinDays * 864e5;
  const out = [];

  for (const course of snapshot.courses ?? []) {
    for (const tab of ['assessment', 'submission']) {
      for (const row of tableRows(course.tabs, tab)) {
        const due = row.map(parsePk).find((t) => !Number.isNaN(t) && t > now && t < limit);
        if (due) out.push({ course: `${course.code} ${course.name}`, item: row[1] || row[0], due: new Date(due) });
      }
    }
  }
  // Final exams live on the global datesheet, not on a course tab.
  for (const t of snapshot.global?.datesheet ?? []) {
    for (const row of t.rows ?? []) {
      const startTime = (row[4] || '').split('-')[0].trim();
      const due = parsePk(`${row[3]} ${startTime}`);
      if (!Number.isNaN(due) && due > now && due < limit) {
        out.push({ course: row[1], item: 'Final exam', due: new Date(due) });
      }
    }
  }

  return out.sort((a, b) => a.due - b.due);
}

if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1] ?? '').href) {
  const { readFileSync } = await import('node:fs');
  const [a, b] = process.argv.slice(2);
  const events = diffSnapshots(
    a ? JSON.parse(readFileSync(a, 'utf8')) : { courses: [] },
    JSON.parse(readFileSync(b ?? 'out/snapshot.json', 'utf8')),
  );
  console.log(events.length ? events.map((e) => e.text).join(NL + NL + '---' + NL + NL) : 'No changes.');
}
