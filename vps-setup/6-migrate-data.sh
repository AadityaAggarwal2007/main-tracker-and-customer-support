#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Step 6: Migrate Data from Supabase → Local PostgreSQL
# Run AFTER postgres setup and BEFORE going live
# Usage: bash 6-migrate-data.sh
# ═══════════════════════════════════════════════════════════════
set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Data Migration: Supabase → Local PostgreSQL"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "METHOD 1 (Recommended): pg_dump from Supabase"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Step 1: Get your Supabase connection string from:"
echo "  Supabase Dashboard → Settings → Database → Connection string"
echo "  (Use the 'URI' format with your password)"
echo ""
echo "Step 2: Run on your LOCAL machine:"
echo ""
echo "  pg_dump \"YOUR_SUPABASE_CONNECTION_STRING\" \\"
echo "    --no-owner --no-acl \\"
echo "    -t orders -t order_items -t businesses \\"
echo "    -t team_users -t tracking_history \\"
echo "    -t upload_logs -t email_logs \\"
echo "    -t draft_queue -t progression_settings \\"
echo "    --data-only \\"
echo "    -f supabase_export.sql"
echo ""
echo "Step 3: Copy the dump to VPS:"
echo ""
echo "  scp supabase_export.sql root@YOUR_VPS_IP:/tmp/supabase_export.sql"
echo ""
echo "Step 4: Import on VPS (run this script with --import flag):"
echo ""
echo "  bash 6-migrate-data.sh --import"
echo ""

if [ "$1" = "--import" ]; then
  DUMP_FILE="/tmp/supabase_export.sql"
  DB_CREDS=$(cat /etc/tracker/db-credentials.txt)
  DB_NAME=$(echo "$DB_CREDS" | grep DB_NAME | cut -d'=' -f2)
  DB_USER=$(echo "$DB_CREDS" | grep DB_USER | cut -d'=' -f2)

  if [ ! -f "$DUMP_FILE" ]; then
    echo "ERROR: $DUMP_FILE not found."
    echo "Copy your pg_dump file to /tmp/supabase_export.sql first."
    exit 1
  fi

  echo "Importing $DUMP_FILE into $DB_NAME..."
  sudo -u postgres psql -d $DB_NAME -U $DB_USER -f $DUMP_FILE

  # Verify row counts
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " Row counts after migration:"
  sudo -u postgres psql -d $DB_NAME -c "
    SELECT 'orders' as table_name, COUNT(*) as rows FROM orders
    UNION ALL SELECT 'order_items', COUNT(*) FROM order_items
    UNION ALL SELECT 'businesses', COUNT(*) FROM businesses
    UNION ALL SELECT 'team_users', COUNT(*) FROM team_users
    UNION ALL SELECT 'tracking_history', COUNT(*) FROM tracking_history
    UNION ALL SELECT 'email_logs', COUNT(*) FROM email_logs
    UNION ALL SELECT 'progression_settings', COUNT(*) FROM progression_settings
    ORDER BY table_name;
  "
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " ✅ Import complete! Verify counts match Supabase."
fi
