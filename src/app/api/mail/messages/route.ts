import { NextRequest, NextResponse } from 'next/server';
import { mailAccess, mailFail } from '@/lib/chat/mail-access';
import { listMails } from '@/lib/chat/mail-inbox';
import { listCached } from '@/lib/chat/mail-cache';
import { verifiedSenders } from '@/lib/chat/mail-verify';
import { can } from '@/lib/permissions';

// GET /api/mail/messages?box=<mailbox id>: the last 30 days of that Gmail inbox, unread first. Since 2026-10-09 the
// full list comes from the server's copy (mail-cache.ts: kept in memory, refreshed by the poller every few minutes and
// behind the screen when older than 45 s), so it opens at once on every panel; `cached` / `at` say so. `verified`
// says which senders are verified for an order (mail-verify.ts), with the customer's chat to open (only for a login
// that may open Chat Support).
export async function GET(request: NextRequest) {
  const a = await mailAccess(request, new URL(request.url).searchParams.get('box'), 'view');
  if ('error' in a) return a.error;
  try {
    // phase=fast: only who / subject / date / flags, so the list can show at once (mail-inbox.ts listMails); the sender
    // checks (automatic verification) need the full list and are skipped. The verified marks already saved still show.
    const phase = new URL(request.url).searchParams.get('phase') === 'fast' ? 'fast' as const : 'full' as const;
    const t0 = Date.now();
    // The quick first list is only for a mailbox the server has no copy of yet; the full list runs the automatic
    // verification (mail-auto-verify.ts) inside refreshList, once per read, not once per screen.
    const r = phase === 'fast'
      ? { ...await listMails(a.box, Date.now(), { phase }), cached: false, at: Date.now() }
      : { ...await listCached(a.box), phase };
    const gmailMs = Date.now() - t0;
    const verified = await verifiedSenders(a.box.panelId, r.mails.map(m => m.fromAddress));
    if (!can(a.user, 'chat.view')) for (const list of Object.values(verified)) for (const v of list) v.chatId = null;
    const total = Date.now() - t0;
    if (total > 2000) console.log(`[mail-timing] route ${phase} gmail=${gmailMs}ms database=${total - gmailMs}ms total=${total}ms`);
    return NextResponse.json({ ...r, mailbox: a.box.email, verified }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return mailFail(e); }
}
