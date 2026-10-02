'use client';

// ── Refund requests (owner, 2026-10-02): the Super Admin's tab next to Team score ──
// SUPER ADMIN ONLY (the admin page shows the tab only to him; every /api/refunds/* route checks again).
// The team, Chikki, the learner, search and the team score never see any of this. Customers only ever
// see "Vastora Support" messages in their chat, one fixed text per step (never the internal note).
// UPI / bank details are stored encrypted and shown masked here; the full details come only from
// "Show full details" (POST /api/refunds/<id>/reveal: recorded, 30 an hour) and hide again after 60 s.
// Owner change 2026-10-02 ~15:00: no photo / video upload, so there is no photos section.
// Spec refund_form_spec.md 7.2 - 7.4.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, ChevronLeft, Copy, Eye, ExternalLink, Loader2, Printer, RefreshCw, Search, X } from 'lucide-react';
import { REASON_TEXT, SUB_REASON_TEXT, formatAmount, formatDate, formatDateTime } from '@/lib/refund/texts';
import { checkAmount, checkUtr, isCod, istDay, NOTE_MAX, RETURN_NOTE_MAX, AMOUNT_CAP, type Reason } from '@/lib/refund/rules';

// ── What the routes send (spec 3.5) ────────────────────────────
type Status = 'new' | 'approved' | 'rejected' | 'refunded' | 'cancelled';
type ViewKey = Status | 'sent' | 'all';
type Lang = 'hinglish' | 'en';
interface Payout { method: 'upi' | 'bank'; mask: string }
interface Item {
  id: string; ref: string; status: Status; seen: boolean; created_at: string | null; status_at: string | null; panel: string | null;
  order_id: string; customer_name: string | null; reason: string; sub_reason: string | null; total: number | null; payment: string | null;
  payout: Payout; flags: string[]; return_needed: boolean; conversation_id: string;
}
interface SentLink {
  id: string; order_id: string; customer_name: string | null; panel: string | null; sent_at: string | null; expires_at: string | null;
  state: 'active' | 'expired'; opened_count: number; last_opened_at: string | null; conversation_id: string;
}
interface Counts { new: number; unseen: number; approved: number; rejected: number; refunded: number; cancelled: number; sent: number }
interface ListAnswer { items?: Item[]; links?: SentLink[]; counts?: Counts; next_before?: string | null; setup?: null | 'key_missing' | 'off' }
interface Flag { code: string; level: 'red' | 'amber' | 'grey'; text: string; refs: string[] }
interface Msg { step: string; id: string | null; at: string | null; lang: string | null; emailed: boolean | null; failed: boolean }
interface Ev { at: string | null; kind: string; actor: string | null; from: string | null; to: string | null; note: string | null; meta: Record<string, unknown> | null }
type Bi2 = { en: string; hinglish: string };
interface Detail {
  request: {
    id: string; ref: string; status: Status; status_at: string | null; created_at: string | null; reason: string; sub_reason: string | null;
    checked_around: boolean; details: string; consent_version: string | null; consent_at: string | null; device: string | null;
    payout: Payout & { bank_name: string | null; holder_matches: boolean | null };
    refund_amount: number | null; refund_date: string | null; utr: string | null; gateway_checked: boolean;
    return_needed: boolean; return_note: string | null; return_told_at: string | null; ack_posted: boolean;
  };
  order: { snapshot: Record<string, unknown>; now: null | { tracking_status: string | null; delivered_at: string | null; is_cancelled: boolean; total: number | null; phone_last4: string | null }; changed: boolean };
  chat: { conversation_id: string; live_id: string | null; channel: 'chat' | 'email'; status: string | null; case_kind: string | null; open_url: string | null };
  link: { sent_at: string | null; expires_at: string | null; opened_count: number; first_opened_at: string | null; last_opened_at: string | null; submitted_at: string | null; devices: string[] };
  flags: Flag[];
  messages: Msg[];
  events: Ev[];
  allowed: string[];
  lang: Lang;
  previews: { approved: Bi2; rejected: Bi2; refunded: Bi2; return: Bi2 };
}
type Revealed = { method: 'upi'; upi: string; holder: string } | { method: 'bank'; account: string; ifsc: string; bank_name: string | null; holder: string };
type Move = 'approve' | 'reject' | 'refunded' | 'cancel';

interface Props {
  token: string;
  onAlert: (type: string, message: string) => void;
  openId?: string | null;          // deep link /admin?tab=refunds&open=<id> (from the chat's "Open request")
  onSeen?: () => void;             // the badge's counts changed (a request was opened or moved)
}

// ── Labels ─────────────────────────────────────────────────────
const VIEWS: { v: ViewKey; label: string; hint: string }[] = [
  { v: 'new', label: 'New', hint: 'naye' },
  { v: 'approved', label: 'Approved', hint: 'approve kiye' },
  { v: 'rejected', label: 'Rejected', hint: 'mana kiye' },
  { v: 'refunded', label: 'Refunded', hint: 'paise bhej diye' },
  { v: 'cancelled', label: 'Cancelled', hint: 'band kiye' },
  { v: 'sent', label: 'Form sent', hint: 'bheja, bhara nahi' },
  { v: 'all', label: 'All', hint: 'sab' },
];
const STATUS_PILL: Record<Status, { label: string; fg: string; bg: string }> = {
  new: { label: 'New', fg: 'var(--warning)', bg: 'var(--warning-light)' },
  approved: { label: 'Approved', fg: 'var(--primary)', bg: 'var(--primary-light)' },
  rejected: { label: 'Rejected', fg: 'var(--danger)', bg: 'var(--danger-light)' },
  refunded: { label: 'Refunded', fg: 'var(--success)', bg: 'var(--success-light)' },
  cancelled: { label: 'Cancelled', fg: 'var(--fg-muted)', bg: 'var(--bg-subtle)' },
};
const LEVEL_COLOR: Record<string, { fg: string; bg: string }> = {
  red: { fg: 'var(--danger)', bg: 'var(--danger-light)' },
  amber: { fg: '#b45309', bg: 'var(--warning-light)' },
  grey: { fg: 'var(--fg-muted)', bg: 'var(--bg-subtle)' },
};
// The list carries flag codes only (from stored columns); short words for the row.
const FLAG_SHORT: Record<string, { label: string; level: 'red' | 'amber' | 'grey' }> = {
  prepaid: { label: 'prepaid', level: 'red' },
  cod_not_delivered: { label: 'COD not delivered', level: 'red' },
  cod_not_received: { label: 'COD not received', level: 'red' },
  payout_reused: { label: 'same UPI / bank', level: 'red' },
  ack_failed: { label: 'message not sent', level: 'red' },
  email_failed: { label: 'email failed', level: 'red' },
  order_cancelled: { label: 'order cancelled', level: 'amber' },
  name_differs: { label: 'name', level: 'amber' },
  repeat_customer: { label: 'repeat', level: 'amber' },
  order_changed: { label: 'order changed', level: 'amber' },
  opened_by_many: { label: 'many networks', level: 'amber' },
  not_refund_case: { label: 'not in Refund', level: 'grey' },
};
const STEP_LABEL: Record<string, string> = {
  form: 'Form link', received: 'Form received', approved: 'Approved', rejected: 'Not approved', refunded: 'Refunded (reference)', return: 'Return pickup',
};
const EVENT_LABEL: Record<string, string> = {
  link_sent: 'Form sent', link_opened: 'Customer opened the form', link_revoked: 'Link closed', submitted: 'Customer submitted the form',
  viewed: 'You opened this request', revealed: 'Full details viewed', status: 'Status changed', message_posted: 'Message in the chat',
  message_failed: 'Message NOT sent', email_sent: 'Email sent', email_failed: 'Email failed', note: 'Note', return_flag: 'Return pickup',
  return_told: 'Customer told about the return pickup',
};
const ACTOR: Record<string, string> = { owner: 'You', customer: 'Customer', system: 'System' };
// Field errors from PATCH (rules.ts codes).
const ADMIN_ERR: Record<string, string> = {
  note_required: 'Write a note (only you see it).',
  note_long: `Keep the note under ${NOTE_MAX} characters.`,
  return_note_long: `Keep the return note under ${RETURN_NOTE_MAX} characters.`,
  utr_format: 'UTR / reference: 8 to 30 letters or digits.',
  utr_used: 'This UTR is already on another request.',
  amount_format: 'Amount in rupees, like 1299 or 1299.50.',
  amount_over_total: 'More than the order total.',
  amount_high: `Above ${formatAmount(AMOUNT_CAP)}: check the amount.`,
  date_range: 'Pick a day from the day the form came in to today.',
  gateway_tick: 'Tick that you checked the payment gateway.',
  move_not_allowed: 'This is not allowed now. Reload.',
};

