'use client';

// ── Mail: the real Gmail inbox of a panel (owner 2026-10-08; laid out like Gmail since 2026-10-11) ─────────────
// Gmail's way (owner 2026-10-11, "aisa UI UX bana de" with Gmail's inbox as the picture): the boxes on the left (To reply,
// Replied, Not customers: mail-filters.ts bucketOf; then All mail and the filters), the list across the whole width, one
// line per conversation; a click opens the conversation across the whole width (cards, the reply box at the bottom),
// and a reply sent from "To reply" opens the next mail to answer. The box chosen is remembered (localStorage mail_view).
// The Super Admin's tab; a team member sees it only with the Mail ticks and only for their panels (every
// /api/mail/* route checks both again). It reads the last 30 days of the Gmail inbox over IMAP and stores nothing
// on the server. Layout (owner: "ye ui ux bilkul accha nahi"): filters on the left, a tall list in the middle, the
// open mail on the right (a phone shows one at a time). What was read stays in the browser's memory
// (mail/cache.ts) so going to another tab and back, or a filter click, never reloads Gmail; the list refreshes
// quietly in the background (a minute, or the Refresh button) without clearing what is on screen. Opening a mail
// marks it read in Gmail ("Mark unread" undoes it). Filters, search and order: src/lib/chat/mail-filters.ts.
// An HTML mail is shown in a sandboxed frame (no scripts) with remote pictures blocked until "Show images".
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ban, BadgeCheck, ChevronLeft, FolderCheck, FolderOpen, Inbox, Loader2, Mail as MailIcon, Mails, Paperclip, RefreshCw, Reply, ShieldQuestion, Calendar, CalendarDays, MessageSquareReply, Search } from 'lucide-react';

import { agoText } from '@/app/admin/_lib/format';
import { VIEW_LABELS, bucketOf, caseAddress, caseRows, caseState, customerCase, gmailBlocksToday, matchesView, neighbour, searchMatch, sortItems, viewCounts, type MailSort, type MailView } from '@/lib/chat/mail-filters';
import { mailCache, mailKey, threadKey } from './mail/cache';
import MailRows from './mail/MailRows';
import MailReader from './mail/MailReader';
import type { Box, CasesMap, Customer, Full, Item, ListEntry, MailCase, ThreadItem, Ver } from './mail/types';

interface Props { token: string; onAlert: (type: string, message: string) => void; activePanelId?: string; initialBox?: string | null; initialUid?: number | null }

const REFRESH_MS = 60_000;
// The three boxes first (owner 2026-10-11), then the cases per customer (owner 2026-10-11 afternoon: "active case aur close
// case"; one row per customer, mail-filters.ts caseRows), then everything and the older filters.
const NAV: { title: string; views: MailView[] }[] = [
  { title: '', views: ['todo', 'done', 'other'] },
  { title: 'Cases', views: ['active', 'closed'] },
  { title: '', views: ['all'] },
  { title: 'Filters', views: ['unread', 'unverified', 'verified', 'attach', 'today', 'week'] },
];
const VIEW_ICON: Partial<Record<MailView, typeof Inbox>> = { todo: Inbox, done: MessageSquareReply, other: Ban, active: FolderOpen, closed: FolderCheck, all: Mails, unread: MailIcon, unverified: ShieldQuestion, verified: BadgeCheck, notreplied: Reply, replied: MessageSquareReply, attach: Paperclip, today: Calendar, week: CalendarDays };
const CASE_VIEW = (v: MailView) => v === 'active' || v === 'closed';
const VIEW_KEY = 'mail_view';
const readView = (): MailView => { try { const v = localStorage.getItem(VIEW_KEY) as MailView | null; return v && v in VIEW_LABELS ? v : 'todo'; } catch { return 'todo'; } };

