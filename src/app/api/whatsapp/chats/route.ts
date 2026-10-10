import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { isSuperAdmin } from '@/lib/permissions';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

// ── WhatsApp > Chats, brand by brand (owner 2026-10-10: "customer reply kar raha hai to kuch to pata ho, chat ka
// system ho, brand wise") ──
// GET ?panel=<panel id>|all: { panels: [{ id, name, chats, unread, today, waiting }], chats: [the latest 60 WhatsApp chats PER brand (the board shows a column each), the latest WhatsApp
// chats of that brand: who, the last line and who wrote it, unread, status, whether it began with one of the
// automation's messages and how many times the customer wrote] }. Read only; the team answers in Chat Support
// (the chat opens there) and the answer goes out on WhatsApp. Super Admin only, like the rest of the WhatsApp screen.
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || !isSuperAdmin(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const wanted = (request.nextUrl?.searchParams?.get('panel') || 'all').trim();
  const panel = wanted === 'all' || !/^[\w-]{1,64}$/.test(wanted) ? null : wanted;
  try {
    const sums = await query<{ id: string; name: string; chats: number; unread: number; today: number; waiting: number }>(
      `SELECT b.id::text AS id, b.name,
              count(c.id)::int AS chats,
              (count(c.id) FILTER (WHERE c.unread_count > 0))::int AS unread,
              (count(c.id) FILTER (WHERE c.last_message_at > now() - interval '24 hours'))::int AS today,
              (count(c.id) FILTER (WHERE c.status <> 'resolved' AND lm.sender = 'visitor'))::int AS waiting
         FROM businesses b
         LEFT JOIN sites s ON s.tracker_business_id::text = b.id::text
         LEFT JOIN conversations c ON c.site_id = s.id AND c.source = 'whatsapp' AND c.merged_into IS NULL
         LEFT JOIN LATERAL (SELECT m.sender FROM messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL AND m.sender <> 'system' ORDER BY m.created_at DESC LIMIT 1) lm ON true
        GROUP BY b.id, b.name, b.is_default, b.created_at
        ORDER BY b.is_default DESC, b.created_at ASC`
    );
    const rows = await query<{
      id: string; name: string | null; phone: string | null; status: string; unread: number; last_message_at: string | null;
      last_message: string | null; last_sender: string | null; panel_id: string | null; panel: string | null;
      automation: boolean; customer_msgs: number; subject: string | null;
    }>(
      `SELECT * FROM (
       SELECT c.id, c.visitor_name AS name, c.visitor_phone AS phone, c.status, c.unread_count AS unread, c.last_message_at,
              (SELECT m.content FROM messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL AND m.sender <> 'system' ORDER BY m.created_at DESC LIMIT 1) AS last_message,
              (SELECT m.sender FROM messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL AND m.sender <> 'system' ORDER BY m.created_at DESC LIMIT 1) AS last_sender,
              s.tracker_business_id::text AS panel_id, b.name AS panel,
              EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.metadata->>'automation' = 'true') AS automation,
              (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender = 'visitor' AND m.deleted_at IS NULL)::int AS customer_msgs,
              c.subject_summary AS subject,
              row_number() OVER (PARTITION BY s.tracker_business_id ORDER BY c.last_message_at DESC NULLS LAST) AS rn
         FROM conversations c
         JOIN sites s ON s.id = c.site_id
         LEFT JOIN businesses b ON b.id::text = s.tracker_business_id::text
        WHERE c.source = 'whatsapp' AND c.merged_into IS NULL AND ($1::text IS NULL OR s.tracker_business_id::text = $1::text)
       ) x
        WHERE x.rn <= 60
        ORDER BY x.last_message_at DESC NULLS LAST
        LIMIT 300`,
      [panel]
    );
    // What the automation sent per brand (owner: "chat mein dikhe kis customer ko gaya"): the latest 30 per brand,
    // with the customer's name from the order and whether they wrote back since. The table may not be installed.
    let sent: Record<string, unknown>[] = [];
    try {
      const sr = await query<{
        id: string; panel_id: string; order_id: string; kind: string; status: string; to_number: string | null; body_text: string | null;
        template: string | null; error: string | null; sent_at: string | null; at: string; customer_name: string | null; replied: boolean;
      }>(
        `SELECT w.id::text AS id, w.business_id AS panel_id, w.order_id, w.kind, w.status, w.to_number, w.body_text, w.template, w.error,
                w.sent_at, COALESCE(w.sent_at, w.updated_at) AS at, o.customer_name,
                EXISTS (SELECT 1 FROM sites s2
                          JOIN conversations c2 ON c2.site_id = s2.id AND c2.source = 'whatsapp' AND c2.visitor_id = 'wa:' || w.to_number
                          JOIN messages m2 ON m2.conversation_id = c2.id AND m2.sender = 'visitor' AND m2.deleted_at IS NULL AND m2.created_at > w.sent_at
                         WHERE s2.tracker_business_id::text = w.business_id) AS replied
           FROM (SELECT x.*, row_number() OVER (PARTITION BY x.business_id ORDER BY COALESCE(x.sent_at, x.updated_at) DESC) AS rn
                   FROM wa_auto_sends x WHERE x.status IN ('sent', 'delivered', 'read', 'failed')) w
           LEFT JOIN orders o ON o.business_id::text = w.business_id AND o.order_id = w.order_id
          WHERE w.rn <= 30 AND ($1::text IS NULL OR w.business_id = $1::text)
          ORDER BY COALESCE(w.sent_at, w.updated_at) DESC`,
        [panel]
      );
      sent = sr.rows.map((r) => ({
        id: r.id, panelId: r.panel_id, orderId: r.order_id, kind: r.kind, status: r.status, phone: r.to_number ? '+' + r.to_number : null,
        text: (r.body_text || '').slice(0, 1000), template: r.template, error: r.error, at: r.at, name: r.customer_name, replied: !!r.replied,
      }));
    } catch (e) {
      if ((e as { code?: string })?.code !== '42P01') console.error('[whatsapp] chats sent list:', (e as Error).message);
    }
    return NextResponse.json({
      sent,
      panels: sums.rows,
      chats: rows.rows.map((r) => ({
        id: r.id, name: r.name, phone: r.phone, status: r.status, unread: r.unread, at: r.last_message_at,
        last: (r.last_message || '').slice(0, 160), lastSender: r.last_sender, panelId: r.panel_id, panel: r.panel,
        automation: !!r.automation, customerMsgs: r.customer_msgs, subject: r.subject,
      })),
    });
  } catch (e) {
    console.error('[whatsapp] chats:', (e as Error).message);
    return NextResponse.json({ panels: [], chats: [], error: 'Could not read the WhatsApp chats' });
  }
}
