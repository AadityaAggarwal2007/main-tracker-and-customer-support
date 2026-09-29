import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { normalizePhone, verifyOrderByPhone } from '@/lib/chat/orders';
import { clientIp, getOrCreateVisitorConversation, siteByKey, widgetJson, widgetPreflight } from '@/lib/chat/widget-api';

export const dynamic = 'force-dynamic';

export async function OPTIONS() { return widgetPreflight(); }

// ── Guessing limits ────────────────────────────────────────────
// Order IDs are sequential and site keys sit in every storefront's page
// source, so the only thing between a caller and a stranger's order is the
// full phone number. Failed attempts are counted in memory: ShipTrack runs as
// a single PM2 process, and a counter that resets on deploy is still far
// better than none (same reasoning as /api/widget/resume).
// visitorId is made up by the caller, so the visitor limit alone stops only
// honest mistakes. The IP limit uses nginx's X-Real-IP (see clientIp), and the
// order and phone limits cap guessing at one target however the caller
// rotates the rest: the 6 missing phone digits of one order, or the order
// numbers of one known phone.
const LIMITS = {
  visitor: { max: 5, windowMs: 15 * 60 * 1000 },
  ip: { max: 20, windowMs: 60 * 60 * 1000 },
  order: { max: 10, windowMs: 24 * 60 * 60 * 1000 },
  phone: { max: 10, windowMs: 24 * 60 * 60 * 1000 },
};
const MAX_ENTRIES = 10000;
const failures = new Map<string, { count: number; resetAt: number }>();

function prune(now: number) {
  for (const [k, v] of failures) if (now > v.resetAt) failures.delete(k);
  // Still too many live entries: drop the oldest (a Map keeps insertion order).
  for (const k of failures.keys()) {
    if (failures.size <= MAX_ENTRIES) break;
    failures.delete(k);
  }
}

function isLimited(key: string, max: number): boolean {
  const entry = failures.get(key);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    failures.delete(key);
    return false;
  }
  return entry.count >= max;
}

// Counted before the database is asked, so parallel requests cannot all slip
// past the check while the first ones are still in flight. A match gives the
// attempt back (release).
function reserve(key: string, windowMs: number) {
  const now = Date.now();
  const entry = failures.get(key);
  if (!entry || now > entry.resetAt) {
    failures.set(key, { count: 1, resetAt: now + windowMs });
    if (failures.size > MAX_ENTRIES / 2) prune(now);
    return;
  }
  entry.count += 1;
}

function release(key: string) {
  const entry = failures.get(key);
  if (!entry) return;
  entry.count -= 1;
  if (entry.count <= 0) failures.delete(key);
}

// POST /api/widget/verify — the widget's "Verify yourself and continue a chat"
// form. Order ID (or ST… tracking ID) + the customer's full phone number. On a
// match the visitor's chat is marked as verified for that order, so the AI
// never asks them for the order ID or phone digits, and staff see the chat
// under Customers. Nothing about the order is returned except its ID and the
// customer's first name, and the phone number is never sent to the AI.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const siteKey = typeof body?.siteKey === 'string' ? body.siteKey.trim() : '';
    const visitorId = typeof body?.visitorId === 'string' ? body.visitorId.trim() : '';
    const orderId = typeof body?.orderId === 'string' ? body.orderId.trim() : '';
    const phone = typeof body?.phone === 'string' || typeof body?.phone === 'number' ? String(body.phone).trim() : '';
    if (!siteKey || !visitorId || !orderId || !phone) {
      return widgetJson({ error: 'siteKey, visitorId, orderId, phone required' }, 400);
    }

    const site = await siteByKey(siteKey);
    if (!site) return widgetJson({ error: 'Invalid site key' }, 404);

    const keys: [string, { max: number; windowMs: number }][] = [
      [`v:${siteKey}:${visitorId}`.slice(0, 300), LIMITS.visitor],
      [`ip:${clientIp(request)}`.slice(0, 100), LIMITS.ip],
      [`o:${siteKey}:${orderId.toLowerCase().replace(/[#\s]/g, '')}`.slice(0, 200), LIMITS.order],
      [`p:${siteKey}:${normalizePhone(phone) || ''}`.slice(0, 200), LIMITS.phone],
    ];
    if (keys.some(([key, l]) => isLimited(key, l.max))) {
      return widgetJson({ verified: false, error: 'too_many_attempts' }, 429);
    }
    for (const [key, l] of keys) reserve(key, l.windowMs);

    // The same answer whether the order ID exists or not, so the form cannot
    // be used to find out which order numbers are real. A site with no panel
    // linked has no orders of its own, so nothing verifies there.
    const order = orderId.length <= 64
      ? await verifyOrderByPhone(orderId, phone, site.tracker_business_id)
      : null;
    if (!order) return widgetJson({ verified: false, error: 'not_found' });
    for (const [key] of keys) release(key);

    const conversation = await getOrCreateVisitorConversation(site.id, visitorId);

    // The real order holder's name, cleaned the way ai.ts does after a lookup.
    const realName = String(order.customer_name || '').replace(/\s*\.\s*$/, '').trim();
    await query(
      `UPDATE conversations
          SET verified_order_id = $1,
              verified_at = now(),
              verified_via = 'form',
              visitor_name = COALESCE($2, visitor_name),
              visitor_phone = $3,
              updated_at = now()
        WHERE id = $4`,
      [order.order_id, realName || null, normalizePhone(phone), conversation.id]
    );
    console.log(`[widget] verified conv ${conversation.id} via form`);

    return widgetJson({
      verified: true,
      conversationId: conversation.id,
      status: conversation.status,
      siteName: site.name,
      orderId: order.order_id,
      firstName: realName ? realName.split(/\s+/)[0] : null,
    });
  } catch (err) {
    console.error('[widget] verify error:', err);
    return widgetJson({ error: 'Could not verify right now' }, 500);
  }
}
