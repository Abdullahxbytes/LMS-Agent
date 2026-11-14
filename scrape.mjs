// Scrapes the CUST Odoo student portal into one structured JSON snapshot.
// Snapshots are what the notifier diffs and what the chat bot queries.
// Run: node --env-file=.env scrape.mjs

import { writeFileSync, mkdirSync, renameSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { parseTimetable } from './timetable.mjs';
import { getSession } from './session.mjs';

const BASE = 'https://odoo.cust.edu.pk';
const SID = getSession();
if (!SID) { console.error('CUST_SESSION missing in .env'); process.exit(1); }

// Per-course tabs. 'outline' is static all term, so it is not polled here.
const COURSE_TABS = ['gradebook', 'assessment', 'submission', 'material', 'info', 'attendance'];
const GLOBAL_PAGES = {
  results: '/student/results',
  datesheet: '/student/exam/datesheet',
  notifications: '/student/notifications',
  invoices: '/student/invoices',
};

class SessionExpired extends Error {}

// Without a limit, Node waits up to five minutes for a page that never
// arrives, and a hung portal kept a scrape alive long enough for the next
// one to start on top of it. Pages are ~1 MB, so this is generous; a tab
// that times out is recorded as an error, which the diff treats as no change.
const REQUEST_TIMEOUT_MS = 180_000;

async function get(path) {
  const res = await fetch(BASE + path, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: 'manual',
    headers: { Cookie: `session_id=${SID}`, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  if (res.status === 303 || res.status === 302) throw new SessionExpired(path);
  if (res.status !== 200) throw new Error(`HTTP ${res.status} on ${path}`);
  return res.text();
}

const txt = (s) => (s || '').replace(/\s+/g, ' ').trim();
const ownText = ($, el) => txt($(el).clone().children().remove().end().text());

// The portal renders everything as tables. Each is captured with its nearest
// heading so we know what it represents without hardcoding page layouts.
function extractTables(html) {
  const $ = cheerio.load(html);
  $('script, style, nav, header, footer').remove();

  const out = [];
  $('table').each((_, el) => {
    const $t = $(el);
    let label = txt($t.prevAll('h1,h2,h3,h4,h5,strong,.md-card-toolbar-heading-text').first().text());
    if (!label) {
      for (const p of $t.parentsUntil('body').toArray()) {
        const h = txt($(p).find('h1,h2,h3,h4,h5,.md-card-toolbar-heading-text').first().text());
        if (h) { label = h; break; }
      }
    }

    if (label.includes('Course Outline') && label.includes('Grade Book')) label = '';
    const rows = $t.find('tr').toArray().filter((tr) => $(tr).closest('table').get(0) === el)
      .map((tr) => $(tr).find('th,td').toArray().map((c) => txt($(c).text())))
      .filter((r) => r.some((c) => c !== ''));

    const headIdx = rows.findIndex((r) => r.length > 1);
    if (headIdx < 0) return;
    const columns = rows[headIdx];
    const data = rows.slice(headIdx + 1).filter((r) => r.length >= 2);

    out.push({ label, columns, rows: data });
  });
  return out;
}

// Each enrolled-course card is a .md-card wrapping a link that embeds the
// course's opaque id.
function extractCourses(html) {
  const $ = cheerio.load(html);
  $('script, style').remove();
  const seen = new Map();

  $('a[href*="/student/course/"]').each((_, a) => {
    const id = /\/student\/course\/[a-z_]+\/([A-Za-z0-9]+)/.exec($(a).attr('href') || '')?.[1];
    if (!id || seen.has(id)) return;

    const card = $(a).closest('.md-card');
    const body = txt((card.length ? card : $(a).parent()).text());

    seen.set(id, {
      id,
      code: /\b([A-Z]{2,5}\d{4})\b/.exec(body)?.[1] ?? null,
      name: txt(/^(?:FOC\s*)?(.+?)\s*[A-Z]{2,5}\d{4}/.exec(body)?.[1] ?? body.slice(0, 60)),
      credits: /Credits:\s*([\d.]+)/.exec(body)?.[1] ?? null,
      type: /Course Type:\s*(\w+)/.exec(body)?.[1] ?? null,
      term: /((?:Fall|Spring|Summer)\s*\d{4})/.exec(body)?.[1] ?? null,
    });
  });
  return [...seen.values()];
}

// Course pages carry "Name (CODE-SECTION)" in a link - the authoritative title.
function extractCourseTitle(html) {
  const $ = cheerio.load(html);
  $('script, style').remove();
  for (const el of $('a, h1, h2, h3, span').toArray()) {
    const m = /^(.+?)\s*\(\s*([A-Z]{2,5}\d{4}[\w-]*)\s*\)$/.exec(ownText($, el));
    if (m) return { name: txt(m[1]), section: m[2] };
  }
  return null;
}

// The gradebook is one flat table alternating 2-column category rows
// ("Quiz 15.0 %" | "55.00") with 5-column per-assessment detail rows.
function parseGradebook(html) {
  const $ = cheerio.load(html);
  $('script, style').remove();
  const table = $('table').first();
  if (!table.length) return [];

  const categories = [];
  let current = null;

  table.find('tr').each((_, tr) => {
    const cells = $(tr).find('th,td').toArray();
    const vals = cells.map((c) => txt($(c).text()));
    if (cells.every((c) => c.tagName === 'th')) return;
    if (vals.every((v) => v === '')) return;

    const num = (v) => (v === '' || v == null ? null : Number(v));

    if (vals.length === 2) {
      const m = /^(.*?) ([0-9.]+) ?%$/.exec(vals[0]);
      current = {
        category: txt(m ? m[1] : vals[0]),
        weight: m ? Number(m[2]) : null,
        obtainedPercent: num(vals[1]),
        items: [],
      };
      categories.push(current);
    } else if (vals.length === 5 && current) {
      current.items.push({
        name: vals[0],
        maxMark: num(vals[1]),
        obtained: num(vals[2]),
        classAverage: num(vals[3]),
        percent: num(vals[4]),
      });
    }
  });
  return categories;
}
// The attendance page states its own totals; trusting them avoids
// re-deriving a percentage from rows (where 'Leave' also counts against you).
function parseAttendanceSummary(html) {
  const flat = cheerio.load(html)('body').text().replace(/[\s]+/g, ' ');
  const m = /Conducted\s*:?\s*([0-9]+).{0,100}?Attended\s*:?\s*([0-9]+).{0,150}?Attendance Percentage\s*:?\s*([0-9.]+)/.exec(flat);
  if (!m) return null;
  return { conducted: Number(m[1]), attended: Number(m[2]), percent: Number(m[3]) };
}

const snapshot = { fetchedAt: new Date().toISOString(), courses: [], global: {} };

try {
  console.log('Fetching course list...');
  const courses = extractCourses(await get('/student/enrolled/courses'));
  console.log(`  ${courses.length} courses\n`);

  for (const c of courses) {
    const entry = { ...c, tabs: {} };
    for (const tab of COURSE_TABS) {
      try {
        const html = await get(`/student/course/${tab}/${c.id}`);
        if (!entry.section) Object.assign(entry, extractCourseTitle(html) ?? {});
        if (tab === 'gradebook') entry.marks = parseGradebook(html);
        if (tab === 'attendance') entry.attendance = parseAttendanceSummary(html);
        entry.tabs[tab] = extractTables(html);
      } catch (e) {
        if (e instanceof SessionExpired) throw e;
        entry.tabs[tab] = { error: e.message };
      }
    }
    const marks = (entry.marks ?? []).reduce((n, c) => n + c.items.length, 0);
    const assess = (entry.tabs.assessment ?? []).reduce((n, t) => n + (t.rows?.length ?? 0), 0);
    const att = entry.attendance ? `${String(entry.attendance.percent).padStart(6)}% att` : '      - att';
    console.log(`  ${(entry.code ?? '?').padEnd(9)} ${entry.name.slice(0, 36).padEnd(38)} ${String(marks).padStart(2)} marks ${String(assess).padStart(2)} assess ${att}`);
    snapshot.courses.push(entry);
  }

  console.log('\nFetching global pages...');
  for (const [key, path] of Object.entries(GLOBAL_PAGES)) {
    try {
      snapshot.global[key] = extractTables(await get(path));
      console.log(`  ${key}: ${snapshot.global[key].length} tables`);
    } catch (e) {
      if (e instanceof SessionExpired) throw e;
      snapshot.global[key] = { error: e.message };
    }
  }

  console.log('Fetching timetable...');
  snapshot.timetable = parseTimetable(await get('/student/class/schedule'));

  // The timetable grid truncates long course names; the enrolled-courses
  // list has them in full, so prefer those.
  const nameByCode = new Map(snapshot.courses.map((c) => [c.code, c.name]));
  for (const slot of snapshot.timetable) {
    if (nameByCode.has(slot.code)) slot.title = nameByCode.get(slot.code);
  }
  console.log(`  ${snapshot.timetable.length} weekly slots`);
} catch (e) {
  if (e instanceof SessionExpired) {
    console.error(`\nSESSION EXPIRED (redirected on ${e.message}). Paste a fresh CUST_SESSION into .env.`);
    process.exit(2);
  }
  throw e;
}

mkdirSync('out', { recursive: true });
// Written beside the real file and renamed over it, so the bot never reads a
// half-written snapshot. A rename within one directory is atomic.
writeFileSync('out/snapshot.json.tmp', JSON.stringify(snapshot, null, 2));
renameSync('out/snapshot.json.tmp', 'out/snapshot.json');
console.log(`\nSaved out/snapshot.json`);
