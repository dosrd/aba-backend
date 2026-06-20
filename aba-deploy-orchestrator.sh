#!/bin/bash
# =============================================================================
# ABA Deploy Orchestrator
# =============================================================================
# Picks up pending deployments from aba_deployments and provisions EC2.
# Run by cron every minute.
#
# ⚠️  Anti-duplicate safeguards:
#   1. Atomic claim — UPDATE ... WHERE status='pending' is the lock (DB-level, no race)
#   2. Stale recovery — deployments stuck in 'provisioning' >15 min are auto-retried
#   3. Health check — active deployments are probed; dead ones flagged
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/.aba-aws-env"

DB_USER="aba_app"
DB_PASS="Aba_Portal_2026_Go"
DB_NAME="aba_portal"

export AWS_REGION="$REGION"
export AWS_DEFAULT_REGION="$REGION"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# Trap: if we crash after claiming a deployment, mark it failed, not stranded
_CURRENT_DEPLOY_ID=""
cleanup_on_exit() {
  local ec=$?
  if [ "$ec" -ne 0 ] && [ -n "$_CURRENT_DEPLOY_ID" ]; then
    log "💀 Crash exit $ec — marking deploy #$_CURRENT_DEPLOY_ID as failed"
    mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
      UPDATE aba_deployments SET status = 'failed', error_message = 'Provisioning crashed (exit $ec) — check orchestrator logs', updated_at = NOW() WHERE id = $_CURRENT_DEPLOY_ID AND status = 'provisioning'
    " 2>/dev/null || true
  fi
}
trap cleanup_on_exit EXIT

# ─── Step 0: Health-check active deployments ──────────────
# If an active agent stops responding, flag it (but don't auto-kill)
log "Checking active deployments..."
mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e "
  SELECT id, public_ip, telegram_bot_username
  FROM aba_deployments
  WHERE status = 'active'
    AND (last_health_check IS NULL OR last_health_check < NOW() - INTERVAL 10 MINUTE)
" 2>/dev/null | while read -r DEPLOY_ID PUBLIC_IP BOT_USER; do
  HTTP_CODE=000
  if [ -n "$PUBLIC_IP" ]; then
    HTTP_CODE=$(curl -sk -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 8 \
      "https://$PUBLIC_IP/" 2>/dev/null || echo "000")
  fi

  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "502" ]; then
    # 502 from Caddy before OpenClaw is fine — the reverse proxy is alive
    mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
      UPDATE aba_deployments SET last_health_check = NOW() WHERE id = $DEPLOY_ID
    " 2>/dev/null
  elif [ "$HTTP_CODE" != "000" ]; then
    # Got a response but not expected — still mark healthy (might be custom page)
    mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
      UPDATE aba_deployments SET last_health_check = NOW() WHERE id = $DEPLOY_ID
    " 2>/dev/null
  else
    log "⚠️  Deploy #$DEPLOY_ID ($PUBLIC_IP) unreachable — checking instance health"
    # Fetch the instance_id for this deployment
    CHECK_ID=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e \
      "SELECT instance_id FROM aba_deployments WHERE id = $DEPLOY_ID" 2>/dev/null)
    if [ -n "$CHECK_ID" ]; then
      STATE=$(aws ec2 describe-instances --instance-ids "$CHECK_ID" --region "$REGION" \
        --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null || echo "gone")
      if [ "$STATE" = "terminated" ] || [ "$STATE" = "stopped" ] || [ "$STATE" = "gone" ]; then
        log "🔄 Instance $CHECK_ID is $STATE — re-queuing deployment #$DEPLOY_ID for replacement"
        mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
          UPDATE aba_deployments
          SET status = 'pending',
              instance_id = NULL,
              public_ip = NULL,
              error_message = CONCAT(IFNULL(error_message,''), '; Auto-replace: instance $CHECK_ID was $STATE at ', NOW()),
              updated_at = NOW()
          WHERE id = $DEPLOY_ID
        " 2>/dev/null
      else
        log "⚠️  Instance $CHECK_ID is $STATE but unreachable — manual intervention may be needed"
        mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
          UPDATE aba_deployments SET error_message = CONCAT(IFNULL(error_message,''), '; Health check failed at ', NOW()) WHERE id = $DEPLOY_ID
        " 2>/dev/null
      fi
    else
      # No instance_id stored — can't replace
      log "⚠️  Deploy #$DEPLOY_ID has no instance_id — just flagging"
      mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
        UPDATE aba_deployments SET error_message = CONCAT(IFNULL(error_message,''), '; Health check failed at ', NOW()) WHERE id = $DEPLOY_ID
      " 2>/dev/null
    fi
  fi
done

# ─── Step 1: Recover stale provisioning (>15 min) ─────────
STALE=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e "
  SELECT COUNT(*) FROM aba_deployments
  WHERE status = 'provisioning' AND updated_at < NOW() - INTERVAL 15 MINUTE
" 2>/dev/null)
if [ "$STALE" -gt 0 ]; then
  log "🔄 Recovering $STALE stale provisioning(s) back to pending"
  mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
    UPDATE aba_deployments
    SET status = 'failed',
        error_message = CONCAT(IFNULL(error_message,''), '; Timed out after 15 min in provisioning (retry limit exceeded)'),
        updated_at = NOW()
    WHERE status = 'provisioning' AND updated_at < NOW() - INTERVAL 15 MINUTE
  " 2>/dev/null
fi

# ─── Step 2: Atomically claim the next pending ────────────
# MySQL UPDATE ... WHERE status='pending' is atomic thanks to
# InnoDB row-level locks. Only one concurrent cron run wins.
# The SELECT then reads the claimed row back.
mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
  UPDATE aba_deployments
  SET status = 'provisioning', updated_at = NOW()
  WHERE status = 'pending'
  ORDER BY id ASC
  LIMIT 1
" 2>/dev/null

# Read claimed row
pending=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e "
  SELECT d.id, d.user_id, u.email, u.name
  FROM aba_deployments d
  JOIN aba_users u ON d.user_id = u.id
  WHERE d.status = 'provisioning' AND d.updated_at > NOW() - INTERVAL 1 MINUTE
  ORDER BY d.id ASC
  LIMIT 1
" 2>/dev/null)

# ─── Check if already running elsewhere (double-spawn guard) ─
if [ -n "$pending" ]; then
  DEPLOY_ID=$(echo "$pending" | awk '{print $1}')
  # Extra safety: check if this exact deploy already has an instance
  EXISTING_INSTANCE=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e \
    "SELECT instance_id FROM aba_deployments WHERE id = $DEPLOY_ID AND instance_id IS NOT NULL" 2>/dev/null)
  if [ -n "$EXISTING_INSTANCE" ]; then
    # Check if it's actually running
    STATE=$(aws ec2 describe-instances --instance-ids "$EXISTING_INSTANCE" --region "$REGION" \
      --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null || echo "gone")
    if [ "$STATE" = "running" ] || [ "$STATE" = "pending" ]; then
      log "⚠️  Deploy #$DEPLOY_ID already has running instance $EXISTING_INSTANCE ($STATE) — marking active"
      mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
        UPDATE aba_deployments SET status = 'active', updated_at = NOW() WHERE id = $DEPLOY_ID
      " 2>/dev/null
      exit 0
    else
      log "🔄 Instance $EXISTING_INSTANCE is $STATE — will re-provision"
    fi
  fi
fi

[ -z "$pending" ] && exit 0

_CURRENT_DEPLOY_ID="$DEPLOY_ID"

echo ""
log "============================================="
log "Found pending deployment!"
log "============================================="

