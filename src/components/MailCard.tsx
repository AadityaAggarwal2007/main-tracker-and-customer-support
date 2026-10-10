'use client';

// ── Mail: the real Gmail inbox of a panel (owner 2026-10-08) ──────────────────────────────────
// The Super Admin's tab; a team member sees it only with the Mail ticks and only for their panels (every
// /api/mail/* route checks both again). It reads the last 30 days of the Gmail inbox over IMAP and stores nothing
// on the server. Layout (owner: "ye ui ux bilkul accha nahi"): filters on the left, a tall list in the middle, the
// open mail on the right (a phone shows one at a time). What was read stays in the browser's memory
// (mail/cache.ts) so going to another tab and back, or a filter click, never reloads Gmail; the list refreshes
// quietly in the background (a minute, or the Refresh button) without clearing what is on screen. Opening a mail
// marks it read in Gmail ("Mark unread" undoes it). Filters, search and order: src/lib/chat/mail-filters.ts.
// An HTML mail is shown in a sandboxed frame (no scripts) with remote pictures blocked until "Show images".
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BadgeCheck, ChevronLeft, Inbox, Loader2, Mail as MailIcon, MailOpen, Paperclip, RefreshCw, Reply, ShieldQuestion, Calendar, CalendarDays, MessageSquareReply, Search } from 'lucide-react';

// Owner 2026-10-09 ("open open poora poora bada bada kar"): an open mail takes the whole width by default (the filters and
// the list step aside; the List button brings them back); the choice is remembered per browser.
const WIDE_KEY = 'mail_wide';
const readWide = () => { try { return localStorage.getItem(WIDE_KEY) !== '0'; } catch { return true; } };
import { agoText } from '@/app/admin/_lib/format';
import { VIEW_LABELS, initials, matchesView, neighbour, searchMatch, sortItems, viewCounts, type MailSort, type MailView } from '@/lib/chat/mail-filters';
import { mailCache, mailKey, threadKey } from './mail/cache';
import MailRows from './mail/MailRows';
import MailReader from './mail/MailReader';
import type { Box, Full, Item, ListEntry, ThreadItem, Ver } from './mail/types';

interface Props { token: string; onAlert: (type: string, message: string) => void; activePanelId?: string; initialBox?: string | null; initialUid?: number | null }

const REFRESH_MS = 60_000;
const FILTER_GROUPS: { title: string; icon: typeof Inbox; views: MailView[] }[] = [
  { title: 'Inbox', icon: Inbox, views: ['all', 'unread'] },
  { title: 'Verification', icon: BadgeCheck, views: ['unverified', 'verified'] },
  { title: 'Reply', icon: MessageSquareReply, views: ['notreplied', 'replied'] },
  { title: 'More', icon: Paperclip, views: ['attach', 'today', 'week'] },
];
const VIEW_ICON: Partial<Record<MailView, typeof Inbox>> = { all: Inbox, unread: MailIcon, unverified: ShieldQuestion, verified: BadgeCheck, notreplied: Reply, replied: MessageSquareReply, attach: Paperclip, today: Calendar, week: CalendarDays };