const boxKind = (b: Box) => b.kind === 'chargeback' ? 'Chargeback Gmail' : 'Support Gmail';

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
  const [view, setViewState] = useState<MailView>('todo');
  useEffect(() => { setViewState(readView()); }, []);
  const setView = (v: MailView) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* private window */ } };
  const [sort, setSort] = useState<MailSort>('newest');   // like Gmail (owner 2026-10-11): opening a mail never moves it in the list
  const [q, setQ] = useState('');
  const [openUid, setOpenUid] = useState<number | null>(null);
  const [mail, setMail] = useState<Full | null>(null);
  const [opening, setOpening] = useState(false);
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
      return { items: d.mails || [], verified: d.verified || {}, cases: d.cases || {}, truncated: !!d.truncated, at: Date.now(), partial: phase === 'fast' && !d.store, store: d.store ?? null };
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

  // A case closed / reopened on this screen shows at once (the next list refresh brings the same from the server).
  const patchCases = useCallback((address: string, c: MailCase) => {
    setEntry(prev => {
      if (!prev || !boxRef.current) return prev;
      const next = { ...prev, cases: { ...prev.cases, [address]: c } as CasesMap };
      mailCache.lists.set(boxRef.current, next);
      return next;
    });
  }, []);

  const items = entry?.items ?? [];
  const verified = entry?.verified ?? {};
  const cases = entry?.cases ?? {};
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
    // Never a spinner for ever (owner 2026-10-11, "ni open ho rha"): after 35 s it says Gmail is slow and the row can be clicked again.
    const ctl = new AbortController();
    const cut = setTimeout(() => ctl.abort(), 35_000);
    try {
      const r = await fetch(`/api/mail/message?box=${encodeURIComponent(id)}&uid=${uid}${images ? '&images=1' : ''}`, { headers: auth, cache: 'no-store', signal: ctl.signal });
      const d = await r.json().catch(() => ({}));
      if (seq !== openSeq.current) return;
      if (!r.ok) { alertRef.current('error', d.error || 'Could not open that mail.'); setOpenUid(null); return; }
      mailCache.mails.set(mailKey(id, uid), d.mail);
      setMail(d.mail);
      patchItems(list => list.map(x => x.uid === uid ? { ...x, unread: false } : x),
        Array.isArray(d.verified) && d.verified.length ? { ...(mailCache.lists.get(id)?.verified ?? {}), [d.mail.fromAddress]: d.verified } : undefined);
    } catch { if (seq === openSeq.current) { alertRef.current('error', 'Gmail is very slow right now: the mail could not be opened. Click it again in a moment.'); setOpenUid(null); } }
    finally { clearTimeout(cut); if (seq === openSeq.current) setOpening(false); }
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

  const shown = useMemo<Item[]>(() => {
    const now = Date.now();
    // Active / Closed cases: one row per customer (their newest conversation), with how many conversations they have
    if (CASE_VIEW(view)) {
      const rows: Item[] = caseRows(items.filter(x => searchMatch(x, q, verified)), verified, cases, view as 'active' | 'closed');
      const open = openUid && !rows.some(x => x.uid === openUid) ? items.find(x => x.uid === openUid) : null;
      return sortItems(open ? [...rows, open] : rows, sort);
    }
    return sortItems(items.filter(x => x.uid === openUid || (matchesView(x, view, verified, now, cases) && searchMatch(x, q, verified))), sort);
  }, [items, view, q, sort, verified, cases, openUid]);
  const counts = useMemo(() => viewCounts(items, verified, Date.now(), cases), [items, verified, cases]);
  // The list can now hold up to 2,000 conversations (owner 2026-10-14): draw 300 at a time, "Show more" for the rest.
  const [rowLimit, setRowLimit] = useState(300);
  useEffect(() => { setRowLimit(300); }, [view, q, boxId, sort]);
  const drawn = useMemo(() => {
    const head = shown.slice(0, rowLimit);
    const open = openUid && !head.some(x => x.uid === openUid) ? shown.find(x => x.uid === openUid) : null;
    return open ? [...head, open] : head;
  }, [shown, rowLimit, openUid]);
  // Gmail not synced for a while = new mails may be missing here (owner 2026-10-14: "sari mail nai pakad rha"): say so.
  // Gmail stopping our own mails today (owner 2026-10-14: "appears suspicious and wasn't delivered"): one warning on top.
  const blockedToday = useMemo(() => gmailBlocksToday(items, Date.now()), [items]);
  const syncedAgoMin = entry?.store?.syncedAt ? (Date.now() - Date.parse(entry.store.syncedAt)) / 60_000 : null;

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

  // The conversation with the open mail's sender (owner 2026-10-11, "conversation abhi bhi nahi khul raha, kisi panel mein"):
  // THEIR mails come from the list this screen already has (no Gmail call: shown at once, always); only OUR replies (Gmail's
  // Sent folder) are read from the server, behind the screen, and a failure there never hides the rest. Keyed by the
  // address, so a slow answer for one sender can never show up under another.
  const [threadSt, setThreadSt] = useState<{ key: string; items: ThreadItem[] | null; loading: boolean; failed: boolean } | null>(null);
  const loadThread = useCallback(async (id: string, address: string, force = false, uid: number | null = null) => {
    const k = threadKey(id, `${address}|${uid ?? ''}`);
    const cached = mailCache.threads.get(k) ?? null;
    const seq = ++threadSeq.current;
    if (cached && !force) { setThreadSt({ key: k, items: cached, loading: false, failed: false }); return; }
    setThreadSt({ key: k, items: cached, loading: true, failed: false });
    // Never longer than 30 s: then it says so and offers "Try again".
    const ctl = new AbortController();
    const cut = setTimeout(() => ctl.abort(), 30_000);
    try {
      const r = await fetch(`/api/mail/thread?box=${encodeURIComponent(id)}&address=${encodeURIComponent(address)}${uid ? `&uid=${uid}` : ''}${force ? '&fresh=1' : ''}`, { headers: auth, cache: 'no-store', signal: ctl.signal });
      const d = await r.json().catch(() => ({}));
      if (seq !== threadSeq.current) return;
      if (r.ok && Array.isArray(d.items)) { mailCache.threads.set(k, d.items); setThreadSt({ key: k, items: d.items, loading: false, failed: false }); }
      else setThreadSt({ key: k, items: cached, loading: false, failed: true });
    } catch { if (seq === threadSeq.current) setThreadSt({ key: k, items: cached, loading: false, failed: true }); }
    finally { clearTimeout(cut); }
  }, [auth]);
  const openAddress = mail?.fromAddress;
  const openMailUid = mail?.uid ?? null;
  useEffect(() => {
    if (!boxId || !openAddress) return;
    void loadThread(boxId, openAddress, false, openMailUid);
  }, [boxId, openAddress, openMailUid, loadThread]);
  // What is shown: their mails from the list + whatever the server read (ours, and theirs older than the list), one each.
  const curKey = boxId && openAddress ? threadKey(boxId, `${openAddress}|${openMailUid ?? ''}`) : null;
  const serverThread = threadSt && threadSt.key === curKey ? threadSt : null;
  const thread = useMemo<ThreadItem[] | null>(() => {
    if (!openAddress) return null;
    const addr = openAddress.toLowerCase();
    const local: ThreadItem[] = (entry?.items ?? []).filter(x => (x.fromAddress || '').toLowerCase() === addr)
      .map(x => ({ folder: 'inbox' as const, uid: x.uid, from: x.from, to: '', subject: x.subject, date: x.date }));
    const seen = new Set<string>(); const all: ThreadItem[] = [];
    for (const x of [...(serverThread?.items ?? []), ...local]) { const k = `${x.folder}:${x.uid}`; if (!seen.has(k)) { seen.add(k); all.push(x); } }
    return all.sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0));
  }, [entry?.items, openAddress, serverThread?.items]);
  const threadLoading = !!serverThread?.loading;
  const threadFailed = !!serverThread?.failed;
  // A reply the outbox is still sending: the conversation is read again every few seconds until it is Sent or Not sent.
  const sendingNow = !!serverThread?.items?.some(x => x.local && x.sendState === 'sending');
  useEffect(() => {
    if (!sendingNow || !boxId || !openAddress) return;
    const t = setTimeout(() => { if (document.visibilityState === 'visible') void loadThread(boxId, openAddress, true, openMailUid); }, 4000);
    return () => clearTimeout(t);
  }, [sendingNow, boxId, openAddress, openMailUid, loadThread, serverThread?.items]);
  const retrySend = useCallback(async (outboxId: string) => {
    if (!boxId) return;
    try {
      const r = await fetch('/api/mail/send', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'retry', box: boxId, id: outboxId }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { alertRef.current('error', d.error || 'Could not send it again.'); return; }
      alertRef.current('success', 'Sending the reply again.');
      if (openAddress) void loadThread(boxId, openAddress, true, openMailUid);
    } catch { alertRef.current('error', 'Could not send it again.'); }
  }, [auth, boxId, openAddress, openMailUid, loadThread]);

  // The "Customer" card (owner 2026-10-11): the sender's verified order(s) with their details, or the orders placed with
  // that email as hints; read once per address (cached), again after a verification changes.
  const [customerSt, setCustomerSt] = useState<{ key: string; customer: Customer | null; loading: boolean } | null>(null);
  const customerSeq = useRef(0);
  const loadCustomer = useCallback(async (id: string, address: string, force = false) => {
    const k = threadKey(id, `cust|${address}`);
    const cached = mailCache.customers.get(k) ?? null;
    const seq = ++customerSeq.current;
    if (cached && !force) { setCustomerSt({ key: k, customer: cached, loading: false }); return; }
    setCustomerSt({ key: k, customer: cached, loading: true });
    try {
      const r = await fetch(`/api/mail/customer?box=${encodeURIComponent(id)}&email=${encodeURIComponent(address)}`, { headers: auth, cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (seq !== customerSeq.current) return;
      if (r.ok && d.customer) { mailCache.customers.set(k, d.customer); setCustomerSt({ key: k, customer: d.customer, loading: false }); }
      else setCustomerSt({ key: k, customer: cached, loading: false });
    } catch { if (seq === customerSeq.current) setCustomerSt({ key: k, customer: cached, loading: false }); }
  }, [auth]);
  useEffect(() => { if (boxId && openAddress) void loadCustomer(boxId, openAddress); }, [boxId, openAddress, loadCustomer]);
  const customerKey = boxId && openAddress ? threadKey(boxId, `cust|${openAddress}`) : null;
  const customer = customerSt && customerSt.key === customerKey ? customerSt : null;

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

  const goNext = (from: number, keep: (x: Item) => boolean = x => bucketOf(x, verified, cases) === 'todo') => {
    // after a reply: the next mail still to reply to, below this one in the list (else the first one), else the list
    const rest = shown.filter(x => x.uid !== from && keep(x));
    const i = shown.findIndex(x => x.uid === from);
    const next = rest.find(x => shown.indexOf(x) > i) ?? rest[0];
    if (next) void openMail(next.uid); else { setOpenUid(null); setMail(null); }
  };
  const pos = openUid ? shown.findIndex(x => x.uid === openUid) : -1;
  // The open mail's customer case (owner 2026-10-11 afternoon): Active / Closed from their newest mail; null = not a customer.
  const openCase = mail ? customerCase(items, mail.fromAddress, verified, cases) : null;
  const setCase = async (action: 'close' | 'reopen') => {
    if (!boxId || !mail) return;
    const uid = mail.uid, address = mail.fromAddress.toLowerCase();
    try {
      const r = await fetch('/api/mail/case', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ box: boxId, address, action }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { alertRef.current('error', d.error || (action === 'close' ? 'Could not close the case.' : 'Could not reopen the case.')); return; }
      // From Active cases a close opens the next active customer (like Send from To reply); the list is patched after the pick
      const fromActive = action === 'close' && view === 'active';
      patchCases(address, d.case);
      const who = mail.from.replace(/\s*<[^>]*>\s*$/, '') || address;
      alertRef.current('success', action === 'close' ? `Case closed for ${who}.` : `Case reopened for ${who}.`);
      if (fromActive) goNext(uid, () => true);
    } catch { alertRef.current('error', 'Could not change the case. Try again.'); }
  };

  return (
    <div className={`mail-app gm${openUid ? ' mail-open' : ''}`}>
      {/* The boxes (owner 2026-10-11: "Jawab dena hai / Jawab de diya / Customer nahi"), then the other filters */}
      <nav className="mail-filters" aria-label="Mail boxes">
        {/* The Gmails of the panel as buttons (owner 2026-10-13: the chargeback Gmail gets customers' mails too, so it is a
            box here next to the support Gmail; shown on a phone as well). */}
        {visibleBoxes.length > 1 ? (
          <div className="mail-boxtabs" role="tablist" aria-label="Gmail inbox">
            {visibleBoxes.map(b => (
              <button key={b.id} type="button" role="tab" aria-selected={b.id === boxId} title={b.email}
                className={`mail-boxtab${b.id === boxId ? ' active' : ''}${b.kind === 'chargeback' ? ' cb' : ''}`} onClick={() => setBoxId(b.id)}>
                <span>{boxKind(b)}{activePanelId ? '' : ` · ${b.panelName}`}</span>
                <span className="meta">{b.email}</span>
              </button>
            ))}
          </div>
        ) : <div className="mail-box-name" title={box?.email}>{box?.panelName}{box?.kind === 'chargeback' ? ' · Chargeback Gmail' : ''}<span className="meta">{box?.email}</span></div>}
        {box?.kind === 'chargeback' && (box.sharedWith?.length ?? 0) > 0 && (
          <p className="meta mail-boxnote">Shared with {box.sharedWith!.join(', ')}: their customers&rsquo; mails are in their own box; a mail we cannot place shows in both.</p>
        )}
        {NAV.map((g, gi) => (
          <div key={gi} className="mail-fgroup">
            {g.title && <div className="mail-ftitle">{g.title}</div>}
            {g.views.map(v => {
              const Icon = VIEW_ICON[v] || Inbox;
              return (
                <button type="button" key={v} className={`mail-f${gi === 0 ? ' big' : ''}`} aria-pressed={view === v} onClick={() => { setView(v); setOpenUid(null); setMail(null); }}>
                  <Icon size={gi === 0 ? 16 : 14} /> <span>{VIEW_LABELS[v]}</span>
                  <b className={v === 'todo' && counts[v] > 0 ? 'warn' : ''}>{counts[v]}</b>
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {!openUid && (
        <section className="mail-listpane">
          <div className="mail-listhead">
            <div className="mail-search">
              <Search size={15} />
              <input placeholder="Search mail: sender, subject, words, order number" value={q} onChange={e => setQ(e.target.value)} aria-label="Search mail" />
            </div>
            <div className="mail-bar" style={{ border: 0, padding: 0, flexWrap: 'nowrap' }}>
              <b className="mail-viewname">{VIEW_LABELS[view]} <span className="meta">{shown.length}</span></b>
              <span style={{ flex: 1 }} />
              <select className="form-input mail-sort" value={sort} onChange={e => setSort(e.target.value as MailSort)} aria-label="Order">
                <option value="unreadfirst">Unread first</option>
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
              </select>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => boxId && refresh(boxId, false)} disabled={refreshing} title="Read again">
                {refreshing ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
              </button>
            </div>
            {view === 'todo' && <div className="meta">Customers&apos; mails nobody has answered yet. Reply, and the next one opens by itself.</div>}
            {view === 'other' && <div className="meta">Banks, gateways, tools, newsletters and sales mails: not from a customer, nothing to answer.</div>}
            {view === 'active' && <div className="meta">One line per customer whose newest mail we have not answered yet, newest first. Your reply closes the case by itself; Close case is for a mail that needs no reply. A customer who writes again comes back here by himself.</div>}
            {view === 'closed' && <div className="meta">Customers we replied to after their newest mail, or whose case was closed by hand. A new mail from them makes the case active again.</div>}
          </div>
          {(box?.status && !box.status.ok) && <div className="mail-warn">{box.status.error}</div>}
          {down && <div className="mail-warn">{down}</div>}
          {blockedToday > 0 && (
            <div className="mail-warn">Gmail stopped {blockedToday === 1 ? 'one of our mails' : `${blockedToday} of our mails`} today before it left (it called it suspicious, or this Gmail hit its daily limit), so that customer never got our reply; they are back in To reply. Do not send the same text again and again: one short reply without links. If it keeps happening, tell the Super Admin.</div>
          )}
          {syncedAgoMin != null && syncedAgoMin > 10 && (
            <div className="mail-warn">Gmail has not synced for {Math.round(syncedAgoMin)} minutes, so the newest mails may be missing here.{entry?.store?.error ? ` Gmail said: ${entry.store.error}` : ' It usually catches up by itself; if this stays, tell the Super Admin.'}</div>
          )}
          <div className="mail-rows">
            {!entry && refreshing && <div className="mail-empty"><Loader2 size={16} className="spin" /> Reading the mails…</div>}
            {entry && shown.length === 0 && (
              <div className="mail-empty">{items.length === 0 ? 'No mail in this period.' : view === 'todo' && !q ? 'Nothing left to reply to. 🎉' : view === 'active' && !q ? 'No active case: every customer\'s case is closed.' : view === 'closed' && !q ? 'No closed case yet. A reply closes a customer\'s case by itself; "Close case" closes one that needs no reply.' : 'Nothing matches this.'}{items.length > 0 && q && <button type="button" className="btn btn-outline btn-sm" onClick={() => setQ('')}>Clear search</button>}</div>
            )}
            <MailRows items={drawn} verified={verified} openUid={openUid} onOpen={uid => void openMail(uid)} showVerify={view !== 'other'} />
            {shown.length > rowLimit && (
              <div style={{ padding: '0.5rem 0.75rem' }}>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => setRowLimit(n => n + 300)}>Show more ({shown.length - rowLimit} left)</button>
              </div>
            )}
            {entry?.truncated && <div className="meta" style={{ padding: '0.5rem 0.75rem' }}>Showing the first 2,000 conversations (every unanswered one first). Use search to find an older one.</div>}
          </div>
          <div className="meta mail-foot">
            {entry?.store ? `${entry.store.mails} mails saved in ShipTrack${entry.store.bodies < entry.store.mails ? ` (${entry.store.bodies} ready to open at once, the rest within minutes)` : ''}${entry.store.syncedAt ? ` · synced with Gmail ${agoText(Date.parse(entry.store.syncedAt))}` : ''}${entry.store.error ? ` · Gmail: ${entry.store.error}` : ''}` : `${items.length} mails${entry ? ` · updated ${agoText(entry.at)}` : ''}${entry?.partial ? ' · loading attachments and sender checks…' : ''}`}
          </div>
        </section>
      )}

      {openUid && (
        <section className="mail-readerpane">
          {!mail && (() => {
            // The mail's own header from the list shows at once; only the body is still coming.
            const it = items.find(x => x.uid === openUid);
            return (
              <div className="mail-reader">
                <div className="mail-readbar"><button type="button" className="btn btn-ghost btn-sm mail-back" onClick={() => { setOpenUid(null); setMail(null); }}><ChevronLeft size={16} /> {VIEW_LABELS[view]}</button></div>
                {it && <header className="mail-subjecthead"><h2>{it.subject}</h2></header>}
                {it && <div className="meta" style={{ marginBottom: '0.5rem' }}><b>{it.from}</b> · {it.fromAddress}</div>}
                <div className="mail-empty"><Loader2 size={16} className="spin" /> Opening the mail…</div>
              </div>
            );
          })()}
          {mail && (
            <MailReader
              token={token} box={box} mail={mail} canReply={canReply} onAlert={onAlert}
              versions={verified[mail.fromAddress] || []}
              thread={thread} threadLoading={threadLoading} threadFailed={threadFailed}
              onRetryThread={() => { if (boxId && mail) void loadThread(boxId, mail.fromAddress, true, mail.uid); }}
              onRetrySend={outboxId => void retrySend(outboxId)}
              customer={customer?.customer ?? null} customerLoading={!!customer?.loading}
              onBack={() => { setOpenUid(null); setMail(null); }}
              backLabel={VIEW_LABELS[view]}
              position={pos >= 0 ? `${pos + 1} of ${shown.length}` : undefined}
              bucket={(() => { const it = items.find(x => x.uid === mail.uid); return it ? bucketOf(it, verified, cases) : undefined; })()}
              bounced={items.find(x => x.uid === mail.uid)?.bounce ?? null}
              caseInfo={openCase}
              onCase={action => void setCase(action)}
              onNextAfterSend={view === 'todo' || view === 'active'}
              onPrev={neighbour(shown, openUid, -1) ? () => void openMail(neighbour(shown, openUid, -1) as number) : null}
              onNext={neighbour(shown, openUid, 1) ? () => void openMail(neighbour(shown, openUid, 1) as number) : null}
              onShowImages={() => void openMail(mail.uid, true)}
              onMarkUnread={markUnread}
              onChanged={() => { if (boxId) { void refresh(boxId); if (mail) void loadCustomer(boxId, mail.fromAddress, true); } }}
              onSent={() => {
                const uid = mail.uid;
                const addr = caseAddress(mail.fromAddress);
                // repliedAt now: the reply closes the customer's case at once on this screen (owner 2026-10-11 12:45); the
                // next list refresh brings the same from the store. Every mail of this customer on the list, not only the
                // one answered (owner 2026-10-11 13:02: a customer's second mail in another Gmail thread stayed To reply
                // after the team answered the first; storeList counts a reply to the customer, whatever the thread).
                const at = new Date().toISOString();
                patchItems(list => list.map(x => x.uid === uid || (addr && caseAddress(x.fromAddress) === addr) ? { ...x, answered: true, replied: true, repliedAt: at, bounce: undefined } : x));
                setMail(m => (m ? { ...m, answered: true } : m));
                if (boxId) void loadThread(boxId, mail.fromAddress, true, uid);
                if (view === 'todo') goNext(uid);
                // from Active cases the next active customer opens, like from To reply
                else if (view === 'active') goNext(uid, x => caseState(x, cases) === 'active');
              }}
            />
          )}
        </section>
      )}
    </div>
  );
}
