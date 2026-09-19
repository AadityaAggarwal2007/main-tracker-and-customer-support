import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';
import Imap from 'imap';

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

// Google shows app passwords as "abcd efgh ijkl mnop". The spaces are for
// reading; IMAP and SMTP want the 16 characters.
function normalizeAppPassword(raw: string): string {
  return raw.replace(/\s+/g, '');
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// Sign in once before saving, for two reasons. A wrong app password fails
// silently otherwise — the poller logs an IMAP error every 60s and the
// customer's mail sits unread. And the mailbox's current high-water mark has
// to be recorded: the poller answers everything above last_uid, so starting at
// zero would auto-reply to every email already sitting in the inbox, years-old
// threads included. Whatever is in there now is left alone.
type MailboxCheck = { error: string } | { lastUid: number };

function checkMailbox(user: string, password: string): Promise<MailboxCheck> {
  return new Promise((resolve) => {
    let settled = false;
    const imap = new Imap({
      user,
      password,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 15000,
      authTimeout: 12000,
    });

    const done = (result: MailboxCheck) => {
      if (settled) return;
      settled = true;
      try { imap.end(); } catch { /* already closed */ }
      resolve(result);
    };

    imap.once('ready', () => {
      // Read-only: opening the inbox must not mark anything as seen.
      imap.openBox('INBOX', true, (err: Error | null, box: { uidnext?: number }) => {
        if (err) {
          done({ error: 'Signed in, but could not open the inbox. Check that IMAP is enabled in Gmail.' });
          return;
        }

        // uidnext is the id the next arriving message will get, so everything
        // already in the mailbox sits below it.
        if (typeof box?.uidnext === 'number' && box.uidnext > 0) {
          done({ lastUid: box.uidnext - 1 });
          return;
        }

        // No uidnext — fall back to the highest id actually present. Failing
        // closed here matters: guessing zero would answer the whole mailbox.
        imap.search(['ALL'], (searchErr: Error | null, uids: number[]) => {
          if (searchErr || !Array.isArray(uids)) {
            done({ error: 'Could not read the mailbox state. Try connecting again in a moment.' });
            return;
          }
          done({ lastUid: uids.length ? Math.max(...uids) : 0 });
        });
      });
    });

    imap.once('error', (err: Error & { textCode?: string }) => {
      const text = `${err?.textCode || ''} ${err?.message || ''}`.toLowerCase();
      if (text.includes('invalid credentials') || text.includes('authenticationfailed')) {
        done({ error: 'Gmail rejected that address and app password. Use a 16-character App Password, not the normal account password.' });
      } else if (text.includes('imap access is disabled') || text.includes('not enabled')) {
        done({ error: 'IMAP is switched off for this mailbox. Turn it on in Gmail settings, then try again.' });
      } else if (text.includes('timeout') || text.includes('etimedout')) {
        done({ error: 'Gmail did not answer in time. Try again in a moment.' });
      } else {
        done({ error: err?.message || 'Could not sign in to that mailbox.' });
      }
    });
    imap.once('end', () => done({ error: 'The connection closed before sign-in finished.' }));

    try {
      imap.connect();
    } catch {
      done({ error: 'Could not reach Gmail.' });
    }
  });
}

// The chat site that carries this panel's mailboxes, created if missing.
// tracker_business_id is text on the chat side and uuid on ours, so every
// comparison here is made as text.
async function ensureSiteId(businessId: string, mailboxForDomain: string): Promise<string> {
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM sites WHERE tracker_business_id::text = $1::text`,
    [businessId]
  );
  if (existing) return existing.id;

  const biz = await queryOne<{ name: string; shopify_domain: string | null }>(
    `SELECT name, shopify_domain FROM businesses WHERE id = $1`,
    [businessId]
  );

  // A panel with no Shopify store still needs something readable in the chat
  // dashboard's site list, so fall back to the mailbox's own domain.
  const domain =
    biz?.shopify_domain ||
    mailboxForDomain.split('@')[1] ||
    'email-only';

  // id and widget_key are generated here rather than leaning on the column
  // defaults Prisma happens to have created on the chat-support tables.
  const created = await queryOne<{ id: string }>(
    `INSERT INTO sites (id, name, domain, widget_key, ai_enabled, tracker_business_id, created_at, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, gen_random_uuid()::text, true, $3::text, now(), now())
     ON CONFLICT (tracker_business_id) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [biz?.name || 'Panel', domain, businessId]
  );

  return created!.id;
}

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

  // app_password is never selected — it only ever travels inwards.
  return NextResponse.json({ accounts: accounts.rows, max: MAX_ACCOUNTS });
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

    const siteId = await ensureSiteId(businessId, address);

    // last_uid is the mailbox as it stands right now, so answering begins with
    // the next email to arrive rather than the entire history.
    const account = await queryOne<{ id: string; email: string; created_at: string }>(
      `INSERT INTO site_emails (id, site_id, email, app_password, last_uid, created_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, now())
       RETURNING id, email, created_at`,
      [siteId, address, secret, check.lastUid]
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
