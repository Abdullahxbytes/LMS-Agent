// Logs into the portal with Microsoft and returns a fresh Odoo session cookie,
// so the bot no longer depends on a cookie pasted by hand.
//
// The portal's students are Microsoft-OAuth-only: there is no local Odoo
// password to POST to /web/login. The sign-in button starts a normal OAuth2
// authorization-code flow at login.microsoftonline.com, which needs a real
// browser - it is a JavaScript form with hidden anti-forgery fields and a
// flow token that changes on every load. Driving a headless browser through
// it is far more robust than trying to replay those requests by hand.
//
// The CUST tenant is "Managed" (passwords checked by Azure AD directly, no
// on-prem ADFS hop), which keeps this to two form fills.
//
//   node --env-file=.env login.mjs           log in and store the cookie
//   node --env-file=.env login.mjs --show    same, with a visible browser
//
// Needs CUST_EMAIL and CUST_PASSWORD in .env.

import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { setSession } from './session.mjs';
import { checkSession } from './portal.mjs';

const LOGIN_URL = 'https://odoo.cust.edu.pk/web/login';
const PORTAL_HOST = 'odoo.cust.edu.pk';

// Locally we drive the installed Edge, which avoids downloading a browser.
// A Linux host has no Edge, so PLAYWRIGHT_CHANNEL= (empty) falls back to the
// bundled Chromium that `npx playwright install chromium` provides.
const channel = process.env.PLAYWRIGHT_CHANNEL ?? 'msedge';

class LoginFailed extends Error {}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Microsoft's sign-in markup carries stable ids, but it also A/B tests the
// surrounding page, so each step accepts a couple of alternatives.
const EMAIL_BOX = 'input[type="email"], input[name="loginfmt"]';
const PASSWORD_BOX = 'input[type="password"], input[name="passwd"]';
const SUBMIT = '#idSIButton9, input[type="submit"], button[type="submit"]';

async function textOfError(page) {
  const box = page.locator('#passwordError, #usernameError, .alert-error, [role="alert"]').first();
  try {
    if (await box.isVisible({ timeout: 1000 })) return (await box.innerText()).trim();
  } catch { /* no error box on the page */ }
  return null;
}

// Which of the known interruptions, if any, the page is currently showing.
async function classify(page) {
  const checks = [
    ['rejected', '#passwordError, #usernameError'],
    ['mfa', '#idDiv_SAOTCS_Proofs, #idTxtBx_SAOTCC_OTC'],
    ['stay-signed-in', '#idSIButton9[value="Yes"], #acceptButton'],
  ];
  for (const [name, selector] of checks) {
    const hit = await page.locator(selector).first().isVisible({ timeout: 250 }).catch(() => false);
    if (hit) return name;
  }
  return null;
}