const reasonText = (reason: string, sub: string | null) => {
  const r = REASON_TEXT[reason as Reason]?.en || reason;
  const s = sub ? SUB_REASON_TEXT[sub]?.en || sub : '';
  return s ? `${r} · ${s}` : r;
};
const payoutText = (p: Payout | null | undefined) => (p ? `${p.method === 'upi' ? 'UPI' : 'Bank'} ${p.mask}` : '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function ago(iso: string | null): string {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return '';
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
const daysLeft = (iso: string | null) => {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return '';
  const d = Math.ceil((ms - Date.now()) / 86_400_000);
  return d <= 0 ? 'expired' : d === 1 ? '1 day left' : `${d} days left`;
};
const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const muted: CSSProperties = { border: '1px solid var(--border)', background: 'transparent', color: 'var(--fg-muted)' };
const chosen: CSSProperties = { border: '1px solid var(--primary)', color: 'var(--primary)', background: 'var(--primary-light)' };
const small: CSSProperties = { fontSize: '0.6875rem', color: 'var(--fg-muted)', lineHeight: 1.4 };
const pill = (fg: string, bg: string): CSSProperties => ({
  fontSize: '0.625rem', fontWeight: 700, padding: '0.0625rem 0.4rem', borderRadius: 999, color: fg, background: bg,
  whiteSpace: 'nowrap', display: 'inline-block', lineHeight: 1.5,
});
const sectionTitle: CSSProperties = { fontSize: '0.6875rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)', margin: '0 0 0.375rem' };
const box: CSSProperties = { padding: '0.75rem', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--card-bg)', marginBottom: '0.75rem' };
const td: CSSProperties = { padding: '0.5rem 0.625rem', borderTop: '1px solid var(--border)', fontSize: '0.8125rem', verticalAlign: 'top', overflowWrap: 'anywhere' };
const th: CSSProperties = { padding: '0.5rem 0.625rem', fontSize: '0.6875rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--fg-muted)', textAlign: 'left', whiteSpace: 'nowrap' };
const noteBox = (fg: string, bg: string): CSSProperties => ({ padding: '0.5rem 0.75rem', borderRadius: 8, borderLeft: `3px solid ${fg}`, background: bg, fontSize: '0.75rem', lineHeight: 1.5, overflowWrap: 'anywhere', color: 'var(--fg)' });

function StatusPill({ status }: { status: Status }) {
  const p = STATUS_PILL[status] || STATUS_PILL.cancelled;
  return <span style={pill(p.fg, p.bg)}>{p.label}</span>;
}
function FlagPills({ codes }: { codes: string[] }) {
  if (!codes.length) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {codes.map((c) => {
        const f = FLAG_SHORT[c] || { label: c, level: 'grey' as const };
        const col = LEVEL_COLOR[f.level];
        return <span key={c} style={pill(col.fg, col.bg)}>{f.level === 'grey' ? '' : '⚠ '}{f.label}</span>;
      })}
    </span>
  );
}
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 7.5rem) minmax(0, 1fr)', gap: 8, padding: '0.25rem 0', fontSize: '0.8125rem' }}>
      <span style={{ color: 'var(--fg-muted)' }}>{label}</span>
      <span style={{ minWidth: 0, overflowWrap: 'anywhere', color: 'var(--fg)' }}>{children}</span>
    </div>
  );
}

