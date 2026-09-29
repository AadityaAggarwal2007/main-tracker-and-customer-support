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

// The caller's address, for rate limits. nginx sets X-Real-IP to $remote_addr,
// which the client cannot choose. X-Forwarded-For keeps whatever the client
// sent and only appends the real address, so its FIRST entry is attacker
// controlled; when it is all we have, the LAST entry (nginx's) is used.
export function clientIp(request: Request): string {
  const real = request.headers.get('x-real-ip')?.trim();
  if (real) return real;
  const forwarded = (request.headers.get('x-forwarded-for') || '').split(',').map((s) => s.trim()).filter(Boolean);
  return forwarded[forwarded.length - 1] || 'unknown';
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

// The visitor's open conversation on this site, or a new one. Shared by
// /api/widget/conversation (first message) and /api/widget/verify (the
// "Verify yourself" form), so both land in the same chat for the same visitor.
export async function getOrCreateVisitorConversation(
  siteId: string,
  visitorId: string,
  visitorName?: string | null
): Promise<{ id: string; status: string }> {
  let conversation = await queryOne<{ id: string; status: string }>(
    `SELECT id, status FROM conversations
      WHERE site_id = $1 AND visitor_id = $2 AND status <> 'resolved'
      ORDER BY created_at DESC
      LIMIT 1`,
    [siteId, visitorId]
  );

  if (!conversation) {
    conversation = await queryOne<{ id: string; status: string }>(
      `INSERT INTO conversations
         (id, site_id, visitor_id, visitor_name, status, source, category,
          unread_count, last_message_at, created_at, updated_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'ai_handling', 'chat', 'others',
               0, now(), now(), now())
       RETURNING id, status`,
      [siteId, visitorId, visitorName || 'Visitor']
    );
  }

  return conversation!;
}

// tool_result rows, hidden tool bookkeeping and empty AI placeholders are
// internal — a visitor must never see them.
export const CUSTOMER_MESSAGE_SQL = `
  sender <> 'tool_result'
  AND COALESCE(metadata->>'hidden', 'false') <> 'true'
  AND content IS NOT NULL
  AND btrim(content) <> ''
`;

// ...and neither must a message the team deleted from the inbox.
export const VISIBLE_MESSAGE_SQL = `${CUSTOMER_MESSAGE_SQL} AND deleted_at IS NULL`;
