#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Step 2: PostgreSQL Database Setup
# Run as root: bash 2-postgres-setup.sh
# ═══════════════════════════════════════════════════════════════
set -e

# Generate a random strong password
DB_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=' | head -c 40)
DB_NAME="tracking_crm"
DB_USER="tracker_user"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " PostgreSQL Database Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "DB_NAME: $DB_NAME"
echo "DB_USER: $DB_USER"
echo "DB_PASS: $DB_PASSWORD"
echo ""
echo " ⚠️  SAVE THIS PASSWORD — you'll need it for .env"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Create database and user
sudo -u postgres psql << PSQL
-- Create user
CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';

-- Create database
CREATE DATABASE $DB_NAME OWNER $DB_USER;

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;

-- Connect to the new database
\c $DB_NAME

-- Grant schema privileges
GRANT ALL ON SCHEMA public TO $DB_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO $DB_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO $DB_USER;
PSQL

echo ""
echo "[1/3] User and database created."

# Run the schema SQL
echo "[2/3] Running schema migrations..."
sudo -u postgres psql -d $DB_NAME << 'SCHEMA'

-- ============================================
-- Customer Tracking CRM — Schema
-- ============================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- for fast ILIKE searches

-- ── ORDERS ──────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  order_id TEXT UNIQUE NOT NULL,
  shopify_id TEXT,
  payment_method TEXT DEFAULT 'COD',
  financial_status TEXT DEFAULT 'paid',
  customer_name TEXT NOT NULL,
  customer_email TEXT,
  customer_mobile TEXT NOT NULL,
  address_line1 TEXT,
  address_line2 TEXT,
  address_line3 TEXT,
  city TEXT,
  state TEXT,
  pincode TEXT,
  tracking_status TEXT DEFAULT 'Order Placed',
  tracking_id TEXT,
  courier_partner TEXT,
  tracking_token UUID DEFAULT uuid_generate_v4() UNIQUE,
  status_updated_at TIMESTAMPTZ DEFAULT now(),
  estimated_delivery DATE,
  order_total DECIMAL(10,2) DEFAULT 0,
  is_cancelled BOOLEAN DEFAULT false,
  cancelled_at TIMESTAMPTZ,
  notes TEXT,
  business_id UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ── ORDER ITEMS ──────────────────────────────
