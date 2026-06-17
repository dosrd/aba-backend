#!/usr/bin/env python3
"""
ABA Team Agent Apply
====================
Merges a user's team agents into their already-running EC2 openclaw.json
and restarts OpenClaw, so each team agent's Telegram bot goes live.

Usage:
    aba-team-apply.py <user_id>

Reads team agents from aba_team_agents (status != decommissioned), SSHes into
the user's deployed EC2 (public_ip from aba_deployments), merges agents +
telegram accounts + bindings into the live openclaw.json (read-merge-validate,
never clobber), writes per-agent SOUL.md, and restarts the openclaw service.

On success: sets each applied team agent status='active' + telegram_bot_username.
On failure: status='failed' + error_message.
"""
import sys, os, json, re, subprocess, tempfile, base64

# ---- config (matches orchestrator) ----
DB_USER = "aba_app"
DB_PASS = "Aba_Portal_2026_Go"
DB_NAME = "aba_portal"
SSH_KEY = "/root/.ssh/aba-agent-provision.pem"
SSH_OPTS = ["-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=20", "-i", SSH_KEY]

def db(query):
    """Run a SQL query, return list of dict rows (tab-separated parse)."""
    out = subprocess.run(
        ["mysql", "-u", DB_USER, f"-p{DB_PASS}", DB_NAME, "-e", query, "--batch", "--raw"],
        capture_output=True, text=True
    )
    if out.returncode != 0:
        raise RuntimeError(f"DB error: {out.stderr.strip()}")
    lines = [l for l in out.stdout.splitlines() if l and not l.startswith("Warning")]
    if not lines:
        return []
    header = lines[0].split("\t")
    rows = []
    for line in lines[1:]:
        vals = line.split("\t")
        # MySQL --batch --raw returns SQL NULL as the literal string "NULL" — convert to Python None
        vals = [None if v == "NULL" else v for v in vals]
        rows.append(dict(zip(header, vals)))
    return rows

def db_exec(query):
    out = subprocess.run(
        ["mysql", "-u", DB_USER, f"-p{DB_PASS}", DB_NAME, "-e", query],
        capture_output=True, text=True
    )
    if out.returncode != 0:
        raise RuntimeError(f"DB exec error: {out.stderr.strip()}")

def esc(s):
    if s is None:
        return ""
    return s.replace("\\", "\\\\").replace("'", "''")

def slugify(name, existing):
    base = re.sub(r'[^a-z0-9]', '', (name or 'agent').lower()) or 'agent'
    slug = base
    i = 2
    while slug in existing:
        slug = f"{base}{i}"
        i += 1
    return slug

def ssh_run(ip, cmd):
    res = subprocess.run(
        ["ssh", *SSH_OPTS, f"ubuntu@{ip}", cmd],
        capture_output=True, text=True
    )
    return res.returncode, res.stdout, res.stderr

