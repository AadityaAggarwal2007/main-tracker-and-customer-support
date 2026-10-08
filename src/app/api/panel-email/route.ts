import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';
import { ensureSiteForPanel, siteForPanel } from '@/lib/chat/site';
import { emailDraftOnly, setEmailDraftOnly } from '@/lib/chat/email-draft-mode';
import { getMailboxStatus } from '@/lib/chat/mailbox-status';
import { checkMailbox, looksLikeEmail, normalizeAppPassword } from '@/lib/chat/mailbox-check';

// ── Email support for a panel ──────────────────────────────────
// The mailboxes live in the chat-support tables in this same database
// (sites -> site_emails). That app's poller already fetches every incoming
// email, answers it with the same AI that runs the chat widget, threads the
// reply and holds anything it is unsure about — so this route owns only the
// setup.
//
// The panel's chat site is created here on demand. Until now a site only
// appeared when a panel connected Shopify, which meant a panel that never
// sells through Shopify had nowhere to attach a mailbox.

const MAX_ACCOUNTS = 10;

// ── GET /api/panel-email?businessId= ───────────────────────────
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const businessId = new URL(request.url).searchParams.get('businessId');
  if (!businessId) {
    return NextResponse.json({ error: 'businessId required' }, { status: 400 });
  }

  const accounts = await query<{ id: string; email: string; created_at: string }>(
    `SELECT se.id, se.email, se.created_at
       FROM site_emails se
       JOIN sites s ON s.id = se.site_id
      WHERE s.tracker_business_id::text = $1::text
      ORDER BY se.created_at ASC`,
    [businessId]
  );

  // "AI writes a draft, the team sends" (owner 2026-10-08): ON unless switched off for this panel.
  const site = await siteForPanel(businessId);
  const draftOnly = site ? await emailDraftOnly(site.id) : true;

  // app_password is never selected — it only ever travels inwards.
  // Step 2 (owner 2026-10-08): per mailbox, when the poller last signed in and whether it worked (memory only).
  return NextResponse.json({
    accounts: accounts.rows.map(a => ({ ...a, status: getMailboxStatus(a.id) })),
    max: MAX_ACCOUNTS,
    draftOnly,
  });
}

// ── PATCH /api/panel-email { businessId, draftOnly } ───────────
// Super Admin only. ON (the default): Chikki writes the reply to an incoming email as a draft and the
// team sends it; OFF: she sends routine answers herself, as before (email-draft.ts).
export async function PATCH(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { businessId, draftOnly } = await request.json();
    if (!businessId || typeof draftOnly !== 'boolean') {
      return NextResponse.json({ error: 'businessId and draftOnly (true or false) are required' }, { status: 400 });
    }
    const biz = await queryOne<{ id: string }>(`SELECT id FROM businesses WHERE id = $1`, [businessId]);
    if (!biz) return NextResponse.json({ error: 'Panel not found' }, { status: 404 });
    const site = await ensureSiteForPanel(businessId);
    await setEmailDraftOnly(site.id, draftOnly);
    return NextResponse.json({ draftOnly });
  } catch (err) {
    console.error('Panel email draft switch error:', err);
    return NextResponse.json({ error: 'Could not save that setting' }, { status: 500 });
  }
}

// ── POST /api/panel-email ──────────────────────────────────────
export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { businessId, email, appPassword } = await request.json();

    if (!businessId || !email || !appPassword) {
      return NextResponse.json({ error: 'businessId, email and appPassword are required' }, { status: 400 });
    }

    const address = String(email).toLowerCase().trim();
    const secret = normalizeAppPassword(String(appPassword));

    if (!looksLikeEmail(address)) {
      return NextResponse.json({ error: 'That does not look like an email address' }, { status: 400 });
    }
    if (secret.length < 16) {
      return NextResponse.json(
        { error: 'A Google App Password is 16 characters. Paste the one Google showed you, spaces and all.' },
        { status: 400 }
      );
    }

    const biz = await queryOne<{ id: string; name: string }>(
      `SELECT id, name FROM businesses WHERE id = $1`,
      [businessId]
    );
    if (!biz) {
      return NextResponse.json({ error: 'Panel not found' }, { status: 404 });
    }

    // One mailbox answers for one panel. Two panels polling the same address
    // would both reply to the customer and split the thread in two.
    const claimed = await queryOne<{ panel: string | null; site_name: string }>(
      `SELECT b.name AS panel, s.name AS site_name
         FROM site_emails se
         JOIN sites s ON s.id = se.site_id
         LEFT JOIN businesses b ON b.id::text = s.tracker_business_id::text
        WHERE se.email = $1`,
      [address]
    );
    if (claimed) {
      return NextResponse.json(
        { error: `${address} is already connected to "${claimed.panel || claimed.site_name}". Remove it there first.` },
        { status: 409 }
      );
    }

    const count = await queryOne<{ n: string }>(
      `SELECT count(*) AS n
         FROM site_emails se
         JOIN sites s ON s.id = se.site_id
        WHERE s.tracker_business_id::text = $1::text`,
      [businessId]
    );
    if (Number(count?.n ?? 0) >= MAX_ACCOUNTS) {
      return NextResponse.json({ error: `A panel can hold ${MAX_ACCOUNTS} mailboxes` }, { status: 400 });
    }

    const check = await checkMailbox(address, secret);
    if ('error' in check) {
      return NextResponse.json({ error: check.error }, { status: 400 });
    }

    const site = await ensureSiteForPanel(businessId, address);

    // last_uid is the mailbox as it stands right now, so answering begins with
    // the next email to arrive rather than the entire history.
    const account = await queryOne<{ id: string; email: string; created_at: string }>(
      `INSERT INTO site_emails (id, site_id, email, app_password, last_uid, created_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, now())
       RETURNING id, email, created_at`,
      [site.id, address, secret, check.lastUid]
    );

    return NextResponse.json({ account });
  } catch (err) {
    console.error('Panel email connect error:', err);
    return NextResponse.json({ error: 'Could not connect that mailbox' }, { status: 500 });
  }
}

// ── DELETE /api/panel-email?businessId=&id= ────────────────────
export async function DELETE(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const businessId = searchParams.get('businessId');
  const id = searchParams.get('id');

  if (!businessId || !id) {
    return NextResponse.json({ error: 'businessId and id required' }, { status: 400 });
  }

  // Scoped through the panel so one panel cannot remove another's mailbox.
  const result = await query(
    `DELETE FROM site_emails se
      USING sites s
      WHERE se.site_id = s.id
        AND se.id = $1
        AND s.tracker_business_id::text = $2::text`,
    [id, businessId]
  );

  if ((result.rowCount ?? 0) === 0) {
    return NextResponse.json({ error: 'Mailbox not found for this panel' }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
