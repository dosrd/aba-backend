#!/usr/bin/env node
const http = require('http');
const { exec, spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '4321', 10);
const TOKEN = process.env.AGENT_TOKEN || crypto.randomBytes(16).toString('hex');

const WA_AUTH_DIR = '/tmp/wa-auth-tmp';
const WA_CREDS_DIR = '/home/ubuntu/.openclaw/credentials/whatsapp/default';
const WA_EXTENSIONS = '/home/ubuntu/.openclaw/extensions/whatsapp';

function auth(req) { return req.headers['x-agent-token'] === TOKEN; }

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function readFile(p, encoding) {
  try { return fs.readFileSync(p, encoding || 'utf-8'); }
  catch { return null; }
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

function bootstrapAgentWorkspace(slug, name, role, personality) {
  var dir = '/home/ubuntu/.openclaw/workspace-' + slug;
  var dirs = [dir, dir + '/images', dir + '/memory'];
  dirs.forEach(function(d) { try { fs.mkdirSync(d, { recursive: true }); } catch {} });
  var files = {
    'SOUL.md': '# SOUL.md - ' + name + '\n\nYou are ' + name + ', a ' + role + ' for ABA (African Business Automation).\nYou are professional, warm, and efficient.\nYour tone is friendly but focused.\n\nCore behavior:\n- You represent ABA\n- When asked who you are, say "I am ' + name + ', your ' + role + '"\n- Keep responses concise and helpful\n',
    'IDENTITY.md': '# IDENTITY.md - ' + name + '\n\n- Name: ' + name + '\n- Role: ' + role + '\n- Personality: ' + personality + '\n- Organization: ABA (African Business Automation)\n',
    'MEMORY.md': '# MEMORY.md - ' + name + '\n\nLast updated: ' + new Date().toISOString().split('T')[0] + '\n\n## My Role\nI am a ' + role + '. ' + personality + '.\n',
    'USER.md': '# USER.md - My User\n\n- Timezone: Africa/Lagos (GMT+1)\n'
  };
  Object.keys(files).forEach(function(f) {
    try { fs.writeFileSync(dir + '/' + f, files[f]); } catch {}
  });
  try { fs.writeFileSync(dir + '/memory/' + new Date().toISOString().split('T')[0] + '.md', '#' + name + ' activated'); } catch {}
}

function createServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'x-agent-token, content-type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    if (req.url === '/health') {
      return json(res, 200, { ok: true, uptime: process.uptime(), pid: process.pid });
    }

    if (!auth(req)) {
      return json(res, 401, { error: 'Invalid x-agent-token' });
    }

    // ───── Route: POST /whatsapp/pair ─────
    if (req.method === 'POST' && req.url === '/whatsapp/pair') {
      try {
        const body = await parseBody(req);

        // Async cleanup — no execSync, no pkill race
        exec('pkill -f "gen-wa-qr-v4" 2>/dev/null; rm -rf /tmp/wa-auth-tmp /tmp/wa-pairing-status.json /tmp/wa-qr-clean.png /tmp/wa-pairing-output.log; true', { timeout: 10000 }, () => {});
        await new Promise(r => setTimeout(r, 500)); // brief pause for cleanup

        if (body && body.script_content) {
          fs.writeFileSync('/tmp/gen-wa-qr-v4.js', body.script_content);
        }

        if (!fs.existsSync('/tmp/gen-wa-qr-v4.js')) {
          return json(res, 400, { error: 'Script not found. Send script_content in body.' });
        }

        // Run in background (detached so it survives agent-server restart)
        const child = spawn('/usr/bin/node', ['/tmp/gen-wa-qr-v4.js'], {
          cwd: WA_EXTENSIONS,
          env: {
            ...process.env,
            NODE_PATH: WA_EXTENSIONS + '/node_modules',
            HOME: process.env.HOME
          },
          stdio: ['ignore', fs.openSync('/tmp/wa-pairing-output.log', 'a'), fs.openSync('/tmp/wa-pairing-output.log', 'a')],
          detached: true
        });
        child.on('error', (err) => {
          var ef = fs.openSync('/tmp/wa-pairing-output.log', 'a');
          fs.writeSync(ef, 'SPAWN ERROR: ' + err.message + '\n');
          fs.closeSync(ef);
        });
        child.on('exit', (code, sig) => {
          var ef = fs.openSync('/tmp/wa-pairing-output.log', 'a');
          fs.writeSync(ef, 'EXIT code=' + code + ' signal=' + sig + '\n');
          fs.closeSync(ef);
        });
        child.unref();

        return json(res, 200, { success: true, message: 'WhatsApp pairing started' });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // ───── Route: POST /whatsapp/reconnect ─────
    // Clears old creds + activation, then starts fresh pairing
    if (req.method === 'POST' && req.url === '/whatsapp/reconnect') {
      try {
        const body = await parseBody(req);

        // Kill any running pair script
        exec('pkill -f "gen-wa-qr-v4" 2>/dev/null; true', { timeout: 10000 }, () => {});

        // Remove old WhatsApp credentials so Baileys starts fresh
        try { fs.rmSync(WA_CREDS_DIR, { recursive: true, force: true }); } catch {}

        // Remove activation flag so re-activate can run again
        try { fs.rmSync('/tmp/wa-activated.flag', { force: true }); } catch {}

        // Remove temp pairing artifacts
        try { fs.rmSync('/tmp/wa-auth-tmp', { recursive: true, force: true }); } catch {}
        try { fs.rmSync('/tmp/wa-pairing-status.json', { force: true }); } catch {}
        try { fs.rmSync('/tmp/wa-qr-clean.png', { force: true }); } catch {}
        try { fs.rmSync('/tmp/wa-pairing-output.log', { force: true }); } catch {}

        await new Promise(r => setTimeout(r, 500));

        if (body && body.script_content) {
          fs.writeFileSync('/tmp/gen-wa-qr-v4.js', body.script_content);
        }

        if (!fs.existsSync('/tmp/gen-wa-qr-v4.js')) {
          return json(res, 400, { error: 'Script not found. Send script_content in body.' });
        }

        // Spawn fresh pairing
        const child = spawn('/usr/bin/node', ['/tmp/gen-wa-qr-v4.js'], {
          cwd: WA_EXTENSIONS,
          env: {
            ...process.env,
            NODE_PATH: WA_EXTENSIONS + '/node_modules',
            HOME: process.env.HOME
          },
          stdio: ['ignore', fs.openSync('/tmp/wa-pairing-output.log', 'a'), fs.openSync('/tmp/wa-pairing-output.log', 'a')],
          detached: true
        });
        child.on('error', (err) => {
          var ef = fs.openSync('/tmp/wa-pairing-output.log', 'a');
          fs.writeSync(ef, 'RECONNECT SPAWN ERROR: ' + err.message + '\n');
          fs.closeSync(ef);
        });
        child.unref();

        return json(res, 200, { success: true, message: 'WhatsApp reconnection started' });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // ───── Route: GET /whatsapp/pair-status ─────
    if (req.method === 'GET' && req.url === '/whatsapp/pair-status') {
      const statusRaw = readFile('/tmp/wa-pairing-status.json');
      if (!statusRaw) return json(res, 200, { stage: 'initializing' });

      try {
        const status = JSON.parse(statusRaw);
        if (status.stage === 'qr_ready') {
          // Use qr_data_url from status JSON if embedded by the script (avoids read race)
          if (status.qr_data_url) {
            return json(res, 200, { stage: 'qr_ready', qr_data_url: status.qr_data_url, ts: status.ts });
          }
          // Fallback: read the PNG file directly
          let qrBuf = null;
          try { qrBuf = fs.readFileSync('/tmp/wa-qr-clean.png'); } catch {}
          if (!qrBuf) return json(res, 200, { stage: 'qr_ready', ts: status.ts });
          const b64 = qrBuf.toString('base64');
          return json(res, 200, {
            stage: 'qr_ready',
            qr_data_url: 'data:image/png;base64,' + b64,
            ts: status.ts
          });
        }
        return json(res, 200, status);
      } catch {
        return json(res, 200, { stage: 'initializing' });
      }
    }

    // ───── Route: GET /whatsapp/status ─────
    if (req.method === 'GET' && req.url === '/whatsapp/status') {
      const credsExist = fs.existsSync(WA_CREDS_DIR + '/creds.json');
      return json(res, 200, { paired: credsExist });
    }

    // ───── Route: POST /whatsapp/activate ─────
    // Patches openclaw.json with WhatsApp channel + binding, installs plugin, restarts gateway
    // Idempotent — only activates once (checked via flag file)
    if (req.method === 'POST' && req.url === '/whatsapp/activate') {
      try {
        // Check if already activated — but if creds are empty, re-activate anyway
        if (fs.existsSync('/tmp/wa-activated.flag')) {
          var credsPath = WA_CREDS_DIR + '/creds.json';
          var credsOk = false;
          try { credsOk = fs.statSync(credsPath).size > 50; } catch {}
          if (credsOk) {
            return json(res, 200, { success: true, message: 'Already activated', already: true });
          }
          // Creds empty or missing — clear flag and re-activate
          try { fs.unlinkSync('/tmp/wa-activated.flag'); } catch {}
          console.log('WA activate: flag existed but creds empty, re-activating');
        }

        // Wait for creds.json to be written and non-empty (up to 10s)
        var credsPath = WA_CREDS_DIR + '/creds.json';
        for (var i = 0; i < 10; i++) {
          try {
            var stat = fs.statSync(credsPath);
            if (stat.size > 50) break;
          } catch {}
          console.log('WA activate: waiting for creds... (' + (i + 1) + 's)');
          require('child_process').execSync('sleep 1', { timeout: 2000 });
        }

        // 1. Install WhatsApp plugin if missing
        if (!fs.existsSync(WA_EXTENSIONS + '/dist/index.js')) {
          execSync('openclaw plugins install clawhub:@openclaw/whatsapp 2>&1', { timeout: 60000, encoding: 'utf-8' });
        }

        // 2. Patch openclaw.json with WhatsApp channel
        const confPath = '/home/ubuntu/.openclaw/openclaw.json';
        const conf = JSON.parse(fs.readFileSync(confPath, 'utf-8'));

        if (!conf.channels) conf.channels = {};
        conf.channels.whatsapp = {
          dmPolicy: 'open',
          allowFrom: ['*'],
          selfChatMode: true,
          sendReadReceipts: true
        };

        if (!conf.bindings) conf.bindings = [];
        const hasBinding = conf.bindings.some(function(b) { return b.agentId === 'main' && b.match && b.match.channel === 'whatsapp'; });
        if (!hasBinding) {
          conf.bindings.push({ agentId: 'main', match: { channel: 'whatsapp', accountId: 'default' } });
        }

        fs.writeFileSync(confPath, JSON.stringify(conf, null, 2));

        // 3. Create flag BEFORE restart so concurrent calls don't restart again
        fs.writeFileSync('/tmp/wa-activated.flag', new Date().toISOString());

        // 4. Restart OpenClaw gateway
        exec('sudo systemctl restart openclaw.service', { timeout: 15000 }, function(err) {
          if (err) {
            var ef = fs.openSync('/tmp/wa-pairing-output.log', 'a');
            fs.writeSync(ef, 'ACTIVATE gateway restart error: ' + err.message + '\n');
            fs.closeSync(ef);
          }
        });

        return json(res, 200, {
          success: true,
          message: 'WhatsApp activating — gateway restarting...'
        });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // ───── Route: POST /whatsapp/pair-team/:id ─────
    // Per-team-agent WhatsApp pairing. Uses separate creds dir per agent id.
    if (req.method === 'POST' && req.url.startsWith('/whatsapp/pair-team/')) {
      try {
        const agentId = req.url.split('/whatsapp/pair-team/')[1];
        if (!agentId || !/^\d+$/.test(agentId)) {
          return json(res, 400, { error: 'Invalid agent id' });
        }
        const body = await parseBody(req);
        const agentCredsDir = '/tmp/wa-auth-team-' + agentId;
        const agentStatusFile = '/tmp/wa-pairing-team-' + agentId + '.json';
        const agentOutputLog = '/tmp/wa-pairing-team-' + agentId + '.log';

        // Kill any existing pairing for this agent
        exec('pkill -f "gen-wa-qr-v4-team-' + agentId + '" 2>/dev/null; rm -rf ' + agentCredsDir + ' ' + agentStatusFile + '; true', { timeout: 10000 }, function() {});
        await new Promise(r => setTimeout(r, 500));

        const scriptContent = body && body.script_content ? body.script_content : '';
        if (!scriptContent) {
          return json(res, 400, { error: 'script_content required' });
        }

        // Write script to disk and spawn it with per-agent env vars
        var teamScriptPath = '/tmp/gen-wa-qr-team-' + agentId + '.js';
        fs.writeFileSync(teamScriptPath, scriptContent);

        const child = spawn('/usr/bin/node', [teamScriptPath], {
          cwd: WA_EXTENSIONS,
          env: {
            ...process.env,
            NODE_PATH: WA_EXTENSIONS + '/node_modules',
            HOME: process.env.HOME,
            WA_AUTH_DIR: agentCredsDir,
            WA_STATUS_FILE: agentStatusFile,
            WA_OUTPUT_LOG: agentOutputLog,
            WA_TEAM_AGENT_ID: agentId
          },
          stdio: ['ignore', fs.openSync('/tmp/wa-pairing-output.log', 'a'), fs.openSync('/tmp/wa-pairing-output.log', 'a')],
          detached: true
        });
        child.on('error', function(err) {
          var ef = fs.openSync('/tmp/wa-pairing-output.log', 'a');
          fs.writeSync(ef, 'TEAM[' + agentId + '] SPAWN ERROR: ' + err.message + '\n');
          fs.closeSync(ef);
        });
        child.unref();

        return json(res, 200, { success: true, message: 'Team agent WhatsApp pairing started', agent_id: parseInt(agentId, 10) });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // ───── Route: GET /whatsapp/pair-team-status/:id ─────
    // Returns QR/status for a specific team agent's pairing
    if (req.method === 'GET' && req.url.startsWith('/whatsapp/pair-team-status/')) {
      const agentId = req.url.split('/whatsapp/pair-team-status/')[1];
      if (!agentId || !/^\d+$/.test(agentId)) {
        return json(res, 400, { error: 'Invalid agent id' });
      }
      const agentStatusFile = '/tmp/wa-pairing-team-' + agentId + '.json';
      const statusRaw = readFile(agentStatusFile);
      if (!statusRaw) return json(res, 200, { stage: 'initializing', agent_id: parseInt(agentId, 10) });

      try {
        const status = JSON.parse(statusRaw);
        if (status.stage === 'qr_ready') {
          var qrPath = '/tmp/wa-qr-team-' + agentId + '.png';
          var qrBuf = null;
          try { qrBuf = fs.readFileSync(qrPath); } catch {}
          if (!qrBuf) return json(res, 200, { stage: 'qr_ready', agent_id: parseInt(agentId, 10), ts: status.ts });
          var b64 = qrBuf.toString('base64');
          return json(res, 200, {
            stage: 'qr_ready',
            qr_data_url: 'data:image/png;base64,' + b64,
            agent_id: parseInt(agentId, 10),
            ts: status.ts
          });
        }
        return json(res, 200, status);
      } catch {
        return json(res, 200, { stage: 'initializing', agent_id: parseInt(agentId, 10) });
      }
    }

    // ───── Route: POST /whatsapp/activate-team/:id ─────
    // Wires a team agent's WhatsApp account into openclaw.json, activates their creds
    if (req.method === 'POST' && req.url.startsWith('/whatsapp/activate-team/')) {
      try {
        const agentId = req.url.split('/whatsapp/activate-team/')[1];
        if (!agentId || !/^\d+$/.test(agentId)) {
          return json(res, 400, { error: 'Invalid agent id' });
        }
        const body = await parseBody(req);
        const agentSlug = body && body.agent_slug ? body.agent_slug : 'team-' + agentId;
        const agentName = body && body.agent_name ? body.agent_name : 'Team Agent ' + agentId;

        // Wait for creds to be written
        const agentCredsPath = '/home/ubuntu/.openclaw/credentials/whatsapp/team-' + agentId + '/creds.json';
        for (var i = 0; i < 10; i++) {
          try {
            var stat = fs.statSync(agentCredsPath);
            if (stat.size > 50) break;
          } catch {}
          console.log('WA team-activate: waiting for creds (' + agentId + ')... ' + (i + 1) + 's');
          execSync('sleep 1', { timeout: 2000 });
        }

        // Check creds exist
        if (!fs.existsSync(agentCredsPath)) {
          return json(res, 400, { error: 'WhatsApp creds not found. Complete pairing first.' });
        }

        // Install WhatsApp plugin if needed
        if (!fs.existsSync(WA_EXTENSIONS + '/dist/index.js')) {
          execSync('openclaw plugins install clawhub:@openclaw/whatsapp 2>&1', { timeout: 60000, encoding: 'utf-8' });
        }

        // Patch openclaw.json with team agent WhatsApp account
        const confPath = '/home/ubuntu/.openclaw/openclaw.json';
        const conf = JSON.parse(fs.readFileSync(confPath, 'utf-8'));

        if (!conf.channels) conf.channels = {};
        if (!conf.channels.whatsapp) conf.channels.whatsapp = {};
        if (typeof conf.channels.whatsapp === 'object' && !conf.channels.whatsapp.accounts) {
          // Migrate flat config to accounts-based
          conf.channels.whatsapp = { accounts: { default: conf.channels.whatsapp } };
        }
        if (!conf.channels.whatsapp.accounts) {
          conf.channels.whatsapp.accounts = {};
        }

        // Add this team agent as a WhatsApp account
        const waAccountId = 'team-' + agentId;
        conf.channels.whatsapp.accounts[waAccountId] = {
          dmPolicy: 'open',
          allowFrom: ['*'],
          selfChatMode: true,
          sendReadReceipts: true
        };

        // Register team agent in agents.list
        if (!conf.agents) conf.agents = { list: [] };
        if (!conf.agents.list) conf.agents.list = [];
        const agentExists = conf.agents.list.some(function(a) { return a.id === agentSlug; });
        if (!agentExists) {
          var agentModel = body.preferred_model && body.preferred_model !== 'default' ? body.preferred_model : undefined;
          conf.agents.list.push({
            id: agentSlug,
            name: agentName,
            description: 'Team agent (WhatsApp routing)',
            workspace: '/home/ubuntu/.openclaw/workspace-' + agentSlug
          });
          if (agentModel) { conf.agents.list[conf.agents.list.length-1].model = agentModel; }
          // Bootstrap workspace
          bootstrapAgentWorkspace(agentSlug, agentName, body.agent_role || 'Operations Assistant', body.agent_personality || 'Professional');
        }

        // Add binding for this team agent
        if (!conf.bindings) conf.bindings = [];
        const hasBinding = conf.bindings.some(function(b) {
          return b.agentId === agentSlug && b.match && b.match.channel === 'whatsapp';
        });
        if (!hasBinding) {
          conf.bindings.push({
            agentId: agentSlug,
            match: { channel: 'whatsapp', accountId: waAccountId }
          });
        }

        fs.writeFileSync(confPath, JSON.stringify(conf, null, 2));

        // Write per-agent activation flag
        var flagPath = '/tmp/wa-team-activated-' + agentId + '.flag';
        fs.writeFileSync(flagPath, new Date().toISOString());

        // Restart OpenClaw
        exec('sudo systemctl restart openclaw.service', { timeout: 15000 }, function(err) {
          if (err) {
            var ef = fs.openSync('/tmp/wa-pairing-output.log', 'a');
            fs.writeSync(ef, 'WA team-activate gateway restart error (' + agentId + '): ' + err.message + '\n');
            fs.closeSync(ef);
          }
        });

        return json(res, 200, {
          success: true,
          message: 'WhatsApp for ' + agentName + ' activating — gateway restarting...'
        });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // ───── Route: POST /whatsapp/disconnect-team/:id ─────
    if (req.method === 'POST' && req.url.startsWith('/whatsapp/disconnect-team/')) {
      try {
        const agentId = req.url.split('/whatsapp/disconnect-team/')[1];
        if (!agentId || !/^\d+$/.test(agentId)) {
          return json(res, 400, { error: 'Invalid agent id' });
        }
        const body = await parseBody(req);
        const agentSlug = body && body.agent_slug ? body.agent_slug : 'team-' + agentId;
        const waAccountId = 'team-' + agentId;

        const confPath = '/home/ubuntu/.openclaw/openclaw.json';
        const conf = JSON.parse(fs.readFileSync(confPath, 'utf-8'));

        // Remove WhatsApp account and binding for this team agent
        if (conf.channels && conf.channels.whatsapp && conf.channels.whatsapp.accounts) {
          delete conf.channels.whatsapp.accounts[waAccountId];
        }
        if (conf.bindings) {
          conf.bindings = conf.bindings.filter(function(b) {
            return !(b.match && b.match.channel === 'whatsapp' && b.match.accountId === waAccountId);
          });
        }
        // Remove from agents.list
        if (conf.agents && conf.agents.list) {
          conf.agents.list = conf.agents.list.filter(function(a) { return a.id !== agentSlug; });
        }

        fs.writeFileSync(confPath, JSON.stringify(conf, null, 2));

        // Remove creds
        var credsDir = '/home/ubuntu/.openclaw/credentials/whatsapp/team-' + agentId;
        try { fs.rmSync(credsDir, { recursive: true, force: true }); } catch {}

        // Remove activation flag
        try { fs.unlinkSync('/tmp/wa-team-activated-' + agentId + '.flag'); } catch {}
        // Clean up temp pairing data
        try { fs.rmSync('/tmp/wa-auth-team-' + agentId, { recursive: true, force: true }); } catch {}
        try { fs.unlinkSync('/tmp/wa-pairing-team-' + agentId + '.json'); } catch {}
        try { fs.unlinkSync('/tmp/wa-qr-team-' + agentId + '.png'); } catch {}

        // Restart OpenClaw to take effect
        exec('sudo systemctl restart openclaw.service', { timeout: 15000 });

        return json(res, 200, { success: true, message: 'WhatsApp disconnected for agent ' + agentId });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // ───── Route: POST /whatsapp/activate-team-status/:id ─────
    if (req.method === 'GET' && req.url.startsWith('/whatsapp/activate-team-status/')) {
      try {
        const agentId = req.url.split('/whatsapp/activate-team-status/')[1];
        if (!agentId || !/^\d+$/.test(agentId)) {
          return json(res, 400, { error: 'Invalid agent id' });
        }
        var flagPath = '/tmp/wa-team-activated-' + agentId + '.flag';
        var credsPath = '/home/ubuntu/.openclaw/credentials/whatsapp/team-' + agentId + '/creds.json';
        var hasCreds = false;
        try { hasCreds = fs.statSync(credsPath).size > 50; } catch {}
        var hasFlag = fs.existsSync(flagPath);
        return json(res, 200, {
          agent_id: parseInt(agentId, 10),
          has_creds: hasCreds,
          activated: hasFlag && hasCreds,
          flag_exists: hasFlag
        });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // ───── Route: POST /team/configure-telegram/:id ─────
    // Wires a team agent's Telegram bot token into openclaw.json
    if (req.method === 'POST' && req.url.startsWith('/team/configure-telegram/')) {
      try {
        const agentId = req.url.split('/team/configure-telegram/')[1];
        if (!agentId || !/^\d+$/.test(agentId)) {
          return json(res, 400, { error: 'Invalid agent id' });
        }
        const body = await parseBody(req);
        if (!body || !body.bot_token) {
          return json(res, 400, { error: 'bot_token required' });
        }
        const agentSlug = body.agent_slug || 'team-' + agentId;
        const botToken = body.bot_token;

        const confPath = '/home/ubuntu/.openclaw/openclaw.json';
        const conf = JSON.parse(fs.readFileSync(confPath, 'utf-8'));

        if (!conf.channels) conf.channels = {};
        if (!conf.channels.telegram) conf.channels.telegram = { enabled: true };
        if (!conf.channels.telegram.accounts) {
          conf.channels.telegram.accounts = {};
          // Migrate if there's a flat botToken
          if (conf.channels.telegram.botToken) {
            conf.channels.telegram.accounts.main = { botToken: conf.channels.telegram.botToken, dmPolicy: 'open', allowFrom: ['*'] };
            delete conf.channels.telegram.botToken;
          }
        }

        // Register team agent in agents.list
        if (!conf.agents) conf.agents = { list: [] };
        if (!conf.agents.list) conf.agents.list = [];
        var agentExists = conf.agents.list.some(function(a) { return a.id === agentSlug; });
        if (!agentExists) {
          var agentModel = body.preferred_model && body.preferred_model !== 'default' ? body.preferred_model : undefined;
          conf.agents.list.push({
            id: agentSlug,
            name: body.agent_name || 'Team Agent ' + agentId,
            description: 'Team agent (' + (body.agent_role || 'Telegram') + ' routing)',
            workspace: '/home/ubuntu/.openclaw/workspace-' + agentSlug
          });
          if (agentModel) { conf.agents.list[conf.agents.list.length-1].model = agentModel; }
          // Bootstrap workspace
          bootstrapAgentWorkspace(agentSlug, body.agent_name || 'Team Agent ' + agentId, body.agent_role || 'Operations Assistant', body.agent_personality || 'Professional');
        }

        // Add this team agent's bot
        conf.channels.telegram.accounts[agentSlug] = {
          botToken: botToken,
          dmPolicy: 'open',
          allowFrom: ['*']
        };

        // Add binding
        if (!conf.bindings) conf.bindings = [];
        var hasBinding = conf.bindings.some(function(b) {
          return b.agentId === agentSlug && b.match && b.match.channel === 'telegram';
        });
        if (!hasBinding) {
          conf.bindings.push({
            agentId: agentSlug,
            match: { channel: 'telegram', accountId: agentSlug }
          });
        }

        fs.writeFileSync(confPath, JSON.stringify(conf, null, 2));

        // Restart OpenClaw
        exec('sudo systemctl restart openclaw.service', { timeout: 15000 }, function(err) {
          if (err) {
            var ef = fs.openSync('/tmp/wa-pairing-output.log', 'a');
            fs.writeSync(ef, 'TEAM Telegram configure error (' + agentId + '): ' + err.message + '\n');
            fs.closeSync(ef);
          }
        });

        return json(res, 200, { success: true, message: 'Telegram configured for agent ' + agentId });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // ───── Email Poller State ─────
    const emailPollers = {};

    function startEmailPoller(agentKey, config) {
      if (emailPollers[agentKey]) {
        clearInterval(emailPollers[agentKey]);
        delete emailPollers[agentKey];
      }
      console.log('Starting email poller for ' + agentKey + ' (' + config.email_address + ')');

      async function checkMail() {
        try {
          const imapSimple = require('imap-simple');
          const imapConfig = {
            imap: {
              user: config.email_address,
              password: config.email_password,
              host: config.email_pop_host,
              port: config.email_pop_port || 993,
              tls: true,
              tlsOptions: { rejectUnauthorized: false },
              authTimeout: 15000
            }
          };

          const connection = await imapSimple.connect(imapConfig);
          await connection.openBox('INBOX');

          // Search for unseen emails
          const searchCriteria = ['UNSEEN'];
          const fetchOptions = { bodies: ['HEADER', 'TEXT'], markSeen: true, struct: true };
          const messages = await connection.search(searchCriteria, fetchOptions);

          for (const msg of messages) {
            const headerPart = msg.parts.find(p => p.which === 'HEADER');
            if (!headerPart) continue;

            const headers = imapSimple.parseHeader(headerPart.body);
            const from = (headers.from || [''])[0];
            const subject = (headers.subject || ['(No subject)'])[0];
            const to = (headers.to || [''])[0];
            const date = (headers.date || [''])[0];

            // Get text body
            let body = '';
            const textPart = msg.parts.find(p => p.which === 'TEXT');
            if (textPart) {
              body = textPart.body.substring(0, 3000);
            }

            console.log('📧 New email for ' + agentKey + ': from=' + from + ' subject=' + subject);

            // Write to a mail file the agent can read from its workspace
            const mailDir = '/home/ubuntu/.openclaw/mail/' + agentKey + '/inbox';
            try { execSync('mkdir -p ' + mailDir); } catch(e) {}

            const mailFile = mailDir + '/' + Date.now() + '.json';
            const mailData = JSON.stringify({
              from: from,
              to: to || '',
              subject: subject,
              date: date,
              body: body,
              receivedAt: new Date().toISOString()
            });

            try {
              execSync('cat > ' + mailFile + ' << MAILEOF\n' + mailData.replace(/'/g, "'\\''") + '\nMAILEOF', { timeout: 5000 });
            } catch(e) {
              fs.writeFileSync(mailFile, mailData);
            }
          }

          await connection.end();
          // Update last_checked
          try {
            execSync('date +%s > /home/ubuntu/.openclaw/mail/' + agentKey + '/last_check', { timeout: 3000 });
          } catch(e) {}
        } catch (e) {
          console.log('Email poll error for ' + agentKey + ': ' + e.message);
        }
      }

      // Poll every 5 minutes
      checkMail();
      emailPollers[agentKey] = setInterval(checkMail, 5 * 60 * 1000);
    }

    function stopEmailPoller(agentKey) {
      if (emailPollers[agentKey]) {
        clearInterval(emailPollers[agentKey]);
        delete emailPollers[agentKey];
        console.log('Stopped email poller for ' + agentKey);
      }
    }

    // ───── Route: POST /team/configure-email/:id ─────
    if (req.method === 'POST' && req.url.startsWith('/team/configure-email/')) {
      try {
        const agentId = req.url.split('/team/configure-email/')[1];
        if (!agentId || !/^\d+$/.test(agentId)) {
          return json(res, 400, { error: 'Invalid agent id' });
        }
        const body = await parseBody(req);
        if (!body || !body.email_address || !body.email_password || !body.email_pop_host) {
          return json(res, 400, { error: 'email_address, email_password, email_pop_host required' });
        }

        const agentKey = 'team-' + agentId;
        startEmailPoller(agentKey, body);

        return json(res, 200, { success: true, message: 'Email poller started for agent ' + agentId });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // ───── Route: POST /agent/configure-email ─────
    if (req.method === 'POST' && req.url === '/agent/configure-email') {
      try {
        const body = await parseBody(req);
        if (!body || !body.email_address || !body.email_password || !body.email_pop_host) {
          return json(res, 400, { error: 'email_address, email_password, email_pop_host required' });
        }

        startEmailPoller('main', body);

        return json(res, 200, { success: true, message: 'Email poller started for main agent' });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // ───── Route: POST /team/disconnect-email/:id ─────
    if (req.method === 'POST' && req.url.startsWith('/team/disconnect-email/')) {
      try {
        const agentId = req.url.split('/team/disconnect-email/')[1];
        if (!agentId || !/^\d+$/.test(agentId)) {
          return json(res, 400, { error: 'Invalid agent id' });
        }
        stopEmailPoller('team-' + agentId);
        // Clean up mail directory
        try { execSync('rm -rf /home/ubuntu/.openclaw/mail/team-' + agentId, { timeout: 5000 }); } catch(e) {}
        return json(res, 200, { success: true, message: 'Email disconnected for agent ' + agentId });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // ───── Route: POST /agent/disconnect-email ─────
    if (req.method === 'POST' && req.url === '/agent/disconnect-email') {
      try {
        stopEmailPoller('main');
        try { execSync('rm -rf /home/ubuntu/.openclaw/mail/main', { timeout: 5000 }); } catch(e) {}
        return json(res, 200, { success: true, message: 'Email disconnected for main agent' });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // ───── Route: GET /agent/email/status ─────
    if (req.method === 'GET' && req.url === '/agent/email/status') {
      try {
        const agents = Object.keys(emailPollers);
        const statuses = {};
        for (const key of agents) {
          const lastCheck = readFile('/home/ubuntu/.openclaw/mail/' + key + '/last_check', 'utf-8');
          let inbox = [];
          try {
            const inboxDir = '/home/ubuntu/.openclaw/mail/' + key + '/inbox';
            const files = execSync('ls -t ' + inboxDir + ' 2>/dev/null || echo', { timeout: 3000 }).toString().trim().split('\n').filter(Boolean);
            inbox = files.slice(0, 5).map(f => {
              const data = readFile(inboxDir + '/' + f);
              if (data) {
                try { const parsed = JSON.parse(data); return { from: parsed.from, subject: parsed.subject, date: parsed.date, receivedAt: parsed.receivedAt }; }
                catch(e) { return { file: f }; }
              }
              return { file: f };
            });
          } catch(e) {}
          statuses[key] = {
            running: true,
            lastCheck: lastCheck ? new Date(parseInt(lastCheck) * 1000).toISOString() : null,
            recentEmails: inbox
          };
        }
        return json(res, 200, { statuses });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // ───── Route: POST /team/disconnect-telegram/:id ─────
    if (req.method === 'POST' && req.url.startsWith('/team/disconnect-telegram/')) {
      try {
        const agentId = req.url.split('/team/disconnect-telegram/')[1];
        if (!agentId || !/^\d+$/.test(agentId)) {
          return json(res, 400, { error: 'Invalid agent id' });
        }
        const body = await parseBody(req);
        const agentSlug = body && body.agent_slug ? body.agent_slug : 'team-' + agentId;

        const confPath = '/home/ubuntu/.openclaw/openclaw.json';
        const conf = JSON.parse(fs.readFileSync(confPath, 'utf-8'));

        // Remove Telegram account and binding for this team agent
        if (conf.channels && conf.channels.telegram && conf.channels.telegram.accounts) {
          delete conf.channels.telegram.accounts[agentSlug];
        }
        if (conf.bindings) {
          conf.bindings = conf.bindings.filter(function(b) {
            return !(b.match && b.match.channel === 'telegram' && b.match.accountId === agentSlug);
          });
        }
        // Remove from agents.list
        if (conf.agents && conf.agents.list) {
          conf.agents.list = conf.agents.list.filter(function(a) { return a.id !== agentSlug; });
        }

        fs.writeFileSync(confPath, JSON.stringify(conf, null, 2));

        exec('sudo systemctl restart openclaw.service', { timeout: 15000 });

        return json(res, 200, { success: true, message: 'Telegram disconnected for agent ' + agentId });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // ───── Route: POST /telegram/configure ─────
    // (main admin telegram configure — already exists as implicit path, add explicit)
    if (req.method === 'POST' && req.url === '/telegram/configure') {
      try {
        const body = await parseBody(req);
        if (!body || !body.bot_token) {
          return json(res, 400, { error: 'bot_token required' });
        }
        const botToken = body.bot_token;

        const confPath = '/home/ubuntu/.openclaw/openclaw.json';
        const conf = JSON.parse(fs.readFileSync(confPath, 'utf-8'));

        if (!conf.channels) conf.channels = {};
        if (!conf.channels.telegram) conf.channels.telegram = { enabled: true, accounts: {} };
        if (!conf.channels.telegram.accounts) conf.channels.telegram.accounts = {};

        // Put main admin telegram in the accounts format
        conf.channels.telegram.accounts.main = {
          botToken: botToken,
          dmPolicy: 'open',
          allowFrom: ['*']
        };

        // Ensure binding exists
        if (!conf.bindings) conf.bindings = [];
        var hasBinding = conf.bindings.some(function(b) {
          return b.agentId === 'main' && b.match && b.match.channel === 'telegram';
        });
        if (!hasBinding) {
          conf.bindings.push({
            agentId: 'main',
            match: { channel: 'telegram', accountId: 'main' }
          });
        }

        // Clean up old flat format
        delete conf.channels.telegram.botToken;

        fs.writeFileSync(confPath, JSON.stringify(conf, null, 2));

        exec('sudo systemctl restart openclaw.service', { timeout: 15000 });

        return json(res, 200, { success: true, message: 'Telegram configured' });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // ───── Route: POST /team/configure-escalation/:id ─────
    // Writes escalation and report instructions into the agent's SOUL.md
    if (req.method === 'POST' && req.url.startsWith('/team/configure-escalation/')) {
      try {
        const agentId = req.url.split('/team/configure-escalation/')[1];
        if (!agentId || !/^\d+$/.test(agentId)) return json(res, 400, { error: 'Invalid agent id' });
        const body = await parseBody(req);
        if (!body) return json(res, 400, { error: 'Request body required' });

        const agentSlug = body.agent_slug || 'team-' + agentId;
        const wsDir = '/home/ubuntu/.openclaw/workspace-' + agentSlug;

        if (!fs.existsSync(wsDir)) {
          bootstrapAgentWorkspace(agentSlug, body.agent_name || 'Team Agent ' + agentId, body.agent_role || 'Operations Assistant', body.agent_personality || 'Professional');
        }

        const soulPath = wsDir + '/SOUL.md';
        var soulContent = '';
        try { soulContent = fs.readFileSync(soulPath, 'utf-8'); } catch {}

        // Remove any previous escalation section to avoid stacking
        soulContent = soulContent.replace(/\n*## Escalation & Reporting[\s\S]*$/, '');

        // Build escalation block
        var escBlock = '\n\n## Escalation & Reporting\n';
        if (body.associate_name) {
          escBlock += '\n**Escalation Contact:** ' + body.associate_name;
          if (body.associate_role) escBlock += ' (' + body.associate_role + ')';
          escBlock += '\n';
          if (body.associate_email) escBlock += '- Email: ' + body.associate_email + '\n';
          if (body.associate_mobile) escBlock += '- Phone: ' + body.associate_mobile + '\n';
        }
        if (body.instructions) {
          escBlock += '\n**Escalation Rules:**\n' + body.instructions + '\n';
        }
        escBlock += '\n**End-of-Day Report:** Send a summary of completed tasks, pending items, and any issues to the escalation contact at ' + body.report_time + ' ' + (body.report_frequency || 'daily') + '.\n';
        if (body.associate_email) {
          escBlock += '- Format: email to ' + body.associate_email + '\n';
        }
        if (body.associate_mobile) {
          escBlock += '- Format: WhatsApp message to ' + body.associate_mobile + '\n';
        }
        escBlock += '- Include: tasks completed, pending items, issues encountered, recommendations\n';

        fs.writeFileSync(soulPath, soulContent + escBlock);

        return json(res, 200, { success: true, message: 'Escalation configured for agent ' + agentId });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // ───── Route: POST /team/update-model/:id ─────
    // Updates the model override for an existing team agent in agents.list and restarts OpenClaw
    if (req.method === 'POST' && req.url.startsWith('/team/update-model/')) {
      try {
        const agentId = req.url.split('/team/update-model/')[1];
        if (!agentId || !/^\d+$/.test(agentId)) return json(res, 400, { error: 'Invalid agent id' });
        const body = await parseBody(req);
        if (!body) return json(res, 400, { error: 'Request body required' });

        var confPath = process.env.OPENCLAW_CONF || '/home/ubuntu/.openclaw/openclaw.json';
        var confStr = '{}';
        try { confStr = fs.readFileSync(confPath, 'utf-8'); } catch {}
        var conf = JSON.parse(confStr);

        if (!conf.agents) conf.agents = { list: [] };
        if (!conf.agents.list) conf.agents.list = [];

        var agentSlug = body.agent_slug || 'team-' + agentId;
        var found = false;
        for (var i = 0; i < conf.agents.list.length; i++) {
          if (conf.agents.list[i].id === agentSlug) {
            var modelVal = body.preferred_model && body.preferred_model !== '' && body.preferred_model !== 'default' ? body.preferred_model : undefined;
            if (modelVal) {
              conf.agents.list[i].model = modelVal;
            } else {
              delete conf.agents.list[i].model;
            }
            found = true;
            break;
          }
        }

        if (!found) {
          // Add new entry
          conf.agents.list.push({
            id: agentSlug,
            name: body.agent_name || 'Team Agent ' + agentId,
            description: 'Team agent (' + (body.agent_role || 'Operations') + ' routing)',
            workspace: '/home/ubuntu/.openclaw/workspace-' + agentSlug
          });
          var modelVal = body.preferred_model && body.preferred_model !== '' && body.preferred_model !== 'default' ? body.preferred_model : undefined;
          if (modelVal) {
            conf.agents.list[conf.agents.list.length - 1].model = modelVal;
          }
        }

        fs.writeFileSync(confPath, JSON.stringify(conf, null, 2));

        // Restart OpenClaw
        var child = require('child_process');
        child.exec('openclaw gateway restart', { timeout: 15000 }, function(e) {
          if (e) console.error('Restart error:', e.message);
        });

        return json(res, 200, { success: true, message: 'Model updated for agent ' + agentSlug });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // ───── Route: GET /workspace/:slug/download ─────
    if (req.method === 'GET' && req.url.startsWith('/workspace/') && req.url.endsWith('/download')) {
      const slug = req.url.split('/workspace/')[1].split('/download')[0];
      if (!slug) { json(res, 400, { error: 'Missing agent slug' }); return; }
      const workspaceDir = '/home/ubuntu/.openclaw/workspace-' + slug;
      if (!fs.existsSync(workspaceDir)) {
        const mainDir = '/home/ubuntu/.openclaw/workspace';
        if (fs.existsSync(mainDir) && slug !== 'main') { json(res, 404, { error: 'No workspace found for this agent' }); return; }
      }
      try {
        const zipPath = '/tmp/workspace-' + slug + '-' + Date.now() + '.tar.gz';
        execSync('cd /home/ubuntu/.openclaw && tar -czf ' + zipPath + ' workspace-' + slug + ' 2>/dev/null', { timeout: 30000, stdio: 'pipe' });
        if (!fs.existsSync(zipPath)) { json(res, 500, { error: 'Failed to create zip' }); return; }
        const stat = fs.statSync(zipPath);
        res.writeHead(200, {
          'Content-Type': 'application/gzip',
          'Content-Disposition': 'attachment; filename="workspace-' + slug + '.tar.gz"',
          'Content-Length': stat.size,
          'Access-Control-Allow-Origin': '*'
        });
        const readStream = fs.createReadStream(zipPath);
        readStream.pipe(res);
        readStream.on('end', function() {
          try { fs.unlinkSync(zipPath); } catch {}
        });
        return;
      } catch (e) {
        json(res, 500, { error: 'Failed to zip workspace: ' + e.message });
        return;
      }
    }

    // ───── 404 ─────
    json(res, 404, { error: 'Not found' });
  });

  // Save token
  fs.mkdirSync('/tmp/agent-server', { recursive: true });
  fs.writeFileSync('/tmp/agent-server/token.txt', TOKEN);

  server.listen(PORT, '0.0.0.0', () => {
    console.log('Agent server listening on port ' + PORT);
    console.log('Token: ' + TOKEN);
  });
}

createServer();
