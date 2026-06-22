# 🔧 ABA Backend — Issue Resolution Log

Issues affecting the backend API (`server.ts`), agent-server (`agent-server.js`), deployment orchestrator, EC2 provisioning, database, and WhatsApp pairing infrastructure.

---

## #4 — WhatsApp Link UI Not Transitioning (Agent Not Responding)

| Field | Value |
|-------|-------|
| **Date** | 2026-06-21 |
| **Summary** | Scanned WhatsApp QR and linked phone successfully, but UI never changed to "Connected" and agent didn't respond to WA messages |
| **Symptoms** | QR code kept reloading even after successful scan. WhatsApp channel wasn't bound in OpenClaw. |
| **Root Cause** | Two layered issues: (1) During auto-activate, the backend tried to install the WhatsApp plugin, but OpenClaw was v2026.6.8 and the plugin required >=v2026.6.9. Install failed silently → no openclaw.json channel patch. (2) When testing "Reconnect", OpenClaw stayed running with the old session in memory, causing a conflict when fresh creds were written → session immediately logged out. |
| **Resolution** | Upgraded OpenClaw to `2026.6.9`. Updated orchestrator to automatically install the WhatsApp plugin and Baileys dependencies correctly on EC2 provision. Updated `agent-server.js` `/whatsapp/reconnect` to gracefully unload the specific WhatsApp account from `openclaw.json` *before* wiping creds, avoiding the session conflict. Fixed `gen-wa-qr-v4-team.js` to also embed `qr_data_url`. |
| **Files changed** | `aba-deploy-orchestrator.sh`, `agent-server.js`, `gen-wa-qr-v4-team.js` |
| **Commit** | `9336532` — "fix: make WhatsApp pairing robust for new deployments and reconnects" |
| **Verified** | UI updates to "Connected" properly, agent receives and answers WhatsApp messages. ✅ |
| **Prevention** | Orchestrator now enforces the plugin installation directly, and OpenClaw handles the config hot-reload gracefully during reconnects. |

---

## #3 — WhatsApp QR Code Not Displaying (Corrupted Base64)

| Field | Value |
|-------|-------|
| **Date** | 2026-06-21 |
| **Summary** | After clicking "Link WhatsApp", the QR code showed alt text "WhatsApp QR" — image didn't render |
| **Symptoms** | Frontend received `data:image/png;base64,/VBORw0...` instead of `iVBORw0...` — first byte of PNG header (`\x89`) was missing, invalid image |
| **Root Cause** | Race condition: pairing script (gen-wa-qr-v4.js) wrote PNG file to disk, agent-server read it on a separate file read. Script's `writeStatus({stage:'qr_ready'})` triggered agent-server to read PNG **while it was still being written** → corrupted base64 |
| **Resolution** | Modified gen-wa-qr-v4.js to embed the full `qr_data_url` (base64) directly into the status JSON. Agent-server now reads it from status object instead of doing a separate `fs.readFileSync()` — no race |
| **Files changed** | `gen-wa-qr-v4.js`, `agent-server.js`, `aba-deploy-orchestrator.sh` |
| **Commit** | `98c49dd` — "fix: WhatsApp QR corruption — base64 starts '/VBO' instead of 'iVBORw0'" |
| **Verified** | Base64 now starts with `iVBORw0KGgoAAAANhE` ✅ |
| **Prevention** | All future QR-reading paths should read base64 from status JSON, not re-read the file |

---

## #2 — WhatsApp Pairing Stuck at "Initializing..." Indefinitely

| Field | Value |
|-------|-------|
| **Date** | 2026-06-21 |
| **Summary** | Clicked "Link WhatsApp", got "Starting... Initializing..." forever — never showed QR code |
| **Symptoms** | Agent-server crashed on every `/whatsapp/pair` call. Frontend polled `/whatsapp/pair-status`, got `{stage: 'initializing'}` every time |
| **Root Cause** | Four blockers chained: (1) `spawn('node', ...)` failed because systemd strips PATH — `node` binary not found (ENOENT). (2) `cwd` directory `/home/ubuntu/.openclaw/extensions/whatsapp/` didn't exist → ENOENT on spawn. (3) `qrencode` binary not installed on EC2. (4) `@whiskeysockets/baileys` npm package installed at parent `extensions/` level vs the `whatsapp/` subdirectory |
| **Resolution** | (1) Changed to `spawn('/usr/bin/node', ...)`. (2) Created `extensions/whatsapp/` dir. (3) Installed `qrencode` via apt. (4) Installed baileys in correct directory with local `package.json` |
| **Files changed** | `agent-server.js`, `aba-deploy-orchestrator.sh` |
| **Commit** | `98c49dd` (partial — spawn path + orchestrator changes included) |
| **Verified** | Pairing script runs, generates QR, writes `{stage:'qr_ready'}` ✅ |
| **Prevention** | Orchestrator now creates dir, installs baileys in correct location, and installs qrencode on provision. Also added systemd drop-in with correct PATH |

