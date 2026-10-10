// ── Every AI model down, a visitor typed their order ID + phone: the code checks it (owner 2026-10-11, "AI band ho tab bhi
// order check: visitor order ID + phone de, to code khud check karke status bata de") ──
// The same check as the widget's "Verify yourself" form (verifyOrderByPhone: order ID + the FULL phone, inside this
// site's panel only) under the SAME guessing limits (lookup-limits.ts: per chat, IP, order and phone, shared counters
// with the form and Chikki's lookup), so a down AI never opens a way to guess orders. A match marks the chat verified
// exactly as Chikki's found lookup does ('chat_phone', customer_key), and the reply is the order's stage line from
// the tracking page (closed-hours.ts statusLine: stage, estimated date unless late, the tracking link; never "today");
// the route then hands the chat to the team (a verified customer whose AI is down goes to a person, master rules 13).
// No match: one plain line (the same whether the order exists or not). Limited or not both typed: null (the route keeps
// ai-down.ts aiDownVisitorReply). Never throws.
import { query } from '@/lib/db';
import { verifyOrderByPhone, customerKeyForOrderSql } from './orders';
import { loadOrderFacts } from './order-facts';
import { statusLine } from './closed-hours';
import { LIMITS, isLimited, release, reserve } from './lookup-limits';
import { aiDownFoundReply, aiDownNoMatchReply, orderAndPhone } from './ai-down';

export interface AiDownCheck { verified: boolean; text: string }

export async function aiDownCheck(x: {
  conversationId: string; siteKey: string; ip: string; businessId: string | null; brand: string; visitorTexts: string[];
}): Promise<AiDownCheck | null> {
  try {
    const got = orderAndPhone(x.visitorTexts);
    if (!got || !x.businessId) return null;
    const keys: [string, { max: number; windowMs: number }][] = [
      [`v:${x.siteKey}:conv:${x.conversationId}`.slice(0, 300), LIMITS.visitor],
      [`ip:${x.ip}`.slice(0, 100), LIMITS.ip],
      [`o:${x.siteKey}:${got.order.toLowerCase().replace(/[#\s]/g, '')}`.slice(0, 200), LIMITS.order],
      [`p:${x.siteKey}:${got.phone}`.slice(0, 200), LIMITS.phone],
    ];
    if (keys.some(([k, l]) => isLimited(k, l.max))) return null;
    for (const [k, l] of keys) reserve(k, l.windowMs);
    const order = await verifyOrderByPhone(got.order, got.phone, x.businessId);
    if (!order) return { verified: false, text: aiDownNoMatchReply(x.brand, x.visitorTexts) };
    for (const [k] of keys) release(k);

    // Proved in this chat: the same columns Chikki's found lookup writes (ai.ts), never over an earlier proof.
    await query(
      `UPDATE conversations
          SET verified_order_id = CASE WHEN verified_order_id IS NULL OR verified_via = 'legacy' THEN $1 ELSE verified_order_id END,
              verified_at = CASE WHEN verified_order_id IS NULL OR verified_via = 'legacy' THEN now() ELSE verified_at END,
              verified_via = CASE WHEN verified_order_id IS NULL OR verified_via = 'legacy' THEN 'chat_phone' ELSE verified_via END,
              customer_key = CASE WHEN (verified_order_id IS NULL OR verified_via = 'legacy') AND source = 'chat'
                                  THEN ${customerKeyForOrderSql('$1', 'conversations.site_id')} ELSE customer_key END
        WHERE id = $2`,
      [order.order_id, x.conversationId]);
    const f = await loadOrderFacts(order.order_id, x.businessId, 'verified').catch(() => null);
    const latest = x.visitorTexts[x.visitorTexts.length - 1] || '';
    const status = f ? statusLine({ order_id: f.order_id, status: f.status, eta: f.eta, late: !!f.late, tracking_link: f.tracking_link }, latest) : null;
    const first = String(order.customer_name || '').replace(/\s*\.\s*$/, '').trim().split(/\s+/)[0] || null;
    console.log(`[widget] AI down: conv ${x.conversationId} verified by the code check`);
    return { verified: true, text: aiDownFoundReply(first, status, x.visitorTexts) };
  } catch (e) {
    console.error('[widget] AI-down order check failed:', (e as Error).message);
    return null;
  }
}