export async function fetchSessionViaLogin({ headless = true, log = console.log } = {}) {
  const email = process.env.CUST_EMAIL;
  const password = process.env.CUST_PASSWORD;
  if (!email || !password) {
    throw new LoginFailed('CUST_EMAIL and CUST_PASSWORD must be set in .env');
  }

  const browser = await chromium.launch({ headless, channel: channel || undefined });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    if (process.env.LOGIN_DEBUG) {
      const watch = (pg, tag) => {
        pg.on('framenavigated', (f) => { if (!f.parentFrame()) log('[' + tag + '] -> ' + f.url().slice(0, 120)); });
        pg.on('close', () => log('[' + tag + '] closed'));
        pg.on('crash', () => log('[' + tag + '] CRASHED'));
      };
      watch(page, 'p0');
      context.on('page', (pg) => { log('[new page opened]'); watch(pg, 'pN'); });
    }

    // The portal tab can close the instant the OAuth redirect lands, taking
    // the cookie store with it - so collect every session id the moment it
    // appears instead of reading cookies once at the end.
    const candidates = new Set();
    const harvest = async () => {
      for (const c of await context.cookies().catch(() => [])) {
        if (c.name === 'session_id' && c.value) candidates.add(c.value);
      }
    };
    // headers() collapses repeated Set-Cookie headers; headersArray() keeps
    // each one, which matters because the redirect chain can set several.
    context.on('response', async (res) => {
      const all = await res.headersArray().catch(() => []);
      for (const h of all) {
        if (h.name.toLowerCase() !== 'set-cookie') continue;
        if (process.env.LOGIN_DEBUG) log('[set-cookie] ' + h.value.slice(0, 80));
        for (const m of String(h.value).matchAll(/session_id=([A-Za-z0-9]{20,})/g)) candidates.add(m[1]);
      }
    });
    page.on('framenavigated', (f) => { if (!f.parentFrame()) harvest(); });

    log('opening the portal login page');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Follow the page's own Microsoft link rather than a hardcoded authorize
    // URL, so a change of client_id or scopes by the university still works.
    const msLink = page.locator('a[href*="login.microsoftonline.com"]').first();
    if (!(await msLink.count())) throw new LoginFailed('No Microsoft sign-in link on the login page');
    await msLink.click();

    await page.waitForURL(/login\.microsoftonline\.com/, { timeout: 60000 });

    log('entering email');
    await page.waitForSelector(EMAIL_BOX, { timeout: 30000 });
    await page.fill(EMAIL_BOX, email);
    await page.click(SUBMIT);

    log('entering password');
    await page.waitForSelector(PASSWORD_BOX, { state: 'visible', timeout: 30000 });
    await page.fill(PASSWORD_BOX, password);
    await page.click(SUBMIT);

    // From here either we land back on the portal, or Microsoft stops us with
    // "Stay signed in?", a wrong-password error, or an unexpected MFA prompt.
    // Rather than racing on URLs, wait for the thing we actually want: the
    // Odoo session cookie. The redirect chain back from Microsoft passes
    // through several hosts and can close or replace the page underneath us,
    // which is what made waiting on the final URL flaky.
    // Odoo hands out a session_id to anonymous visitors the moment /web/login
    // is opened, so "a cookie exists" means nothing. The only reliable signal
    // that the OAuth round trip finished is the portal accepting the cookie,
    // so poll that instead. It also covers Odoo rotating the id on login.
    const deadline = Date.now() + 90000;
    let accepted = null;
    const tried = new Set();

    while (Date.now() < deadline && !accepted) {
      await harvest();

      // Odoo issues a session_id to anonymous visitors too, so the only proof
      // a cookie is the logged-in one is the portal accepting it.
      // Odoo does not issue a new id on login - it upgrades the anonymous one
      // in place. So the same cookie must be re-tested until it starts
      // working; checking each value only once never sees it flip.
      for (const value of candidates) {
        if (!tried.has(value)) {
          tried.add(value);
          log('watching cookie ' + value.slice(0, 8) + '...');
        }
        const ok = await checkSession(value);
        if (process.env.LOGIN_DEBUG) log('[check] ' + value.slice(0, 8) + ' -> ' + ok);
        if (ok) { accepted = value; break; }
      }
      if (accepted) break;

      const active = context.pages().find((pg) => !pg.isClosed());
      if (active) {
        const problem = await classify(active);
        if (problem === 'rejected') {
          throw new LoginFailed('Microsoft rejected the sign-in: '
            + (await textOfError(active) ?? 'check CUST_EMAIL and CUST_PASSWORD'));
        }
        if (problem === 'mfa') {
          throw new LoginFailed('Microsoft asked for a second factor. Automatic login needs '
            + 'an account without MFA, or a TOTP secret.');
        }
        if (problem === 'stay-signed-in') {
          log('answering "Stay signed in?"');
          // Navigation begins on click, so a failure here is expected.
          await active.click('#idSIButton9, #acceptButton').catch(() => {});
        }
      }

      await wait(1000);
    }

    if (!accepted) {
      throw new LoginFailed('Sign-in did not produce a working session (saw '
        + candidates.size + ' session cookie(s), none accepted)');
    }

    return accepted;
  } finally {
    await browser.close();
  }
}

// Logs in and stores the cookie, returning it. Used by the bot when a scrape
// reports an expired session.
export async function refreshSession({ log = console.log } = {}) {
  const value = await fetchSessionViaLogin({ log });
  if (!(await checkSession(value))) {
    throw new LoginFailed('Got a cookie, but the portal would not accept it');
  }
  setSession(value);
  log('session refreshed and stored');
  return value;
}

const runDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (runDirectly) {
  const headless = !process.argv.includes('--show');
  try {
    await fetchSessionViaLogin({ headless }).then(async (value) => {
      const ok = await checkSession(value);
      console.log(`cookie: ${value.slice(0, 8)}... accepted=${ok}`);
      if (!ok) process.exit(1);
      setSession(value);
      console.log('stored in out/session.json');
    });
  } catch (e) {
    console.error(e instanceof LoginFailed ? e.message : (e.stack ?? e.message));
    process.exit(1);
  }
}