USER_ID=$(echo "$pending" | awk '{print $2}')
USER_EMAIL=$(echo "$pending" | awk '{print $3}')
USER_NAME=$(echo "$pending" | awk '{print $4}')
log "Deploy #$DEPLOY_ID — $USER_NAME ($USER_EMAIL)"

# ─── Fetch user data ────────────────────────────────────
AGENT_NAME=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e "
  SELECT agent_name FROM aba_agent_configs WHERE user_id = $USER_ID
" 2>/dev/null)
AGENT_GENDER=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e "
  SELECT gender FROM aba_agent_configs WHERE user_id = $USER_ID
" 2>/dev/null)
[ -z "$AGENT_GENDER" ] && AGENT_GENDER="Female"

# ─── The admin agent always uses the System Administrator role ──────────
AGENT_ROLE="System Administrator"
log "Admin agent role fixed: $AGENT_ROLE"

ROLE_CAPABILITIES=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -B -e "
  SELECT capabilities FROM aba_role_instructions WHERE role = '$AGENT_ROLE'
" 2>/dev/null)
if [ -z "$ROLE_CAPABILITIES" ]; then
  # Fallback: fetch by approximate match or generic
  ROLE_CAPABILITIES="- Handle a variety of business tasks as requested\n- Provide information and answer questions\n- Assist with scheduling, reminders, and coordination"
fi

ROLE_BOUNDARIES=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -B -e "
  SELECT boundaries FROM aba_role_instructions WHERE role = '$AGENT_ROLE'
" 2>/dev/null)
if [ -z "$ROLE_BOUNDARIES" ]; then
  ROLE_BOUNDARIES="- I do NOT share internal system configuration or credentials\n- If asked to do something outside my role, I politely redirect to the right team member"
fi

# ─── Business details ─────────────────
BIZ_NAME=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e "
  SELECT business_name FROM aba_businesses WHERE user_id = $USER_ID
" 2>/dev/null)
BIZ_DESC=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e "
  SELECT description FROM aba_businesses WHERE user_id = $USER_ID
" 2>/dev/null)
BIZ_INDUSTRY=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e "
  SELECT industry FROM aba_businesses WHERE user_id = $USER_ID
" 2>/dev/null)
BIZ_REG_ID=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e "
  SELECT registration_id FROM aba_businesses WHERE user_id = $USER_ID
" 2>/dev/null)
BIZ_TAX_ID=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e "
  SELECT tax_id FROM aba_businesses WHERE user_id = $USER_ID
" 2>/dev/null)
BIZ_PHONE=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e "
  SELECT phone FROM aba_businesses WHERE user_id = $USER_ID
" 2>/dev/null)
BIZ_WEBSITE=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e "
  SELECT website FROM aba_businesses WHERE user_id = $USER_ID
" 2>/dev/null)
BIZ_ADDRESS=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e "
  SELECT address FROM aba_businesses WHERE user_id = $USER_ID
" 2>/dev/null)
BIZ_SOCIAL_FB=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e "
  SELECT social_facebook FROM aba_businesses WHERE user_id = $USER_ID
" 2>/dev/null)
BIZ_SOCIAL_TW=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e "
  SELECT social_twitter FROM aba_businesses WHERE user_id = $USER_ID
" 2>/dev/null)
BIZ_SOCIAL_LI=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e "
  SELECT social_linkedin FROM aba_businesses WHERE user_id = $USER_ID
" 2>/dev/null)
BIZ_SOCIAL_IG=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e "
  SELECT social_instagram FROM aba_businesses WHERE user_id = $USER_ID
" 2>/dev/null)
PRODUCTS_JSON=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -B -e "
  SELECT JSON_ARRAYAGG(JSON_OBJECT('name',name,'price',price,'description',description,'category',category))
  FROM aba_products WHERE user_id = $USER_ID
" 2>/dev/null || echo '[]')
if [ -z "$PRODUCTS_JSON" ] || [ "$PRODUCTS_JSON" = 'NULL' ]; then PRODUCTS_JSON='[]'; fi

TELEGRAM_TOKEN=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e "
  SELECT telegram_bot_token FROM aba_agent_configs WHERE user_id = $USER_ID
" 2>/dev/null)
DEEPSEEK_KEY=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e "
  SELECT api_key FROM aba_api_keys WHERE user_id = $USER_ID AND provider = 'deepseek' AND is_active = 1 LIMIT 1
" 2>/dev/null || true)
OPENAI_KEY=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e "
  SELECT api_key FROM aba_api_keys WHERE user_id = $USER_ID AND provider = 'openai' AND is_active = 1 LIMIT 1
" 2>/dev/null || true)
BIND_CODE=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e "
  SELECT bind_code FROM aba_deployments WHERE id = $DEPLOY_ID
" 2>/dev/null || echo '')

# Fetch extended agent config for tools/integrations
AGENT_CONFIG_JSON=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -B -e "
  SELECT JSON_OBJECT(
    'whatsapp_number', whatsapp_number,
    'whatsapp_open_dm', whatsapp_open_dm,
    'integrations', integrations,
    'email_pop_host', email_pop_host,
    'email_pop_port', email_pop_port,
    'email_pop_user', email_pop_user,
    'twilio_sid', twilio_sid,
    'twilio_phone', twilio_phone,
    'github_token', github_token,
    'woo_url', woo_url,
    'woo_key', woo_key,
    'woo_secret', woo_secret,
    'db_connection_string', db_connection_string,
    'google_drive_folder', google_drive_folder
  ) FROM aba_agent_configs WHERE user_id = $USER_ID
" 2>/dev/null || echo '{}')

if [ -z "$TELEGRAM_TOKEN" ]; then
  log "⚠️ No Telegram token for user $USER_ID — deploying without channels"
  HAS_TELEGRAM=false
else
  HAS_TELEGRAM=true
fi

# ─── Build config JSON using Python ─────────────────────
ADMIN_TOKEN=$(openssl rand -hex 32)

