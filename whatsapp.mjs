// WhatsApp transport via Baileys.
//
// Baileys pairs with your own WhatsApp account rather than the official Cloud
// API, which matters here: the Cloud API only lets you message freely inside a
// 24-hour window opened by the user, and marks get uploaded at arbitrary times.
//
// Messages go to your own chat ("message yourself"), so no second number is
// needed.

import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion,
  Browsers, makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { rmSync } from 'node:fs';

// Baileys wants a pino-shaped logger; this keeps its internal chatter quiet
// without pulling in pino directly.
const quietLogger = {
  level: 'silent',
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return quietLogger; },
};

// libsignal logs undecryptable messages with a hardcoded console.error that
// bypasses the logger above. Every message sent to you BEFORE this device was
// linked is undecryptable by design - a linked device gets no Signal session
// for history it was never part of - so the backlog produces a wall of
// "Bad MAC" on the first run after pairing. Baileys already handles the
// thrown error and skips the message; only the noise is a problem.
//
// Narrowly filtered so genuine errors still reach the console.
let signalNoiseMuted = false;

// Routine Signal session churn. libsignal logs all of this unconditionally;
// none of it is actionable, and "Closing session:" dumps private key material
// into the console. Genuine libsignal errors (bad pubkey length, storage
// migration failures) are deliberately NOT listed, so they still show.
const SIGNAL_NOISE = [
  'Session error:',
  'Closing session:',
  'Session already closed',
  'Session already open',
  'Session already closed',
  'Decrypted message with closed session.',
  'Closing open session in favor of incoming prekey bundle',
];
const UNDECRYPTABLE = 'Failed to decrypt message with any known session';

export function muteSignalNoise(onSkipped) {
  if (signalNoiseMuted) return;
  signalNoiseMuted = true;

  for (const level of ['error', 'warn', 'info']) {
    const real = console[level].bind(console);
    console[level] = (...args) => {
      const first = typeof args[0] === 'string' ? args[0] : '';
      if (first.startsWith(UNDECRYPTABLE)) { onSkipped?.(); return; }
      if (SIGNAL_NOISE.some((p) => first.startsWith(p))) return;
      real(...args);
    };
  }
}

// Strips the :device suffix: 923001234567:13@s.whatsapp.net -> 923001234567@s.whatsapp.net
const bareJid = (raw) => {
  if (!raw) return null;
  const [user, server] = String(raw).split('@');
  return user.split(':')[0] + '@' + (server || 's.whatsapp.net');
};

const selfJid = (sock) => {
  const raw = sock.user?.id ?? '';
  return `${raw.split(':')[0].split('@')[0]}@s.whatsapp.net`;
};

// Baileys gives the timestamp as a number or a Long, depending on source.
const stamp = (msg) => Number(msg.messageTimestamp?.low ?? msg.messageTimestamp ?? 0);

// A message can arrive wrapped in several layers: disappearing chats add
// ephemeralMessage, view-once adds viewOnceMessage, an edit adds
// editedMessage. Baileys unwraps deviceSentMessage itself but not these, and
// an unwrapped message looks like it has no text at all.
const unwrap = (m) => {
  let cur = m ?? {};
  for (let i = 0; i < 5; i += 1) {
    const inner = cur.ephemeralMessage?.message
      ?? cur.viewOnceMessage?.message
      ?? cur.viewOnceMessageV2?.message
      ?? cur.viewOnceMessageV2Extension?.message
      ?? cur.documentWithCaptionMessage?.message
      ?? cur.editedMessage?.message
      ?? cur.deviceSentMessage?.message;
    if (!inner) break;
    cur = inner;
  }
  return cur;
};

const textOf = (msg) => {
  const m = unwrap(msg.message);
  return m.conversation
    ?? m.extendedTextMessage?.text
    ?? m.imageMessage?.caption
    ?? m.videoMessage?.caption
    ?? m.documentMessage?.caption
    ?? '';
};

