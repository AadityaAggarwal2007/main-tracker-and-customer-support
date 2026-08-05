# 🚀 VPS Deployment Guide — Two Apps, One Server

**Apps to deploy:**
1. **Tracker CRM** — Customer order tracking (Next.js 14 + direct PostgreSQL)
2. **Add ERP (Meta Ads)** — Meta Ads analytics/automation (Next.js 16 + Supabase → PostgreSQL)

**VPS:** Hostinger KVM 4 — 4 vCPU, 16 GB RAM, 200 GB NVMe, 16 TB bandwidth  
**Goal:** Both apps running fast on the same server with separate domains/subdomains

---

## Architecture Overview

```
Internet
    │
    ▼
[Nginx] :443 (SSL via Let's Encrypt)
    │
    ├── tracker.yourdomain.com  ──▶  [Next.js PM2] :3000  (Tracker CRM)
    │                                      │
    │                                      └──▶  [PostgreSQL] DB: tracking_crm
    │
    └── ads.yourdomain.com      ──▶  [Next.js PM2] :3001  (Add ERP)
                                           │
                                           └──▶  [PostgreSQL] DB: meta_ads

[Linux cron] → hits both apps' /api/cron/* on localhost every minute
```

**Resource allocation (16GB RAM):**
| Component | RAM | vCPUs |
|---|---|---|
| PostgreSQL (both DBs) | ~5 GB | Shared |
| Tracker CRM (2 PM2 instances) | ~2 GB | 1 |
| Add ERP (2 PM2 instances) | ~2 GB | 1 |
| Nginx + system | ~1 GB | Shared |
| **Free headroom** | **~6 GB** | — |

