import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne, withTransaction } from '@/lib/db';

// ── GET all businesses ─────────────────────────────────────────
// With ?impactId=<uuid>: returns what deleting that panel would destroy,
// so the admin sees real numbers before confirming.
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const impactId = new URL(request.url).searchParams.get('impactId');
  if (impactId) {
    if (user.role !== 'admin') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const biz = await queryOne<{ id: string; name: string; is_default: boolean; is_shopify_connected: boolean; shopify_domain: string | null }>(
      `SELECT id, name, is_default, is_shopify_connected, shopify_domain FROM businesses WHERE id = $1`,
      [impactId]
    );
    if (!biz) {
      return NextResponse.json({ error: 'Panel not found' }, { status: 404 });
    }

    // Chat support lives in this same database (sites.tracker_business_id -> businesses.id),
    // so its rows are counted here too.
    //
    // Every id is compared as text on both sides. The two apps disagree about
    // types for the same id: businesses.id is uuid, while the chat tables come
    // from Prisma `String` columns and are text. Comparing a text column to a
    // uuid parameter is a hard error in Postgres (operator does not exist:
    // text = uuid), so nothing here assumes which one a column is.
    const counts = await queryOne<Record<string, string>>(
      `SELECT
         (SELECT count(*) FROM orders          WHERE business_id::text = $1::text) AS orders,
         (SELECT count(*) FROM support_tickets WHERE business_id::text = $1::text) AS tickets,
         (SELECT count(*) FROM sites           WHERE tracker_business_id::text = $1::text) AS chat_sites,
         (SELECT count(*) FROM conversations c
            JOIN sites s ON s.id = c.site_id
           WHERE s.tracker_business_id::text = $1::text) AS chat_conversations,
         (SELECT count(*) FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            JOIN sites s ON s.id = c.site_id
           WHERE s.tracker_business_id::text = $1::text) AS chat_messages,
         (SELECT count(*) FROM team_users
           WHERE business_ids::text[] @> ARRAY[$1]::text[]) AS team_members,
         (SELECT count(*) FROM team_users
           WHERE business_ids::text[] @> ARRAY[$1]::text[] AND cardinality(business_ids) = 1) AS team_members_losing_access`,
      [impactId]
    );

    return NextResponse.json({
      impact: {
        id: biz.id,
        name: biz.name,
        isDefault: biz.is_default,
        isShopifyConnected: biz.is_shopify_connected,
        shopifyDomain: biz.shopify_domain,
        orders: Number(counts?.orders ?? 0),
        tickets: Number(counts?.tickets ?? 0),
        chatSites: Number(counts?.chat_sites ?? 0),
        chatConversations: Number(counts?.chat_conversations ?? 0),
        chatMessages: Number(counts?.chat_messages ?? 0),
        teamMembers: Number(counts?.team_members ?? 0),
        teamMembersLosingAccess: Number(counts?.team_members_losing_access ?? 0),
      },
    });
  }

  const result = await query(
    `SELECT * FROM businesses ORDER BY created_at ASC`
  );

  return NextResponse.json({ businesses: result.rows });
}