export default function MailCard({ token, onAlert, activePanelId, initialBox, initialUid }: Props) {
  const alertRef = useRef(onAlert);
  alertRef.current = onAlert;
  const auth = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const [boxes, setBoxes] = useState<Box[] | null>(mailCache.boxes?.list ?? null);
  const [canReply, setCanReply] = useState(mailCache.boxes?.canReply ?? false);
  const [boxId, setBoxId] = useState<string | null>(null);
  const [entry, setEntry] = useState<ListEntry | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [down, setDown] = useState<string | null>(null);
  const [view, setView] = useState<MailView>('all');
  const [sort, setSort] = useState<MailSort>('unreadfirst');
  const [q, setQ] = useState('');
  const [openUid, setOpenUid] = useState<number | null>(null);
  const [wide, setWide] = useState(true);
  useEffect(() => { setWide(readWide()); }, []);
  const toggleWide = () => { setWide(w => { try { localStorage.setItem(WIDE_KEY, w ? '0' : '1'); } catch { /* ignore */ } return !w; }); };
  const [mail, setMail] = useState<Full | null>(null);
  const [opening, setOpening] = useState(false);
  const [thread, setThread] = useState<ThreadItem[] | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  // The conversation could not be read (owner 2026-10-10: it used to spin): a line with "Try again" instead.
  const [threadFailed, setThreadFailed] = useState(false);
  const threadSeq = useRef(0);
  const [, tick] = useState(0);
  const initialDone = useRef(false);
  const listSeq = useRef(0);
  const openSeq = useRef(0);
  const boxRef = useRef<string | null>(null);
  boxRef.current = boxId;

  // The mailboxes this login may open: shown from memory at once, checked again quietly.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetch('/api/mail/boxes', { headers: auth, cache: 'no-store' });
        const d = await r.json().catch(() => ({}));
        if (!live) return;
        if (!r.ok) { if (!mailCache.boxes) { setBoxes([]); setDown(d.error || 'Mail could not be opened.'); } return; }
        mailCache.boxes = { list: d.boxes || [], canReply: !!d.canReply };
        setBoxes(mailCache.boxes.list); setCanReply(!!d.canReply);
      } catch { if (live && !mailCache.boxes) { setBoxes([]); setDown('Mail could not be opened.'); } }
    })();
    return () => { live = false; };
  }, [auth]);

  // The Gmail follows the panel switcher: only the active panel's Gmail(s) (a link from a chat may name another one).
  const visibleBoxes = useMemo(
    () => (boxes ?? []).filter(b => !activePanelId || b.panelId === activePanelId || b.id === initialBox),
    [boxes, activePanelId, initialBox],
  );
  useEffect(() => {
    if (boxes === null) return;
    setBoxId(prev => {
      if (!initialDone.current && initialBox && visibleBoxes.some(b => b.id === initialBox)) return initialBox;
      return prev && visibleBoxes.some(b => b.id === prev) ? prev : (visibleBoxes[0]?.id ?? null);
    });
  }, [boxes, visibleBoxes, initialBox]);

  // Read the list. The first time (nothing remembered) the QUICK list comes first (who / subject / date / flags: a few
  // seconds) so the screen is never empty for long, then the full one (attachment icons, automatic sender checks) replaces
  // it. A refresh later is silent: the rows stay, only the Refresh button spins.
  const fetchList = useCallback(async (id: string, phase: 'fast' | 'full'): Promise<ListEntry | string> => {
    try {
      const r = await fetch(`/api/mail/messages?box=${encodeURIComponent(id)}${phase === 'fast' ? '&phase=fast' : ''}`, { headers: auth, cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return d.error || 'Could not read Gmail.';
      return { items: d.mails || [], verified: d.verified || {}, truncated: !!d.truncated, at: Date.now(), partial: phase === 'fast' };
    } catch { return 'Could not reach Gmail. It will try again.'; }
  }, [auth]);

  const refresh = useCallback(async (id: string, silent = true) => {
    const seq = ++listSeq.current;
    setRefreshing(true);
    if (!silent) setDown(null);
    try {
      if (!mailCache.lists.get(id)) {
        const quick = await fetchList(id, 'fast');
        if (seq !== listSeq.current) return;
        if (typeof quick !== 'string') { mailCache.lists.set(id, quick); setEntry(quick); setDown(null); }
      }
      const full = await fetchList(id, 'full');
      if (seq !== listSeq.current) return;
      if (typeof full === 'string') { setDown(full); return; }
      mailCache.lists.set(id, full); setEntry(full); setDown(null);
    } finally { if (seq === listSeq.current) setRefreshing(false); }
  }, [fetchList]);

  // A box was chosen: show what is remembered at once, read again only when it is old.
  useEffect(() => {
    setOpenUid(null); setMail(null); setDown(null);
    if (!boxId) { setEntry(null); return; }
    const cached = mailCache.lists.get(boxId) ?? null;
    setEntry(cached);
    if (!cached || Date.now() - cached.at > 30_000) void refresh(boxId);
  }, [boxId, refresh]);

  // Quiet refresh every minute while the tab is visible, and when the window is focused again after a while.
  useEffect(() => {
    const t = setInterval(() => { tick(n => n + 1); if (boxRef.current && document.visibilityState === 'visible') void refresh(boxRef.current); }, REFRESH_MS);
    const onFocus = () => { const e = boxRef.current ? mailCache.lists.get(boxRef.current) : null; if (boxRef.current && (!e || Date.now() - e.at > 30_000)) void refresh(boxRef.current); };
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [refresh]);

  // Edits that must show at once and stay (the list in memory is the same object the cache holds).
  const patchItems = useCallback((fn: (items: Item[]) => Item[], verified?: Record<string, Ver[]>) => {
    setEntry(prev => {
      if (!prev || !boxRef.current) return prev;
      const next = { ...prev, items: fn(prev.items), verified: verified ?? prev.verified };
      mailCache.lists.set(boxRef.current, next);
      return next;
    });
  }, []);

  const items = entry?.items ?? [];
  const verified = entry?.verified ?? {};
  const openMail = useCallback(async (uid: number, images = false) => {
    const id = boxRef.current;
    if (!id) return;
    const seq = ++openSeq.current;
    setOpenUid(uid);
    const cached = mailCache.mails.get(mailKey(id, uid));
    const wasUnread = !!mailCache.lists.get(id)?.items.find(x => x.uid === uid)?.unread;
    if (cached && !images) {
      // Already read (or fetched ahead of time) and kept: it opens at once. An unread one is marked read in Gmail
      // by a quiet call in the background, so the person never waits for it.
      setMail(cached);
      if (wasUnread) {
        patchItems(list => list.map(x => x.uid === uid ? { ...x, unread: false } : x));
        void fetch('/api/mail/message', { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ box: id, uid, seen: true }) }).catch(() => undefined);
      }
      return;
    }
    setOpening(true);
    if (!images && !cached) setMail(null);
    try {
      const r = await fetch(`/api/mail/message?box=${encodeURIComponent(id)}&uid=${uid}${images ? '&images=1' : ''}`, { headers: auth, cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (seq !== openSeq.current) return;
      if (!r.ok) { alertRef.current('error', d.error || 'Could not open that mail.'); setOpenUid(null); return; }
      mailCache.mails.set(mailKey(id, uid), d.mail);
      setMail(d.mail);
      patchItems(list => list.map(x => x.uid === uid ? { ...x, unread: false } : x),
        Array.isArray(d.verified) && d.verified.length ? { ...(mailCache.lists.get(id)?.verified ?? {}), [d.mail.fromAddress]: d.verified } : undefined);
    } catch { if (seq === openSeq.current) { alertRef.current('error', 'Could not open that mail.'); setOpenUid(null); } }
    finally { if (seq === openSeq.current) setOpening(false); }
  }, [auth, patchItems]);

  // The mailbox and the open mail are remembered for the next refresh (owner 2026-10-10; the admin page restores them
  // through initialBox / initialUid). A closed mail is remembered as "none".
  useEffect(() => {
    if (!boxId) return;
    try { localStorage.setItem('mail_last', JSON.stringify({ box: boxId, uid: openUid ?? 0 })); } catch { /* ignore */ }
  }, [boxId, openUid]);

  // Opens the mail a chat's "Emails" link pointed at, once, when its mailbox's list is there.
  useEffect(() => {
    if (initialDone.current || !initialUid || !boxId || boxId !== initialBox || items.length === 0) return;
    initialDone.current = true;
    void openMail(initialUid);
  }, [items.length, boxId, initialBox, initialUid, openMail]);

  const shown = useMemo(() => {
    const now = Date.now();
    return sortItems(items.filter(x => x.uid === openUid || (matchesView(x, view, verified, now) && searchMatch(x, q, verified))), sort);
  }, [items, view, q, sort, verified, openUid]);
  const counts = useMemo(() => viewCounts(items, verified, Date.now()), [items, verified]);

  // Fetch ahead (owner 2026-10-08: "sloww hai"): the first few mails of what is on screen are read in the
  // background WITHOUT marking them read in Gmail (peek=1), one at a time, so opening them is instant. Opening
  // one then marks it read (quietly). Nothing is stored anywhere but this page's memory.
  const prefetching = useRef(false);
  const topKey = shown.slice(0, 5).map(x => x.uid).join(',');
  useEffect(() => {
    const id = boxId;
    if (!id || !entry || prefetching.current || document.visibilityState !== 'visible') return;
    const todo = shown.slice(0, 5).filter(m => !mailCache.mails.has(mailKey(id, m.uid)));
    if (todo.length === 0) return;
    prefetching.current = true;
    (async () => {
      try {
        for (const m of todo) {
          if (boxRef.current !== id) break;
          const r = await fetch(`/api/mail/message?box=${encodeURIComponent(id)}&uid=${m.uid}&peek=1`, { headers: auth, cache: 'no-store' });
          if (!r.ok) break;
          const d = await r.json();
          if (d?.mail) mailCache.mails.set(mailKey(id, m.uid), d.mail);
          if (Array.isArray(d?.verified) && d.verified.length && d?.mail?.fromAddress && boxRef.current === id) {
            patchItems(list => list, { ...(mailCache.lists.get(id)?.verified ?? {}), [d.mail.fromAddress]: d.verified });
          }
        }
      } catch { /* a failed look-ahead only means that mail opens the normal way */ }
      finally { prefetching.current = false; }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxId, entry?.at, topKey]);

  // The conversation with the open mail's sender (their mails and ours): shown from memory at once, read in the background.
  const loadThread = useCallback(async (id: string, address: string, force = false) => {
    const k = threadKey(id, address);
    const cached = mailCache.threads.get(k);
    if (cached && !force) { setThread(cached); return; }
    const seq = ++threadSeq.current;
    setThread(cached ?? null); setThreadLoading(true); setThreadFailed(false);
    // Never longer than 40 s: then it says so and offers "Try again".
    const ctl = new AbortController();
    const cut = setTimeout(() => ctl.abort(), 40_000);
    try {
      const r = await fetch(`/api/mail/thread?box=${encodeURIComponent(id)}&address=${encodeURIComponent(address)}${force ? '&fresh=1' : ''}`, { headers: auth, cache: 'no-store', signal: ctl.signal });
      const d = await r.json().catch(() => ({}));
      if (seq !== threadSeq.current) return;
      if (r.ok && Array.isArray(d.items)) { mailCache.threads.set(k, d.items); if (boxRef.current === id) setThread(d.items); }
      else if (!cached) setThreadFailed(true);
    } catch { if (seq === threadSeq.current && !cached) setThreadFailed(true); }
    finally { clearTimeout(cut); if (seq === threadSeq.current) setThreadLoading(false); }
  }, [auth]);
  const openAddress = mail?.fromAddress;
  useEffect(() => {
    if (!boxId || !openAddress) { setThread(null); return; }
    void loadThread(boxId, openAddress);
  }, [boxId, openAddress, loadThread]);

  const markUnread = async () => {
    if (!boxId || !mail) return;
    try {
      const r = await fetch('/api/mail/message', { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ box: boxId, uid: mail.uid, seen: false }) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); alertRef.current('error', d.error || 'Could not mark it unread.'); return; }
      patchItems(list => list.map(x => x.uid === mail.uid ? { ...x, unread: true } : x));
      setOpenUid(null); setMail(null);
    } catch { alertRef.current('error', 'Could not mark it unread.'); }
  };

  const box = visibleBoxes.find(b => b.id === boxId) ?? null;
  const panelName = (boxes ?? []).find(b => b.panelId === activePanelId)?.panelName;
  const nextUnverified = items.find(x => !verified[x.fromAddress]?.length && x.unread) ?? items.find(x => !verified[x.fromAddress]?.length);

  if (boxes === null) return <div className="mail-empty"><Loader2 size={18} className="spin" /> Opening Mail…</div>;
  if (visibleBoxes.length === 0) {
    return (
      <div className="mail-empty">
        <MailIcon size={28} />
        <b>{down || (boxes.length === 0 ? 'No Gmail is connected yet.' : `No Gmail is connected to ${panelName || 'this panel'}.`)}</b>
        {!down && <span className="meta">{boxes.length === 0 ? 'The Super Admin connects a Gmail in Settings → panel → Email Support. Then it shows here.' : 'Switch the panel at the top left to see another panel’s Gmail, or connect one in Settings → Email Support.'}</span>}
      </div>
    );
  }

  return (
    <div className={`mail-app${openUid ? ' mail-open' : ''}${openUid && wide ? ' mail-wide' : ''}`}>
      {/* Filters (owner 2026-10-08): what a support person sorts the day by */}
      <nav className="mail-filters" aria-label="Mail filters">
        {FILTER_GROUPS.map(g => (
          <div key={g.title} className="mail-fgroup">
            <div className="mail-ftitle">{g.title}</div>
            {g.views.map(v => {
              const Icon = VIEW_ICON[v] || Inbox;
              return (
                <button type="button" key={v} className="mail-f" aria-pressed={view === v} onClick={() => setView(v)}>
                  <Icon size={14} /> <span>{VIEW_LABELS[v]}</span>
                  <b className={v === 'unverified' && counts[v] > 0 ? 'warn' : ''}>{counts[v]}</b>
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <section className="mail-listpane">
        <div className="mail-listhead">
          <div className="mail-bar" style={{ border: 0, padding: 0 }}>
            {visibleBoxes.length > 1 ? (
              <select className="form-input" value={boxId ?? ''} onChange={e => setBoxId(e.target.value)} aria-label="Gmail inbox" style={{ flex: 1, minWidth: 0 }}>
                {visibleBoxes.map(b => <option key={b.id} value={b.id}>{b.panelName} · {b.email}</option>)}
              </select>
            ) : <div className="mail-box-name" title={box?.email}>{box?.panelName} · {box?.email}</div>}
            <button type="button" className="btn btn-outline btn-sm" onClick={() => boxId && refresh(boxId, false)} disabled={refreshing} title="Read Gmail again">
              {refreshing ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Refresh
            </button>
          </div>
          <div className="mail-bar" style={{ border: 0, padding: 0, flexWrap: 'nowrap' }}>
            <div className="mail-search" style={{ flex: 1, minWidth: 0 }}>
              <Search size={14} />
              <input placeholder="Search sender, subject or order number" value={q} onChange={e => setQ(e.target.value)} aria-label="Search mail" />
            </div>
            <select className="form-input mail-sort" value={sort} onChange={e => setSort(e.target.value as MailSort)} aria-label="Order">
              <option value="unreadfirst">Unread first</option>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
          </div>
          <div className="mail-tabs" role="tablist">
            {(['all', 'unverified', 'verified'] as MailView[]).map(v => (
              <button type="button" role="tab" key={v} className="seg-btn" aria-pressed={view === v} onClick={() => setView(v)}>
                {v === 'all' ? 'All' : VIEW_LABELS[v]} <span className="mail-count">{counts[v]}</span>
              </button>
            ))}
          </div>
          {view !== 'all' && view !== 'unverified' && view !== 'verified' && (
            <div className="meta">Showing: <b>{VIEW_LABELS[view]}</b> · <button type="button" className="meta-btn" onClick={() => setView('all')}>Show all</button></div>
          )}
        </div>
        {(box?.status && !box.status.ok) && <div className="mail-warn">{box.status.error}</div>}
        {down && <div className="mail-warn">{down}</div>}
        <div className="mail-rows">
          {!entry && refreshing && <div className="mail-empty"><Loader2 size={16} className="spin" /> Reading Gmail…</div>}
          {entry && shown.length === 0 && (
            <div className="mail-empty">{items.length === 0 ? 'No mail in the last 30 days.' : 'Nothing matches this filter.'}{items.length > 0 && <button type="button" className="btn btn-outline btn-sm" onClick={() => { setView('all'); setQ(''); }}>Clear filters</button>}</div>
          )}
          <MailRows items={shown} verified={verified} openUid={openUid} onOpen={uid => void openMail(uid)} />
          {entry?.truncated && <div className="meta" style={{ padding: '0.5rem 0.75rem' }}>Showing the newest 200 mails of the last 30 days.</div>}
        </div>
        <div className="meta mail-foot">
          {shown.length} of {items.length} mails{entry ? ` · updated ${agoText(entry.at)}` : ''} · {entry?.partial ? 'loading attachments and sender checks…' : refreshing && entry ? 'refreshing…' : 'kept ready on the server, refreshed every few minutes'}
        </div>
      </section>

      <section className="mail-readerpane">
        {!openUid && (
          <div className="mail-home">
            <MailOpen size={34} />
            <h3>Choose a mail to read it</h3>
            <div className="mail-stats">
              <button type="button" className="mail-stat warn" onClick={() => setView('unverified')}><b>{counts.unverified}</b><span>not verified</span></button>
              <button type="button" className="mail-stat" onClick={() => setView('unread')}><b>{counts.unread}</b><span>unread</span></button>
              <button type="button" className="mail-stat" onClick={() => setView('notreplied')}><b>{counts.notreplied}</b><span>not replied</span></button>
              <button type="button" className="mail-stat ok" onClick={() => setView('verified')}><b>{counts.verified}</b><span>verified</span></button>
            </div>
            {nextUnverified && <button type="button" className="btn btn-primary btn-sm" onClick={() => void openMail(nextUnverified.uid)}><ShieldQuestion size={14} /> Open next not-verified mail</button>}
            <p className="meta">Verified senders are matched to their order by themselves (their email is on an order and Gmail confirms it is real). The rest wait for you: ask for the Order ID and phone, then press Verify.</p>
          </div>
        )}
        {openUid && !mail && (() => {
          // The mail's own header from the list shows at once; only the body is still coming.
          const it = items.find(x => x.uid === openUid);
          return (
            <div className="mail-reader">
              <div className="mail-readbar"><button type="button" className="btn btn-ghost btn-sm mail-back" onClick={() => { setOpenUid(null); setMail(null); }}><ChevronLeft size={16} /> List</button></div>
              {it && (
                <header className="mail-head">
                  <div className="mail-avatar" aria-hidden="true">{initials(it.from)}</div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <h2>{it.subject}</h2>
                    <div className="meta"><b>{it.from}</b> · {it.fromAddress}</div>
                  </div>
                </header>
              )}
              <div className="mail-empty"><Loader2 size={16} className="spin" /> Opening the mail…</div>
            </div>
          );
        })()}
        {openUid && mail && (
          <MailReader
            token={token} box={box} mail={mail} canReply={canReply} onAlert={onAlert}
            versions={verified[mail.fromAddress] || []}
            thread={thread} threadLoading={threadLoading} threadFailed={threadFailed}
            onRetryThread={() => { if (boxId && mail) void loadThread(boxId, mail.fromAddress, true); }}
            onBack={() => { setOpenUid(null); setMail(null); }}
            wide={wide} onToggleWide={toggleWide}
            onPrev={neighbour(shown, openUid, -1) ? () => void openMail(neighbour(shown, openUid, -1) as number) : null}
            onNext={neighbour(shown, openUid, 1) ? () => void openMail(neighbour(shown, openUid, 1) as number) : null}
            onShowImages={() => void openMail(mail.uid, true)}
            onMarkUnread={markUnread}
            onChanged={() => { if (boxId) void refresh(boxId); }}
            onSent={() => { patchItems(list => list.map(x => x.uid === mail.uid ? { ...x, answered: true } : x)); setMail(m => (m ? { ...m, answered: true } : m)); if (boxId) void loadThread(boxId, mail.fromAddress, true); }}
          />
        )}
      </section>
    </div>
  );
}
