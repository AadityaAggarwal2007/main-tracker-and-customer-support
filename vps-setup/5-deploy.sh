#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Step 5: Deploy Application
# Usage: bash 5-deploy.sh
# Run from /var/www/tracker after git clone
# ═══════════════════════════════════════════════════════════════
set -e

APP_DIR="/var/www/tracker"
ENV_FILE="/etc/tracker/.env"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Deploying Tracker CRM..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check env file exists
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found."
  echo "Copy your .env.production to /etc/tracker/.env first."
  exit 1
fi

cd $APP_DIR

# Pull latest code
echo "[1/5] Pulling latest code..."
git pull origin main

# Copy env file
echo "[2/5] Copying environment variables..."
cp $ENV_FILE .env.production.local

# Install dependencies (production only)
echo "[3/5] Installing dependencies..."
npm ci --production=false

# Build Next.js
echo "[4/5] Building Next.js..."
NODE_ENV=production npm run build

# Start/Reload PM2
echo "[5/5] Starting PM2..."
if pm2 describe tracker > /dev/null 2>&1; then
  pm2 reload tracker --update-env
else
  pm2 start ecosystem.config.js --env production
fi

pm2 save

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " ✅ Deployment complete!"
echo ""
echo " Status: pm2 status"
echo " Logs:   pm2 logs tracker"
echo " Reload: pm2 reload tracker"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