CREATE TABLE IF NOT EXISTS order_items (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  brand TEXT,
  product_name TEXT NOT NULL,
  quantity INTEGER DEFAULT 1,
  price DECIMAL(10,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── BUSINESSES ──────────────────────────────
CREATE TABLE IF NOT EXISTS businesses (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  name TEXT NOT NULL,
  logo_url TEXT,
  support_email TEXT,
  support_phone TEXT,
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ── TEAM USERS ──────────────────────────────
CREATE TABLE IF NOT EXISTS team_users (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  is_active BOOLEAN DEFAULT true,
  last_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ── TRACKING HISTORY ────────────────────────
CREATE TABLE IF NOT EXISTS tracking_history (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  changed_by TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── UPLOAD LOGS ─────────────────────────────
CREATE TABLE IF NOT EXISTS upload_logs (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  filename TEXT,
  total_rows INTEGER DEFAULT 0,
  new_orders INTEGER DEFAULT 0,
  updated_orders INTEGER DEFAULT 0,
  skipped_rows INTEGER DEFAULT 0,
  uploaded_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── EMAIL LOGS ──────────────────────────────
CREATE TABLE IF NOT EXISTS email_logs (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  status TEXT,
  recipient_email TEXT,
  success BOOLEAN DEFAULT false,
  error_message TEXT,
  sent_at TIMESTAMPTZ DEFAULT now()
);

-- ── DRAFT QUEUE ─────────────────────────────
CREATE TABLE IF NOT EXISTS draft_queue (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  email_status TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ── PROGRESSION SETTINGS ────────────────────
CREATE TABLE IF NOT EXISTS progression_settings (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  step_order INTEGER NOT NULL,
  step_from TEXT NOT NULL,
  step_to TEXT NOT NULL,
  delay_minutes INTEGER DEFAULT 60,
  is_enabled BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Insert default progression steps if empty
INSERT INTO progression_settings (step_order, step_from, step_to, delay_minutes, is_enabled)
SELECT * FROM (VALUES
  (1, 'Order Placed', 'Processing', 60, false),
  (2, 'Processing', 'Packed', 120, false),
  (3, 'Packed', 'Shipped', 240, false),
  (4, 'Shipped', 'In Transit', 480, false),
  (5, 'In Transit', 'Out for Delivery', 1440, false),
  (6, 'Out for Delivery', 'Delivered', 240, false)
) AS v(step_order, step_from, step_to, delay_minutes, is_enabled)
WHERE NOT EXISTS (SELECT 1 FROM progression_settings LIMIT 1);

-- ── INDEXES ─────────────────────────────────

-- Orders: most critical for dashboard speed
CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(order_id);
CREATE INDEX IF NOT EXISTS idx_orders_tracking_token ON orders(tracking_token);
CREATE INDEX IF NOT EXISTS idx_orders_customer_mobile ON orders(customer_mobile);
CREATE INDEX IF NOT EXISTS idx_orders_tracking_status ON orders(tracking_status);
CREATE INDEX IF NOT EXISTS idx_orders_is_cancelled ON orders(is_cancelled);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_business_id ON orders(business_id);
CREATE INDEX IF NOT EXISTS idx_orders_status_cancelled ON orders(tracking_status, is_cancelled);
-- Composite for cron queries
CREATE INDEX IF NOT EXISTS idx_orders_status_time ON orders(tracking_status, is_cancelled, status_updated_at);

-- Trigram index for fast ILIKE search on name/email/phone
CREATE INDEX IF NOT EXISTS idx_orders_customer_name_trgm ON orders USING gin(customer_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_orders_customer_email_trgm ON orders USING gin(customer_email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_orders_order_id_trgm ON orders USING gin(order_id gin_trgm_ops);

-- Order items
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_brand ON order_items(brand);

-- Tracking history
CREATE INDEX IF NOT EXISTS idx_tracking_history_order_id ON tracking_history(order_id);

-- Email logs
CREATE INDEX IF NOT EXISTS idx_email_logs_order_id ON email_logs(order_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_success ON email_logs(order_id, success);
CREATE INDEX IF NOT EXISTS idx_email_logs_sent_at ON email_logs(sent_at DESC);

-- Draft queue
CREATE INDEX IF NOT EXISTS idx_draft_queue_status ON draft_queue(status);
CREATE INDEX IF NOT EXISTS idx_draft_queue_order_status ON draft_queue(order_id, status);

-- Businesses
CREATE INDEX IF NOT EXISTS idx_businesses_is_default ON businesses(is_default);

-- ── AUTO-UPDATE updated_at ───────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER team_users_updated_at
  BEFORE UPDATE ON team_users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER businesses_updated_at
  BEFORE UPDATE ON businesses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

SCHEMA

echo "[3/3] Schema applied."

# Save credentials to a file
cat > /etc/tracker/db-credentials.txt << CREDS
DATABASE_URL=postgresql://$DB_USER:$DB_PASSWORD@localhost:5432/$DB_NAME
DB_HOST=localhost
DB_PORT=5432
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
CREDS

chmod 600 /etc/tracker/db-credentials.txt

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " ✅ Database setup complete!"
echo " Credentials saved to: /etc/tracker/db-credentials.txt"
echo ""
echo " DATABASE_URL=postgresql://$DB_USER:$DB_PASSWORD@localhost:5432/$DB_NAME"
echo ""
echo " Add this DATABASE_URL to /etc/tracker/.env"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
