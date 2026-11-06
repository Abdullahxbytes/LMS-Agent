// Pairs WhatsApp, and nothing else. Isolated from the portal so a pairing
// problem is not tangled up with scraping logs.
//
//   node --env-file=.env pair.mjs            QR code (recommended)
//   node --env-file=.env pair.mjs --code     8-character pairing code
//   node --env-file=.env pair.mjs --reset    throw away stored credentials first
//
// Credentials sitting on disk do not mean the phone still trusts them: once
// the device is unlinked from WhatsApp they still look perfectly valid here,
// and the server answers every connection with a 401. That used to leave
// pairing stuck insisting it was "already paired" while never showing a QR,
// so a revoked session is now detected, cleared and re-paired automatically.

import { rmSync, existsSync, readFileSync } from 'node:fs';
import { connectWhatsApp } from './whatsapp.mjs';

const AUTH_DIR = process.env.AUTH_DIR ?? 'auth_info';
const useCode = process.argv.includes('--code');
const reset = process.argv.includes('--reset');

// Baileys sets creds.registered only when pairing by code; a QR pairing
// leaves it false. creds.me is set by both, so it is the signal to trust.
function haveCreds() {
  try {
    const creds = JSON.parse(readFileSync(`${AUTH_DIR}/creds.json`, 'utf8'));
    return Boolean(creds?.registered || creds?.me?.id);
  } catch { return false; }
}

if (reset && existsSync(AUTH_DIR)) {
  rmSync(AUTH_DIR, { recursive: true, force: true });
  console.log(`Cleared ${AUTH_DIR} on request.`);
} else if (existsSync(AUTH_DIR) && !haveCreds()) {
  rmSync(AUTH_DIR, { recursive: true, force: true });
  console.log('Cleared a half-finished pairing from a previous attempt.');
} else if (haveCreds()) {
  console.log('Found stored credentials - checking whether WhatsApp still accepts them.');
}
console.log('');

if (useCode && !process.env.PAIR_NUMBER) {
  console.error('--code needs PAIR_NUMBER in .env (e.g. 923001234567).');
  process.exit(1);
}

console.log(useCode
  ? 'Requesting a pairing code. Enter it within about a minute - it expires quickly.'
  : 'Waiting for a QR code. Scan the LOWEST one shown; they refresh every ~20s.');
console.log('');

const timeout = setTimeout(() => {
  console.error('\nNo pairing after 3 minutes. Run it again; try without --code if the code failed.');
  process.exit(1);
}, 180000);

let retried = false;

const options = () => ({
  authDir: AUTH_DIR,
  pairNumber: useCode ? process.env.PAIR_NUMBER : null,
  log: (...a) => console.log(...a),

  onReady: async ({ send, jid }) => {
    clearTimeout(timeout);
    console.log(`\nPaired. Messaging ${jid}`);
    try {
      await send('Pairing successful. The CUST portal agent can reach you here.');
      console.log('Test message sent - check your WhatsApp.');
    } catch (e) {
      console.log('Paired, but the test message failed:', e.message);
    }
    console.log('\nNow run:  npm run dev');
    setTimeout(() => process.exit(0), 2500);
  },

  // connectWhatsApp has already deleted the dead credentials by this point,
  // so reconnecting starts a genuine new pairing and shows a QR code.
  onLoggedOut: () => {
    if (retried) {
      console.error('Still logged out after clearing the credentials. Stopping.');
      process.exit(1);
    }
    retried = true;
    console.log('Those credentials were revoked. Starting a fresh pairing...\n');
    connectWhatsApp(options()).catch((e) => {
      console.error('Retry failed:', e.message);
      process.exit(1);
    });
  },
});

await connectWhatsApp(options());
