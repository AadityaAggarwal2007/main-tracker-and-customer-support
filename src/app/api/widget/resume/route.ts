import { NextRequest } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { normalizePhone } from '@/lib/chat/orders';
import { VISIBLE_MESSAGE_SQL, clientIp, siteByKey, widgetJson, widgetPreflight } from '@/lib/chat/widget-api';

export const dynamic = 'force-dynamic';

export async function OPTIONS() { return widgetPreflight(); }

// A phone number is the only thing standing between a caller and somebody
// else's transcript here, and site keys are printed in every storefront's page
// source. Without a verification code — which needs an SMS provider this
// project does not have — the best available defence is to make guessing
// numbers slow enough to be useless. Counted per site key and caller IP, in
// memory: ShipTrack runs as a single process, and a counter that resets on
// deploy is still far better than none.
const ATTEMPT_LIMIT = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; resetAt: number }>();

function tooManyAttempts(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    // Keep the map from growing without bound on a long-lived process.
    if (attempts.size > 5000) {
      for (const [k, v] of attempts) if (now > v.resetAt) attempts.delete(k);
    }
    return false;
  }

  entry.count += 1;
  return entry.count > ATTEMPT_LIMIT;
}

// POST /api/widget/resume — pick up a conversation on another device
export async function POST(request: NextRequest) {
  try {
    const { siteKey, phone, visitorId } = await request.json();
    if (!siteKey || !phone) return widgetJson({ error: 'siteKey and phone required' }, 400);

    const site = await siteByKey(siteKey);
    if (!site) return widgetJson({ error: 'Invalid site key' }, 404);

    const caller = clientIp(request);
    if (tooManyAttempts(`${siteKey}:${caller}`)) {
      return widgetJson({ error: 'Too many attempts. Please try again later.' }, 429);
    }

    // Partial numbers are not accepted — the stored value must match in full.
    const normalized = normalizePhone(phone);
    if (!normalized || normalized.length < 10) {
      return widgetJson({ found: false });
    }

    const conversation = await queryOne<{ id: string; status: string }>(
      `SELECT id, status FROM conversations
        WHERE site_id = $1
          AND regexp_replace(COALESCE(visitor_phone, ''), '\\D', '', 'g') LIKE '%' || $2
        ORDER BY last_message_at DESC NULLS LAST
        LIMIT 1`,
      [site.id, normalized]
    );

    if (!conversation) return widgetJson({ found: false });

    // A phone number alone is not the order ID + last 4 the AI needs before it
    // talks about an order. A chat verified on one device therefore stops
    // being verified when it is picked up on another, so ai.ts no longer
    // re-serves that order there; a fresh lookup in the chat verifies it
    // again. The same browser (same visitorId) keeps its verification. Older
    // widgets send no visitorId and are treated as another device.
    // customer_key goes with it (chat-customer-key.sql): an unverified device
    // must not sit in the verified customer's inbox thread, where staff would
    // take it for the customer. A fresh lookup keys it again.
    try {
      const cleared = await query(
        `UPDATE conversations
            SET verified_order_id = NULL, verified_at = NULL, verified_via = NULL,
                customer_key = NULL
          WHERE id = $1
            AND verified_order_id IS NOT NULL
            AND visitor_id IS DISTINCT FROM $2`,
        [conversation.id, typeof visitorId === 'string' && visitorId ? visitorId : null]
      );
      if (cleared.rowCount) console.log(`[widget] resumed conv ${conversation.id} on another device, verification cleared`);
    } catch (err) {
      // Before chat-verified.sql is applied the columns do not exist yet.
      console.error('[widget] resume verification reset failed:', (err as Error)?.message);
    }

    const messages = await query(
      `SELECT id, conversation_id, sender, content, metadata, created_at
         FROM messages
        WHERE conversation_id = $1
          AND ${VISIBLE_MESSAGE_SQL}
        ORDER BY created_at ASC`,
      [conversation.id]
    );

    return widgetJson({
      found: true,
      conversationId: conversation.id,
      status: conversation.status,
      messages: messages.rows,
      siteName: site.name,
    });
  } catch (err) {
    console.error('[widget] resume error:', err);
    return widgetJson({ error: 'Could not resume that conversation' }, 500);
  }
}
