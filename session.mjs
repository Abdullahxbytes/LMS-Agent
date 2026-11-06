// Where the portal session cookie lives.
//
// The value can be replaced at runtime from WhatsApp, so a file written to
// out/ takes precedence over the environment variable. out/ is gitignored,
// which matters because this file holds a live credential.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const FILE = 'out/session.json';
const clean = (v) => (v || '').trim().replace(/^session_id=/, '');

export function getSession() {
  try {
    const stored = JSON.parse(readFileSync(FILE, 'utf8'));
    if (stored?.session) return clean(stored.session);
  } catch { /* fall back to the environment */ }
  return clean(process.env.CUST_SESSION);
}

export function setSession(value) {
  mkdirSync('out', { recursive: true });
  writeFileSync(FILE, JSON.stringify({ session: clean(value), updatedAt: new Date().toISOString() }, null, 2));
}

export const looksLikeSession = (v) => /^[0-9a-f]{40}$/.test(clean(v));