export CONFIG_B64=$(python3 -c "
import json, base64
from datetime import datetime, timezone

now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')

config = {
    'gateway': {
        'mode': 'local', 'port': 8080, 'bind': 'lan',
        'auth': {'mode': 'token', 'token': '$ADMIN_TOKEN'},
        'controlUi': {'allowedOrigins': ['*']}
    },
    'meta': {'lastTouchedVersion': '2026.6.6', 'lastTouchedAt': now},
    'agents': {
        'defaults': {
            'workspace': '/home/ubuntu/.openclaw/workspace',
            'model': 'deepseek/deepseek-chat'
        },
        'list': [{'id': 'main', 'name': '$AGENT_NAME', 'description': 'Agent for $USER_NAME'}]
    },
    'models': {'providers': {}},
    'tools': {
        'agentToAgent': {
            'enabled': True,
            'allow': ['main']
        }
    },
    'channels': {},
    'bindings': []
}

# Telegram channel (for main agent)
telegram_token = '$TELEGRAM_TOKEN'
if telegram_token:
    config['channels']['telegram'] = {
        'enabled': True,
        'accounts': {
            'main': {
                'botToken': telegram_token,
                'dmPolicy': 'open',
                'allowFrom': ['*']
            }
        }
    }
    config['bindings'].append({
        'agentId': 'main',
        'match': {'channel': 'telegram', 'accountId': 'main'}
    })

# Parse extended agent config for integrations/connections
import json as _j
try:
    agent_cfg = _j.loads('''$AGENT_CONFIG_JSON''')
except:
    agent_cfg = {}

integrations = agent_cfg.get('integrations') or []
if isinstance(integrations, str):
    integrations = _j.loads(integrations)

# WhatsApp channel (requires phone number configured)
whatsapp_number = agent_cfg.get('whatsapp_number') or ''
if whatsapp_number and 'whatsapp' in integrations:
    open_dm = bool(agent_cfg.get('whatsapp_open_dm', 1))
    config['channels']['whatsapp'] = {
        'enabled': True,
        'dmPolicy': 'open' if open_dm else 'allowlist',
        'groupPolicy': 'open' if open_dm else 'allowlist',
        'selfChatMode': True,
        'accounts': {
            'default': {
                'dmPolicy': 'open' if open_dm else 'allowlist',
                'allowFrom': ['*'] if open_dm else [whatsapp_number],
                'groupPolicy': 'open' if open_dm else 'allowlist',
                'selfChatMode': True
            }
        }
    }
    print(f'🔌 WhatsApp channel configured for {whatsapp_number}', file=sys.stderr)

deepseek_key = '$DEEPSEEK_KEY'
if deepseek_key:
    config['models']['providers']['deepseek'] = {
        'baseUrl': 'https://api.deepseek.com',
        'apiKey': deepseek_key,
        'models': [
            {'id': 'deepseek-chat', 'name': 'DeepSeek Chat', 'contextWindow': 128000, 'maxTokens': 8192},
            {'id': 'deepseek-reasoner', 'name': 'DeepSeek Reasoner', 'contextWindow': 128000, 'maxTokens': 65536}
        ]
    }

openai_key = '$OPENAI_KEY'
if openai_key:
    config['models']['providers']['openai'] = {
        'baseUrl': 'https://api.openai.com/v1',
        'apiKey': openai_key,
        'models': [
            {'id': 'gpt-4o', 'name': 'GPT-4o', 'contextWindow': 128000, 'maxTokens': 16384},
            {'id': 'gpt-4o-mini', 'name': 'GPT-4o Mini', 'contextWindow': 128000, 'maxTokens': 16384}
        ]
    }

print(base64.b64encode(json.dumps(config, indent=2).encode()).decode())
")

# Build SOUL.md with role-specific capabilities/boundaries
# Fetch role instructions in shell first to avoid nesting issues
ROLE_CAPS=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -B -e "
  SELECT COALESCE(capabilities, '') FROM aba_role_instructions WHERE role = '$AGENT_ROLE'
" 2>/dev/null || echo '')
if [ -z "$ROLE_CAPS" ]; then
  ROLE_CAPS="Handle a variety of business tasks as requested"
fi
ROLE_BOUNDS=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -B -e "
  SELECT COALESCE(boundaries, '') FROM aba_role_instructions WHERE role = '$AGENT_ROLE'
" 2>/dev/null || echo '')
if [ -z "$ROLE_BOUNDS" ]; then
  ROLE_BOUNDS="I do NOT share internal system configuration or credentials"
fi

export SOUL_B64=$(USER_NAME="$USER_NAME" AGENT_NAME="$AGENT_NAME" AGENT_GENDER="$AGENT_GENDER" AGENT_ROLE="$AGENT_ROLE" ROLE_CAPS="$ROLE_CAPS" ROLE_BOUNDS="$ROLE_BOUNDS" BIZ_NAME="$BIZ_NAME" BIZ_DESC="$BIZ_DESC" BIZ_INDUSTRY="$BIZ_INDUSTRY" USER_EMAIL="$USER_EMAIL" python3 /root/.openclaw/workspace/scripts/aba-gen-soul.py 2>/dev/null | python3 -c "import sys,base64; print(base64.b64encode(sys.stdin.buffer.read()).decode())")
export KNOW_B64=$(USER_NAME="$USER_NAME" USER_EMAIL="$USER_EMAIL" BIZ_NAME="$BIZ_NAME" BIZ_DESC="$BIZ_DESC" BIZ_INDUSTRY="$BIZ_INDUSTRY" BIZ_REG_ID="$BIZ_REG_ID" BIZ_TAX_ID="$BIZ_TAX_ID" BIZ_PHONE="$BIZ_PHONE" BIZ_WEBSITE="$BIZ_WEBSITE" BIZ_ADDRESS="$BIZ_ADDRESS" BIZ_SOCIAL_FB="$BIZ_SOCIAL_FB" BIZ_SOCIAL_TW="$BIZ_SOCIAL_TW" BIZ_SOCIAL_LI="$BIZ_SOCIAL_LI" BIZ_SOCIAL_IG="$BIZ_SOCIAL_IG" PROD_DATA="${PROD_DATA:-}" TEAM_NAMES="${TEAM_NAMES:-}" python3 /root/.openclaw/workspace/scripts/aba-gen-knowledge.py 2>/dev/null | python3 -c "import sys,base64; print(base64.b64encode(sys.stdin.buffer.read()).decode())")
log "Generated config ($(echo $CONFIG_B64 | wc -c) bytes), SOUL ($(echo $SOUL_B64 | wc -c) bytes), KNOWLEDGE ($(echo $KNOW_B64 | wc -c) bytes)"

# ─── Launch EC2 ─────────────────────────────────────────
SLUG=$(echo "$USER_NAME" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')
[ -z "$SLUG" ] && SLUG="user-$USER_ID"

AMI_ID=$(aws ec2 describe-images --region "$REGION" --owners 099720109477 \
  --filters "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" "Name=state,Values=available" \
  --query 'Images | sort_by(@, &CreationDate) | [-1].ImageId' --output text 2>/dev/null || true)
if [ -z "$AMI_ID" ] || [ "$AMI_ID" = "None" ]; then
  FAIL_MSG="Failed to find Ubuntu 22.04 AMI"
  log "❌ $FAIL_MSG"
  mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "UPDATE aba_deployments SET status='failed', error_message='$FAIL_MSG', updated_at=NOW() WHERE id=$DEPLOY_ID" 2>/dev/null
  exit 1
fi

# ─── Detect plan type (trial=spot, paid=on-demand) ──
PLAN=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e "
  SELECT plan FROM aba_subscriptions WHERE user_id = $USER_ID ORDER BY created_at DESC LIMIT 1
" 2>/dev/null)
[ -z "$PLAN" ] && PLAN="trial"
if [ "$PLAN" = "trial" ]; then
  MARKET_OPTIONS='{"MarketType":"spot","SpotOptions":{"MaxPrice":"0.0095","SpotInstanceType":"one-time","InstanceInterruptionBehavior":"terminate"}}'
else
  MARKET_OPTIONS=''
fi
INSTANCE_TYPE=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e "
  SELECT instance_type FROM aba_deployments WHERE id = $DEPLOY_ID
" 2>/dev/null)
[ -z "$INSTANCE_TYPE" ] && INSTANCE_TYPE="t3.small"
log "Instance type: $INSTANCE_TYPE"
log "Plan: $PLAN → market options set"

LAUNCH_OUTPUT=$(aws ec2 run-instances --region "$REGION" \
  --image-id "$AMI_ID" --instance-type "$INSTANCE_TYPE" \
  --launch-template "LaunchTemplateName=aba-agent-provision,Version=\$Default" \
  ${MARKET_OPTIONS:+--instance-market-options "$MARKET_OPTIONS"} \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=customer-agent-${SLUG}},{Key=Customer,Value=${USER_NAME}},{Key=DeployId,Value=${DEPLOY_ID}}]" \
  --query 'Instances[0].InstanceId' --output text 2>&1) || true

# Check if the launch failed
if echo "$LAUNCH_OUTPUT" | grep -qi "error\|unsupported\|not supported\|quota"; then
  FAIL_MSG="$(echo "$LAUNCH_OUTPUT" | head -1 | tr -dc '[:print:]' | cut -c1-200)"
  log "❌ AWS launch failed: $FAIL_MSG"
  mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
    UPDATE aba_deployments SET status = 'failed', error_message = 'AWS EC2 launch failed: $FAIL_MSG', updated_at = NOW() WHERE id = $DEPLOY_ID
  " 2>/dev/null
  exit 1
fi

INSTANCE_ID="$LAUNCH_OUTPUT"

# Verify instance launched
if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "None" ]; then
  log "❌ Failed to launch EC2 instance — no instance ID returned"
  mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
    UPDATE aba_deployments SET status = 'failed', error_message = 'AWS EC2 returned no instance ID — check quotas', updated_at = NOW() WHERE id = $DEPLOY_ID
  " 2>/dev/null
  exit 1