> ✅ KVM 4 is more than enough for both apps. You could even add a 3rd app later.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Hostinger Panel Setup](#2-hostinger-panel-setup)
3. [Push Both Projects to GitHub](#3-push-both-projects-to-github)
4. [SSH Into Your VPS](#4-ssh-into-your-vps)
5. [Run Server Setup](#5-run-server-setup-script-1)
6. [PostgreSQL Setup — Both Databases](#6-postgresql-setup--both-databases)
7. [Create Environment Files](#7-create-environment-files)
8. [Deploy Tracker CRM (App 1)](#8-deploy-tracker-crm-app-1)
9. [Migrate Add ERP to Direct PostgreSQL](#9-migrate-add-erp-to-direct-postgresql)
10. [Deploy Add ERP (App 2)](#10-deploy-add-erp-app-2)
11. [Migrate Data from Supabase](#11-migrate-data-from-supabase)
12. [Point Domains & Setup SSL](#12-point-domains--setup-ssl)
13. [Setup Cron Jobs — Both Apps](#13-setup-cron-jobs--both-apps)
14. [Update External Webhook URLs](#14-update-external-webhook-urls)
15. [Verify Everything Works](#15-verify-everything-works)
16. [Ongoing Maintenance](#16-ongoing-maintenance)
17. [Troubleshooting](#17-troubleshooting)

---

## 1. Prerequisites

Before you begin, make sure you have:

- [ ] **Hostinger KVM 4 VPS** purchased (Ubuntu 22.04 or 24.04)
- [ ] **Two domains/subdomains** for the apps (e.g., `tracker.yourbrand.com` + `ads.yourbrand.com`)
- [ ] **Supabase dashboard access** — to export data for both apps
- [ ] **GitHub account** — to push both projects
- [ ] **Current `.env` values** for both apps handy

**Tracker CRM env vars you need:**
- `ADMIN_USERNAME` / `ADMIN_PASSWORD`
- `DRAFT_QUEUE_SECRET`
- `GMAIL_USER` / `GMAIL_APP_PASSWORD`
- `SHOPIFY_WEBHOOK_SECRET`

**Add ERP env vars you need:**
- `META_APP_SECRET`
- `NEXT_PUBLIC_META_APP_ID`
- `ADMIN_USERNAME` / `ADMIN_PASSWORD`
- `CRON_SECRET_KEY`
- Meta access tokens (in the `meta_accounts` DB table)

---

## 2. Hostinger Panel Setup

1. **Log into Hostinger** → Go to **VPS** section
2. Click on your **KVM 4** plan
3. Under **Operating System**, install **Ubuntu 22.04** (plain, NOT Docker/WordPress template)
4. Note down:
   - **Server IP address** (e.g., `185.xxx.xxx.xxx`)
   - **Root password** (set during OS install)
5. Make sure VPS status shows **Running**

---

## 3. Push Both Projects to GitHub

### Tracker CRM
```bash
cd "/Users/aadityaaggarwal/Desktop/untitled folder 5/Tracker"
git init
git add .
git commit -m "VPS migration - direct PostgreSQL"
git remote add origin https://github.com/YOUR_USERNAME/tracker-crm.git
git branch -M main
git push -u origin main
```

### Add ERP
```bash
cd "/Users/aadityaaggarwal/Desktop/Add ERP/meta-ads"
git add .
git commit -m "VPS migration prep"
git remote add origin https://github.com/YOUR_USERNAME/meta-ads-erp.git
git branch -M main
git push -u origin main
```

> 💡 Use **private** repos for both.

---

## 4. SSH Into Your VPS

```bash
ssh root@YOUR_VPS_IP
```

**Optional (recommended):** Set up SSH key:
```bash
# On your Mac
ssh-keygen -t ed25519
ssh-copy-id root@YOUR_VPS_IP
```

---

## 5. Run Server Setup (Script 1)

**On your Mac — copy setup scripts to VPS:**
```bash
scp "/Users/aadityaaggarwal/Desktop/untitled folder 5/Tracker/vps-setup/"* root@YOUR_VPS_IP:/tmp/vps-setup/
```

**On VPS:**
```bash
mkdir -p /tmp/vps-setup
cd /tmp/vps-setup
chmod +x *.sh
bash 1-server-setup.sh
```

**What this installs:**
- Node.js 20 LTS (via NVM)
- PM2 (process manager)
- PostgreSQL 16 (tuned for 16GB RAM)
- Nginx (reverse proxy)
- Certbot (free SSL)
- UFW firewall (SSH, HTTP, HTTPS only)

**Expected time:** ~5 minutes

**Verify:**
```bash
node -v        # v20.x.x
pm2 -v         # version number
psql --version # 14+ or 16
nginx -v       # version
```

---

## 6. PostgreSQL Setup — Both Databases

### Database 1: Tracker CRM

```bash
bash /tmp/vps-setup/2-postgres-setup.sh
```

This creates:
- Database: `tracking_crm`
- User: `tracker_user`
- All 9 tables + indexes + triggers
- Credentials saved to `/etc/tracker/db-credentials.txt`

**⚠️ Copy the `DATABASE_URL` it prints — you need it for the .env file.**

### Database 2: Add ERP (Meta Ads)

Create the second database manually:

```bash
# Generate a strong password
META_DB_PASS=$(openssl rand -base64 32 | tr -d '/+=' | head -c 40)
echo "META DB PASSWORD: $META_DB_PASS"
echo "SAVE THIS PASSWORD!"

# Create database and user
sudo -u postgres psql << PSQL
CREATE USER meta_user WITH PASSWORD '$META_DB_PASS';
CREATE DATABASE meta_ads OWNER meta_user;
GRANT ALL PRIVILEGES ON DATABASE meta_ads TO meta_user;
\c meta_ads
GRANT ALL ON SCHEMA public TO meta_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO meta_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO meta_user;
PSQL
```

Now apply the Add ERP schema. You need to copy the schema file to the VPS first.

**On your Mac:**
```bash
scp "/Users/aadityaaggarwal/Desktop/Add ERP/meta-ads/supabase/complete_schema.sql" root@YOUR_VPS_IP:/tmp/meta_ads_schema.sql
```

**On VPS:**
```bash
# Remove the Supabase-specific realtime line before importing
sed -i '/supabase_realtime/d' /tmp/meta_ads_schema.sql

sudo -u postgres psql -d meta_ads -f /tmp/meta_ads_schema.sql
```

**Save credentials:**
```bash
mkdir -p /etc/meta-ads
cat > /etc/meta-ads/db-credentials.txt << CREDS
DATABASE_URL=postgresql://meta_user:$META_DB_PASS@localhost:5432/meta_ads
DB_HOST=localhost
DB_PORT=5432
DB_NAME=meta_ads
DB_USER=meta_user
DB_PASSWORD=$META_DB_PASS
CREDS
chmod 600 /etc/meta-ads/db-credentials.txt
```

**Verify both databases:**
```bash
sudo -u postgres psql -d tracking_crm -c "\dt"   # 9 tables
sudo -u postgres psql -d meta_ads -c "\dt"        # 15 tables
```

---

## 7. Create Environment Files

### Tracker CRM — `/etc/tracker/.env`

```bash
nano /etc/tracker/.env
```

```env
# ── Database (from step 6) ────────────────────────────────────
DATABASE_URL=postgresql://tracker_user:PASSWORD_FROM_STEP6@localhost:5432/tracking_crm

# ── App Config ────────────────────────────────────────────────
NEXT_PUBLIC_BASE_URL=https://tracker.yourdomain.com
NODE_ENV=production
PORT=3000

# ── Admin Login ───────────────────────────────────────────────
ADMIN_USERNAME=your_admin_username
ADMIN_PASSWORD=your_admin_password

# ── Cron Secret ───────────────────────────────────────────────
DRAFT_QUEUE_SECRET=your_secret_key

# ── Gmail SMTP ────────────────────────────────────────────────
GMAIL_USER=your.email@gmail.com
GMAIL_APP_PASSWORD=your_16_char_app_password

# ── Shopify Webhook ──────────────────────────────────────────
SHOPIFY_WEBHOOK_SECRET=your_shopify_webhook_secret
```

### Add ERP — `/etc/meta-ads/.env`

```bash
nano /etc/meta-ads/.env
```

```env
# ── Database (from step 6) ────────────────────────────────────
DATABASE_URL=postgresql://meta_user:PASSWORD_FROM_STEP6@localhost:5432/meta_ads

# ── App Config ────────────────────────────────────────────────
NEXT_PUBLIC_APP_URL=https://ads.yourdomain.com
NODE_ENV=production
PORT=3001

# ── Meta App ──────────────────────────────────────────────────
NEXT_PUBLIC_META_APP_ID=1659156191762953
META_APP_SECRET=your_meta_app_secret

# ── Admin Login ───────────────────────────────────────────────
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your_strong_password

# ── Cron Secret ───────────────────────────────────────────────
CRON_SECRET_KEY=your_cron_secret
```

**Lock both files:**
```bash
chmod 600 /etc/tracker/.env
chmod 600 /etc/meta-ads/.env
```

> 💡 If no domain yet, use `http://YOUR_VPS_IP:3000` and `http://YOUR_VPS_IP:3001` temporarily.

---

## 8. Deploy Tracker CRM (App 1)

Tracker is already migrated to direct PostgreSQL. Just clone and deploy.

**On VPS:**
```bash
mkdir -p /var/www/tracker
cd /var/www/tracker
git clone https://github.com/YOUR_USERNAME/tracker-crm.git .
```

Copy env and build:
```bash
cp /etc/tracker/.env .env.production.local
npm ci --production=false
NODE_ENV=production npm run build
```

Start with PM2:
```bash
pm2 start ecosystem.config.js --env production
pm2 save
```

**Verify:**
```bash
pm2 status                                          # 2 instances online
curl -s http://localhost:3000/api/orders | head -c 100  # JSON response
```

---

## 9. Migrate Add ERP to Direct PostgreSQL

> ⚠️ **This step needs to happen BEFORE deploying Add ERP.**
> Add ERP currently uses Supabase JS client (29 files). It needs the same migration we did for Tracker — replacing `@supabase/supabase-js` with direct `pg` queries.

**This is the big piece of work.** Add ERP has:
- **15 database tables** (meta_accounts, campaigns, ad_sets, ads, metrics, automation_rules, automation_logs, notifications, sync_status, users, automation_paused_ads, blocked_accounts, spam_comments_log, system_settings)
- **27 API routes** using Supabase
- **2 lib files** (`supabase.js`, `supabase-server.js`)
- Complex queries with JOINs across campaigns → ad_sets → ads → metrics

### What needs to be done:

1. **Create `src/lib/db.js`** — pg Pool connection (same pattern as Tracker)
2. **Rewrite all 27 API routes** from Supabase JS → parameterized SQL
3. **Rewrite `src/lib/meta-api.js`** (uses Supabase for storing sync data)
4. **Rewrite `src/lib/rule-evaluator.js`** and `src/lib/live-rule-evaluator.js`** (heavy Supabase usage)
5. **Rewrite `src/lib/auth.js`** (user lookup)
6. **Rewrite `src/middleware.js`** (auth check)
7. **Delete `src/lib/supabase.js`** and `src/lib/supabase-server.js`**
8. **Update `package.json`** — add `pg`, remove `@supabase/supabase-js`
9. **Handle Supabase Realtime** — notifications table uses realtime subscriptions; replace with polling or SSE

> 📋 **When you're ready, tell me to start this migration and I'll do it file by file, just like I did for Tracker.**

### Alternative: Keep Add ERP on Supabase Cloud (faster to deploy)

If you want to get Add ERP live on VPS quickly without the full DB migration:
- Just move the Next.js app to VPS (eliminates cold starts)
- Keep the Supabase cloud database (DB queries still go over internet, ~50ms)
- Migrate DB later when you have time

To do this, skip step 9 entirely and in step 10 use the existing Supabase env vars instead of `DATABASE_URL`.

---

## 10. Deploy Add ERP (App 2)

**On VPS:**
```bash
mkdir -p /var/www/meta-ads
cd /var/www/meta-ads
git clone https://github.com/YOUR_USERNAME/meta-ads-erp.git .
```

Copy env and build:
```bash
cp /etc/meta-ads/.env .env.production.local
npm ci --production=false
NODE_ENV=production npm run build
```

Create PM2 config:
```bash
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [
    {
      name: 'meta-ads',
      script: 'node_modules/.bin/next',
      args: 'start',
      cwd: '/var/www/meta-ads',
      instances: 2,
      exec_mode: 'cluster',
      max_memory_restart: '2G',
      env_production: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '5s',
      out_file: '/var/log/meta-ads-out.log',
      error_file: '/var/log/meta-ads-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
};
EOF
```

Start with PM2:
```bash
pm2 start ecosystem.config.js --env production
pm2 save
```

**Verify both apps running:**
```bash
pm2 status
# Should show:
# │ tracker    │ cluster │ online │ :3000 │
# │ tracker    │ cluster │ online │ :3000 │
# │ meta-ads   │ cluster │ online │ :3001 │
# │ meta-ads   │ cluster │ online │ :3001 │

curl -s http://localhost:3001  # Should return Add ERP HTML
```

---

## 11. Migrate Data from Supabase

### Tracker CRM Data

**On your Mac:**
```bash
# Get connection string from Supabase Dashboard → Settings → Database
pg_dump "YOUR_SUPABASE_TRACKER_CONNECTION_STRING" \
  --no-owner --no-acl \
  -t orders -t order_items -t businesses \
  -t team_users -t tracking_history \
  -t upload_logs -t email_logs \
  -t draft_queue -t progression_settings \
  --data-only \
  -f tracker_export.sql

scp tracker_export.sql root@YOUR_VPS_IP:/tmp/tracker_export.sql
```

**On VPS:**
```bash
bash /tmp/vps-setup/6-migrate-data.sh --import
```

### Add ERP Data (only if you did step 9)

**On your Mac:**
```bash
pg_dump "YOUR_SUPABASE_META_ADS_CONNECTION_STRING" \
  --no-owner --no-acl \
  -t meta_accounts -t campaigns -t ad_sets -t ads \
  -t metrics -t automation_rules -t automation_logs \
  -t notifications -t sync_status -t system_settings \
  -t users -t automation_paused_ads \
  -t blocked_accounts -t spam_comments_log \
  --data-only \
  -f meta_ads_export.sql

scp meta_ads_export.sql root@YOUR_VPS_IP:/tmp/meta_ads_export.sql
```

**On VPS:**
```bash
sudo -u postgres psql -d meta_ads -f /tmp/meta_ads_export.sql

# Verify row counts
sudo -u postgres psql -d meta_ads -c "
  SELECT 'meta_accounts' as tbl, COUNT(*) FROM meta_accounts
  UNION ALL SELECT 'campaigns', COUNT(*) FROM campaigns
  UNION ALL SELECT 'ad_sets', COUNT(*) FROM ad_sets
  UNION ALL SELECT 'ads', COUNT(*) FROM ads
  UNION ALL SELECT 'metrics', COUNT(*) FROM metrics
  UNION ALL SELECT 'automation_rules', COUNT(*) FROM automation_rules
  UNION ALL SELECT 'users', COUNT(*) FROM users
  ORDER BY tbl;
"
```

---

## 12. Point Domains & Setup SSL

### Step 1 — DNS Setup

Go to your domain registrar and create A records:

| Hostname | Type | Value |
|---|---|---|
| `tracker.yourdomain.com` | A | `YOUR_VPS_IP` |
| `ads.yourdomain.com` | A | `YOUR_VPS_IP` |

Wait 5-15 mins for DNS propagation. Verify:
```bash
ping tracker.yourdomain.com  # Should resolve to VPS IP
ping ads.yourdomain.com      # Should resolve to VPS IP
```

### Step 2 — Nginx Config for Both Apps

**On VPS:**
```bash
cat > /etc/nginx/sites-available/tracker << 'NGINX'
# ── TRACKER CRM ──────────────────────────────────
server {
    listen 80;
    server_name tracker.yourdomain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name tracker.yourdomain.com;

    # SSL — filled by Certbot
    ssl_certificate /etc/letsencrypt/live/tracker.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tracker.yourdomain.com/privkey.pem;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    # Gzip
    gzip on;
    gzip_vary on;
    gzip_comp_level 6;
    gzip_types text/plain text/css application/json application/javascript image/svg+xml;

    # Static files
    location /_next/static/ {
        alias /var/www/tracker/.next/static/;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Shopify webhook (raw body for HMAC)
    location /api/shopify/webhook {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering off;
        client_max_body_size 1m;
    }

    # CSV upload (20MB)
    location /api/upload {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
        client_max_body_size 20m;
    }

    # Everything else → Next.js
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        client_max_body_size 20m;
    }
}
NGINX

cat > /etc/nginx/sites-available/meta-ads << 'NGINX'
# ── ADD ERP (META ADS) ──────────────────────────
server {
    listen 80;
    server_name ads.yourdomain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ads.yourdomain.com;

    # SSL — filled by Certbot
    ssl_certificate /etc/letsencrypt/live/ads.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ads.yourdomain.com/privkey.pem;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    # Gzip
    gzip on;
    gzip_vary on;
    gzip_comp_level 6;
    gzip_types text/plain text/css application/json application/javascript image/svg+xml;

    # Static files
    location /_next/static/ {
        alias /var/www/meta-ads/.next/static/;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Everything else → Next.js
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        client_max_body_size 10m;
    }
}
NGINX

# Enable both sites
ln -sf /etc/nginx/sites-available/tracker /etc/nginx/sites-enabled/tracker
ln -sf /etc/nginx/sites-available/meta-ads /etc/nginx/sites-enabled/meta-ads
rm -f /etc/nginx/sites-enabled/default

# Test config
nginx -t
```

### Step 3 — Get SSL Certificates

```bash
# Tracker
certbot --nginx -d tracker.yourdomain.com --non-interactive --agree-tos --email your@email.com --redirect

# Add ERP
certbot --nginx -d ads.yourdomain.com --non-interactive --agree-tos --email your@email.com --redirect

systemctl reload nginx
```

**Verify:**
- Open `https://tracker.yourdomain.com` — should show Tracker login 🔒
- Open `https://ads.yourdomain.com` — should show Add ERP login 🔒

### No Domain Yet?

Access both apps via IP temporarily:
```
http://YOUR_VPS_IP:3000   ← Tracker
http://YOUR_VPS_IP:3001   ← Add ERP
```
Come back to this step when you have domains.

---

## 13. Setup Cron Jobs — Both Apps

**On VPS:**

```bash
# Read secrets from env files
TRACKER_SECRET=$(grep DRAFT_QUEUE_SECRET /etc/tracker/.env | cut -d'=' -f2)
META_SECRET=$(grep CRON_SECRET_KEY /etc/meta-ads/.env | cut -d'=' -f2)

# Write crontab
crontab -l 2>/dev/null | grep -v "app-cron" > /tmp/cron_combined || true

cat >> /tmp/cron_combined << CRON
# ─── TRACKER CRM Crons ──────────────────────────
* * * * * curl -s --max-time 25 "http://localhost:3000/api/cron/progress-orders?key=$TRACKER_SECRET" >> /var/log/tracker-cron.log 2>&1 # app-cron
* * * * * curl -s --max-time 25 "http://localhost:3000/api/cron/pending-emails?key=$TRACKER_SECRET" >> /var/log/tracker-cron.log 2>&1 # app-cron

# ─── ADD ERP Crons ──────────────────────────────
*/5 * * * * curl -s --max-time 55 "http://localhost:3001/api/sync?key=$META_SECRET" >> /var/log/meta-ads-cron.log 2>&1 # app-cron
*/5 * * * * curl -s --max-time 55 "http://localhost:3001/api/automation/evaluate?key=$META_SECRET" >> /var/log/meta-ads-cron.log 2>&1 # app-cron

# ─── Log Rotation ──────────────────────────────
0 0 * * * find /var/log/tracker-cron.log -size +50M -exec truncate -s 0 {} \; # app-cron
0 0 * * * find /var/log/meta-ads-cron.log -size +50M -exec truncate -s 0 {} \; # app-cron
CRON

crontab /tmp/cron_combined
rm /tmp/cron_combined
```

**Verify:**
```bash
crontab -l   # Should show all 6 cron entries
```

> 💡 Adjust Add ERP cron frequency as needed. `*/5` = every 5 mins for sync/evaluation.

---

## 14. Update External Webhook URLs

### Shopify (for Tracker CRM)

1. Go to **Shopify Admin** → **Settings** → **Notifications** → **Webhooks**
2. Change webhook URL to: `https://tracker.yourdomain.com/api/shopify/webhook`

### Meta App (for Add ERP)

1. Go to [Meta Developers](https://developers.facebook.com/apps/)
2. Update your app's **Redirect URI** to: `https://ads.yourdomain.com/auth`
3. Update any webhook URLs to the new domain

> ⚠️ Do this AFTER verifying both apps work on the VPS.

---

## 15. Verify Everything Works

### System Health
```bash
pm2 status                    # All 4 instances online
sudo systemctl status nginx   # Active
sudo systemctl status postgresql  # Active
df -h                         # Disk space OK
free -h                       # Memory usage OK
```

### Tracker CRM Checks
```bash
curl -s http://localhost:3000/api/orders | head -c 200
sudo -u postgres psql -d tracking_crm -c "SELECT COUNT(*) FROM orders;"
tail -5 /var/log/tracker-cron.log
```

Browser:
- [ ] Login works at `https://tracker.yourdomain.com/login`
- [ ] Dashboard shows orders
- [ ] Search works
- [ ] CSV upload works
- [ ] Track page loads
- [ ] Emails send

### Add ERP Checks
```bash
curl -s http://localhost:3001 | head -c 200
sudo -u postgres psql -d meta_ads -c "SELECT COUNT(*) FROM campaigns;"
tail -5 /var/log/meta-ads-cron.log
```

Browser:
- [ ] Login works at `https://ads.yourdomain.com/login`
- [ ] Dashboard loads with campaigns
- [ ] Meta sync works
- [ ] Automation rules fire
- [ ] Comments moderation works

### Performance Check
```bash
# Both should respond in <100ms
time curl -s http://localhost:3000/api/orders > /dev/null
time curl -s http://localhost:3001 > /dev/null
```

---

## 16. Ongoing Maintenance

### Deploy Updates

**Tracker:**
```bash
ssh root@YOUR_VPS_IP "cd /var/www/tracker && git pull origin main && npm ci --production=false && npm run build && pm2 reload tracker"
```

**Add ERP:**
```bash
ssh root@YOUR_VPS_IP "cd /var/www/meta-ads && git pull origin main && npm ci --production=false && npm run build && pm2 reload meta-ads"
```

### Useful Commands

| Command | What it does |
|---|---|
| `pm2 status` | Check all apps |
| `pm2 logs tracker` | Tracker logs |
| `pm2 logs meta-ads` | Add ERP logs |
| `pm2 reload tracker` | Zero-downtime restart |
| `pm2 reload meta-ads` | Zero-downtime restart |
| `pm2 monit` | Live CPU/memory monitor |
| `sudo -u postgres psql -d tracking_crm` | Tracker DB shell |
| `sudo -u postgres psql -d meta_ads` | Add ERP DB shell |
| `nginx -t && systemctl reload nginx` | Reload Nginx |
| `certbot renew --dry-run` | Test SSL renewal |
| `htop` | System resource monitor |
| `df -h` | Check disk space |

### Database Backups (Both DBs)

```bash
mkdir -p /var/backups/tracker /var/backups/meta-ads

# Add to crontab (daily at 2 AM)
(crontab -l; echo "0 2 * * * pg_dump -U tracker_user tracking_crm | gzip > /var/backups/tracker/backup_\$(date +\%Y\%m\%d).sql.gz && find /var/backups/tracker -mtime +7 -delete # db-backup") | crontab -

(crontab -l; echo "5 2 * * * pg_dump -U meta_user meta_ads | gzip > /var/backups/meta-ads/backup_\$(date +\%Y\%m\%d).sql.gz && find /var/backups/meta-ads -mtime +7 -delete # db-backup") | crontab -
```

---

## 17. Troubleshooting

### App won't start
```bash
pm2 logs tracker --lines 50      # or meta-ads
cat /etc/tracker/.env             # Verify env vars
cat /etc/meta-ads/.env
```

### Database connection error
```bash
systemctl status postgresql
sudo -u postgres psql -d tracking_crm -c "SELECT 1"
sudo -u postgres psql -d meta_ads -c "SELECT 1"
cat /etc/tracker/db-credentials.txt
cat /etc/meta-ads/db-credentials.txt
```

### Nginx 502 Bad Gateway
```bash
pm2 status                        # App crashed?
pm2 restart tracker               # or meta-ads
tail -20 /var/log/nginx/error.log
```

### Port conflict
```bash
# Check what's using ports 3000 and 3001
lsof -i :3000
lsof -i :3001
```

### SSL certificate issues
```bash
certbot certificates              # Check expiry
certbot renew --force-renewal     # Force renew
```

### Out of memory
```bash
free -h
htop
# If needed, reduce PM2 instances from 2 to 1 per app:
pm2 scale tracker 1
pm2 scale meta-ads 1
```

### Emails not sending
```bash
tail -20 /var/log/tracker-cron.log
curl -X POST "http://localhost:3000/api/cron/pending-emails?key=YOUR_SECRET"
```

---

## Quick Reference Card

```
┌─────────────────────────────────────────────────────────────┐
│  DUAL APP VPS — Quick Reference                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ── TRACKER CRM ──                                           │
│  URL:       https://tracker.yourdomain.com                   │
│  Port:      3000                                             │
│  App Dir:   /var/www/tracker                                 │
│  Env:       /etc/tracker/.env                                │
│  DB:        tracking_crm (tracker_user)                      │
│  PM2:       tracker (2 instances)                            │
│  Logs:      pm2 logs tracker                                 │
│  Cron Log:  /var/log/tracker-cron.log                        │
│                                                              │
│  ── ADD ERP (META ADS) ──                                    │
│  URL:       https://ads.yourdomain.com                       │
│  Port:      3001                                             │
│  App Dir:   /var/www/meta-ads                                │
│  Env:       /etc/meta-ads/.env                               │
│  DB:        meta_ads (meta_user)                             │
│  PM2:       meta-ads (2 instances)                           │
│  Logs:      pm2 logs meta-ads                                │
│  Cron Log:  /var/log/meta-ads-cron.log                       │
│                                                              │
│  ── SERVER ──                                                │
│  IP:        YOUR_VPS_IP                                      │
│  SSH:       ssh root@YOUR_VPS_IP                             │
│  Backups:   /var/backups/                                    │
│  Deploy:    cd /var/www/APP && git pull && npm ci &&          │
│             npm run build && pm2 reload APP_NAME             │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Execution Order Summary

```
 1. bash 1-server-setup.sh              ← Installs Node, PM2, Postgres, Nginx
 2. bash 2-postgres-setup.sh            ← Tracker DB (tracking_crm)
 3. Create meta_ads DB manually         ← Add ERP DB (meta_ads)
 4. nano /etc/tracker/.env              ← Tracker env vars
 5. nano /etc/meta-ads/.env             ← Add ERP env vars
 6. Clone + deploy Tracker (:3000)      ← git clone + pm2 start
 7. (Optional) Migrate Add ERP to pg    ← Replace Supabase client with pg
 8. Clone + deploy Add ERP (:3001)      ← git clone + pm2 start
 9. Export data from both Supabase DBs  ← pg_dump
10. Import data on VPS                  ← psql -f
11. Point both domains → VPS IP         ← DNS A records
12. Run SSL setup for both domains      ← certbot
13. Setup cron jobs for both apps       ← crontab
14. Update Shopify + Meta webhook URLs  ← Final switch
```

**Total estimated time: 2-3 hours** (plus Add ERP Supabase→pg migration if you do step 7)