export async function connectWhatsApp({
  authDir = 'auth_info', onMessage, onReady, onLoggedOut, log = console.log,
  pairNumber = process.env.PAIR_NUMBER,
} = {}) {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  // Baileys only sets creds.registered on the pairing-code path; a QR
  // pairing leaves it false forever. creds.me is what both paths set, so
  // that - not registered - is the real "this device is linked" signal.
  const isLinked = () => Boolean(state.creds?.registered || state.creds?.me?.id);

  let sock = null;
  let target = null;
  let starting = false;
  let askedForPairCode = false;
  const sentIds = new Set();
  const selfChat = new Set();
  // Only act on messages newer than this run, so a replayed backlog of old
  // commands does not all fire at once on startup.
  const startedAt = Math.floor(Date.now() / 1000);

  async function send(text) {
    if (!sock || !target) throw new Error('WhatsApp not connected yet');
    const res = await sock.sendMessage(target, { text });
    if (res?.key?.id) sentIds.add(res.key.id);
    log('-> ' + text.split(String.fromCharCode(10))[0].slice(0, 60));
    return res;
  }

  // Replaces the socket in place. The previous one is torn down first -
  // leaving old listeners attached is what makes a reconnect loop spawn
  // endless QR codes.
  async function start(reason = 'initial') {
    if (starting) return;
    starting = true;

    if (sock) {
      try { sock.ev.removeAllListeners(); sock.end(undefined); } catch { /* already gone */ }
      sock = null;
    }

    const { version } = await fetchLatestBaileysVersion();
    log(`connecting (${reason}), WA v${version.join('.')}, linked=${isLinked()}`);

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, quietLogger),
      },
      logger: quietLogger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', onConnectionUpdate);
    sock.ev.on('messages.upsert', onUpsert);

    // Pairing by code avoids the camera entirely; useful when QR scanning
    // keeps failing. Set PAIR_NUMBER to your number in full international
    // form with no plus or spaces, e.g. 923001234567.
    if (pairNumber && !isLinked() && !askedForPairCode) {
      askedForPairCode = true;
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(pairNumber.replace(/[^0-9]/g, ''));
          log(`\nPairing code: ${code}\nWhatsApp -> Linked Devices -> Link a Device -> Link with phone number\n`);
        } catch (e) {
          log('Could not request a pairing code:', e.message);
        }
      }, 4000);
    }

    starting = false;
  }

  function onConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !pairNumber) {
      log('\nScan with WhatsApp -> Settings -> Linked Devices -> Link a Device');
      log('(the code refreshes every ~20s; a fresh one below replaces the one above)\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      // This account has been migrated to LID addressing: incoming messages
      // arrive from <lid>@lid. Replying over the old phone-number address
      // leaves the primary phone unable to decrypt ("Waiting for this
      // message") even though linked desktops cope fine, so prefer the LID.
      const lid = bareJid(sock.user?.lid ?? state.creds?.me?.lid);
      target = process.env.OWNER_JID || lid || selfJid(sock);

      // WhatsApp now addresses your own chat by LID rather than by phone
      // number, so an incoming command arrives as <lid>@lid while we send to
      // <number>@s.whatsapp.net. Both identify the same chat, so accept
      // either - matching only the send address ignored every command.
      selfChat.clear();
      for (const j of [target, sock.user?.id, sock.user?.lid, state.creds?.me?.id, state.creds?.me?.lid]) {
        const bare = bareJid(j);
        if (bare) selfChat.add(bare);
      }
      log('accepting commands from: ' + [...selfChat].join(', '));
      log(`connected as ${sock.user?.id} -> messaging ${target}`);
      onReady?.({ send, jid: target });
      return;
    }

    if (connection !== 'close') return;

    const code = lastDisconnect?.error?.output?.statusCode;

    // 515 is sent immediately after a successful pairing: the credentials are
    // already saved and the socket simply has to be rebuilt. Showing a new QR
    // here is what made pairing appear to fail.
    if (code === DisconnectReason.restartRequired) {
      log('paired - restarting with saved credentials');
      start('restart required').catch((e) => log('restart failed:', e.message));
      return;
    }

    if (code === DisconnectReason.loggedOut) {
      // A 401 before registration means the pairing attempt was rejected.
      // The half-written creds left behind would make every later run fail
      // instantly with the same 401, so clear them here.
      // Whether the device was unlinked from the phone or the pairing was
      // rejected outright, a 401 means these credentials are dead. Keeping
      // them only guarantees the same 401 on the next run - which is how
      // pairing ends up stuck claiming "Already paired".
      if (onLoggedOut) {
        try { rmSync(authDir, { recursive: true, force: true }); } catch { /* nothing to clear */ }
        log('session is logged out; cleared ' + authDir);
        onLoggedOut();
      } else {
        log('logged out - run: npm run pair -- --reset');
      }
      return;
    }

    const delay = code === DisconnectReason.connectionReplaced ? 30000 : 5000;
    log(`connection closed (${code ?? 'network'}), retrying in ${delay / 1000}s`);
    setTimeout(() => start(`retry after ${code ?? 'network'}`).catch((e) => log('retry failed:', e.message)), delay);
  }

  async function onUpsert({ messages, type }) {
    // Printed for every batch, so "no reply" can be told apart from
    // "the event never fired".
    log('[upsert] type=' + type + ' count=' + (messages?.length ?? 0));
    if (!onMessage) return;

    for (const msg of messages) {
      // Every filter below used to drop messages silently, which made a
      // missing reply impossible to diagnose. Each one now says why.
      const skip = (reason) => log('[skip] ' + reason
        + ' type=' + type
        + ' jid=' + msg.key?.remoteJid
        + ' fromMe=' + msg.key?.fromMe
        + ' ts=' + stamp(msg) + ' startedAt=' + startedAt
        + ' keys=' + Object.keys(msg.message || {}).join(','));

      if (sentIds.has(msg.key?.id)) continue;   // our own reply coming back
      if (type !== 'notify' && type !== 'append') { skip('upsert type'); continue; }
      if (!msg.message) { skip('no content'); continue; }
      if (selfChat.size && !selfChat.has(bareJid(msg.key.remoteJid))) { skip('different chat'); continue; }

      const body = textOf(msg).trim();
      if (!body) { skip('no text found'); continue; }

      // Stops the bot replaying old commands when a reconnect replays history.
      if (msg.key.fromMe && stamp(msg) < startedAt) { skip('older than this run'); continue; }

      log('<- ' + body.slice(0, 60));

      try {
        const reply = await onMessage(body, { from: msg.key.remoteJid });
        if (reply) await send(reply);
        else log('   (not a command - ignored)');
      } catch (e) {
        await send('Error: ' + e.message).catch(() => {});
      }
    }
  }

  await start();
  return { send, get jid() { return target; }, get sock() { return sock; } };
}
