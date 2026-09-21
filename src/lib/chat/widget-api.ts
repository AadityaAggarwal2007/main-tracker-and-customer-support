import { NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';

// ── Shared pieces for the public widget endpoints ──────────────
// These routes are called cross-origin from merchants' storefronts, with no
// session and no cookie. The site key in the request body is the only
// credential, exactly as it was in the old Express app.

// The widget posts JSON, which triggers a preflight. Without these headers on
// both the preflight and the response, every widget on every store goes silent
// with nothing in the server log.
export const WIDGET_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export function widgetJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: WIDGET_CORS });
}

export function widgetPreflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: WIDGET_CORS });
}

export interface WidgetSite {
  id: string;
  name: string;
  ai_enabled: boolean;
  system_prompt: string | null;
  tracker_business_id: string | null;
  cod_available: boolean | null;
}

export async function siteByKey(siteKey: string): Promise<WidgetSite | null> {
  return queryOne<WidgetSite>(
    `SELECT id, name, ai_enabled, system_prompt, tracker_business_id, cod_available
       FROM sites WHERE widget_key = $1`,
    [siteKey]
  );
}

export interface WidgetConversation {
  id: string;
  site_id: string;
  status: string;
}

// A conversation is only ever readable through the site key that owns it.
export async function conversationForSite(
  conversationId: string,
  siteId: string
): Promise<WidgetConversation | null> {
  return queryOne<WidgetConversation>(
    `SELECT id, site_id, status FROM conversations WHERE id = $1 AND site_id = $2`,
    [conversationId, siteId]
  );
}

// tool_result rows, hidden tool bookkeeping and empty AI placeholders are
// internal — a visitor must never see them.
export const VISIBLE_MESSAGE_SQL = `
  sender <> 'tool_result'
  AND COALESCE(metadata->>'hidden', 'false') <> 'true'
  AND content IS NOT NULL
  AND btrim(content) <> ''
`;