fi

log "✅ Instance: $INSTANCE_ID"

mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
  UPDATE aba_deployments SET instance_id = '$INSTANCE_ID', updated_at = NOW() WHERE id = $DEPLOY_ID
" 2>/dev/null

# ─── Wait for IP ────────────────────────────────────────
log "Waiting for instance to start..."
for _i in 1 2 3 4 5 6; do
  INSTANCE_STATE=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --region "$REGION" \
    --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null || true)
  if [ "$INSTANCE_STATE" = "running" ]; then
    log "✅ Instance running"
    break
  fi
  sleep 10
done

if [ "$INSTANCE_STATE" != "running" ]; then
  log "❌ Instance did not become running within 60s"
  mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
    UPDATE aba_deployments SET status = 'failed', error_message = 'AWS instance did not start within 60s', updated_at = NOW() WHERE id = $DEPLOY_ID
  " 2>/dev/null
  exit 1
fi

sleep 5
PUBLIC_IP=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --region "$REGION" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text 2>/dev/null || true)

if [ -z "$PUBLIC_IP" ] || [ "$PUBLIC_IP" = "None" ]; then
  log "❌ No public IP assigned to instance $INSTANCE_ID"
  mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
    UPDATE aba_deployments SET status = 'failed', error_message = 'No public IP assigned — subnet may not have internet gateway', updated_at = NOW() WHERE id = $DEPLOY_ID
  " 2>/dev/null
  exit 1
fi

log "✅ Public IP: $PUBLIC_IP"

mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
  UPDATE aba_deployments SET public_ip = '$PUBLIC_IP', updated_at = NOW() WHERE id = $DEPLOY_ID
" 2>/dev/null

# ─── Wait for SSH ──────────────────────────────────────
log "Waiting for SSH..."
for i in $(seq 1 30); do
  if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -i "$SSH_KEY_PATH" "ubuntu@$PUBLIC_IP" "echo ready" 2>/dev/null; then
    log "✅ SSH ready after ${i}0s"; break
  fi
  if [ "$i" -eq 30 ]; then
    log "❌ SSH timeout"
    mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
      UPDATE aba_deployments SET status = 'failed', error_message = 'SSH timeout after 5 minutes', updated_at = NOW() WHERE id = $DEPLOY_ID
    " 2>/dev/null
    exit 1
  fi
  sleep 10
done

# ─── Write & run remote provision script ────────────────
cat > /tmp/provision-ec2.py << 'PYEOF'
#!/usr/bin/env python3
"""Remote EC2 provisioning: installs OpenClaw, Caddy, config, and starts services."""
import json, os, subprocess, sys, base64

ADMIN_TOKEN = os.environ.get('ADMIN_TOKEN', '')
CONFIG_B64 = os.environ.get('CONFIG_B64', '')
SOUL_B64 = os.environ.get('SOUL_B64', '')
KNOW_B64 = os.environ.get('KNOW_B64', '')

def sh(cmd, timeout=None):
    print(f"> {cmd}")
    kwargs = {'shell': True, 'capture_output': True, 'text': True}
    if timeout:
        kwargs['timeout'] = timeout
    r = subprocess.run(cmd, **kwargs)
    if r.stdout.strip(): print(r.stdout.strip()[:300])
    if r.stderr.strip(): print(r.stderr.strip()[:300])
    if r.returncode != 0: print(f"⚠️  exit {r.returncode}")
    return r

# Swap (prevents OOM on t3.micro during npm)
print("\n### Swap 1GB ###")
sh("sudo fallocate -l 1G /swapfile")
sh("sudo chmod 600 /swapfile")
sh("sudo mkswap /swapfile")
sh("sudo swapon /swapfile")
sh("echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab > /dev/null")
sh("free -h | head -3")

# ─── Restore workspace from backup (SCP'd by orchestrator) ───
import os as _os
_backup_path = '/tmp/workspace-backup.tar.gz'
if _os.path.exists(_backup_path):
    print("Backup found — restoring...")
    _r = sh("tar xzf " + _backup_path + " -C /home/ubuntu/.openclaw 2>/dev/null || tar xzf " + _backup_path + " -C /home/ubuntu 2>/dev/null", timeout=60)
    if _r.returncode == 0:
        print("✅ Backup restored")
    sh("rm -f " + _backup_path)
else:
    print("ℹ️  No backup found — provisioning fresh")

# Node.js
print("\n### Node.js 22.x ###")
sh("curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -")
sh("sudo apt-get install -y nodejs -qq")

# OpenClaw (single-threaded to avoid OOM on small instance)
print("\n### OpenClaw ###")
sh("npm config set jobs 1")
sh("sudo npm install -g openclaw@latest --no-optional")
sh("mkdir -p /home/ubuntu/.openclaw/workspace")
sh("mkdir -p /home/ubuntu/.openclaw/workspace/memory")
sh("mkdir -p /home/ubuntu/.openclaw/state")

# Write config.json
config_json = base64.b64decode(CONFIG_B64).decode()
with open("/home/ubuntu/.openclaw/openclaw.json", "w") as f:
    f.write(config_json)
print("✅ openclaw.json written")

# Fix permissions (critical — gateway runs as ubuntu, not root)
sh("sudo chown -R ubuntu:ubuntu /home/ubuntu/.openclaw")
sh("sudo chmod -R u+rwX /home/ubuntu/.openclaw")

# SOUL.md
soul_content = base64.b64decode(SOUL_B64).decode()
with open("/home/ubuntu/.openclaw/workspace/SOUL.md", "w") as f:
    f.write(soul_content)
print("✅ SOUL.md written")

# KNOWLEDGE.md
know_content = base64.b64decode(KNOW_B64).decode()
with open("/home/ubuntu/.openclaw/workspace/KNOWLEDGE.md", "w") as f:
    f.write(know_content)
print("✅ KNOWLEDGE.md written")

# IDENTITY.md
import os as _os
_agent_name = _os.environ.get('AGENT_NAME', 'ABA Agent')
_agent_gender = _os.environ.get('AGENT_GENDER', 'Female')
_user_email = _os.environ.get('USER_EMAIL', '')
with open("/home/ubuntu/.openclaw/workspace/IDENTITY.md", "w") as f:
    f.write(f"""# IDENTITY.md\n- **Name:** {_agent_name}\n- **Gender:** {_agent_gender}\n- **Owner Email:** {_user_email or 'Not set'}\n- **Creature:** AI business assistant\n- **Vibe:** Helpful, professional, efficient\n""")

# USER.md
_user_name = _os.environ.get('USER_EMAIL', 'ABA Customer')  # email as fallback name
_user_email_2 = _os.environ.get('USER_EMAIL', '')
with open("/home/ubuntu/.openclaw/workspace/USER.md", "w") as f:
    f.write(f"# USER.md\n- **Owner Name:** {_user_name}\n- **Owner Email:** {_user_email_2 or 'Not set'}\n- **Preferred contact:** Telegram\n")

# Backend admin token (for agent-sync auth)
_BACKEND_TOKEN = os.environ.get('SYNC_ADMIN_TOKEN', 'abacadaba123')
_USER_ID = os.environ.get('USER_ID', '')
with open("/home/ubuntu/.openclaw/admin-token.txt", "w") as f:
    f.write(_BACKEND_TOKEN + "\n")
