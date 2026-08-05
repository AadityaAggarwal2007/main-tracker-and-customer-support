#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Step 1: Server Bootstrap — Hostinger KVM4 Ubuntu 22.04
# Run as root via SSH: bash 1-server-setup.sh
# ═══════════════════════════════════════════════════════════════
set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Customer Tracking CRM — VPS Setup"
echo " Hostinger KVM4 | Ubuntu 22.04"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─── System Update ─────────────────────────────────────────────
echo "[1/8] Updating system packages..."
apt-get update -y && apt-get upgrade -y
apt-get install -y curl wget git unzip ufw htop

# ─── Node.js 20 LTS (via NVM) ─────────────────────────────────
echo "[2/8] Installing Node.js 20 LTS via NVM..."
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
export NVM_DIR="$HOME/.nvm"
source "$NVM_DIR/nvm.sh"
nvm install 20
nvm use 20
nvm alias default 20

# Make node/npm available system-wide
ln -sf "$(which node)" /usr/local/bin/node
ln -sf "$(which npm)" /usr/local/bin/npm
ln -sf "$(which npx)" /usr/local/bin/npx

echo "Node version: $(node -v)"
echo "NPM version: $(npm -v)"

# ─── PM2 ──────────────────────────────────────────────────────
echo "[3/8] Installing PM2..."
npm install -g pm2
pm2 startup systemd -u root --hp /root
ln -sf "$(which pm2)" /usr/local/bin/pm2

# ─── PostgreSQL 16 ────────────────────────────────────────────
echo "[4/8] Installing PostgreSQL 16..."
apt-get install -y postgresql postgresql-contrib

# Tune PostgreSQL for 16GB RAM (KVM4)
cat >> /etc/postgresql/*/main/postgresql.conf << 'PGCONF'

# ─── Performance tuning for 16GB RAM / 4 vCPU ───
shared_buffers = 4GB              # 25% of RAM
effective_cache_size = 12GB       # 75% of RAM
work_mem = 64MB                   # Per sort/hash operation
maintenance_work_mem = 1GB        # For VACUUM, CREATE INDEX
max_connections = 100             # Enough for our pool
checkpoint_completion_target = 0.9
wal_buffers = 64MB
default_statistics_target = 100
random_page_cost = 1.1            # SSD (NVMe) setting
effective_io_concurrency = 200    # SSD parallel I/O
max_worker_processes = 4          # Match vCPU count
max_parallel_workers_per_gather = 2
max_parallel_workers = 4
PGCONF

# Allow local connections
sed -i "s/#listen_addresses = 'localhost'/listen_addresses = 'localhost'/" /etc/postgresql/*/main/postgresql.conf

systemctl restart postgresql
systemctl enable postgresql
echo "PostgreSQL 16 installed and tuned."

# ─── Nginx ────────────────────────────────────────────────────
echo "[5/8] Installing Nginx..."
apt-get install -y nginx
systemctl enable nginx

# ─── Certbot (SSL) ────────────────────────────────────────────
echo "[6/8] Installing Certbot..."
apt-get install -y certbot python3-certbot-nginx

# ─── UFW Firewall ─────────────────────────────────────────────
echo "[7/8] Configuring firewall..."
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh          # 22
ufw allow http         # 80
ufw allow https        # 443
ufw --force enable
echo "Firewall configured: SSH, HTTP, HTTPS allowed."

# ─── App Directory ────────────────────────────────────────────
echo "[8/8] Creating app directory..."
mkdir -p /var/www/tracker
mkdir -p /etc/tracker
chmod 755 /var/www/tracker

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " ✅ Server setup complete!"
echo ""
echo " NEXT STEPS:"
echo " 1. Run: bash 2-postgres-setup.sh"
echo " 2. Copy your .env.production to /etc/tracker/.env"
echo " 3. Run: bash 5-deploy.sh"
echo " 4. Point your domain to this server IP"
echo " 5. Run: bash 3-nginx-ssl.sh YOUR_DOMAIN"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
