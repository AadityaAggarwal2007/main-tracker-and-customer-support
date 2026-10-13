import { NextRequest, NextResponse } from 'next/server';
import { mailAccess, mailFail } from '@/lib/chat/mail-access';
import { listMails } from '@/lib/chat/mail-inbox';
import { cachedList, listCached } from '@/lib/chat/mail-cache';
import { verifiedSenders } from '@/lib/chat/mail-verify';
import { storeList, storeReady, storeStatus } from '@/lib/chat/mail-store';
import { loadMailCases } from '@/lib/chat/mail-cases';
import { can } from '@/lib/permissions';
import { hiddenForPanel } from '@/lib/chat/mail-cb-box';

// GET /api/mail/messages?box=<mailbox id>: the last 30 days of that Gmail inbox, unread first. Since 2026-10-09 the
// full list comes from the server's copy (mail-cache.ts: kept in memory, refreshed by the poller every few minutes and
// behind the screen when older than 45 s), so it opens at once on every panel; `cached` / `at` say so. `verified`
// says which senders are verified for an order (mail-verify.ts), with the customer's chat to open (only for a login
// that may open Chat Support).
export async function GET(request: NextRequest) {
  const a = await mailAccess(request, new URL(request.url).searchParams.get('box'), 'view');
  if ('error' in a) return a.error;
  try {
    // The mail store (owner 2026-10-11, mail-store.sql + mail-sync.ts): once this mailbox's copy exists the list comes
    // from the database, never from Gmail, for both phases.
    const st = await storeReady(a.box.id);
    // `cases` (owner 2026-10-11 afternoon): the closed cases of this mailbox by address (mail-cases.ts; a failed read = {}).
    if (st.ok) {
      const l0 = await storeList(a.box.id);
      // A chargeback Gmail two panels share (owner 2026-10-13, mail-cb-box.ts): the other panel's customers stay out.
      const hide = await hiddenForPanel(a.box.id, a.box.panelId, l0.mails);
      const l = hide.size ? { ...l0, mails: l0.mails.filter(m => !hide.has(m.uid)) } : l0;
      const verified = await verifiedSenders(a.box.panelId, l.mails.map(m => m.fromAddress));
      if (!can(a.user, 'chat.view')) for (const list of Object.values(verified)) for (const v of list) v.chatId = null;
      return NextResponse.json({ ...l, cached: true, at: st.syncedAt ? Date.parse(st.syncedAt) : Date.now(), phase: 'full', store: await storeStatus(a.box.id), mailbox: a.box.email, verified, cases: await loadMailCases(a.box.id) }, { headers: { 'Cache-Control': 'no-store' } });
    }
    // phase=fast: only who / subject / date / flags, so the list can show at once (mail-inbox.ts listMails); the sender
    // checks (automatic verification) need the full list and are skipped. The verified marks already saved still show.
    const phase = new URL(request.url).searchParams.get('phase') === 'fast' ? 'fast' as const : 'full' as const;
    const t0 = Date.now();
    // The quick first list (a page load) is answered from the server's copy too when there is one (owner 2026-10-09
    // evening, "abhi bhi slow hai": it used to ask Gmail live on every page load); it reads Gmail only for a mailbox
    // the server has no copy of yet. The full list runs the automatic verification (mail-auto-verify.ts) inside
    // refreshList, once per read, not once per screen.
    const copy = cachedList(a.box.id);
    const r0 = phase === 'fast'
      ? (copy ? { ...copy, cached: true, phase: 'full' as const } : { ...await listMails(a.box, Date.now(), { phase }), cached: false, at: Date.now() })
      : { ...await listCached(a.box), phase };
    const hide = await hiddenForPanel(a.box.id, a.box.panelId, r0.mails);
    const r = hide.size ? { ...r0, mails: r0.mails.filter(m => !hide.has(m.uid)) } : r0;
    const gmailMs = Date.now() - t0;
    const verified = await verifiedSenders(a.box.panelId, r.mails.map(m => m.fromAddress));
    if (!can(a.user, 'chat.view')) for (const list of Object.values(verified)) for (const v of list) v.chatId = null;
    const total = Date.now() - t0;
    if (total > 2000) console.log(`[mail-timing] route ${phase} gmail=${gmailMs}ms database=${total - gmailMs}ms total=${total}ms`);
    return NextResponse.json({ ...r, mailbox: a.box.email, verified, cases: await loadMailCases(a.box.id) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return mailFail(e); }
}
