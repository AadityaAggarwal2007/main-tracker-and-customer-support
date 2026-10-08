import { query, queryOne } from '@/lib/db';
import { verifyOrderByPhone } from './orders';
import type { AuthUser } from '@/lib/auth';
import type { MailBoxSecret } from './mail-inbox';

// ── Verifying a Gmail sender (owner 2026-10-08) ───────────────────────────────────────────────
// Same proof as the chat's "Verify yourself" form: the ORDER ID and the customer's FULL phone number must
// both match one order of this panel (verifyOrderByPhone). The team member types what the customer wrote
// back; the sender's address alone never verifies anyone. A success is saved in mail_verifications
// (mail-verify.sql) and the sender's email chats in Chat Support become verified ('mail': a team check, not the
// strict proof the automatic Refund promise needs). Staff only; the phone number is never stored or returned.

export interface SenderVerification { orderId: string; byName: string; at: string; chatId: string | null }

const missingTable = (e: unknown) => (e as { code?: string })?.code === '42P01';
export const lowerEmail = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');
export const looksLikeAddress = (v: string): boolean => /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(v) && v.length <= 254;

// Who did it: the Super Admin is 'owner', a member their team_users id (a rename never changes it).
export const actorKey = (u: Pick<AuthUser, 'role' | 'id' | 'username'>): string => (u.role === 'admin' ? 'owner' : (u.id || u.username));

// Wrong guesses are limited per login (10 in 15 minutes, in memory): the check must not be a way to try
// phone numbers against an order.
const FAILS = new Map<string, { n: number; reset: number }>();
const MAX_FAILS = 10, WINDOW_MS = 15 * 60 * 1000;
function failedTooOften(key: string, now: number): boolean {
  const f = FAILS.get(key);
  return !!f && f.reset > now && f.n >= MAX_FAILS;
}
function noteFail(key: string, now: number): void {
  const f = FAILS.get(key);
  if (!f || f.reset <= now) FAILS.set(key, { n: 1, reset: now + WINDOW_MS });
  else f.n += 1;
}
export function resetVerifyLimits(): void { FAILS.clear(); }

// For a list of sender addresses: who is verified and for which order(s), with the chat to open.
export async function verifiedSenders(businessId: string | null, addresses: string[]): Promise<Record<string, SenderVerification[]>> {
  const out: Record<string, SenderVerification[]> = {};
  const list = Array.from(new Set(addresses.map(lowerEmail).filter(Boolean)));
  if (!businessId || list.length === 0) return out;
  try {
    const r = await query<{ email: string; order_id: string; verified_by_name: string; verified_at: string | Date; chat_id: string | null }>(
      `SELECT v.email, v.order_id, v.verified_by_name, v.verified_at,
              (SELECT c.id FROM conversations c JOIN sites s ON s.id = c.site_id
                WHERE s.tracker_business_id::text = v.business_id AND c.verified_order_id = v.order_id AND c.merged_into IS NULL
                ORDER BY (c.source = 'chat') DESC, c.last_message_at DESC NULLS LAST LIMIT 1) AS chat_id
         FROM mail_verifications v
        WHERE v.business_id = $1 AND v.removed_at IS NULL AND v.email = ANY($2::text[])
        ORDER BY v.verified_at DESC`,
      [businessId, list]
    );
    for (const row of r.rows) {
      (out[row.email] ??= []).push({ orderId: row.order_id, byName: row.verified_by_name, at: new Date(row.verified_at).toISOString(), chatId: row.chat_id });
    }
  } catch (e) {
    if (!missingTable(e)) console.error('[mail] verified senders:', (e as Error).message);
  }
  return out;
}

export type VerifyResult =
  | { ok: true; orderId: string; customerName: string | null; chats: number }
  | { ok: false; status: number; error: string };

