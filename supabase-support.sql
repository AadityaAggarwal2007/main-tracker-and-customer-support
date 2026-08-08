-- ============================================================
-- Support Ticket System — Run on VPS PostgreSQL
-- ============================================================

-- 1. Support Tickets
CREATE TABLE IF NOT EXISTS support_tickets (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id     UUID REFERENCES businesses(id) ON DELETE SET NULL,
  source          TEXT DEFAULT 'email',   -- 'email' | 'shopify'
  status          TEXT DEFAULT 'open',    -- 'open' | 'pending' | 'resolved' | 'spam'
  subject         TEXT,
  customer_email  TEXT,
  customer_name   TEXT,
  order_id        TEXT,                   -- auto-detected from message content
  last_message_at TIMESTAMPTZ DEFAULT now(),
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_business   ON support_tickets(business_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status     ON support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_email      ON support_tickets(customer_email);
CREATE INDEX IF NOT EXISTS idx_support_tickets_created    ON support_tickets(created_at DESC);

-- 2. Ticket Messages (conversation thread)
CREATE TABLE IF NOT EXISTS ticket_messages (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  ticket_id        UUID REFERENCES support_tickets(id) ON DELETE CASCADE,
  direction        TEXT NOT NULL,           -- 'inbound' | 'outbound'
  body             TEXT NOT NULL,
  is_ai_generated  BOOLEAN DEFAULT false,
  sent_by          TEXT,                    -- username or 'ai'
  raw_email_id     TEXT,                    -- IMAP message-id for dedup
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket  ON ticket_messages(ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_messages_created ON ticket_messages(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_messages_email_dedup ON ticket_messages(raw_email_id)
  WHERE raw_email_id IS NOT NULL;

-- 3. Per-panel Support Settings
CREATE TABLE IF NOT EXISTS support_settings (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id           UUID REFERENCES businesses(id) ON DELETE CASCADE UNIQUE,
  ai_mode               TEXT DEFAULT 'human_first', -- 'human_first' | 'ai_first'
  ai_provider           TEXT DEFAULT 'gemini',      -- 'gemini' | 'openai' | 'openrouter'
  ai_api_key            TEXT,
  ai_model              TEXT DEFAULT 'gemini-1.5-flash',
  ai_base_url           TEXT,                        -- for openrouter / custom endpoints
  imap_host             TEXT DEFAULT 'imap.gmail.com',
  imap_port             INTEGER DEFAULT 993,
  imap_user             TEXT,
  imap_password         TEXT,                        -- Gmail App Password
  imap_folder           TEXT DEFAULT 'INBOX',
  auto_reply_enabled    BOOLEAN DEFAULT false,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);

-- Verify
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('support_tickets','ticket_messages','support_settings')
ORDER BY table_name;