// ── POST create business ───────────────────────────────────────
export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { name, logoUrl, supportEmail, supportPhone, isDefault, trackingDomain, primaryColor } = await request.json();

    if (!name) {
      return NextResponse.json({ error: 'Business name is required' }, { status: 400 });
    }

    // If setting as default, unset other defaults
    if (isDefault) {
      await query(`UPDATE businesses SET is_default = false WHERE is_default = true`);
    }

    const data = await queryOne(
      `INSERT INTO businesses (name, logo_url, support_email, support_phone, is_default, tracking_domain, primary_color)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [name, logoUrl || null, supportEmail || null, supportPhone || null, isDefault || false,
       trackingDomain || null, primaryColor || '#4F46E5']
    );

    return NextResponse.json({ business: data });
  } catch {
    return NextResponse.json({ error: 'Failed to create business' }, { status: 500 });
  }
}

// ── PATCH update business ──────────────────────────────────────
export async function PATCH(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { id, name, logoUrl, supportEmail, supportPhone, isDefault, trackingDomain, primaryColor } = await request.json();

    if (!id) {
      return NextResponse.json({ error: 'Business ID required' }, { status: 400 });
    }

    // If setting as default, unset other defaults
    if (isDefault) {
      await query(`UPDATE businesses SET is_default = false WHERE is_default = true AND id != $1`, [id]);
    }

    // Build SET clause dynamically (only update provided fields)
    const sets: string[] = [];
    const params: unknown[] = [];
    let pi = 1;

    if (name !== undefined)           { sets.push(`name = $${pi++}`);            params.push(name); }
    if (logoUrl !== undefined && logoUrl !== null && logoUrl !== '')
                                      { sets.push(`logo_url = $${pi++}`);        params.push(logoUrl); }
    if (supportEmail !== undefined)   { sets.push(`support_email = $${pi++}`);   params.push(supportEmail); }
    if (supportPhone !== undefined)   { sets.push(`support_phone = $${pi++}`);   params.push(supportPhone); }
    if (isDefault !== undefined)      { sets.push(`is_default = $${pi++}`);      params.push(isDefault); }
    if (trackingDomain !== undefined) { sets.push(`tracking_domain = $${pi++}`); params.push(trackingDomain || null); }
    if (primaryColor !== undefined)   { sets.push(`primary_color = $${pi++}`);   params.push(primaryColor); }

    if (sets.length === 0) {
      return NextResponse.json({ success: true });
    }

    params.push(id);
    await query(`UPDATE businesses SET ${sets.join(', ')} WHERE id = $${pi}`, params);

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Update failed' }, { status: 500 });
  }
}

// ── DELETE business ────────────────────────────────────────────
// Permanently removes a panel and everything attached to it, in both apps:
// the Tracker rows (orders and their children, tickets, support settings,
// webhook logs) and the chat-support site that shares this database.
// Requires ?confirmName= to match the panel name exactly.
export async function DELETE(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const confirmName = searchParams.get('confirmName');

  if (!id) {
    return NextResponse.json({ error: 'Business ID required' }, { status: 400 });
  }

  const biz = await queryOne<{
    id: string; name: string; is_default: boolean;
    shopify_domain: string | null; shopify_api_token: string | null; shopify_webhook_id: string | null;
  }>(
    `SELECT id, name, is_default, shopify_domain, shopify_api_token, shopify_webhook_id
       FROM businesses WHERE id = $1`,
    [id]
  );

  if (!biz) {
    return NextResponse.json({ error: 'Panel not found' }, { status: 404 });
  }

  // Typed-name confirmation: this deletion cannot be undone, so a stray or
  // mistaken request must not be enough to wipe a panel.
  if ((confirmName ?? '').trim() !== biz.name.trim()) {
    return NextResponse.json(
      { error: 'Panel name confirmation does not match' },
      { status: 400 }
    );
  }

  // Unregister the Shopify webhook first — the credentials it needs live on the
  // row we are about to delete. Best-effort: a dead store must not block the delete.
  let shopifyWebhookRemoved = false;
  if (biz.shopify_webhook_id && biz.shopify_domain && biz.shopify_api_token) {
    try {
      const res = await fetch(
        `https://${biz.shopify_domain}/admin/api/2024-01/webhooks/${biz.shopify_webhook_id}.json`,
        { method: 'DELETE', headers: { 'X-Shopify-Access-Token': biz.shopify_api_token } }
      );
      shopifyWebhookRemoved = res.ok;
    } catch {
      shopifyWebhookRemoved = false;
    }
  }

  try {
    const deleted = await withTransaction(async (client) => {
      // Production has no FK from orders to businesses, and none from
      // order_items / tracking_history / draft_queue / email_logs / email_queue
      // to orders — nothing cascades, so every child row is removed explicitly.
      const orderIds = (
        await client.query<{ order_id: string }>(
          `SELECT order_id FROM orders WHERE business_id = $1`,
          [id]
        )
      ).rows.map((r) => r.order_id);

      let orderItems = 0, history = 0, drafts = 0, emailLogs = 0, emailQueue = 0;
      if (orderIds.length > 0) {
        orderItems = (await client.query(`DELETE FROM order_items      WHERE order_id = ANY($1::text[])`, [orderIds])).rowCount ?? 0;
        history    = (await client.query(`DELETE FROM tracking_history WHERE order_id = ANY($1::text[])`, [orderIds])).rowCount ?? 0;
        drafts     = (await client.query(`DELETE FROM draft_queue      WHERE order_id = ANY($1::text[])`, [orderIds])).rowCount ?? 0;
        emailLogs  = (await client.query(`DELETE FROM email_logs       WHERE order_id = ANY($1::text[])`, [orderIds])).rowCount ?? 0;
        emailQueue = (await client.query(`DELETE FROM email_queue      WHERE order_id = ANY($1::text[])`, [orderIds])).rowCount ?? 0;
      }

      // Tickets raised against this panel, plus any ticket still pointing at one
      // of its orders. ticket_messages cascade from support_tickets.
      const tickets = (
        await client.query(
          `DELETE FROM support_tickets WHERE business_id = $1 OR order_id = ANY($2::text[])`,
          [id, orderIds]
        )
      ).rowCount ?? 0;

      const orders = (await client.query(`DELETE FROM orders WHERE business_id = $1`, [id])).rowCount ?? 0;

      await client.query(`DELETE FROM shopify_webhook_logs WHERE business_id = $1`, [id]);
      await client.query(`DELETE FROM support_settings     WHERE business_id = $1`, [id]);

      // ── Chat support ────────────────────────────────────────────
      // Same database, but sites.tracker_business_id is a plain column with no
      // FK, so the linked site would otherwise be left behind in the chat
      // dashboard. Deleting the site cascades to conversations, messages,
      // site_emails and webhook_endpoints.
      const chatCounts = await client.query<{ conversations: string; messages: string }>(
        `SELECT
           (SELECT count(*) FROM conversations c
              JOIN sites s ON s.id = c.site_id
             WHERE s.tracker_business_id::text = $1::text) AS conversations,
           (SELECT count(*) FROM messages m
              JOIN conversations c ON c.id = m.conversation_id
              JOIN sites s ON s.id = c.site_id
             WHERE s.tracker_business_id::text = $1::text) AS messages`,
        [id]
      );
      const chatSites = (await client.query(`DELETE FROM sites WHERE tracker_business_id::text = $1::text`, [id])).rowCount ?? 0;

      // ── Team access ─────────────────────────────────────────────
      // An empty business_ids array is read as "all panels" at login, so a
      // member whose only panel was this one is deactivated rather than
      // silently promoted to every panel.
      const stripped = await client.query<{ id: string; username: string; business_ids: string[] | null }>(
        // array_remove() is polymorphic and the driver types $1 as text, so it
        // would need a cast matching the column's element type. Unnesting and
        // comparing as text avoids that guess; business_ids[1:0] is an empty
        // array of whatever type the column is, and is used because array_agg
        // over no rows returns NULL — which login reads as "all panels".
        `UPDATE team_users
            SET business_ids = COALESCE(
                  (SELECT array_agg(v ORDER BY ord)
                     FROM unnest(business_ids) WITH ORDINALITY AS u(v, ord)
                    WHERE v::text <> $1::text),
                  business_ids[1:0]
                )
          WHERE business_ids::text[] @> ARRAY[$1]::text[]
        RETURNING id, username, business_ids`,
        [id]
      );
      const strandedIds = stripped.rows.filter((r) => !r.business_ids || r.business_ids.length === 0).map((r) => r.id);
      let deactivatedUsers: string[] = [];
      if (strandedIds.length > 0) {
        const deact = await client.query<{ username: string }>(
          `UPDATE team_users SET is_active = false WHERE id::text = ANY($1::text[]) RETURNING username`,
          [strandedIds]
        );
        deactivatedUsers = deact.rows.map((r) => r.username);
      }

      await client.query(`DELETE FROM businesses WHERE id = $1`, [id]);

      // Tracking pages and emails fall back to the default panel, so never
      // leave the install without one.
      let newDefault: string | null = null;
      if (biz.is_default) {
        const promoted = await client.query<{ id: string; name: string }>(
          `UPDATE businesses SET is_default = true
            WHERE id = (SELECT id FROM businesses ORDER BY created_at ASC LIMIT 1)
              AND NOT EXISTS (SELECT 1 FROM businesses WHERE is_default = true)
          RETURNING id, name`
        );
        newDefault = promoted.rows[0]?.name ?? null;
      }

      return {
        orders, orderItems, history, drafts, emailLogs, emailQueue, tickets,
        chatSites,
        chatConversations: Number(chatCounts.rows[0]?.conversations ?? 0),
        chatMessages: Number(chatCounts.rows[0]?.messages ?? 0),
        teamMembersUpdated: stripped.rowCount ?? 0,
        deactivatedUsers,
        newDefault,
      };
    });

    return NextResponse.json({
      success: true,
      panel: biz.name,
      shopifyWebhookRemoved,
      deleted,
    });
  } catch (err) {
    console.error('Panel delete error:', err);
    return NextResponse.json({ error: 'Failed to delete panel — nothing was removed' }, { status: 500 });
  }
}