export async function verifySender(user: AuthUser, box: MailBoxSecret, emailRaw: unknown, orderRaw: unknown, phoneRaw: unknown, now = Date.now()): Promise<VerifyResult> {
  const email = lowerEmail(emailRaw);
  const orderText = typeof orderRaw === 'string' ? orderRaw.trim() : '';
  const phone = typeof phoneRaw === 'string' ? phoneRaw.trim() : '';
  if (!looksLikeAddress(email)) return { ok: false, status: 400, error: 'That sender has no valid email address.' };
  if (!orderText || orderText.length > 40) return { ok: false, status: 400, error: 'Type the Order ID the customer sent.' };
  if (!/^\+?[\d\s-]{10,16}$/.test(phone)) return { ok: false, status: 400, error: 'Type the full phone number the customer sent (10 digits).' };
  if (!box.panelId) return { ok: false, status: 400, error: 'This mailbox is not linked to a panel, so no order can be checked.' };
  const limitKey = actorKey(user);
  if (failedTooOften(limitKey, now)) return { ok: false, status: 429, error: 'Too many wrong tries. Wait a few minutes and try again.' };

  const order = await verifyOrderByPhone(orderText, phone, box.panelId);
  if (!order) {
    noteFail(limitKey, now);
    return { ok: false, status: 422, error: 'Order ID and phone number do not match any order of this panel. Check what the customer wrote.' };
  }
  try {
    await query(
      `INSERT INTO mail_verifications (business_id, email, order_id, verified_by, verified_by_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (business_id, email, order_id)
       DO UPDATE SET removed_at = NULL, removed_by = NULL, verified_by = EXCLUDED.verified_by,
                     verified_by_name = EXCLUDED.verified_by_name, verified_at = now()`,
      [box.panelId, email, order.order_id, actorKey(user), user.displayName || user.username]
    );
  } catch (e) {
    if (missingTable(e)) return { ok: false, status: 503, error: 'Mail verification is not installed yet (mail-verify.sql).' };
    throw e;
  }
  // The sender's email chats in Chat Support become verified for this order (only those not verified already).
  const moved = await query(
    `UPDATE conversations c SET verified_order_id = $1, verified_at = now(), verified_via = 'mail'
       FROM sites s
      WHERE s.id = c.site_id AND s.tracker_business_id::text = $2::text
        AND c.source = 'email' AND c.visitor_id = $3 AND c.merged_into IS NULL AND c.verified_order_id IS NULL`,
    [order.order_id, box.panelId, `email:${email}`]
  );
  return { ok: true, orderId: order.order_id, customerName: order.customer_name, chats: moved.rowCount ?? 0 };
}

// "Remove": a wrong click. The row stays as a record; the email chats it verified go back to unverified.
export async function removeVerification(user: AuthUser, box: MailBoxSecret, emailRaw: unknown, orderRaw: unknown): Promise<{ ok: boolean; status?: number; error?: string }> {
  const email = lowerEmail(emailRaw);
  const orderId = typeof orderRaw === 'string' ? orderRaw.trim() : '';
  if (!looksLikeAddress(email) || !orderId || !box.panelId) return { ok: false, status: 400, error: 'email and orderId are required' };
  try {
    const r = await query(
      `UPDATE mail_verifications SET removed_at = now(), removed_by = $4
        WHERE business_id = $1 AND email = $2 AND order_id = $3 AND removed_at IS NULL`,
      [box.panelId, email, orderId, actorKey(user)]
    );
    if ((r.rowCount ?? 0) === 0) return { ok: false, status: 404, error: 'That verification is not there any more.' };
  } catch (e) {
    if (missingTable(e)) return { ok: false, status: 503, error: 'Mail verification is not installed yet (mail-verify.sql).' };
    throw e;
  }
  await query(
    `UPDATE conversations c SET verified_order_id = NULL, verified_at = NULL, verified_via = NULL
       FROM sites s
      WHERE s.id = c.site_id AND s.tracker_business_id::text = $1::text
        AND c.source = 'email' AND c.visitor_id = $2 AND c.verified_via IN ('mail', 'mail_auto') AND c.verified_order_id = $3`,
    [box.panelId, `email:${email}`, orderId]
  );
  return { ok: true };
}

// The chat thread's side: the verified order of a chat and the sender addresses verified for that order.
export async function verifiedEmailsForChat(conversationId: string): Promise<{ siteId: string; businessId: string | null; orderId: string | null; emails: string[] } | null> {
  const c = await queryOne<{ site_id: string; business_id: string | null; verified_order_id: string | null; verified_via: string | null }>(
    `SELECT c.site_id, s.tracker_business_id::text AS business_id, c.verified_order_id, c.verified_via
       FROM conversations c JOIN sites s ON s.id = c.site_id WHERE c.id = $1`,
    [conversationId]
  );
  if (!c) return null;
  const out = { siteId: c.site_id, businessId: c.business_id, orderId: c.verified_order_id, emails: [] as string[] };
  if (!c.verified_order_id || !c.business_id || c.verified_via === 'legacy') return { ...out, orderId: null };
  try {
    const r = await query<{ email: string }>(
      `SELECT email FROM mail_verifications WHERE business_id = $1 AND order_id = $2 AND removed_at IS NULL ORDER BY verified_at DESC`,
      [c.business_id, c.verified_order_id]
    );
    out.emails = r.rows.map(x => x.email);
  } catch (e) {
    if (!missingTable(e)) console.error('[mail] verified emails for chat:', (e as Error).message);
  }
  return out;
}