---

## #1 — WhatsApp Link Returns "Invalid x-agent-token" (401)

| Field | Value |
|-------|-------|
| **Date** | 2026-06-21 |
| **Summary** | Peter Grace's WhatsApp Link button returned HTTP 401 `{"error":"Invalid x-agent-token"}` |
| **Symptoms** | All `/whatsapp/*` API calls from backend to agent-server returned 401 |
| **Root Cause** | Backend `.env` had `AGENT_TOKEN=*** while Peter's EC2 agent-server was provisioned with `AGENT_TOKEN=aba-agent-4321-secure-key`. Token mismatch — orchestrator hardcodes one value, `.env` had a different one |
| **Resolution** | Changed `.env` to match `aba-agent-4321-secure-key`. Restarted backend service |
| **Files changed** | `/opt/aba-backend/.env` (not in git — sensitive) |
| **Commit** | N/A — env file excluded from git |
| **Verified** | Curl with correct token → `200`, old token → `401` ✅ |
| **Prevention** | Orchestrator and `.env` now use the same hardcoded value. Future: store in config table or SSM Parameter Store for single source of truth |

---

## #0 — Team Agents Not Showing in Dashboard (Missing Column)

| Field | Value |
|-------|-------|
| **Date** | 2026-06-21 |
| **Summary** | Peter Grace's "Your Team" section showed no agents even though Mary & Promise existed in DB |
| **Symptoms** | Frontend rendered empty `[]`. API returned 500 |
| **Root Cause** | Startup migration: `ALTER TABLE aba_team_agents ADD COLUMN timezone VARCHAR(64)` — column already existed. Entire migration block failed silently. `custom_instructions` column was never created. API query `SELECT custom_instructions FROM aba_team_agents` crashed with MySQL column-not-found |
| **Resolution** | Added `custom_instructions` column manually. Refactored migration to add columns **one per check** instead of one big ALTER TABLE |
| **Files changed** | `server.ts` (migration logic) |
| **Commit** | `4382c37` — "fix: silent migration failures — missing custom_instructions column broke /api/team-agents" |
| **Verified** | API returns Mary & Promise ✅ |
| **Prevention** | Migration now checks each column individually. A failed ADD COLUMN won't block subsequent ones |

---

## Past: Google Calendar OAuth — Silent 302 Redirect Crashes

| Field | Value |
|-------|-------|
| **Date** | 2026-06-18 |
| **Summary** | Google Calendar OAuth flow crashed — redirect URLs lost data |
| **Symptoms** | Users got blank page after Google OAuth callback |
| **Root Cause** | (1) Logout redirect didn't preserve www vs root domain — localStorage lost. (2) `require()` used instead of `import` in ES module context. (3) SCP target directory didn't exist on EC2. (4) gog binary missing |
| **Resolution** | Fixed domain normalization, changed imports, created SCP dir, installed gog |
| **Files changed** | Multiple backend files |
| **Commit** | N/A |
| **Verified** | Calendar sync works ✅ |

---

## Past: DeepSeek Auth — Kelechi Not Responding

| Field | Value |
|-------|-------|
| **Date** | 2026-06-19 |
| **Summary** | Kelechi agent dead with "Unknown model: deepseek/deepseek-chat" |
| **Symptoms** | Agent startup: model auth failure |
| **Root Cause** | Config file had truncated DeepSeek key (masked version from terminal echo). Real key from DB was longer (35 chars) |
| **Resolution** | Generated config with full key via `/tmp/gen-ribbles-config.py`, applied via gateway config patch, restarted |
| **Files changed** | `openclaw.json` (remote EC2) |
| **Commit** | N/A — config file on server |
| **Verified** | Kelechi back online ✅ |

---

## Past: LinkedIn API Config — 500 Error on Company Page Save

| Field | Value |
|-------|-------|
| **Date** | 2026-06-18 |
| **Summary** | Saving LinkedIn company page config returned HTTP 500 |
| **Symptoms** | Dashboard showed error toast after saving LinkedIn config |
| **Root Cause** | Backend query used `ON DUPLICATE KEY UPDATE` with `VALUES()` syntax — deprecated in MySQL 8.0+. Also foreign key constraint failed because `aba_user_business_id` referenced a different user |
| **Resolution** | Replaced `VALUES()` with `NEW()` syntax, fixed FK to reference correct user |
| **Files changed** | `server.ts` |
| **Commit** | N/A |
| **Verified** | LinkedIn config saves successfully ✅ |
