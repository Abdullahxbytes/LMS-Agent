// Small authenticated fetch helper for live lookups between full scrapes.

import * as cheerio from 'cheerio';
import { getSession } from './session.mjs';

const BASE = 'https://odoo.cust.edu.pk';
// Same limit as scrape.mjs: a hung portal must fail a request, not stall the
// bot's tick indefinitely.
const REQUEST_TIMEOUT_MS = 180_000;

export class SessionExpired extends Error {}

// An authenticated GET that has already been checked: a redirect means the
// session is gone, anything but 200 is an error. The caller reads the body.
export async function portalFetch(path, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const sid = getSession();
  if (!sid) throw new Error('No portal session set');

  const res = await fetch(BASE + path, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual',
    headers: { Cookie: `session_id=${sid}`, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  if (res.status === 303 || res.status === 302) throw new SessionExpired(path);
  if (res.status !== 200) throw new Error(`HTTP ${res.status} on ${path}`);
  return res;
}

export async function getPage(path) {
  return (await portalFetch(path)).text();
}

// Attendance rows for one course: [srNo, date, status, fine].
export async function attendanceRows(courseId) {
  const $ = cheerio.load(await getPage(`/student/course/attendance/${courseId}`));
  $('script, style, nav, header, footer').remove();

  const rows = [];
  $('table').each((_, table) => {
    $(table).find('tr').each((__, tr) => {
      const cells = $(tr).find('th,td').toArray().map((c) => $(c).text().replace(/\s+/g, ' ').trim());
      if (cells.length >= 3) rows.push(cells);
    });
  });
  return rows;
}

// Cheap liveness check for a candidate cookie, without disturbing the
// stored one.
export async function checkSession(sid) {
  // Shorter than a page fetch: login.mjs polls this once a second inside a
  // 90-second window, so one check must not be able to eat the whole window.
  const res = await fetch('https://odoo.cust.edu.pk/student/dashboard', {
    signal: AbortSignal.timeout(30_000),
    redirect: 'manual',
    headers: { Cookie: `session_id=${sid}`, 'User-Agent': 'Mozilla/5.0' },
  });
  return res.status === 200;
}
