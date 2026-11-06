// Probes the CUST Odoo portal using a session_id cookie copied from your browser.
// Needed because student accounts are Microsoft-OAuth only and have no local password.
// Run: node --env-file=.env probe-session.mjs

import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = 'https://odoo.cust.edu.pk';
const SID = (process.env.CUST_SESSION || '').trim().replace(/^session_id=/, '');

if (!SID) {
  console.error('Set CUST_SESSION in .env to the session_id cookie value from your browser.');
  process.exit(1);
}

mkdirSync('out', { recursive: true });
const cookie = `session_id=${SID}`;

const req = (p, o = {}) => fetch(BASE + p, {
  ...o, redirect: 'manual',
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    Cookie: cookie, ...(o.headers ?? {}),
  },
});

const rpc = async (p, params = {}) => {
  const r = await req(p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params }),
  });
  try { return await r.json(); } catch { return { error: { message: `HTTP ${r.status}` } }; }
};

console.log('1. Checking session...');
const info = await rpc('/web/session/get_session_info');
if (info.error) {
  console.error(`   Session rejected: ${info.error.message}`);
  console.error('   The cookie is wrong or expired - copy a fresh one.');
  process.exit(1);
}
const r = info.result ?? {};
console.log(`   Valid. db=${r.db} uid=${r.uid} user=${r.username}`);
writeFileSync('out/session-info.json', JSON.stringify(r, null, 2));

console.log('2. Testing direct model access (lets us skip HTML parsing)...');
const probe = await rpc('/web/dataset/call_kw', {
  model: 'ir.model', method: 'search_read',
  args: [[['model', 'like', 'student']], ['model', 'name']],
  kwargs: { limit: 40 },
});
if (probe.error) {
  console.log(`   Denied (normal for a portal user) -> we parse HTML instead.`);
} else {
  console.log('   ALLOWED. Visible student models:');
  for (const m of probe.result ?? []) console.log(`      ${m.model}  (${m.name})`);
  writeFileSync('out/models.json', JSON.stringify(probe.result, null, 2));
}

console.log('3. Fetching /student/dashboard...');
const dash = await req('/student/dashboard');
const html = await dash.text();
console.log(`   HTTP ${dash.status}, ${html.length} bytes`);
if (dash.status !== 200) {
  console.error('   Redirected - session not accepted for this route.');
  process.exit(1);
}
writeFileSync('out/dashboard.html', html);
console.log('   Saved out/dashboard.html');

const title = /<title>([^<]*)<\/title>/.exec(html)?.[1]?.trim();
if (title) console.log(`   Title: ${title}`);

const heads = [...new Set([...html.matchAll(/<h[1-4][^>]*>\s*([^<]{2,80}?)\s*<\/h[1-4]>/gi)].map(m => m[1].trim()))];
if (heads.length) console.log(`   Sections: ${heads.join(' | ')}`);

const routes = [...new Set([...html.matchAll(/href="(\/[^"#?]*)"/g)].map(m => m[1])
  .filter(h => h.length > 1 && !/\/(web\/static|_|auth_oauth)/.test(h)))].sort();
console.log(`\n   ${routes.length} internal routes found:`);
for (const x of routes) console.log(`      ${x}`);
writeFileSync('out/routes.json', JSON.stringify(routes, null, 2));
console.log('\nDone.');
