// Course files: listed from the stored snapshot, fetched live when asked for.
//
// The download link is read from the portal at the moment a file is asked
// for rather than kept in the snapshot. That costs one extra page fetch, but
// a link is never stale and snapshots taken before this existed still work.

import * as cheerio from 'cheerio';
import { portalFetch, getPage } from './portal.mjs';

// WhatsApp takes far larger documents, but the whole file is held in memory
// on its way through, and course files this size are rare. A bigger one is
// refused with a clear message rather than risking the bot's memory.
export const MAX_FILE_MB = 64;
// Generous because a file is a single long transfer, not a ~1 MB page.
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// [{ sr, name, desc }] from the stored material tab, in upload order.
export function materialsOf(course) {
  const out = [];
  for (const t of course?.tabs?.material ?? []) {
    if (!Array.isArray(t.rows)) continue;
    const cols = (t.columns ?? []).map(norm);
    const iSr = cols.findIndex((c) => c.startsWith('sr'));
    const iName = cols.findIndex((c) => c.includes('file'));
    const iDesc = cols.indexOf('description');
    for (const r of t.rows) {
      const name = String(r[iName >= 0 ? iName : 1] ?? '').trim();
      if (!name) continue;
      out.push({
        sr: Number(r[iSr >= 0 ? iSr : 0]) || out.length + 1,
        name,
        desc: iDesc >= 0 ? String(r[iDesc] ?? '').trim() : '',
      });
    }
  }
  return out.sort((a, b) => a.sr - b.sr);
}

// Every file across all courses whose name or description contains all the
// words asked for.
export function searchMaterials(snapshot, query) {
  const words = norm(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  const hits = [];
  for (const course of snapshot?.courses ?? []) {
    for (const m of materialsOf(course)) {
      const hay = norm(`${m.name} ${m.desc}`);
      if (words.every((w) => hay.includes(w))) hits.push({ course, ...m });
    }
  }
  return hits;
}

// The live material page, with each row's download link.
// Rows look like: Sr | file name | description | <a href="/student/class/material/download/<id>">
export async function liveMaterials(course) {
  const $ = cheerio.load(await getPage(`/student/course/material/${course.id}`));
  const out = [];
  $('table tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 2) return;
    const href = $(tr).find('a[href*="/download/"]').attr('href');
    if (!href) return;
    const text = cells.toArray().map((c) => $(c).text().replace(/\s+/g, ' ').trim());
    out.push({ sr: Number(text[0]) || null, name: text[1], href });
  });
  return out;
}

// The portal's own type is sometimes a raw container guess - an old .ppt
// comes back as application/cdfv2 - which leaves the phone unsure what can
// open it. For the usual course formats the extension is the better guide.
const MIME_BY_EXT = {
  pdf: 'application/pdf',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

// RFC 5987 filename*=UTF-8''... first, then a plain filename=.
function fileNameFrom(disposition) {
  const star = /filename\*\s*=\s*([^']*)''([^;]+)/i.exec(disposition ?? '');
  if (star) {
    try { return decodeURIComponent(star[2].trim()); } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition ?? '');
  return plain ? plain[1].trim() : null;
}

export async function downloadMaterial(href, fallbackName) {
  const res = await portalFetch(href, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
  const limit = MAX_FILE_MB * 1024 * 1024;

  const declared = Number(res.headers.get('content-length'));
  if (declared > limit) {
    await res.body?.cancel();
    throw new Error(`File is ${(declared / 1048576).toFixed(0)} MB, over the ${MAX_FILE_MB} MB limit.`);
  }

  // Counted while streaming too, in case the length header is missing.
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > limit) throw new Error(`File is over the ${MAX_FILE_MB} MB limit.`);
    chunks.push(chunk);
  }

  const mimetype = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  // A login or error page served with a 200 would otherwise be delivered as
  // the "file". Course materials are never HTML.
  if (/^text\/html$/i.test(mimetype)) throw new Error('The portal returned a web page instead of the file.');

  const fileName = fileNameFrom(res.headers.get('content-disposition')) || fallbackName;
  const ext = /\.([a-z0-9]+)$/i.exec(fileName ?? '')?.[1]?.toLowerCase();
  return {
    data: Buffer.concat(chunks),
    fileName,
    mimetype: MIME_BY_EXT[ext] || mimetype || 'application/octet-stream',
  };
}