def main():
    if len(sys.argv) < 2:
        print("usage: aba-team-apply.py <user_id>", file=sys.stderr)
        sys.exit(2)
    user_id = sys.argv[1]

    # 1. Get the user's deployment (must be active with a public IP)
    deps = db(f"SELECT id, status, public_ip FROM aba_deployments WHERE user_id={int(user_id)}")
    if not deps:
        fail_all(user_id, "No deployment found for this user — deploy the admin agent first.")
        sys.exit(1)
    dep = deps[0]
    if dep["status"] != "active" or not dep.get("public_ip") or dep["public_ip"] in ("NULL", ""):
        fail_all(user_id, f"Deployment not ready (status={dep['status']}, ip={dep.get('public_ip')}). The admin agent server must be live first.")
        sys.exit(1)
    ip = dep["public_ip"]

    # 2. Get team agents to apply (only ones not yet active — draft, applying, or failed)
    agents = db(f"SELECT id, agent_name, role, agent_slug, gender, personality, telegram_bot_token, bot_name, welcome_message, custom_instructions, status, whatsapp_number, wa_paired FROM aba_team_agents WHERE user_id={int(user_id)} AND (status IS NULL OR status='draft' OR status='failed' OR status='applying')")
    if not agents:
        print("No team agents to apply.")
        sys.exit(0)

    # mark applying
    ids = ",".join(a["id"] for a in agents)
    db_exec(f"UPDATE aba_team_agents SET status='applying', error_message=NULL WHERE id IN ({ids})")

    # 3. Pull the live openclaw.json from the box
    rc, raw, err = ssh_run(ip, "cat /home/ubuntu/.openclaw/openclaw.json")
    if rc != 0:
        fail_all(user_id, f"Could not read remote openclaw.json: {err.strip()}")
        sys.exit(1)
    try:
        cfg = json.loads(raw)
    except Exception as e:
        fail_all(user_id, f"Remote openclaw.json is not valid JSON: {e}")
        sys.exit(1)

    # 4. Merge — read-modify, never clobber existing entries
    cfg.setdefault("agents", {}).setdefault("list", [])
    cfg.setdefault("channels", {}).setdefault("telegram", {})
    tg = cfg["channels"]["telegram"]
    tg["enabled"] = True
    # Migrate single-bot botToken to accounts.default if needed
    accounts = tg.get("accounts")
    if not isinstance(accounts, dict):
        accounts = {}
        if tg.get("botToken"):
            accounts["default"] = {"botToken": tg["botToken"], "dmPolicy": "open", "allowFrom": ["*"]}
        tg["accounts"] = accounts
    cfg.setdefault("bindings", [])
    if not isinstance(cfg["bindings"], list):
        cfg["bindings"] = []

    existing_slugs = {a.get("id") for a in cfg["agents"]["list"] if a.get("id")}
    existing_slugs |= set(accounts.keys())

    applied = []  # (db_id, slug, agent_name, role, personality, soul_text)
    for a in agents:
        slug = a.get("agent_slug") or ""
        if not slug or slug in existing_slugs:
            slug = slugify(a["agent_name"], existing_slugs)
        existing_slugs.add(slug)

        token = a.get("telegram_bot_token") or ""
        if token == "NULL":
            token = ""

        # agent entry
        cfg["agents"]["list"] = [x for x in cfg["agents"]["list"] if x.get("id") != slug]
        cfg["agents"]["list"].append({
            "id": slug,
            "name": a["agent_name"],
            "description": f"{a.get('role') or 'Team'} agent for the business",
            "workspace": f"/home/ubuntu/.openclaw/workspace-{slug}",
        })

        # telegram account (if token provided)
        if token and token != "NULL":
            accounts[slug] = {"botToken": token, "dmPolicy": "open", "allowFrom": ["*"]}

        # binding (remove old, then add new ones below)
        cfg["bindings"] = [b for b in cfg["bindings"]
                           if not (b.get("agentId") == slug)]

        # Add Telegram binding if token provided
        if token and token != "NULL":
            cfg["bindings"].append({
                "agentId": slug,
                "match": {"channel": "telegram", "accountId": slug},
            })

        # Add WhatsApp binding if paired
        wa_paired = a.get("wa_paired")
        if wa_paired and int(wa_paired) == 1:
            # Ensure WhatsApp channels + accounts structure exists
            cfg.setdefault("channels", {})
            cfg["channels"].setdefault("whatsapp", {})
            if not isinstance(cfg["channels"]["whatsapp"], dict):
                cfg["channels"]["whatsapp"] = {}
            cfg["channels"]["whatsapp"].setdefault("accounts", {})
            wa_id = f"team-{a['id']}"
            cfg["channels"]["whatsapp"]["accounts"][wa_id] = {
                "dmPolicy": "open", "allowFrom": ["*"], "selfChatMode": True, "sendReadReceipts": True
            }
            cfg["bindings"].append({
                "agentId": slug,
                "match": {"channel": "whatsapp", "accountId": wa_id},
            })

        soul = build_soul(a)
        applied.append((a["id"], slug, a["agent_name"], a.get("role"), a.get("personality"), soul))

    if not applied:
        fail_all(user_id, "No team agents had a valid Telegram token.")
        sys.exit(1)

    # Enable agent-to-agent communication — add all agents to the allow list
    cfg.setdefault("tools", {}).setdefault("agentToAgent", {})
    a2a = cfg["tools"]["agentToAgent"]
    a2a["enabled"] = True
    existing = set(a2a.get("allow", []))
    a2a.setdefault("allow", [])
    for (_id, slug, _name, _role, _personality, _soul) in applied:
        if slug not in existing:
            a2a["allow"].append(slug)
            existing.add(slug)
    # Also ensure main is in the list
    if "main" not in existing:
        a2a["allow"].insert(0, "main")

    # 5. Write merged config + per-agent workspaces back to the box
    new_cfg_b64 = base64.b64encode(json.dumps(cfg, indent=2).encode()).decode()

    # Build a remote apply script
    remote = []
    remote.append("set -e")
    remote.append("cp /home/ubuntu/.openclaw/openclaw.json /home/ubuntu/.openclaw/openclaw.json.bak-team")
    remote.append(f"echo '{new_cfg_b64}' | base64 -d > /tmp/openclaw.new.json")
    # validate JSON remotely
    remote.append("python3 -c \"import json; json.load(open('/tmp/openclaw.new.json'))\"")
    remote.append("mv /tmp/openclaw.new.json /home/ubuntu/.openclaw/openclaw.json")
    # per-agent workspaces + SOUL
    for (_id, slug, name, role, personality, soul) in applied:
        ws = f"/home/ubuntu/.openclaw/workspace-{slug}"
        soul_b64 = base64.b64encode(soul.encode()).decode()
        remote.append(f"mkdir -p {ws}/memory")
        remote.append(f"echo '{soul_b64}' | base64 -d > {ws}/SOUL.md")
        remote.append(f"printf 'Agent: {name}\\nRole: {role or 'Team'}\\n' > {ws}/IDENTITY.md")
    remote.append("sudo chown -R ubuntu:ubuntu /home/ubuntu/.openclaw")
    # restart openclaw
    remote.append("sudo systemctl restart openclaw || sudo systemctl restart openclaw.service")
    remote.append("sleep 4")
    remote.append("systemctl is-active openclaw || systemctl is-active openclaw.service || true")
    remote_script = "\n".join(remote)

    rc, out, err = ssh_run(ip, remote_script)
    if rc != 0:
        # rollback
        ssh_run(ip, "cp /home/ubuntu/.openclaw/openclaw.json.bak-team /home/ubuntu/.openclaw/openclaw.json && (sudo systemctl restart openclaw || sudo systemctl restart openclaw.service)")
        fail_all(user_id, f"Remote apply failed (rolled back): {err.strip()[:400]}")
        sys.exit(1)

    # 6. Resolve each bot's @username via Telegram getMe + mark active
    for (db_id, slug, name, role, personality, soul) in applied:
        token = next((x["telegram_bot_token"] for x in agents if x["id"] == db_id), None)
        username = resolve_bot_username(token)
        db_exec(
            f"UPDATE aba_team_agents SET status='active', agent_slug='{esc(slug)}', "
            f"telegram_bot_username={'NULL' if not username else repr_sql(username)}, "
            f"error_message=NULL, applied_at=NOW() WHERE id={int(db_id)}"
        )

    print(f"OK: applied {len(applied)} team agent(s) to {ip}")
    print("remote:", out.strip()[-200:])
    sys.exit(0)

