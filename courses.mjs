// Course naming: short forms, display labels, and matching what you type.
//
// Course codes (CS3432) are what the portal uses, but nobody thinks in them -
// "PDC" and "Parallel and Distributed Computing" are what actually get said.
// Abbreviations are derived from the title rather than hardcoded, so a new
// semester's courses work without touching this file.

const STOP = new Set(['and', 'of', 'the', 'for', 'to', 'in', 'with', 'a', 'an', 'on']);

// Parallel and Distributed Computing -> PDC
// Numerical Computing Lab            -> NC Lab
// Technical and Business Writing     -> TBW
export function abbreviate(name) {
  if (!name) return '';
  const words = String(name).trim().split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!words.length) return '';

  // "Lab" is kept as a visible suffix: PDC and PDC Lab are different courses
  // with different attendance, and collapsing them would be confusing.
  const isLab = /^lab(oratory)?$/i.test(words[words.length - 1]);
  const core = isLab ? words.slice(0, -1) : words;

  const letters = core
    .filter((w) => !STOP.has(w.toLowerCase()))
    .map((w) => w[0].toUpperCase())
    .join('');

  if (!letters) return isLab ? 'Lab' : '';
  return isLab ? `${letters} Lab` : letters;
}

const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// "PDC" and "Parallel and Distributed Computing" -> PDC - Parallel and Distributed Computing (CS3432)
export function fullLabel(course) {
  const name = course?.name ?? course?.title ?? '';
  const code = course?.code ?? '';
  const abbr = abbreviate(name);
  if (!name) return code;
  const head = abbr && abbr !== name ? `${abbr} - ${name}` : name;
  return code ? `${head} (${code})` : head;
}

// A two-line heading: short form and code on one line, the full title on the
// next. One line carrying all three runs to ~60 characters, which wraps badly
// on a phone.
export function headingLines(course) {
  const name = course?.name ?? course?.title ?? '';
  const code = course?.code ?? '';
  const abbr = abbreviate(name) || code;
  const top = code && abbr !== code ? `*${abbr}* (${code})` : `*${abbr}*`;
  return name && name !== abbr ? top + String.fromCharCode(10) + name : top;
}

// For dense listings like a timetable, where the full title does not fit.
export function shortLabel(course) {
  return abbreviate(course?.name ?? course?.title ?? '') || course?.code || '';
}

// Accepts a course code, the full name, part of the name, or the short form.
// "pdc", "PDC", "p d c", "parallel", "cs3432" all find the same course.
export function matches(course, query) {
  const raw = String(query ?? '').toLowerCase().trim();
  if (!raw) return true;

  const code = (course?.code ?? '').toLowerCase();
  const name = (course?.name ?? course?.title ?? '').toLowerCase();
  if (code.includes(raw)) return true;

  // A short query must start a word, or it matches by accident: "nc" is a
  // substring of "Intelligence". Longer queries are specific enough to match
  // anywhere in the title, which keeps "distributed" working.
  const words = name.split(/[^a-z0-9]+/).filter(Boolean);
  if (raw.length >= 4 ? name.includes(raw) : words.some((w) => w.startsWith(raw))) return true;

  const q = squash(raw);
  if (!q) return false;

  const abbr = squash(abbreviate(course?.name ?? course?.title ?? ''));
  if (!abbr) return false;

  // A prefix match lets "pdc" find both "PDC" and "PDC Lab", which is what
  // someone asking about a subject usually wants. Single letters are too
  // broad to be useful, so they are not treated as an abbreviation.
  return q.length >= 2 && abbr.startsWith(q);
}

export function findCourses(snapshot, query) {
  const all = snapshot?.courses ?? [];
  if (!String(query ?? '').trim()) return all;
  return all.filter((c) => matches(c, query));
}
