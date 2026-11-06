// Submission and assessment deadline reminders.
//
// Each item is reminded at 5h, 3h and 1h before its due time. Replying "done"
// marks the most recent item finished so it stops reminding; "done <text>"
// targets a specific one.

import { abbreviate } from './courses.mjs';
import { parsePk } from './diff.mjs';

export const OFFSETS_HOURS = [5, 3, 1];

const txt = (s) => (s || '').trim();
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function colIndex(columns, name) {
  return (columns ?? []).findIndex((c) => norm(c) === norm(name));
}

// Pulls every dated item out of the submission and assessment tabs.
export function collectDeadlines(snapshot) {
  const items = [];

  for (const course of snapshot.courses ?? []) {
    for (const tab of ['submission', 'assessment']) {
      for (const table of course.tabs?.[tab] ?? []) {
        const iName = colIndex(table.columns, 'Name');
        const iDue = colIndex(table.columns, 'Due Date');
        if (iDue < 0) continue;

        for (const row of table.rows ?? []) {
          const due = parsePk(txt(row[iDue]));
          if (Number.isNaN(due)) continue;
          const name = txt(row[iName >= 0 ? iName : 1]) || 'Untitled';
          items.push({
            key: `${course.code}|${name}|${txt(row[iDue])}`,
            code: course.code, course: course.name,
            name, kind: tab, due: new Date(due),
          });
        }
      }
    }
  }
  return items.sort((a, b) => a.due - b.due);
}

export function deadlineReminders(snapshot, now = new Date(), state = {}, offsets = OFFSETS_HOURS) {
  const events = [];
  const sorted = [...offsets].sort((a, b) => b - a);

  for (const item of collectDeadlines(snapshot)) {
    const st = (state[item.key] ??= { done: false, fired: [] });
    if (st.done) continue;

    const hoursLeft = (item.due - now) / 3600000;
    if (hoursLeft < 0) continue;

    for (const offset of sorted) {
      if (hoursLeft > offset || st.fired.includes(offset)) continue;

      // Mark every larger window fired too, so an item discovered late does
      // not emit 5h, 3h and 1h reminders all at once.
      for (const o of sorted) if (o >= offset) if (!st.fired.includes(o)) st.fired.push(o);

      const left = hoursLeft < 1
        ? `${Math.max(1, Math.round(hoursLeft * 60))} min`
        : `${hoursLeft.toFixed(1)} h`;

      state.lastReminded = item.key;
      events.push({
        kind: 'deadline', key: item.key, hoursLeft,
        text: `[due in ${left}] *${abbreviate(item.course) || item.code} - ${item.name}*
${item.course}
Due ${new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Asia/Karachi', weekday: 'short', day: '2-digit',
          month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
        }).format(item.due)}
Reply "done" to stop reminders for this.`,
      });
      break;
    }
  }
  return { events, state };
}

// "done" on its own refers to the item reminded most recently.
export function markDone(snapshot, state, phrase = '') {
  const query = norm(phrase.replace(/^done/i, ''));

  if (!query) {
    const key = state.lastReminded;
    if (!key) return { ok: false, message: 'Nothing to mark done yet.' };
    (state[key] ??= { done: false, fired: [] }).done = true;
    return { ok: true, message: `Marked done: ${key.split('|').slice(0, 2).join(' ')}` };
  }

  const matches = collectDeadlines(snapshot)
    .filter((i) => norm(`${i.code} ${i.name} ${i.course}`).includes(query));

  if (!matches.length) return { ok: false, message: `No deadline matching "${phrase.trim()}".` };
  if (matches.length > 1) {
    return { ok: false, message: `Which one?\n${matches.map((m) => `- ${m.code} ${m.name}`).join('\n')}` };
  }
  (state[matches[0].key] ??= { done: false, fired: [] }).done = true;
  return { ok: true, message: `Marked done: ${matches[0].code} ${matches[0].name}` };
}