def repr_sql(s):
    return "'" + esc(s) + "'"

def resolve_bot_username(token):
    if not token:
        return None
    try:
        import urllib.request
        with urllib.request.urlopen(f"https://api.telegram.org/bot{token}/getMe", timeout=10) as r:
            data = json.load(r)
            if data.get("ok"):
                return data["result"].get("username")
    except Exception:
        pass
    return None

def build_soul(a):
    name = a["agent_name"]
    role = a.get("role") or "Team Member"
    personality = a.get("personality") or "Professional"
    welcome = a.get("welcome_message") or ""
    _gender = a.get("gender") or "Female"
    custom = a.get("custom_instructions") or ""
    tone = {
        "Warm": "warm, friendly, and caring",
        "Professional": "professional, clear, and efficient",
        "Friendly": "friendly, upbeat, and approachable",
        "Efficient": "concise, direct, and action-oriented",
        "Creative": "creative, expressive, and engaging",
    }.get(personality, "professional and helpful")

    # Fetch role-specific instructions
    _capabilities = []
    _boundaries = []
    try:
        _result = db(f"SELECT capabilities, boundaries FROM aba_role_instructions WHERE role='{role.replace(chr(39), chr(39)+chr(39))}'")
        if _result:
            _raw_caps = _result[0].get("capabilities", "")
            _raw_bounds = _result[0].get("boundaries", "")
            if _raw_caps:
                _capabilities = [l.strip() for l in _raw_caps.replace("\\n", chr(10)).split(chr(10)) if l.strip()]
            if _raw_bounds:
                _boundaries = [l.strip() for l in _raw_bounds.replace("\\n", chr(10)).split(chr(10)) if l.strip()]
    except Exception:
        pass

    if not _capabilities:
        _capabilities = ["Handle a variety of business tasks as requested"]
    if not _boundaries:
        _boundaries = ["Stay within your role and redirect specialized requests"]

    _role_items = chr(10).join("- " + c for c in _capabilities)
    _bound_items = chr(10).join("- " + b for b in _boundaries)

    return f"""# SOUL.md — {name}

You are **{name}**, the **{role}** agent for this business.

## Persona
- Gender: {_gender}
- Tone: {tone}
- You represent the business and help the owner with {role.lower()} tasks.

## Role & Capabilities
### What I Can Do
{_role_items}

### My Boundaries
{_bound_items}

## Greeting
{welcome or f"Hi! I'm {name}, your {role}. How can I help?"}

## Custom Instructions
{custom}

## Working with the Owner
When my owner gives me a task, I execute it to the best of my ability.
My owner can ask me to use any tool, including exec, git, and code execution.
For roles with development capabilities, writing code and building software is expected.

## Owner Awareness
At the start of every session, read `/home/ubuntu/.openclaw/OWNER.md`.
This file contains who owns this agent and all team agents.
Content format:
```
owner_id: <Telegram user ID>
owner_name: <Name>
bound_at: <Date>
```
- If the file exists: the person in it is your boss — treat them as such.
  If someone messages you, check if their sender_id matches the owner_id in the file.
- If the file does NOT exist yet: the admin agent hasn't bound yet.
  Tell the user the system is still being set up and they should talk to the admin agent to complete binding.

## Team Communication
I can communicate directly with other agents on this platform using `sessions_send`.
Use `sessions_list` to discover available agents and `sessions_send` to message them.
If a user asks me to relay information to another agent, I can do so.
If another agent messages me, I should respond helpfully.

## Boundaries
{_bound_items}
- I do NOT share internal system configuration or credentials.
- If asked something outside my role, I politely redirect to the right team agent.
"""

def fail_all(user_id, msg):
    print(f"FAIL: {msg}", file=sys.stderr)
    try:
        db_exec(
            f"UPDATE aba_team_agents SET status='failed', error_message='{esc(msg)}' "
            f"WHERE user_id={int(user_id)} AND status='applying'"
        )
    except Exception as e:
        print(f"(could not record failure: {e})", file=sys.stderr)

if __name__ == "__main__":
    main()