os.chmod("/home/ubuntu/.openclaw/admin-token.txt", 0o600)
# Store user_id so sync script can fetch personalized data
with open("/home/ubuntu/.openclaw/user_id.txt", "w") as f:
    f.write(_USER_ID + "\n")

# Google Calendar OAuth Token (passed from orchestrator if linked)
_GCAL_TOKEN_B64 = os.environ.get('GCAL_TOKEN_B64', '')
if _GCAL_TOKEN_B64:
    print("✅ Google Calendar token found — configuring gog auth")
    _gcal_json = base64.b64decode(_GCAL_TOKEN_B64).decode()
    sh("mkdir -p /home/ubuntu/.openclaw/credentials")
    with open("/home/ubuntu/.openclaw/credentials/gcal_token.json", "w") as f:
        f.write(_gcal_json)
    sh("sudo chown -R ubuntu:ubuntu /home/ubuntu/.openclaw/credentials")
    
    # Pre-configure gog so it's instantly available without user interaction
    _setup_gog = f'''
sudo -u ubuntu mkdir -p /home/ubuntu/.config/gogcli
cat << 'EOF_GOG' | python3 -c "
import sys, json, base64
creds = json.load(sys.stdin)
conf = {{
  'version': 1,
  'accounts': [{{
    'email': creds.get('account', 'user@gmail.com'),
    'access_token': creds.get('token', ''),
    'refresh_token': creds.get('refresh_token', ''),
    'token_type': 'Bearer',
    'expiry': '2030-01-01T00:00:00Z',
    'services': ['calendar'],
    'client': {{
       'client_id': creds.get('client_id', ''),
       'client_secret': creds.get('client_secret', '')
    }}
  }}]
}}
with open('/home/ubuntu/.config/gogcli/credentials.json', 'w') as f:
    json.dump(conf, f, indent=2)
"
sudo -u ubuntu chown -R ubuntu:ubuntu /home/ubuntu/.config/gogcli
sudo -u ubuntu /usr/local/bin/gog auth list || true
'''
    with open("/tmp/setup-gog.sh", "w") as f:
        f.write(_setup_gog)
    sh("cat /home/ubuntu/.openclaw/credentials/gcal_token.json | bash /tmp/setup-gog.sh")

# systemd service
service = """[Unit]
Description=OpenClaw Gateway
After=network.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
ExecStart=/usr/bin/openclaw gateway run
Restart=on-failure
RestartSec=5
WorkingDirectory=/home/ubuntu/.openclaw
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
"""
with open("/tmp/openclaw.service", "w") as f:
    f.write(service)
sh("sudo cp /tmp/openclaw.service /etc/systemd/system/")
sh("sudo systemctl daemon-reload")
sh("sudo systemctl enable openclaw.service")

# Caddy
print("\n### Caddy ###")
sh("sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https -qq")
subprocess.run("curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null", shell=True)
sh("curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null")
sh("sudo apt-get update -qq")
sh("sudo apt-get install -y caddy -qq")

public_dns = subprocess.run(
    "curl -s http://169.254.169.254/latest/meta-data/public-hostname",
    shell=True, capture_output=True, text=True
).stdout.strip()

caddyfile = f"""{public_dns} {{
    tls internal
    reverse_proxy 127.0.0.1:8080
}}
:80 {{
    redir https://{{host}}{{uri}} permanent
}}
"""
with open("/tmp/Caddyfile", "w") as f:
    f.write(caddyfile)
sh("sudo cp /tmp/Caddyfile /etc/caddy/")
sh("sudo systemctl restart caddy")

# UFW
print("\n### UFW ###")
sh("sudo ufw --force enable")
sh("sudo ufw allow 22/tcp")
sh("sudo ufw allow 80/tcp")
sh("sudo ufw allow 443/tcp")
sh("sudo ufw allow 4321/tcp")

# Install WhatsApp plugin (pre-installed so post-deploy pairing doesn't need plugin install step)
print("\n### WhatsApp plugin ###")
sh("sudo -u ubuntu openclaw plugins install clawhub:@openclaw/whatsapp 2>&1 || true")

# Agent server (HTTP API for WhatsApp pairing + activation — no SSH needed)
print("\n### Agent server ###")
agent_server_code = '''#!/usr/bin/env node
const http = require(\'http\');
const { exec, spawn, execSync } = require(\'child_process\');
const fs = require(\'fs\');
const path = require(\'path\');
const crypto = require(\'crypto\');

const PORT = parseInt(process.env.PORT || \'4321\', 10);
const TOKEN = process.env.AGENT_TOKEN || crypto.randomBytes(16).toString(\'hex\');

const WA_AUTH_DIR = \'/tmp/wa-auth-tmp\';
const WA_CREDS_DIR = \'/home/ubuntu/.openclaw/credentials/whatsapp/default\';
const WA_EXTENSIONS = \'/home/ubuntu/.openclaw/extensions/whatsapp\';

function auth(req) { return req.headers[\'x-agent-token\'] === TOKEN; }

function json(res, code, data) {
  res.writeHead(code, { \'Content-Type\': \'application/json\', \'Access-Control-Allow-Origin\': \'*\' });
  res.end(JSON.stringify(data));
}

function readFile(p) {
  try { return fs.readFileSync(p, \'utf-8\'); }
  catch { return null; }
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = \'\';
    req.on(\'data\', (c) => { body += c; });
    req.on(\'end\', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

function createServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader(\'Access-Control-Allow-Origin\', \'*\');
    res.setHeader(\'Access-Control-Allow-Methods\', \'GET, POST, OPTIONS\');
    res.setHeader(\'Access-Control-Allow-Headers\', \'x-agent-token, content-type\');

    if (req.method === \'OPTIONS\') {
      res.writeHead(204);
      return res.end();
    }

    if (req.url === \'/health\') {
      return json(res, 200, { ok: true, uptime: process.uptime(), pid: process.pid });
    }

    if (!auth(req)) {
      return json(res, 401, { error: \'Invalid x-agent-token\' });
    }

    if (req.method === \'POST\' && req.url === \'/whatsapp/pair\') {
      try {
        const body = await parseBody(req);
        exec(\'pkill -f "gen-wa-qr-v4" 2>/dev/null; rm -rf /tmp/wa-auth-tmp /tmp/wa-pairing-status.json /tmp/wa-qr-clean.png /tmp/wa-pairing-output.log; true\', { timeout: 10000 }, () => {});
        await new Promise(r => setTimeout(r, 500));
        if (body && body.script_content) fs.writeFileSync(\'/tmp/gen-wa-qr-v4.js\', body.script_content);
        if (!fs.existsSync(\'/tmp/gen-wa-qr-v4.js\')) return json(res, 400, { error: \'Script not found\' });
        const child = spawn(\'node\', [\'/tmp/gen-wa-qr-v4.js\'], {
          cwd: WA_EXTENSIONS,
          env: { ...process.env, NODE_PATH: WA_EXTENSIONS + \'/node_modules\', HOME: process.env.HOME },
          stdio: [\'ignore\', fs.openSync(\'/tmp/wa-pairing-output.log\', \'a\'), fs.openSync(\'/tmp/wa-pairing-output.log\', \'a\')],
          detached: true
        });
        child.unref();
        return json(res, 200, { success: true, message: \'WhatsApp pairing started\' });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }

    if (req.method === \'GET\' && req.url === \'/whatsapp/pair-status\') {
      const s = readFile(\'/tmp/wa-pairing-status.json\');
      if (!s) return json(res, 200, { stage: \'initializing\' });
      try {
        const st = JSON.parse(s);
        if (st.stage === \'qr_ready\') {
          const q = readFile(\'/tmp/wa-qr-clean.png\', \'binary\');
          return json(res, 200, { stage: \'qr_ready\', qr_data_url: q ? \'data:image/png;base64,\' + Buffer.from(q, \'binary\').toString(\'base64\') : null, ts: st.ts });
        }
        return json(res, 200, st);
      } catch { return json(res, 200, { stage: \'initializing\' }); }
    }

    if (req.method === \'GET\' && req.url === \'/whatsapp/status\') {
      return json(res, 200, { paired: fs.existsSync(WA_CREDS_DIR + \'/creds.json\') });
    }

    if (req.method === \'POST\' && req.url === \'/whatsapp/activate\') {
      try {
        if (fs.existsSync(\'/tmp/wa-activated.flag\')) return json(res, 200, { success: true, already: true });
        if (!fs.existsSync(WA_EXTENSIONS + \'/dist/index.js\')) execSync(\'openclaw plugins install clawhub:@openclaw/whatsapp 2>&1\', { timeout: 60000 });
        const conf = JSON.parse(fs.readFileSync(\'/home/ubuntu/.openclaw/openclaw.json\', \'utf-8\'));
        if (!conf.channels) conf.channels = {};
        conf.channels.whatsapp = { dmPolicy: \'open\', allowFrom: [\'*\'], selfChatMode: true, sendReadReceipts: true };
        if (!conf.bindings) conf.bindings = [];
        if (!conf.bindings.some(function(b) { return b.agentId === \'main\' && b.match && b.match.channel === \'whatsapp\'; }))
          conf.bindings.push({ agentId: \'main\', match: { channel: \'whatsapp\', accountId: \'default\' } });
        fs.writeFileSync(\'/home/ubuntu/.openclaw/openclaw.json\', JSON.stringify(conf, null, 2));
        fs.writeFileSync(\'/tmp/wa-activated.flag\', new Date().toISOString());
        exec(\'sudo systemctl restart openclaw.service\', { timeout: 15000 }, function(){});
        return json(res, 200, { success: true, message: \'WhatsApp activating...\' });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }

    json(res, 404, { error: \'Not found\' });
  });

  fs.mkdirSync(\'/tmp/agent-server\', { recursive: true });
  fs.writeFileSync(\'/tmp/agent-server/token.txt\', TOKEN);

  server.listen(PORT, \'0.0.0.0\', () => {
    console.log(\'Agent server listening on port \' + PORT);
    console.log(\'Token: \' + TOKEN);
  });
}

createServer();
'''

