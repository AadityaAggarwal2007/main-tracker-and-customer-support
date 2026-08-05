#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Step 3: Nginx + SSL Setup
# Usage: bash 3-nginx-ssl.sh your-domain.com
# Run AFTER pointing your domain's A record to this server IP
# ═══════════════════════════════════════════════════════════════
set -e

DOMAIN=$1

if [ -z "$DOMAIN" ]; then
  echo "Usage: bash 3-nginx-ssl.sh your-domain.com"
  exit 1
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Nginx + SSL Setup for: $DOMAIN"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─── Write Nginx config ────────────────────────────────────────
cat > /etc/nginx/sites-available/tracker << NGINX
# Redirect HTTP → HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;
    return 301 https://\$server_name\$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $DOMAIN www.$DOMAIN;

    # SSL — will be filled in by Certbot
    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml application/json application/javascript application/xml+rss application/atom+xml image/svg+xml;

    # ── Static files: cache aggressively ──────────────────────
    location /_next/static/ {
        alias /var/www/tracker/.next/static/;
        expires 1y;
        add_header Cache-Control "public, immutable";
        access_log off;
    }

    location /favicon.ico {
        alias /var/www/tracker/public/favicon.ico;
        expires 30d;
        access_log off;
    }

    # ── Shopify Webhook: must pass raw body for HMAC ───────────
    location /api/shopify/webhook {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        # CRITICAL: disable body buffering so raw body reaches Next.js intact
        proxy_request_buffering off;
        proxy_read_timeout 30s;
        client_max_body_size 1m;
    }

    # ── File uploads (CSV up to 20MB) ─────────────────────────
    location /api/upload {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
        client_max_body_size 20m;
    }

    # ── All other requests → Next.js ──────────────────────────
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 60s;
        client_max_body_size 20m;
    }
}
NGINX

# Enable site
ln -sf /etc/nginx/sites-available/tracker /etc/nginx/sites-enabled/tracker
rm -f /etc/nginx/sites-enabled/default

# Test config
nginx -t

# Obtain SSL certificate
echo "Obtaining Let's Encrypt SSL certificate..."
certbot --nginx -d $DOMAIN -d www.$DOMAIN --non-interactive --agree-tos --email admin@$DOMAIN --redirect

# Reload Nginx
systemctl reload nginx

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " ✅ Nginx + SSL configured for https://$DOMAIN"
echo ""
echo " Auto-renewal is set up via: certbot renew"
echo " Test renewal: certbot renew --dry-run"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
