// Parses the weekly class timetable from /student/class/schedule.
// The page uses the CodyHouse schedule component, which stores each class's
// times in data-start / data-end attributes on the event anchor.

import * as cheerio from 'cheerio';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const txt = (s) => (s || '').replace(/\s+/g, ' ').trim();

export function parseTimetable(html) {
  const $ = cheerio.load(html);
  $('script, style').remove();

  const slots = [];
  $('.cd-schedule__group').each((_, group) => {
    const day = txt($(group).find('.cd-schedule__top-info').first().text());
    const dayIndex = DAYS.indexOf(day);
    if (dayIndex < 0) return;

    $(group).find('.cd-schedule__event').each((__, ev) => {
      const a = $(ev).find('a[data-start]').first();
      const start = a.attr('data-start');
      const end = a.attr('data-end');
      if (!start) return;

      const full = txt($(ev).text());
      const sec = /([A-Z]{2,6}[0-9]{4})-([0-9]{3}-[A-Z]{2,4}-[0-9]{3}-[0-9])/.exec(full);

      // Child nodes render as: teacher, course title, section code, room, kind.
      const parts = $(ev).find('em, span').toArray().map((e) => txt($(e).text())).filter(Boolean);
      const sectionFull = sec ? `${sec[1]}-${sec[2]}` : null;
      const title = parts.find((p) => p !== parts[0] && !p.includes(sectionFull ?? '\u0000') && p.length > 4) ?? null;

      slots.push({
        day, dayIndex, start, end,
        code: sec?.[1] ?? null,
        section: sectionFull,
        teacher: parts[0] ?? null,
        title,
        kind: /lab/i.test(full) ? 'Lab' : 'Lecture',
      });
    });
  });

  slots.sort((a, b) => a.dayIndex - b.dayIndex || a.start.localeCompare(b.start));

  // Labs occupy several back-to-back slots; each one is attended separately,
  // so number them per course per day to match attendance rows in order.
  const counters = new Map();
  for (const s of slots) {
    const key = `${s.dayIndex}|${s.code}`;
    const n = counters.get(key) ?? 0;
    s.slotIndex = n;
    counters.set(key, n + 1);
  }
  return slots;
}

// Minutes since midnight, Pakistan time.
export const toMinutes = (hhmm) => {
  const m = /^([0-9]{1,2}):([0-9]{2})$/.exec(hhmm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

export function slotsForDay(timetable, dayIndex) {
  return timetable.filter((s) => s.dayIndex === dayIndex).sort((a, b) => a.start.localeCompare(b.start));
}

if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1] ?? '').href) {
  const { readFileSync } = await import('node:fs');
  const slots = parseTimetable(readFileSync('out/pages/schedule.html', 'utf8'));
  let day = '';
  for (const s of slots) {
    if (s.day !== day) { day = s.day; console.log(`\n${day}`); }
    console.log(`  ${s.start}-${s.end}  ${String(s.code).padEnd(9)} #${s.slotIndex}  ${String(s.kind).padEnd(7)} ${s.teacher}`);
  }
  console.log(`\n${slots.length} slots/week`);
}