with open("/home/ubuntu/agent-server.js", "w") as f:
    f.write(agent_server_code)
print("✅ agent-server.js written")

# systemd service for agent-server
agent_service = """[Unit]
Description=ABA Agent HTTP Server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu
ExecStart=/usr/bin/node /home/ubuntu/agent-server.js
Restart=always
RestartSec=5
Environment=PORT=4321
Environment=EXTENSIONS_DIR=/home/ubuntu/.openclaw/extensions
Environment=AGENT_TOKEN=aba-agent-4321-secure-key

[Install]
WantedBy=multi-user.target
"""
with open("/tmp/agent-server.service", "w") as f:
    f.write(agent_service)
sh("sudo cp /tmp/agent-server.service /etc/systemd/system/")
sh("sudo systemctl daemon-reload")
sh("sudo systemctl enable --now agent-server.service")
print("✅ agent-server service enabled and started")

# Agent sync script (phones home to dashboard for config/knowledge updates)
print("\n### Agent sync script ###")
sync_script = '''#!/usr/bin/env python3
"""ABA agent-sync: polls dashboard for config + knowledge + business updates."""
import json, os, sys, time, urllib.request, urllib.error
SYNC_URL = "https://dabarobjects.com/api/agent-sync"
UD = os.path.expanduser("~")
OC = os.path.join(UD, ".openclaw")
WS = os.path.join(OC, "workspace")
KN = os.path.join(WS, "knowledge")
KM = os.path.join(WS, "KNOWLEDGE.md")
UM = os.path.join(WS, "USER.md")
IM = os.path.join(WS, "IDENTITY.md")
TM = os.path.join(WS, "TOOLS.md")
CJ = os.path.join(WS, "credentials.json")
def log(m): print(f"[sync] {m}", flush=True)
def writef(p, c):
    with open(p, "w") as f: f.write(c)
    log(f"updated {os.path.basename(p)}")
def rebuild_knowledge(biz, tool_config=None):
    n = (biz or {}).get("business_name","") or "My Business"
    d = (biz or {}).get("description","") or ""
    ind = (biz or {}).get("industry","") or "Not specified"
    reg = (biz or {}).get("registration_id","") or ""
    tx = (biz or {}).get("tax_id","") or ""
    ph = (biz or {}).get("phone","") or ""
    w = (biz or {}).get("website","") or ""
    ad = (biz or {}).get("address","") or ""
    sl = [f"- {l}: {biz.get(s,'')}" for l,s in [("Facebook","social_facebook"),("X / Twitter","social_twitter"),("LinkedIn","social_linkedin"),("Instagram","social_instagram")] if biz.get(s,'')]
    sb = "\n".join(sl) if sl else "- None configured"
    k = f"# {n} \u2014 KNOWLEDGE.md\n\n"
    if d: k += f"## About\n{d}\n\n"
    k += "## Business Profile\n" + f"- Business Name: {n}\n- Industry: {ind}\n" + (f"- Registration ID: {reg}\n" if reg else "") + (f"- Tax ID: {tx}\n" if tx else "") + (f"- Phone: {ph}\n" if ph else "") + (f"- Website: {w}\n" if w else "") + (f"- Address: {ad}\n" if ad else "")
    # Products
    product_lines = []
    products_raw2 = (biz or {}).get("_products", None)
    if products_raw2 and isinstance(products_raw2, list) and len(products_raw2) > 0:
        for p in products_raw2:
            pn = p.get("name","")
            pp_ = p.get("price","")
            pd_ = p.get("description","")
            pc = p.get("category","")
            pl = f"- **{pn}**"
            if pp_: pl += f" ({pp_})"
            if pd_: pl += f": {pd_}"
            if pc: pl += f" [{pc}]"
            product_lines.append(pl)
    products_block2 = "\n".join(product_lines) if product_lines else "Check back later. The owner can add products in their ABA dashboard."
    k += f"\n## Social Media\n{sb}\n\n## Products & Services\n{products_block2}\n"
    # Connected Tools
    k += "## Connected Tools\n"
    if tool_config:
        tools_found = 0
        for integration in (tool_config.get("integrations") or []):
            tools_found += 1
            k += f"- {integration}\n"
        if tool_config.get("email"): tools_found += 1; k += "- Email (POP3 configured)\n"
        if tool_config.get("whatsapp"): tools_found += 1; k += "- WhatsApp\n"
        if tool_config.get("twilio"): tools_found += 1; k += "- Twilio (phone calls, SMS)\n"
        if tool_config.get("woo"): tools_found += 1; k += "- WooCommerce (online store)\n"
        if tool_config.get("shopify"): tools_found += 1; k += "- Shopify (online store)\n"
        if tool_config.get("database"): tools_found += 1; k += "- Database (external connection)\n"
        if tool_config.get("github"): tools_found += 1; k += "- GitHub\n"
        if tool_config.get("google_drive"): tools_found += 1; k += "- Google Drive\n"
        if tools_found == 0: k += "No tools connected yet. The owner can configure integrations in the ABA dashboard.\n"
    else:
        k += "No tools connected yet. The owner can configure integrations in the ABA dashboard.\n"
    return k
def rebuild_user_md(op):
    nm = (op or {}).get("name","") or "ABA Customer"
    em = (op or {}).get("email","") or ""
    c = f"# USER.md\n- **Owner Name:** {nm}\n"
    if em: c += f"- **Owner Email:** {em}\n"
    c += "- **Preferred contact:** Telegram\n"
    return c
def rebuild_identity_md(op, biz):
    on = (op or {}).get("name","") or "ABA Customer"
    oe = (op or {}).get("email","") or ""
    bn = (biz or {}).get("business_name","") or ""
    en = "ABA Agent"; eg = "Female"
    if os.path.exists(IM):
        for ln in open(IM).readlines():
            if "Name:" in ln: en = ln.split("Name:")[-1].strip().lstrip("*").strip()
            if "Gender:" in ln: eg = ln.split("Gender:")[-1].strip().lstrip("*").strip()
    c = f"# IDENTITY.md\n- **Name:** {en}\n- **Gender:** {eg}\n- **Owner:** {on}\n"
    if oe: c += f"- **Owner Email:** {oe}\n"
    if bn: c += f"- **Business:** {bn}\n"
    c += "- **Creature:** AI business assistant\n- **Vibe:** Helpful, professional, efficient\n"
    return c
def rebuild_tools_md(tc):
    if not tc: return "No tools configured yet."
    L = ["# TOOLS.md\n","","Connection reference. Credentials in credentials.json.\n"]
    h = False
    e = tc.get("email")
    if e and isinstance(e,dict) and e.get("host"):
        h = True; L += ["## Email\n",f"- Host: {e['host']}:{e.get('port','993')}\n",f"- User: {e.get('user','')}\n","- Creds key: `email`\n\n"]
    w = tc.get("woo")
    if w and isinstance(w,dict) and w.get("url"):
        h = True; L += ["## WooCommerce\n",f"- URL: {w['url']}\n","- Creds key: `woo`\n\n"]
    s = tc.get("shopify")
    if s and isinstance(s,dict) and s.get("url"):
        h = True; L += ["## Shopify\n",f"- URL: {s['url']}\n","- Creds key: `shopify`\n\n"]
    t = tc.get("twilio")
    if t and isinstance(t,dict) and t.get("sid"):
        h = True; L += ["## Twilio\n",f"- Phone: {t.get('phone','')}\n","- Creds key: `twilio`\n\n"]
    wa = tc.get("whatsapp")
    if wa and isinstance(wa,dict) and wa.get("number"):
        h = True; L += ["## WhatsApp\n",f"- Number: {wa['number']}\n","- Creds key: `whatsapp`\n\n"]
    g = tc.get("github")
    if g and isinstance(g,dict) and g.get("token"):
        h = True; L += ["## GitHub\n- Creds key: `github`\n\n"]
    gd = tc.get("google_drive")
    if gd and isinstance(gd,dict) and gd.get("folder_id"):
        h = True; L += ["## Google Drive\n",f"- Folder: {gd['folder_id']}\n","- Creds key: `google_drive`\n\n"]
    db = tc.get("database")
    if db and isinstance(db,dict) and db.get("connection_string"):
        h = True; L += ["## Database\n",f"- Connection: {db['connection_string']}\n\n"]
    if not h: L += ["No tools configured yet.\n"]
    return "".join(L)
def rebuild_credentials_json(tc):
    import json
    c = {}
    if not tc: return json.dumps(c)
    for k in ("email","woo","shopify","twilio","whatsapp","github","google_drive","database"):
        v = tc.get(k)
        if v and isinstance(v,dict):
            f = {kk:vv for kk,vv in v.items() if vv}
            if f: c[k] = f
    return json.dumps(c, indent=2)
try:
    with open(os.path.join(OC, "admin-token.txt")) as f: token = f.read().strip()
    if not token: log("no token"); sys.exit(1)
    _uid = ""
    try:
        with open(os.path.join(OC, "user_id.txt")) as f:
            _uid = "&user_id=" + f.read().strip()
    except: pass
    req = urllib.request.Request(f"{SYNC_URL}?token={token}{_uid}", headers={"User-Agent": "aba-agent-sync/1.0"})
    data = json.loads(urllib.request.urlopen(req, timeout=15).read().decode())
    biz = data.get("business"); op = data.get("owner_profile")
    products = data.get("products", [])
    tool_config = data.get("tool_config", None)
    changed = False
    if biz or op:
        if biz and products:
            biz["_products"] = products
        nk = rebuild_knowledge(biz or {}, tool_config)
        if not os.path.exists(KM) or open(KM).read() != nk: writef(KM, nk); changed = True
        nu = rebuild_user_md(op or {})
        if not os.path.exists(UM) or open(UM).read() != nu: writef(UM, nu); changed = True
        ni = rebuild_identity_md(op or {}, biz or {})
        if not os.path.exists(IM) or open(IM).read() != ni: writef(IM, ni); changed = True
        nt = rebuild_tools_md(tool_config)
        if not os.path.exists(TM) or open(TM).read() != nt: writef(TM, nt); changed = True
        nc = rebuild_credentials_json(tool_config)
        if not os.path.exists(CJ) or open(CJ).read() != nc: writef(CJ, nc); log("updated credentials.json"); changed = True
    os.makedirs(KN, exist_ok=True)
    sf = os.path.join(OC, ".sync-state.json")
    prev = set()
    if os.path.exists(sf):
        try:
            with open(sf) as f: prev = set(json.load(f).get("downloaded_files", []))
        except: pass
    cur = set()
    for f in data.get("knowledgeFiles", []):
        fid = str(f["id"]); cur.add(fid)
        if fid in prev: continue
        fr = urllib.request.urlopen(f"https://dabarobjects.com{f['url']}", timeout=30)
        with open(os.path.join(KN, f["name"]), "wb") as fw: fw.write(fr.read())
        log(f"DL: {f['name']}")
        changed = True
    with open(sf, "w") as f: json.dump({"downloaded_files": list(cur), "last_sync": time.time()}, f)
    if changed: log("sync complete")
    else: log("up to date")
except Exception as e: log(f"ERR: {e}"); sys.exit(1)
'''
with open("/usr/local/bin/aba-agent-sync", "w") as f:
    f.write(sync_script)
