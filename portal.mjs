// Small authenticated fetch helper for live lookups between full scrapes.

import * as cheerio from 'cheerio';
import { getSession } from './session.mjs';

const BASE = 'https://odoo.cust.edu.pk';

export class SessionExpired extends Error {}

export async function getPage(path) {
  const sid = getSession();
  if (!sid) throw new Error('No portal session set');

  const res = await fetch(BASE + path, {
    redirect: 'manual',
    headers: { Cookie: `session_id=${sid}`, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  if (res.status === 303 || res.status === 302) throw new SessionExpired(path);
  if (res.status !== 200) throw new Error(`HTTP ${res.status} on ${path}`);
  return res.text();
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
  const res = await fetch('https://odoo.cust.edu.pk/student/dashboard', {
    redirect: 'manual',
    headers: { Cookie: `session_id=${sid}`, 'User-Agent': 'Mozilla/5.0' },
  });
  return res.status === 200;
}
