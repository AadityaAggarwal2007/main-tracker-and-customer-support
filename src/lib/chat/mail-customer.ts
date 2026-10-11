// ── The customer next to the mail (owner 2026-10-11, "customer ki details mail ke saath dikhein") ──
// What the Mail tab's "Customer" card shows for the open mail's sender: for every order the sender is VERIFIED for
// (mail-verify.ts, the same proof the chat uses) the order as the inbox thread header shows it (order-facts.ts: the
// tracking page's stage, placed / estimated dates, the tracking link; order-items-db.ts: the lines; order-address-db.ts:
// city / state / pincode only, never the street) plus the customer's name, how it was paid and the total, and the chat
// to open. A sender NOT verified only gets hints: up to 5 orders of this panel placed with that email address (order
// id, placed date, stage), so the team knows what to verify; nothing else, because the address alone is no proof.
// Staff only, read only, inside the mailbox's own panel; the route checks orders.view for the order data.
import { query } from '@/lib/db';
import { loadOrderFacts, type OrderFacts } from './order-facts';
import { loadOrderItems } from './order-items-db';
import { loadOrderAddress } from './order-address-db';
import { verifiedSenders, lowerEmail } from './mail-verify';

export interface MailCustomerOrder {
  orderId: string; chatId: string | null; byName: string;
  customerName: string | null; payment: 'cod' | 'prepaid' | null; total: number | null;
  facts: OrderFacts | null;
  items: { product_name: string; quantity: number; price: number | null }[];
  place: { city: string; state: string; pincode: string } | null;
}
export interface MailCustomerHint { orderId: string; placedOn: string | null; status: string | null }
export interface MailCustomer {
  email: string;
  ordersAllowed: boolean;       // false = the login has no orders.view: only the verified order ids and the chat
  verified: MailCustomerOrder[];
  hints: MailCustomerHint[];    // only when not verified
}

export const isCod = (method: string | null | undefined): boolean => /^cod$|cash on delivery/i.test(String(method || '').trim());
const MAX_VERIFIED = 3, MAX_HINTS = 5;

export async function loadMailCustomer(panelId: string | null, emailRaw: string, allow: { orders: boolean; chat: boolean }): Promise<MailCustomer> {
  const email = lowerEmail(emailRaw);
  const out: MailCustomer = { email, ordersAllowed: allow.orders, verified: [], hints: [] };
  if (!panelId || !email) return out;
  const vers = (await verifiedSenders(panelId, [email]))[email] || [];
  for (const v of vers.slice(0, MAX_VERIFIED)) {
    const o: MailCustomerOrder = { orderId: v.orderId, chatId: allow.chat ? v.chatId : null, byName: v.byName, customerName: null, payment: null, total: null, facts: null, items: [], place: null };
    if (allow.orders) {
      const [facts, items, addr, head] = await Promise.all([
        loadOrderFacts(v.orderId, panelId, 'verified'),
        loadOrderItems(v.orderId, panelId),
        loadOrderAddress(v.orderId, panelId),
        query<{ customer_name: string | null; payment_method: string | null; order_total: unknown }>(
          `SELECT customer_name, payment_method, order_total FROM orders WHERE order_id = $1 AND business_id::text = $2::text LIMIT 2`, [v.orderId, panelId])
          .then(r => (r.rows.length === 1 ? r.rows[0] : null)).catch(() => null),
      ]);
      o.facts = facts;
      o.items = (items?.items || []).map(i => ({ product_name: i.product_name, quantity: i.quantity, price: i.price }));
      o.place = addr ? { city: addr.city, state: addr.state, pincode: addr.pincode } : null;
      if (head) {
        o.customerName = (head.customer_name || '').trim() || null;
        o.payment = head.payment_method == null ? null : (isCod(head.payment_method) ? 'cod' : 'prepaid');
        const t = Number(head.order_total);
        o.total = Number.isFinite(t) ? t : null;
      }
    }
    out.verified.push(o);
  }
  if (!out.verified.length && allow.orders) {
    try {
      const r = await query<{ order_id: string }>(
        `SELECT order_id FROM orders WHERE lower(COALESCE(customer_email, '')) = $1 AND business_id::text = $2::text ORDER BY created_at DESC LIMIT ${MAX_HINTS}`, [email, panelId]);
      for (const row of r.rows) {
        const f = await loadOrderFacts(row.order_id, panelId, 'phone_match');
        out.hints.push({ orderId: row.order_id, placedOn: f?.placed_on ?? null, status: f?.status ?? null });
      }
    } catch (e) { console.error('[mail] customer hints:', (e as Error).message); }
  }
  return out;
}