sh("chmod +x /usr/local/bin/aba-agent-sync")

# Schedule sync every 5 minutes via systemd timer
sync_timer = """[Unit]
Description=ABA Agent Sync Timer

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
"""
with open("/tmp/aba-agent-sync.timer", "w") as f: f.write(sync_timer)

sync_service = """[Unit]
Description=ABA Agent Sync

[Service]
Type=oneshot
ExecStart=/usr/local/bin/aba-agent-sync
User=ubuntu
"""
with open("/tmp/aba-agent-sync.service", "w") as f: f.write(sync_service)
sh("sudo cp /tmp/aba-agent-sync.* /etc/systemd/system/")
sh("sudo systemctl daemon-reload")
sh("sudo systemctl enable --now aba-agent-sync.timer")
sh("sudo systemctl start aba-agent-sync.service")
print("✅ Agent sync timer (every 5 min)")

# Clean Telegram webhook + pending updates (prevents orphaned-instance conflicts)
print("\n### Clean Telegram ###")
telegram_token = json.loads(base64.b64decode(CONFIG_B64).decode()).get('channels',{}).get('telegram',{}).get('botToken','')
if telegram_token:
    sh(f"curl -s https://api.telegram.org/bot{telegram_token}/deleteWebhook?drop_pending_updates=true > /dev/null")
    print("✅ Telegram webhook cleared")

# Start OpenClaw
print("\n### Starting OpenClaw ###")
sh("sudo systemctl start openclaw.service")
sh("sleep 5")

print("\nREMOTE_SETUP_COMPLETE")
PYEOF

chmod +x /tmp/provision-ec2.py

