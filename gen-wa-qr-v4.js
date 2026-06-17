
const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const AUTH_DIR = '/tmp/wa-auth-tmp';
const STATUS_FILE = '/tmp/wa-pairing-status.json';
const logger = pino({ level: 'silent' });

function writeStatus(s) { fs.writeFileSync(STATUS_FILE, JSON.stringify(s)); }

async function main() {
  if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  writeStatus({ stage: 'starting', version });
  let sharedState = state;
  let sharedSaveCreds = saveCreds;

  async function createSocket() {
    return makeWASocket({
      auth: { creds: sharedState.creds, keys: makeCacheableSignalKeyStore(sharedState.keys, logger) },
      version, logger, printQRInTerminal: false,
      browser: ['openclaw', 'cli', '1.0'],
      syncFullHistory: false, markOnlineOnConnect: false,
    });
  }

  let sock = await createSocket();
  let postPairingRestarted = false;

  sock.ev.on('creds.update', () => sharedSaveCreds().catch(() => {}));

  let qrSent = false;
  const handler = async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr && !qrSent) {
      qrSent = true;
      try {
        execSync('echo "' + qr.replace(/"/g, '\\"') + '" | qrencode -o /tmp/wa-qr-clean.png -s 10 -l M -t PNG', { stdio: 'pipe' });
        writeStatus({ stage: 'qr_ready', qr_file: '/tmp/wa-qr-clean.png', ts: Date.now() });
      } catch(e) {
        writeStatus({ stage: 'qr_failed', error: e.message });
      }
    }
    if (connection === 'open') {
      writeStatus({ stage: 'connected', user: sock.user });
      // Flush creds to disk via Baileys' own saveCreds, then copy
      try {
        await sharedSaveCreds();
        // Give it a brief moment for the async file write to settle
        await new Promise(r => setTimeout(r, 1000));
        const credsDir = '/home/ubuntu/.openclaw/credentials/whatsapp/default';
        fs.mkdirSync(credsDir, { recursive: true });
        const files = fs.readdirSync(AUTH_DIR);
        for (const f of files) {
          fs.copyFileSync(path.join(AUTH_DIR, f), path.join(credsDir, f));
        }
      } catch (e) {
        writeStatus({ stage: 'connected', creds_saved: false, error: e.message, ts: Date.now() });
        process.exit(1);
      }
      writeStatus({ stage: 'connected', creds_saved: true, ts: Date.now() });
      process.exit(0);
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      writeStatus({ stage: 'closed', code: statusCode, ts: Date.now() });
    }
  };
  sock.ev.on('connection.update', handler);

  // Wait with timeout (5 min total)
  const waitForConnection = () => new Promise((resolve, reject) => {
    const h = (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (connection === 'open') resolve();
      if (connection === 'close') {
        reject({ error: lastDisconnect?.error, statusCode: lastDisconnect?.error?.output?.statusCode });
      }
    };
    sock.ev.on('connection.update', h);
  });

  while (true) {
    try {
      await new Promise((resolve, reject) => {
        const h = (update) => {
          const { connection, lastDisconnect } = update;
          if (connection === 'open') resolve();
          if (connection === 'close') reject({ error: lastDisconnect?.error, statusCode: lastDisconnect?.error?.output?.statusCode });
        };
        sock.ev.on('connection.update', h);
      });
      break;
    } catch (err) {
      const code = err.statusCode;
      if (code === 515 && !postPairingRestarted) {
        postPairingRestarted = true;
        writeStatus({ stage: 'post_pairing_restart', ts: Date.now() });
        try { sock.end?.(new Error('restart')); } catch(_) {}
        try { sock.ws?.close?.(); } catch(_) {}
        await sharedSaveCreds();
        await new Promise(r => setTimeout(r, 2000));
        const fresh = await useMultiFileAuthState(AUTH_DIR);
        sharedState = fresh.state;
        sharedSaveCreds = fresh.saveCreds;
        sock = await createSocket();
        sock.ev.on('creds.update', () => sharedSaveCreds().catch(() => {}));
        sock.ev.on('connection.update', handler);
        continue;
      }
      if (code === 515 && postPairingRestarted) {
        writeStatus({ stage: 'second_restart', ts: Date.now() });
        try { sock.end?.(new Error('restart')); } catch(_) {}
        try { sock.ws?.close?.(); } catch(_) {}
        await sharedSaveCreds();
        await new Promise(r => setTimeout(r, 2000));
        const fresh = await useMultiFileAuthState(AUTH_DIR);
        sharedState = fresh.state;
        sharedSaveCreds = fresh.saveCreds;
        sock = await createSocket();
        sock.ev.on('creds.update', () => sharedSaveCreds().catch(() => {}));
        sock.ev.on('connection.update', handler);
        continue;
      }
      writeStatus({ stage: 'failed', error: err.error?.message || 'Unknown', code, ts: Date.now() });
      return;
    }
  }
}

main().catch(err => {
  writeStatus({ stage: 'failed', error: err.message, ts: Date.now() });
  process.exit(1);
});
