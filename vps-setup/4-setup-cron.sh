# ═══════════════════════════════════════════════════════════════
# Step 4: Linux Cron Setup
# Run as root: bash 4-setup-cron.sh
# Replaces: Vercel crons + Google Apps Script triggers
# ═══════════════════════════════════════════════════════════════

#!/bin/bash
set -e

# Read the cron secret from .env file
CRON_SECRET=$(grep DRAFT_QUEUE_SECRET /etc/tracker/.env | cut -d'=' -f2)

if [ -z "$CRON_SECRET" ]; then
  echo "ERROR: DRAFT_QUEUE_SECRET not found in /etc/tracker/.env"
  exit 1
fi

echo "Setting up cron jobs..."

# Write crontab
crontab -l 2>/dev/null | grep -v "tracker-cron" > /tmp/existing_cron || true

cat >> /tmp/existing_cron << CRON
# ─── Tracker CRM Crons ──────────────────────────────────────
# Auto-progress orders every minute
* * * * * curl -s --max-time 25 "http://localhost:3000/api/cron/progress-orders?key=$CRON_SECRET" >> /var/log/tracker-cron.log 2>&1 # tracker-cron

# Process pending emails every minute
* * * * * curl -s --max-time 25 "http://localhost:3000/api/cron/pending-emails?key=$CRON_SECRET" >> /var/log/tracker-cron.log 2>&1 # tracker-cron

# Rotate log daily (keep last 7 days)
0 0 * * * find /var/log/tracker-cron.log -size +50M -exec truncate -s 0 {} \; # tracker-cron
CRON

crontab /tmp/existing_cron
rm /tmp/existing_cron

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " ✅ Cron jobs installed!"
echo " View cron: crontab -l"
echo " View logs: tail -f /var/log/tracker-cron.log"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