# ─── Restore workspace backup (if available) ───
BACKUP_FILE="/tmp/workspace-restore-${USER_ID}.tar.gz"
RESTORE_MARKER="s3://${BACKUP_BUCKET:-aba-backups}/${USER_ID}/RESTORE_NEEDED"
if aws s3 ls "$RESTORE_MARKER" 2>/dev/null | grep -q .; then
  log "Backup marker found for user $USER_ID — downloading..."
  if aws s3 cp "s3://${BACKUP_BUCKET:-aba-backups}/${USER_ID}/workspace-backup.tar.gz" "$BACKUP_FILE" 2>/dev/null; then
    log "✅ Backup downloaded, uploading to new instance..."
    scp -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=no "$BACKUP_FILE" "ubuntu@$PUBLIC_IP:/tmp/workspace-backup.tar.gz" 2>/dev/null && log "Backup SCP'd to new instance" || log "⚠️  Failed to SCP backup (non-fatal)"
    rm -f "$BACKUP_FILE"
    # Write completed marker since we can't delete
    echo "1" | aws s3 cp - "s3://${BACKUP_BUCKET:-aba-backups}/${USER_ID}/RESTORE_COMPLETED" 2>/dev/null || true
  else
    log "⚠️  Backup download failed (non-fatal)"
  fi
else
  log "No backup found for user $USER_ID — provisioning fresh"
fi

scp -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=no /tmp/provision-ec2.py "ubuntu@$PUBLIC_IP:/tmp/provision.py"

log "Running remote provisioning..."
if ! scp -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=no /tmp/provision-ec2.py "ubuntu@$PUBLIC_IP:/tmp/provision.py" 2>/dev/null; then
  log "❌ SCP failed — instance unreachable"
  mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
    UPDATE aba_deployments SET status = 'failed', error_message = 'SCP to instance failed — SSH key or network issue', updated_at = NOW() WHERE id = $DEPLOY_ID
  " 2>/dev/null
  exit 1
fi

# Write env vars to a safe file (prevents shell escaping issues with user content)
python3 << 'ENVEOF' 2>/dev/null
import os, shlex
keys = ['ADMIN_TOKEN','SYNC_ADMIN_TOKEN','USER_ID','CONFIG_B64','SOUL_B64','KNOW_B64','GCAL_TOKEN_B64',
        'AGENT_NAME','AGENT_GENDER','USER_EMAIL','AGENT_ROLE',
        'BIZ_NAME','BIZ_INDUSTRY','BIZ_DESC',
        'BIZ_SOCIAL_FB','BIZ_SOCIAL_TW','BIZ_SOCIAL_LI','BIZ_SOCIAL_IG']
with open('/tmp/aba-env.json', 'w') as f:
    env = {k: os.environ.get(k, '') for k in keys}
    env.setdefault('SYNC_ADMIN_TOKEN', 'abacadaba123')
    import json
    f.write(json.dumps(env))
ENVEOF

scp -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=no /tmp/aba-env.json "ubuntu@$PUBLIC_IP:/tmp/aba-env.json" 2>/dev/null || log "⚠️  Env file SCP failed (will try inline)"
rm -f /tmp/aba-env.json

REMOTE_OUTPUT=$(ssh -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=no -o ConnectTimeout=30 "ubuntu@$PUBLIC_IP" \
  "sudo -E python3 -c \"\
import json, os; env=json.load(open('/tmp/aba-env.json')); os.environ.update(env); exec(open('/tmp/provision.py').read())\"" 2>&1) || true

echo "$REMOTE_OUTPUT" | grep -v "^> " | head -20

if echo "$REMOTE_OUTPUT" | grep -qi "REMOTE_SETUP_COMPLETE"; then
  log "✅ Remote provisioning completed"
elif echo "$REMOTE_OUTPUT" | grep -qi "error\|failed\|exit 1"; then
  FAIL_DETAIL="$(echo "$REMOTE_OUTPUT" | grep -i "error\|failed" | head -3 | tr -dc '[:print:]' | cut -c1-200)"
  log "❌ Remote provisioning had issues: $FAIL_DETAIL"
  # Non-fatal — might still work partially
  mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
    UPDATE aba_deployments SET error_message = CONCAT(IFNULL(error_message,''), '; Setup script issues: $FAIL_DETAIL'), updated_at = NOW() WHERE id = $DEPLOY_ID
  " 2>/dev/null
fi

# ─── Verify ──────────────────────────────────────────────
sleep 5
HTTP_CODE=$(ssh -i "$SSH_KEY_PATH" -o ConnectTimeout=10 "ubuntu@$PUBLIC_IP" \
  "curl -sk -o /dev/null -w '%{http_code}' https://localhost/" 2>/dev/null || echo "failed")
log "Gateway: HTTPS HTTP $HTTP_CODE"

# ─── Get bot username ───────────────────────────────────
BOT_USERNAME=""
if [ -n "$TELEGRAM_TOKEN" ]; then
  sleep 3
  BOT_INFO=$(curl -s "https://api.telegram.org/bot${TELEGRAM_TOKEN}/getMe" 2>/dev/null || true)
  BOT_USERNAME=$(echo "$BOT_INFO" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('result',{}).get('username',''))" 2>/dev/null || true)
fi

# ─── Mark active ────────────────────────────────────────
# Clear deploy id so EXIT trap doesn't mark success as failure
_CURRENT_DEPLOY_ID=""
mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
  UPDATE aba_deployments
  SET status = 'active',
      admin_token = '$ADMIN_TOKEN',
      telegram_bot_username = '$BOT_USERNAME',
      deployed_at = NOW(),
      updated_at = NOW(),
      last_health_check = NOW()
  WHERE id = $DEPLOY_ID
" 2>/dev/null

# ─── Deploy team agents (Mary, Promise, etc.) ──────────
log "Deploying team agents for user $USER_ID..."
if python3 "$SCRIPT_DIR/aba-team-apply.py" "$USER_ID" 2>/dev/null; then
  log "✅ Team agents applied"
else
  log "⚠️  Team agent apply had issues (non-fatal)"
fi

# ─── Send welcome email ─────────────────────────────────
if [ -n "$USER_EMAIL" ]; then
  python3 -c "
import smtplib
from email.mime.text import MIMEText

msg = MIMEText('''Hi $USER_NAME,

Your ABA agent server is now live! 🎉

Here's what you need to know:

🌐 Agent Console: https://$PUBLIC_IP/
💬 Telegram: https://t.me/$BOT_USERNAME
🆔 Instance ID: $INSTANCE_ID

Your agent is now running 24/7 to handle customer inquiries and support your business.

To get started:
1. Open Telegram and chat with your agent
2. Login to your ABA dashboard to customize products, integrations, and settings
3. Use the web console for advanced management

Admin Token: $ADMIN_TOKEN

Best,
ABA Team
''')
msg['Subject'] = 'Your ABA Agent is Live! 🎉'
msg['From'] = 'ABA <no-reply-pawpaw@storeharmony.com>'
msg['To'] = '$USER_EMAIL'

try:
    s = smtplib.SMTP('mail.storeharmony.com', 587)
    s.starttls()
    s.login('no-reply-pawpaw@storeharmony.com', '\$spp0n11&a')
    s.send_message(msg)
    s.quit()
    print('✅ Welcome email sent to $USER_EMAIL')
except Exception as e:
    print(f'⚠️  Welcome email failed: {e}')
" 2>/dev/null || true
fi

log "============================================="
log "✅ DEPLOYMENT COMPLETE — Deploy #$DEPLOY_ID"
log "   Customer: $USER_NAME"
log "   Instance: $INSTANCE_ID"
log "   IP:       $PUBLIC_IP"
log "   Telegram: @$BOT_USERNAME"
log "============================================="
