-- ============================================================
-- Chat support base tables (sites, site_emails, conversations,
-- messages, webhook_endpoints).
-- These were created by Prisma in the old chat-support server
-- (prisma/schema.prisma) before chat moved into this app, so no
-- SQL file for them existed here. Generated from that schema.
-- Production already has them; this is for fresh/local databases.
-- Apply before supabase-chat-cod.sql and supabase-chat-faq.sql.
-- Additive + idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS "sites" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "widget_key" TEXT NOT NULL,
    "ai_enabled" BOOLEAN NOT NULL DEFAULT true,
    "system_prompt" TEXT,
    "tracker_business_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "site_emails" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "email" TEXT NOT NULL,
    "app_password" TEXT NOT NULL,
    "last_uid" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "site_emails_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "conversations" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "visitor_id" TEXT NOT NULL,
    "visitor_name" TEXT,
    "visitor_phone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ai_handling',
    "source" TEXT NOT NULL DEFAULT 'chat',
    "category" TEXT NOT NULL DEFAULT 'others',
    "email_thread_id" TEXT,
    "unread_count" INTEGER NOT NULL DEFAULT 0,
    "last_message_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "messages" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "sender" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "email_message_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "webhook_endpoints" (
    "id" TEXT NOT NULL,
    "site_id" TEXT,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "sites_widget_key_key" ON "sites"("widget_key");
CREATE UNIQUE INDEX IF NOT EXISTS "sites_tracker_business_id_key" ON "sites"("tracker_business_id");
CREATE INDEX IF NOT EXISTS "conversations_site_id_idx" ON "conversations"("site_id");
CREATE INDEX IF NOT EXISTS "conversations_visitor_id_idx" ON "conversations"("visitor_id");
CREATE INDEX IF NOT EXISTS "messages_conversation_id_idx" ON "messages"("conversation_id");
CREATE INDEX IF NOT EXISTS "messages_created_at_idx" ON "messages"("created_at");