export default function RefundRequestsCard({ token, onAlert, openId, onSeen }: Props) {
  const alertRef = useRef(onAlert);
  alertRef.current = onAlert;
  const seenRef = useRef(onSeen);
  seenRef.current = onSeen;

  const [isPhone, setIsPhone] = useState(false);
  const [view, setView] = useState<ViewKey>('new');
  const [list, setList] = useState<ListAnswer | null>(null);
  const [loading, setLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [down, setDown] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const listSeq = useRef(0);

  // Drawer
  const [openReq, setOpenReq] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailSeq = useRef(0);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [revealLeft, setRevealLeft] = useState(0);
  const [revealing, setRevealing] = useState(false);
  const [rejectBanner, setRejectBanner] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [returnDraft, setReturnDraft] = useState<{ needed: boolean; note: string } | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);   // which small action is running
  const [moreOpen, setMoreOpen] = useState(false);

  // Move dialog
  const [move, setMove] = useState<Move | null>(null);
  const [mLang, setMLang] = useState<Lang>('hinglish');
  const [mNote, setMNote] = useState('');
  const [mAmount, setMAmount] = useState('');
  const [mDate, setMDate] = useState('');
  const [mUtr, setMUtr] = useState('');
  const [mGateway, setMGateway] = useState(false);
  const [mAmountOk, setMAmountOk] = useState(false);
  const [mErrors, setMErrors] = useState<Record<string, string>>({});
  const [mError, setMError] = useState<string | null>(null);
  const [mBusy, setMBusy] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const on = () => setIsPhone(mq.matches);
    on();
    if (mq.addEventListener) mq.addEventListener('change', on); else mq.addListener(on);
    return () => { if (mq.removeEventListener) mq.removeEventListener('change', on); else mq.removeListener(on); };
  }, []);

  const auth = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  // ── List ──
  const load = useCallback(async (v: ViewKey, before?: string | null) => {
    if (!token) return;
    const seq = ++listSeq.current;
    if (before) setMoreLoading(true); else setLoading(true);
    try {
      const qs = new URLSearchParams({ view: v });
      if (before) qs.set('before', before);
      const r = await fetch(`/api/refunds?${qs}`, { headers: auth, cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (seq !== listSeq.current) return;
      if (r.ok) {
        setDown(null);
        setList((prev) => (before && prev
          ? { ...d, items: [...(prev.items || []), ...((d as ListAnswer).items || [])], links: (d as ListAnswer).links || prev.links }
          : d as ListAnswer));
      } else if (r.status === 503) setDown(d.error === 'key_missing' ? 'The refund key is missing on the server.' : (d.error || 'Refund requests are not available right now.'));
      else alertRef.current('error', d.error || 'Could not load refund requests');
    } catch {
      if (seq === listSeq.current) alertRef.current('error', 'Could not load refund requests');
    } finally {
      if (seq === listSeq.current) { setLoading(false); setMoreLoading(false); }
    }
  }, [token, auth]);

  useEffect(() => { void load(view); }, [view, load]);

  // ── Drawer ──
  const loadDetail = useCallback(async (id: string, quiet = false) => {
    if (!token || !UUID.test(id)) return;
    const seq = ++detailSeq.current;
    if (!quiet) { setDetailLoading(true); setDetailErr(null); }
    try {
      const r = await fetch(`/api/refunds/${encodeURIComponent(id)}`, { headers: auth, cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (seq !== detailSeq.current) return;
      if (r.ok && d.request) {
        setDetail(d as Detail);
        setDetailErr(null);
        setList((prev) => (prev?.items ? { ...prev, items: prev.items.map((it) => (it.id === id ? { ...it, seen: true } : it)) } : prev));
        seenRef.current?.();
      } else setDetailErr(d.error || 'Could not open this request.');
    } catch {
      if (seq === detailSeq.current) setDetailErr('Could not open this request. Check the internet and try again.');
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false);
    }
  }, [token, auth]);

  const hideReveal = useCallback(() => { setRevealed(null); setRevealLeft(0); }, []);
  const openDrawer = useCallback((id: string) => {
    hideReveal();
    setOpenReq(id); setDetail(null); setRejectBanner(false); setNoteDraft(''); setReturnDraft(null); setMoreOpen(false);
    void loadDetail(id);
  }, [loadDetail, hideReveal]);
  const closeDrawer = () => {
    if (mBusy) return;
    hideReveal();
    setOpenReq(null); setDetail(null); setMove(null); setDetailErr(null);
  };

  // Deep link from the chat ("Open request"): once per id.
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!openId || !UUID.test(openId) || openedFor.current === openId || !token) return;
    openedFor.current = openId;
    openDrawer(openId);
  }, [openId, token, openDrawer]);

  // The full details hide again after 60 s.
  useEffect(() => {
    if (!revealed) return;
    const t = setInterval(() => setRevealLeft((x) => Math.max(0, x - 1)), 1000);
    return () => clearInterval(t);
  }, [revealed]);
  useEffect(() => { if (revealed && revealLeft <= 0) setRevealed(null); }, [revealed, revealLeft]);

  const reveal = async () => {
    if (!detail || revealing) return;
    setRevealing(true);
    try {
      const r = await fetch(`/api/refunds/${encodeURIComponent(detail.request.id)}/reveal`, { method: 'POST', headers: auth, cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.payout) { setRevealed(d.payout as Revealed); setRevealLeft(60); void loadDetail(detail.request.id, true); }
      else alertRef.current('error', d.error === 'key_missing' ? 'The refund key is missing on the server: details cannot be read.' : (d.error || 'Could not show the details.'));
    } catch {
      alertRef.current('error', 'Could not show the details.');
    } finally {
      setRevealing(false);
    }
  };
  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); alertRef.current('success', `${what} copied`); }
    catch { alertRef.current('error', 'Could not copy. Select it and copy by hand.'); }
  };

  // PATCH /api/refunds/<id>: every action. Returns the answer (or null on a network error).
  const patch = async (body: Record<string, unknown>): Promise<{ ok: boolean; status: number; d: Record<string, unknown> } | null> => {
    if (!detail) return null;
    try {
      const r = await fetch(`/api/refunds/${encodeURIComponent(detail.request.id)}`, {
        method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, d };
    } catch {
      return null;
    }
  };
  const afterChange = (id: string) => { void loadDetail(id, true); void load(view); seenRef.current?.(); };

  const small_action = async (key: string, body: Record<string, unknown>, okText: string) => {
    if (!detail || rowBusy) return;
    setRowBusy(key);
    const id = detail.request.id;
    const a = await patch(body);
    setRowBusy(null);
    if (!a) { alertRef.current('error', 'Could not save. Check the internet and try again.'); return false; }
    if (!a.ok) { alertRef.current('error', s(a.d.error) || 'Could not save.'); afterChange(id); return false; }
    if (a.d.emailed === false) alertRef.current('error', `${okText}, but the email did not go out. Use Retry in the history.`);
    else alertRef.current('success', okText);
    afterChange(id);
    return true;
  };

  // ── Move dialogs ──
  const snap = detail?.order.snapshot || {};
  const total = n(snap.total);
  // The same test the server's gateway tick uses (rules.ts isCod on the snapshot's raw payment method).
  const prepaid = !!detail && !isCod(snap.payment_raw ?? snap.payment ?? '');
  const openMove = (m: Move) => {
    if (!detail) return;
    setMove(m); setMoreOpen(false);
    setMLang(detail.lang === 'en' ? 'en' : 'hinglish');
    setMNote(''); setMUtr(''); setMGateway(false); setMAmountOk(false); setMErrors({}); setMError(null);
    setMAmount(total && total > 0 ? String(total) : '');
    setMDate(istDay(Date.now()));
  };
  const submitMove = async () => {
    if (!detail || !move || mBusy) return;
    const body: Record<string, unknown> = { action: move, expect: detail.request.status, lang: mLang };
    if (mNote.trim()) body.note = mNote.trim();
    if (move === 'refunded') {
      body.utr = mUtr; body.amount = mAmount.trim(); body.refund_date = mDate; body.gateway_checked = mGateway;
      const e: Record<string, string> = {};
      if (!(total && total > 0) && !mAmountOk) e.amount_ok = 'Tick that you checked this amount.';
      if (prepaid && !mGateway) e.gateway_checked = ADMIN_ERR.gateway_tick;
      if (Object.keys(e).length) { setMErrors(e); return; }
    }
    if ((move === 'reject' || move === 'cancel') && !mNote.trim()) { setMErrors({ note: ADMIN_ERR.note_required }); return; }
    setMBusy(true); setMError(null); setMErrors({});
    const id = detail.request.id;
    const a = await patch(body);
    setMBusy(false);
    if (!a) { setMError('Could not save. Check the internet and try again.'); return; }
    if (a.ok) {
      const done = move;
      setMove(null);
      const what = done === 'approve' ? 'Approved, the customer was told' : done === 'reject' ? 'Rejected, the customer was told'
        : done === 'refunded' ? 'Marked refunded, the reference was sent' : 'Request cancelled (the customer was not told)';
      if (a.d.emailed === false) alertRef.current('error', `${what}, but the email did not go out. Use Retry in the history.`);
      else alertRef.current('success', what);
      if (done === 'reject') setRejectBanner(true);
      afterChange(id);
      return;
    }
    const errs = a.d.errors && typeof a.d.errors === 'object' ? a.d.errors as Record<string, string> : {};
    const mapped: Record<string, string> = {};
    for (const [k, v] of Object.entries(errs)) if (k !== 'status') mapped[k] = ADMIN_ERR[v] || v;
    setMErrors(mapped);
    setMError(s(a.d.error) || 'Could not save.');
    if (a.status === 409) afterChange(id);
  };

  // ── List rows ──
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const items = list?.items || [];
    if (!needle) return items;
    return items.filter((it) => [it.ref, it.order_id, it.customer_name || ''].some((x) => x.toLowerCase().includes(needle)));
  }, [list, q]);
  const links = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const ls = list?.links || [];
    if (!needle) return ls;
    return ls.filter((l) => [l.order_id, l.customer_name || ''].some((x) => x.toLowerCase().includes(needle)));
  }, [list, q]);
  const counts = list?.counts;
  const countOf = (v: ViewKey): number | null => (!counts || v === 'all' ? null : v === 'sent' ? counts.sent : counts[v]);

  const chatHref = (id: string) => `/admin/chat?open=${encodeURIComponent(id)}`;

  const itemRow = (it: Item) => {
    const unseen = !it.seen && it.status === 'new';
    const pay = `${it.payment || ''}${it.total !== null ? ` ${formatAmount(it.total)}` : ''}`.trim();
    if (isPhone) {
      return (
        <button key={it.id} type="button" onClick={() => openDrawer(it.id)} className="tf-card"
          style={{ display: 'block', width: '100%', textAlign: 'left', padding: '0.75rem', marginBottom: 8, border: '1px solid var(--border)', cursor: 'pointer', fontWeight: unseen ? 700 : 400, color: 'var(--fg)', background: 'var(--card-bg)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {unseen && <span aria-label="not seen" style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--warning)', flexShrink: 0 }} />}
            <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.8125rem' }}>{it.ref}</span>
            <StatusPill status={it.status} />
            <span style={{ ...small, marginLeft: 'auto' }}>{ago(it.created_at)}</span>
          </div>
          <div style={{ fontSize: '0.875rem', marginTop: 4, overflowWrap: 'anywhere' }}>{it.order_id} · {it.customer_name || '—'}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', marginTop: 2, overflowWrap: 'anywhere', fontWeight: 400 }}>{reasonText(it.reason, it.sub_reason)} · {payoutText(it.payout)}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 4, fontSize: '0.75rem', fontWeight: 400 }}>
            <span>{pay}</span><FlagPills codes={it.flags} />
          </div>
        </button>
      );
    }
    return (
      <tr key={it.id} onClick={() => openDrawer(it.id)} className="rf-row" style={{ cursor: 'pointer', fontWeight: unseen ? 700 : 400 }}>
        <td style={{ ...td, whiteSpace: 'nowrap', overflowWrap: 'normal' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span aria-label={unseen ? 'not seen' : undefined} style={{ width: 8, height: 8, borderRadius: 4, background: unseen ? 'var(--warning)' : 'transparent', flexShrink: 0 }} />
            <button type="button" onClick={(e) => { e.stopPropagation(); openDrawer(it.id); }}
              style={{ border: 'none', background: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', fontFamily: 'ui-monospace, monospace' }}>{it.ref}</button>
          </span>
        </td>
        <td style={td}>{it.order_id} <span style={{ color: 'var(--fg-muted)' }}>{it.customer_name || ''}</span>{it.panel ? <div style={small}>{it.panel}</div> : null}</td>
        <td style={td}>{reasonText(it.reason, it.sub_reason)}{it.return_needed ? <div style={small}>Return chahiye</div> : null}</td>
        <td style={{ ...td, fontFamily: 'ui-monospace, monospace', fontSize: '0.75rem' }}>{payoutText(it.payout)}</td>
        <td style={td}>{pay}</td>
        <td style={{ ...td, whiteSpace: 'nowrap', color: 'var(--fg-muted)' }} title={it.created_at ? formatDateTime(it.created_at) : ''}>{ago(it.created_at)}</td>
        <td style={td}><StatusPill status={it.status} /></td>
        <td style={td}><FlagPills codes={it.flags} /></td>
      </tr>
    );
  };
  const linkRow = (l: SentLink) => (
    <div key={l.id} className="tf-card" style={{ padding: '0.625rem 0.75rem', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '0.8125rem' }}>
      <span style={{ fontWeight: 600 }}>{l.order_id}</span>
      <span style={{ color: 'var(--fg-muted)', overflowWrap: 'anywhere' }}>{l.customer_name || ''}</span>
      <span style={small}>· sent {l.sent_at ? formatDateTime(l.sent_at) : '—'} · {l.state === 'expired' ? 'expired' : daysLeft(l.expires_at)} · {l.opened_count > 0 ? `opened ✓ (${l.opened_count}×)` : 'not opened'}{l.panel ? ` · ${l.panel}` : ''}</span>
      <a className="btn btn-sm" style={{ ...muted, marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }} href={chatHref(l.conversation_id)} target="_blank" rel="noopener noreferrer">
        Open chat <ExternalLink size={12} />
      </a>
    </div>
  );

  // ── Drawer content ──
  const dr = detail?.request;
  const allowed = new Set(detail?.allowed || []);
  const failedEmail = detail?.messages.find((m) => m.id && m.emailed === false) || null;
  const items = Array.isArray(snap.items) ? (snap.items as Record<string, unknown>[]) : [];
  const nowO = detail?.order.now || null;
  const holderName = revealed ? revealed.holder : null;
  const field: CSSProperties = isPhone ? { fontSize: 16 } : {};

  const drawerBody = detail && dr ? (
    <>
      {rejectBanner && (
        <div style={{ ...noteBox('var(--primary)', 'var(--primary-light)'), marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }} className="rf-noprint">
          <span style={{ flex: 1, minWidth: 0 }}>Talk to the customer in the chat now: they were told the team will talk to them there.</span>
          {detail.chat.open_url && <a className="btn btn-sm btn-primary" href={detail.chat.open_url} target="_blank" rel="noopener noreferrer">Open chat</a>}
        </div>
      )}

      {/* 2. Warnings */}
      {detail.flags.length > 0 && (
        <div style={{ display: 'grid', gap: 4, marginBottom: '0.75rem' }}>
          {detail.flags.map((f) => {
            const col = LEVEL_COLOR[f.level] || LEVEL_COLOR.grey;
            const text = f.text.replace(/\s*\[(Post now|Retry)\]\s*$/, '');
            return (
              <div key={f.code} style={{ ...noteBox(col.fg, col.bg), display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ flex: 1, minWidth: 0 }}>{f.level !== 'grey' && <AlertTriangle size={12} style={{ color: col.fg, verticalAlign: '-1px', marginRight: 4 }} />}{text}</span>
                {f.code === 'ack_failed' && allowed.has('post_ack') && (
                  <button type="button" className="btn btn-sm rf-noprint" style={{ ...muted, background: 'var(--card-bg)' }} disabled={!!rowBusy}
                    onClick={() => small_action('post_ack', { action: 'post_ack' }, '"Form received" message posted')}>
                    {rowBusy === 'post_ack' ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : null} Post now
                  </button>
                )}
                {f.code === 'email_failed' && allowed.has('retry_email') && failedEmail && (
                  <button type="button" className="btn btn-sm rf-noprint" style={{ ...muted, background: 'var(--card-bg)' }} disabled={!!rowBusy}
                    onClick={() => small_action('retry_email', { action: 'retry_email', message_id: failedEmail.id }, 'Email sent again')}>
                    {rowBusy === 'retry_email' ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : null} Retry
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 3. Order */}
      <div style={box}>
        <h4 style={sectionTitle}>Order</h4>
        <Row label="Order ID">{s(snap.order_id) || '—'}</Row>
        <Row label="Name">{s(snap.customer_name) || '—'}</Row>
        <Row label="Phone">{s(snap.phone_last4) ? `••••${s(snap.phone_last4)}` : '—'}{nowO?.phone_last4 && nowO.phone_last4 !== s(snap.phone_last4) ? <span style={{ color: 'var(--danger)' }}> (now ••••{nowO.phone_last4})</span> : null}</Row>
        <Row label="Placed on">{s(snap.placed_at) ? formatDateTime(s(snap.placed_at) as string) : '—'}</Row>
        <Row label="Payment">
          <span style={pill(prepaid ? 'var(--danger)' : '#b45309', prepaid ? 'var(--danger-light)' : 'var(--warning-light)')}>{s(snap.payment) || (prepaid ? 'Prepaid' : 'COD')}</span>
          {' '}{total !== null ? formatAmount(total) : ''}{nowO && nowO.total !== null && total !== null && nowO.total !== total ? <span style={{ color: 'var(--danger)' }}> (now {formatAmount(nowO.total)})</span> : null}
        </Row>
        <Row label="Items">
          {items.length ? items.map((i, k) => (
            <span key={k} style={{ display: 'block' }}>{String(i.name ?? '')} × {n(i.qty) ?? 1}{n(i.price) !== null ? ` · ${formatAmount(n(i.price) as number)}` : ''}</span>
          )) : '—'}
        </Row>
        <Row label="Status now">
          {(nowO?.tracking_status ?? s(snap.tracking_status)) || '—'}
          {(nowO?.delivered_at ?? s(snap.delivered_at)) ? ` · delivered ${formatDateTime((nowO?.delivered_at ?? s(snap.delivered_at)) as string)}` : ''}
          {(nowO ? nowO.is_cancelled : snap.is_cancelled === true) ? <span style={{ color: 'var(--danger)' }}> · cancelled</span> : null}
          {!nowO && <span style={small}> (from the form; the order is not in the panel now)</span>}
        </Row>
        {detail.order.changed && <div style={{ ...noteBox('#b45309', 'var(--warning-light)'), marginTop: 6 }}>Changed since the form was sent.</div>}
      </div>

      {/* 4. Customer says */}
      <div style={box}>
        <h4 style={sectionTitle}>Customer says</h4>
        <div style={{ marginBottom: 6 }}><span style={pill('var(--fg)', 'var(--bg-subtle)')}>{reasonText(dr.reason, dr.sub_reason)}</span></div>
        <div style={{ fontSize: '0.8125rem', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.55, color: dr.details ? 'var(--fg)' : 'var(--fg-muted)' }}>{dr.details || '(nothing written)'}</div>
        {dr.checked_around && <div style={{ fontSize: '0.75rem', color: 'var(--success)', marginTop: 6 }}><Check size={12} style={{ verticalAlign: '-1px' }} /> Checked with family / neighbours / security</div>}
        <div style={{ ...small, marginTop: 6 }}>
          Own-name declaration ticked {dr.consent_at ? formatDateTime(dr.consent_at) : '—'}{dr.consent_version ? ` · ${dr.consent_version}` : ''}{dr.device ? ` · ${dr.device}` : ''}
        </div>
      </div>

      {/* 6. Refund to */}
      <div style={box}>
        <h4 style={sectionTitle}>Refund to</h4>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '0.875rem' }}>
          <span style={pill('var(--primary)', 'var(--primary-light)')}>{dr.payout.method === 'upi' ? 'UPI' : 'Bank'}</span>
          <span style={{ fontFamily: 'ui-monospace, monospace', overflowWrap: 'anywhere' }}>{dr.payout.mask}</span>
          {dr.payout.bank_name && <span style={{ color: 'var(--fg-muted)' }}>{dr.payout.bank_name}</span>}
        </div>
        <div style={{ fontSize: '0.75rem', marginTop: 6, color: dr.payout.holder_matches === true ? 'var(--success)' : dr.payout.holder_matches === false ? '#b45309' : 'var(--fg-muted)' }}>
          {dr.payout.holder_matches === true ? '✓ Name matches the order name'
            : dr.payout.holder_matches === false ? `⚠ Name is different from the order name: ${s(snap.customer_name) || '—'}`
            : '— Name could not be compared'}
        </div>
        {revealed ? (
          <div className="rf-noprint" style={{ marginTop: 8, padding: '0.625rem 0.75rem', borderRadius: 8, background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
            {(revealed.method === 'upi'
              ? [['UPI ID', revealed.upi], ['Name', revealed.holder]]
              : [['Account', revealed.account], ['IFSC', revealed.ifsc], ['Bank', revealed.bank_name || ''], ['Holder', revealed.holder]]
            ).filter(([, v]) => v).map(([k, v]) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0.25rem 0', fontSize: '0.875rem' }}>
                <span style={{ width: 64, flexShrink: 0, color: 'var(--fg-muted)', fontSize: '0.75rem' }}>{k}</span>
                <span style={{ flex: 1, minWidth: 0, fontFamily: 'ui-monospace, monospace', fontWeight: 700, overflowWrap: 'anywhere' }}>{v}</span>
                {k !== 'Bank' && (
                  <button type="button" className="btn btn-sm" style={{ ...muted, height: '1.75rem' }} onClick={() => copy(v as string, k)} aria-label={`Copy ${k}`}>
                    <Copy size={12} /> Copy
                  </button>
                )}
              </div>
            ))}
            <div style={{ ...small, marginTop: 4, display: 'flex', gap: 8, alignItems: 'center' }}>
              Hides in {revealLeft} s ·
              <button type="button" onClick={hideReveal} style={{ border: 'none', background: 'none', padding: 0, color: 'var(--primary)', cursor: 'pointer', font: 'inherit' }}>Hide</button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn-sm rf-noprint" style={{ ...muted, marginTop: 8 }} onClick={reveal} disabled={revealing}>
            {revealing ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Eye size={12} />} Show full details
          </button>
        )}
        <div style={{ ...noteBox('var(--danger)', 'var(--danger-light)'), marginTop: 8, fontWeight: 600 }}>
          {holderName
            ? `Before paying, your UPI / bank app must show the name ${holderName}. If it shows another name, stop.`
            : 'Before paying, your UPI / bank app must show the account holder name from "Show full details". If it shows another name, stop.'}
        </div>
        <div style={{ ...small, marginTop: 6 }}>Every full view is recorded.</div>
        {dr.status === 'refunded' && (
          <div style={{ marginTop: 8, fontSize: '0.8125rem' }}>
            <b>Refunded:</b> {dr.refund_amount !== null ? formatAmount(dr.refund_amount) : '—'} · {dr.refund_date ? formatDate(dr.refund_date) : '—'} · UTR <span style={{ fontFamily: 'ui-monospace, monospace' }}>{dr.utr || '—'}</span>
            {dr.gateway_checked ? <span style={small}> · gateway checked</span> : null}
          </div>
        )}
      </div>

      {/* 7. Return */}
      {(allowed.has('return') || dr.return_needed) && (
        <div style={box} className="rf-noprint">
          <h4 style={sectionTitle}>Return pickup</h4>
          {(() => {
            const draft = returnDraft || { needed: dr.return_needed, note: dr.return_note || '' };
            const dirty = !!returnDraft && (returnDraft.needed !== dr.return_needed || (returnDraft.note || '') !== (dr.return_note || ''));
            return (
              <>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8125rem', cursor: allowed.has('return') ? 'pointer' : 'default' }}>
                  <input type="checkbox" checked={draft.needed} disabled={!allowed.has('return') || !!rowBusy}
                    onChange={(e) => setReturnDraft({ ...draft, needed: e.target.checked })} />
                  Return chahiye <span style={small}>(internal: the customer is not told unless you press Tell customer)</span>
                </label>
                {draft.needed && (
                  <input type="text" className="form-input" maxLength={RETURN_NOTE_MAX} placeholder="Internal note (optional)" value={draft.note}
                    disabled={!allowed.has('return')} onChange={(e) => setReturnDraft({ ...draft, note: e.target.value })} style={{ marginTop: 6, ...field }} />
                )}
                {dirty && (
                  <button type="button" className="btn btn-sm btn-primary" style={{ marginTop: 6 }} disabled={!!rowBusy}
                    onClick={async () => { if (await small_action('return', { action: 'return', needed: draft.needed, note: draft.note }, 'Saved')) setReturnDraft(null); }}>
                    {rowBusy === 'return' ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : null} Save
                  </button>
                )}
                {dr.return_needed && (dr.return_told_at ? (
                  <div style={{ ...small, marginTop: 6 }}>Told {formatDateTime(dr.return_told_at)}.</div>
                ) : allowed.has('tell_return') && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ ...small, marginBottom: 4 }}>The customer gets this message ({detail.lang === 'en' ? 'English' : 'Hinglish'}):</div>
                    <div style={{ fontSize: '0.75rem', padding: '0.5rem 0.625rem', borderRadius: 8, background: 'var(--bg-subtle)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                      {detail.previews.return[detail.lang === 'en' ? 'en' : 'hinglish']}
                    </div>
                    <button type="button" className="btn btn-sm" style={{ ...muted, marginTop: 6 }} disabled={!!rowBusy}
                      onClick={() => small_action('tell_return', { action: 'tell_return', lang: detail.lang }, 'Customer told about the return pickup')}>
                      {rowBusy === 'tell_return' ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : null} Tell customer
                    </button>
                  </div>
                ))}
              </>
            );
          })()}
        </div>
      )}

      {/* Messages the customer got */}
      <div style={box}>
        <h4 style={sectionTitle}>Messages to the customer</h4>
        {detail.messages.length === 0 && <div style={small}>None yet.</div>}
        {detail.messages.map((m, i) => (
          <div key={`${m.id || 'x'}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '0.8125rem', padding: '0.25rem 0' }}>
            <span style={{ fontWeight: 600, color: m.failed ? 'var(--danger)' : 'var(--fg)' }}>{STEP_LABEL[m.step] || m.step}{m.failed ? ' · NOT sent' : ''}</span>
            <span style={small}>{m.at ? formatDateTime(m.at) : ''}{m.lang ? ` · ${m.lang === 'en' ? 'English' : 'Hinglish'}` : ''}{m.emailed === true ? ' · emailed' : m.emailed === false ? ' · email failed' : ''}</span>
            {m.emailed === false && m.id && allowed.has('retry_email') && (
              <button type="button" className="btn btn-sm rf-noprint" style={{ ...muted, height: '1.625rem' }} disabled={!!rowBusy}
                onClick={() => small_action('retry_email', { action: 'retry_email', message_id: m.id }, 'Email sent again')}>Retry</button>
            )}
          </div>
        ))}
        {!dr.ack_posted && allowed.has('post_ack') && !detail.flags.some((f) => f.code === 'ack_failed') && (
          <div style={{ ...small, marginTop: 4 }}>The "form received" message is not in the chat yet.</div>
        )}
      </div>

      {/* 8. Notes & history */}
      <div style={box}>
        <h4 style={sectionTitle}>Notes &amp; history</h4>
        <div className="rf-noprint" style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          <input type="text" className="form-input" maxLength={NOTE_MAX} placeholder="Add a note (only you see it)" value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)} style={{ flex: 1, minWidth: 0, ...field }} />
          <button type="button" className="btn btn-sm" style={muted} disabled={!noteDraft.trim() || !!rowBusy}
            onClick={async () => { if (await small_action('note', { action: 'note', note: noteDraft.trim() }, 'Note saved')) setNoteDraft(''); }}>
            {rowBusy === 'note' ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : null} Add note
          </button>
        </div>
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {detail.events.map((e, i) => {
            const meta = e.meta || {};
            let extra = '';
            if (e.kind === 'status') extra = `${e.from || '?'} → ${e.to || '?'}`;
            else if (e.kind === 'message_posted' || e.kind === 'message_failed' || e.kind === 'email_sent' || e.kind === 'email_failed') extra = STEP_LABEL[String(meta.step ?? '')] || String(meta.step ?? '');
            else if (e.kind === 'link_opened' || e.kind === 'revealed') extra = String(meta.device ?? '');
            else if (e.kind === 'link_revoked') extra = meta.reason === 'reissued' ? 'a new link was sent' : meta.reason === 'cancelled' ? 'cancelled' : '';
            else if (e.kind === 'return_flag') extra = meta.needed ? 'on' : 'off';
            if (e.kind === 'email_failed' && meta.code) extra += ` (${String(meta.code)})`;
            return (
              <li key={i} style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr' : 'minmax(0, 8.5rem) minmax(0, 1fr)', gap: isPhone ? 0 : 8, padding: '0.3125rem 0', borderTop: i ? '1px solid var(--border)' : 'none', fontSize: '0.75rem' }}>
                <span style={{ color: 'var(--fg-muted)' }}>{e.at ? formatDateTime(e.at) : ''}</span>
                <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  <b style={{ fontWeight: 600, color: e.kind === 'message_failed' || e.kind === 'email_failed' ? 'var(--danger)' : 'var(--fg)' }}>{EVENT_LABEL[e.kind] || e.kind}</b>
                  {extra ? ` · ${extra}` : ''}{e.actor && ACTOR[e.actor] && e.kind !== 'viewed' ? <span style={{ color: 'var(--fg-muted)' }}> · {ACTOR[e.actor]}</span> : null}
                  {e.note ? <span style={{ display: 'block', whiteSpace: 'pre-wrap', color: 'var(--fg)', marginTop: 2 }}>“{e.note}”</span> : null}
                </span>
              </li>
            );
          })}
        </ol>
        <div style={{ ...small, marginTop: 6 }}>
          Form sent {detail.link.sent_at ? formatDateTime(detail.link.sent_at) : '—'} · opened {detail.link.opened_count}×
          {detail.link.devices.length ? ` · ${detail.link.devices.join(', ')}` : ''}
        </div>
      </div>
    </>
  ) : null;

  const actions: { key: Move; label: string; primary?: boolean }[] = !dr ? [] : [
    ...(allowed.has('approve') ? [{ key: 'approve' as Move, label: 'Approve', primary: true }] : []),
    ...(allowed.has('refunded') ? [{ key: 'refunded' as Move, label: 'Mark refunded', primary: true }] : []),
    ...(allowed.has('reject') ? [{ key: 'reject' as Move, label: 'Reject' }] : []),
  ];
  const canCancel = !!dr && allowed.has('cancel');

  // ── Move dialog content ──
  const previewText = (() => {
    if (!detail || !move || move === 'cancel') return null;
    const p = move === 'approve' ? detail.previews.approved : move === 'reject' ? detail.previews.rejected : detail.previews.refunded;
    let t = p[mLang];
    if (move === 'refunded') {
      const a = checkAmount(mAmount, total);
      t = t.replace('{amount}', a.ok ? formatAmount(a.value) : '₹…')
        .replace('{date}', /^\d{4}-\d{2}-\d{2}$/.test(mDate) ? formatDate(mDate) : '…')
        .replace('{utr}', checkUtr(mUtr).ok ? checkUtr(mUtr).value : '…');
    }
    return t;
  })();
  const liveWarn: string[] = [];
  if (move === 'refunded' && dr) {
    const u = checkUtr(mUtr, dr.payout.method);
    if (u.ok && u.warn === 'utr_not_upi') liveWarn.push('A UPI refund reference is usually 12 digits. Check it once.');
    const a = checkAmount(mAmount, total);
    if (a.ok && a.warn === 'partial' && total !== null) liveWarn.push(`Less than the order total (${formatAmount(total)}): a partial refund.`);
  }
  const fieldErr = (k: string) => (mErrors[k] ? <div style={{ fontSize: '0.75rem', color: 'var(--danger)', marginTop: 2 }}>{mErrors[k]}</div> : null);
  const moveTitle = move === 'approve' ? 'Approve this refund?' : move === 'reject' ? 'Reject this request?' : move === 'refunded' ? 'Mark refunded' : 'Cancel this request?';
  const moveButton = move === 'approve' ? 'Approve & tell customer' : move === 'reject' ? 'Reject & tell customer' : move === 'refunded' ? 'Mark refunded & send reference' : 'Cancel request';

  const moveDialog = move && detail && dr ? (
    <div className="modal-overlay" style={{ zIndex: 60 }} onClick={() => !mBusy && setMove(null)}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="rf-move-title" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '34rem' }}>
        <div className="modal-header" style={{ alignItems: 'flex-start', gap: 8 }}>
          <div style={{ minWidth: 0 }}>
            <h3 id="rf-move-title" className="modal-title">{moveTitle}</h3>
            <p className="modal-subtitle">{dr.ref} · {s(snap.order_id) || ''} · {s(snap.customer_name) || ''}</p>
          </div>
          <button type="button" className="btn-icon" onClick={() => setMove(null)} aria-label="Close" disabled={mBusy}><X size={16} /></button>
        </div>
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          {move === 'refunded' && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr' : 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 600 }}>Amount ₹
                  <input type="text" inputMode="decimal" className="form-input" value={mAmount} onChange={(e) => setMAmount(e.target.value)} style={{ marginTop: 4, ...field }} />
                  {fieldErr('amount')}
                </label>
                <label style={{ fontSize: '0.75rem', fontWeight: 600 }}>Paid on
                  <input type="date" className="form-input" value={mDate} min={dr.created_at ? istDay(dr.created_at) : undefined} max={istDay(Date.now())}
                    onChange={(e) => setMDate(e.target.value)} style={{ marginTop: 4, ...field }} />
                  {fieldErr('refund_date')}
                </label>
              </div>
              <label style={{ fontSize: '0.75rem', fontWeight: 600 }}>UTR / reference number
                <input type="text" className="form-input" value={mUtr} autoComplete="off" spellCheck={false} maxLength={40}
                  onChange={(e) => setMUtr(e.target.value)} style={{ marginTop: 4, fontFamily: 'ui-monospace, monospace', ...field }} />
                {fieldErr('utr')}
              </label>
              <div style={{ fontSize: '0.8125rem' }}><span style={{ color: 'var(--fg-muted)' }}>To:</span> <span style={{ fontFamily: 'ui-monospace, monospace' }}>{payoutText(dr.payout)}</span></div>
              {!(total && total > 0) && (
                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.8125rem' }}>
                  <input type="checkbox" checked={mAmountOk} onChange={(e) => setMAmountOk(e.target.checked)} style={{ marginTop: 3 }} />
                  <span>The order total is not known: I checked this amount (at most {formatAmount(AMOUNT_CAP)}).</span>
                </label>
              )}
              {fieldErr('amount_ok')}
              {prepaid && (
                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.8125rem', ...noteBox('var(--danger)', 'var(--danger-light)') }}>
                  <input type="checkbox" checked={mGateway} onChange={(e) => setMGateway(e.target.checked)} style={{ marginTop: 3 }} />
                  <span>I checked the payment gateway: no refund or chargeback is already open for this payment.</span>
                </label>
              )}
              {fieldErr('gateway_checked')}
              {liveWarn.map((w) => <div key={w} style={noteBox('#b45309', 'var(--warning-light)')}>{w}</div>)}
            </>
          )}
          <label style={{ fontSize: '0.75rem', fontWeight: 600 }}>
            {move === 'reject' || move === 'cancel' ? 'Note (required)' : 'Note (optional)'}
            <textarea className="form-input" rows={2} maxLength={NOTE_MAX} value={mNote} onChange={(e) => setMNote(e.target.value)}
              style={{ marginTop: 4, height: 'auto', padding: '0.5rem 0.75rem', resize: 'vertical', ...field }} />
            <span style={{ ...small, display: 'block', fontWeight: 400 }}>Only you see this. It is never sent to the customer.</span>
            {fieldErr('note')}
          </label>
          {move === 'cancel' ? (
            <div style={noteBox('var(--fg-muted)', 'var(--bg-subtle)')}>The customer is not told anything. You can then send a new form from the chat.</div>
          ) : (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
                <span style={{ ...small, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>The customer gets this message:</span>
                {(['hinglish', 'en'] as Lang[]).map((l) => (
                  <label key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.75rem', cursor: 'pointer' }}>
                    <input type="radio" name="rf-move-lang" checked={mLang === l} onChange={() => setMLang(l)} /> {l === 'en' ? 'English' : 'Hinglish'}
                    {detail.lang === l ? <span style={small}>(chat)</span> : null}
                  </label>
                ))}
              </div>
              <div style={{ padding: '0.625rem 0.75rem', borderRadius: 10, background: 'var(--bg-subtle)', border: '1px solid var(--border)', fontSize: '0.8125rem', lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {previewText}
              </div>
            </div>
          )}
          {mError && <div role="alert" style={noteBox('var(--danger)', 'var(--danger-light)')}>{mError}</div>}
        </div>
        <div className="modal-actions" style={{ marginTop: '1rem' }}>
          <button type="button" className="btn btn-outline" onClick={() => setMove(null)} disabled={mBusy}>Back</button>
          <button type="button" className="btn btn-primary" onClick={submitMove} disabled={mBusy}
            style={move === 'reject' || move === 'cancel' ? { background: 'var(--danger)' } : undefined}>
            {mBusy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : null} {moveButton}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap', marginBottom: '1rem' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 className="page-title">Refund requests</h2>
          <p style={{ fontSize: '0.8125rem', color: 'var(--fg-muted)', marginTop: 2 }}>
            Only you (Super Admin) can see this · UPI / bank details are encrypted · forms are sent only from a Refund chat
          </p>
        </div>
        <button type="button" className="btn btn-sm" style={muted} disabled={loading} onClick={() => load(view)}>
          <RefreshCw size={13} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} /> Refresh
        </button>
      </div>

      {/* Chips + search */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {VIEWS.map((c) => {
            const k = countOf(c.v);
            const on = view === c.v;
            return (
              <button key={c.v} type="button" className="btn btn-sm" aria-pressed={on} onClick={() => { setView(c.v); setQ(''); }}
                style={{ ...muted, ...(on ? chosen : {}), height: 'auto', padding: '0.25rem 0.625rem', flexDirection: 'column', alignItems: 'flex-start', gap: 0, lineHeight: 1.25 }}>
                <span style={{ fontWeight: 600 }}>{c.label}{k !== null ? ` ${k}` : ''}{c.v === 'new' && counts && counts.unseen > 0 ? <span style={{ ...pill('#fff', 'var(--danger)'), marginLeft: 4 }}>{counts.unseen} unseen</span> : null}</span>
                <span style={{ fontSize: '0.625rem', fontWeight: 400 }}>{c.hint}</span>
              </button>
            );
          })}
        </div>
        <label style={{ position: 'relative', marginLeft: isPhone ? 0 : 'auto', flex: isPhone ? '1 1 100%' : '0 1 16rem', minWidth: 0 }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--fg-muted)' }} aria-hidden />
          <input type="search" className="form-input" placeholder="Ref / order / name" value={q} onChange={(e) => setQ(e.target.value)}
            aria-label="Search the loaded requests" style={{ paddingLeft: 30, height: '2.25rem', ...field }} />
        </label>
      </div>

      {list?.setup && (
        <div style={{ ...noteBox('#b45309', 'var(--warning-light)'), marginBottom: '0.75rem' }}>
          {list.setup === 'off'
            ? 'Refund forms are switched off (REFUND_FORMS=off): customers see "not available" and Send is off. This list still works.'
            : 'The refund key is missing on the server: customers see "not available", Send is off and full details cannot be shown. This list still works.'}
        </div>
      )}
      {down && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '0.5rem 0.75rem', marginBottom: '0.75rem', borderRadius: 10, background: 'var(--danger-light)', color: 'var(--danger)', fontSize: '0.8125rem' }}>
          <span style={{ overflowWrap: 'anywhere' }}>{down}</span>
          <button type="button" className="btn btn-sm" style={{ ...muted, background: 'var(--card-bg)' }} disabled={loading} onClick={() => load(view)}>Retry</button>
        </div>
      )}

      {/* List */}
      {loading && !list && (
        <div className="tf-card" style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--fg-muted)', fontSize: '0.8125rem' }}>
          <Loader2 size={16} style={{ animation: 'spin 1s linear infinite', verticalAlign: 'middle' }} /> Loading…
        </div>
      )}
      {list && view === 'sent' && (
        links.length ? <div>{links.map(linkRow)}</div> : (
          <div className="tf-card" style={{ padding: '1.5rem 1rem', color: 'var(--fg-muted)', fontSize: '0.8125rem', textAlign: 'center' }}>
            {q ? 'Nothing matches.' : 'No open form links. Send a form from a chat in the Refund section.'}
          </div>
        )
      )}
      {list && view !== 'sent' && (rows.length ? (isPhone ? <div>{rows.map(itemRow)}</div> : (
        <div className="tf-card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Ref</th><th style={th}>Order</th><th style={th}>Problem</th><th style={th}>Refund to</th>
                <th style={th}>Payment</th><th style={th}>When</th><th style={th}>Status</th><th style={th}>Flags</th>
              </tr>
            </thead>
            <tbody>{rows.map(itemRow)}</tbody>
          </table>
        </div>
      )) : (
        <div className="tf-card" style={{ padding: '1.5rem 1rem', color: 'var(--fg-muted)', fontSize: '0.8125rem', textAlign: 'center' }}>
          {q ? 'Nothing matches.' : view === 'new' ? 'No new refund requests.' : 'Nothing here.'}
        </div>
      ))}
      {list && view !== 'sent' && list.next_before && !q && (
        <div style={{ textAlign: 'center', marginTop: 8 }}>
          <button type="button" className="btn btn-sm" style={muted} disabled={moreLoading} onClick={() => load(view, list.next_before)}>
            {moreLoading ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : null} Show more
          </button>
        </div>
      )}

      {/* Detail drawer (portal: the admin page's .animate-fade-in-up transform would pin position:fixed to the card) */}
      {openReq && createPortal(
        <div className="modal-overlay rf-print-host" onClick={closeDrawer} style={{ padding: 0, justifyContent: 'flex-end', alignItems: 'stretch' }}>
          <div role="dialog" aria-modal="true" aria-label={dr ? `Refund request ${dr.ref}` : 'Refund request'} onClick={(e) => e.stopPropagation()} className="rf-drawer"
            style={{ width: isPhone ? '100%' : 520, maxWidth: '100%', height: '100%', background: 'var(--card-bg)', borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', animation: 'slideInRight 0.2s ease' }}>
            {/* 1. Header */}
            <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid var(--border)' }}>
              {isPhone && (
                <button type="button" className="btn btn-sm rf-noprint" style={{ ...muted, marginBottom: 8 }} onClick={closeDrawer}><ChevronLeft size={14} /> Back</button>
              )}
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'ui-monospace, monospace' }}>{dr?.ref || '…'}</span>
                    {dr && <StatusPill status={dr.status} />}
                  </h3>
                  {dr && (
                    <p className="modal-subtitle" style={{ overflowWrap: 'anywhere' }}>
                      Submitted {dr.created_at ? formatDateTime(dr.created_at) : '—'}{dr.device ? ` · ${dr.device}` : ''}
                      {dr.status !== 'new' && dr.status_at ? ` · ${STATUS_PILL[dr.status].label} ${formatDateTime(dr.status_at)}` : ''}
                    </p>
                  )}
                </div>
                <div className="rf-noprint" style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                  {detail?.chat.open_url && (
                    <a className="btn btn-sm" style={{ ...muted, display: 'inline-flex', alignItems: 'center', gap: 4 }} href={detail.chat.open_url} target="_blank" rel="noopener noreferrer">
                      Open chat <ExternalLink size={12} />
                    </a>
                  )}
                  {detail && !isPhone && (
                    <button type="button" className="btn-icon" onClick={() => window.print()} aria-label="Print" title="Print (UPI / bank stay masked)"><Printer size={16} /></button>
                  )}
                  {!isPhone && <button type="button" className="btn-icon" onClick={closeDrawer} aria-label="Close"><X size={16} /></button>}
                </div>
              </div>
            </div>
            <div className="rf-drawer-body" style={{ flex: 1, overflowY: 'auto', padding: '0.75rem 1rem 1rem' }}>
              {detailLoading && !detail && (
                <div style={{ padding: '1.5rem 0', textAlign: 'center', color: 'var(--fg-muted)', fontSize: '0.8125rem' }}>
                  <Loader2 size={16} style={{ animation: 'spin 1s linear infinite', verticalAlign: 'middle' }} /> Loading…
                </div>
              )}
              {detailErr && (
                <div style={{ padding: '1rem 0', color: 'var(--danger)', fontSize: '0.8125rem', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  {detailErr}
                  <button type="button" className="btn btn-sm" style={muted} onClick={() => openReq && loadDetail(openReq)}>Retry</button>
                </div>
              )}
              {drawerBody}
            </div>
            {/* 9. Sticky action bar */}
            {dr && (actions.length > 0 || canCancel) && (
              <div className="rf-noprint" style={{ padding: '0.625rem 1rem', borderTop: '1px solid var(--border)', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', background: 'var(--card-bg)' }}>
                {actions.map((a) => (
                  <button key={a.key} type="button" className={`btn btn-sm ${a.primary ? 'btn-primary' : ''}`} style={a.primary ? undefined : { ...muted, color: 'var(--danger)', borderColor: 'var(--danger)' }}
                    onClick={() => openMove(a.key)}>{a.label}</button>
                ))}
                {canCancel && (
                  <div style={{ marginLeft: 'auto', position: 'relative' }}>
                    <button type="button" className="btn btn-sm" style={muted} aria-expanded={moreOpen} onClick={() => setMoreOpen((v) => !v)}>⋯</button>
                    {moreOpen && (
                      <div style={{ position: 'absolute', right: 0, bottom: '110%', background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: 'var(--shadow-lg)', padding: 4, minWidth: 180 }}>
                        <button type="button" onClick={() => openMove('cancel')}
                          style={{ display: 'block', width: '100%', textAlign: 'left', padding: '0.5rem 0.625rem', border: 'none', background: 'none', cursor: 'pointer', fontSize: '0.8125rem', color: 'var(--fg)' }}>
                          Cancel request…
                          <span style={{ ...small, display: 'block' }}>internal, the customer is not told</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>, document.body,
      )}
      {moveDialog && createPortal(moveDialog, document.body)}

      <style>{`
        .rf-row:hover td { background: var(--bg-subtle); }
        @media print {
          body > *:not(.rf-print-host) { display: none !important; }
          .rf-print-host { position: static !important; background: #fff !important; padding: 0 !important; display: block !important; }
          .rf-drawer { width: 100% !important; height: auto !important; border: none !important; animation: none !important; }
          .rf-drawer-body { overflow: visible !important; }
          .rf-noprint { display: none !important; }
        }
      `}</style>
    </div>
  );
}
