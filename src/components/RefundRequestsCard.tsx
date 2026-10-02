'use client';

// ── Refund requests (owner, 2026-10-02): the Super Admin's tab next to Team score ──
// SUPER ADMIN ONLY (the admin page shows the tab only to him; every /api/refunds/* route checks again).
// The team, Chikki, the learner, search and the team score never see any of this. Customers only ever
// see "Vastora Support" messages in their chat, one fixed text per step (never the internal note).
// UPI / bank details are stored encrypted and shown masked here; the full details come only from
// "Show full details" (POST /api/refunds/<id>/reveal: recorded, 30 an hour) and hide again after 60 s.
// Owner change 2026-10-02 ~15:00: no photo / video upload, so there is no photos section.
// Spec refund_form_spec.md 7.2 - 7.4.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ExternalLink, Loader2, Printer, RefreshCw, X } from 'lucide-react';
import { formatAmount, formatDate, formatDateTime } from '@/lib/refund/texts';
import { checkAmount, checkUtr, isCod, istDay } from '@/lib/refund/rules';
import {
  ADMIN_ERR, STATUS_PILL, StatusPill, UUID, muted, n, noteBox, s, small, th,
  type Detail, type Lang, type ListAnswer, type Move, type Revealed, type ViewKey,
} from './RefundRequestsShared';
import { ItemRow, LinkRow } from './RefundRequestRows';
import RefundDrawerBody from './RefundDrawerBody';
import RefundMoveDialog from './RefundMoveDialog';
import RefundFilters from './RefundFilters';

interface Props {
  token: string;
  onAlert: (type: string, message: string) => void;
  openId?: string | null;          // deep link /admin?tab=refunds&open=<id> (from the chat's "Open request")
  onSeen?: () => void;             // the badge's counts changed (a request was opened or moved)
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

  // ── Drawer content ──
  const dr = detail?.request;
  const allowed = new Set(detail?.allowed || []);
  const failedEmail = detail?.messages.find((m) => m.id && m.emailed === false) || null;
  const items = Array.isArray(snap.items) ? (snap.items as Record<string, unknown>[]) : [];
  const nowO = detail?.order.now || null;
  const holderName = revealed ? revealed.holder : null;
  const field: CSSProperties = isPhone ? { fontSize: 16 } : {};

  const drawerBody = detail && dr ? (
    <RefundDrawerBody detail={detail} dr={dr} rejectBanner={rejectBanner} allowed={allowed} failedEmail={failedEmail} rowBusy={rowBusy} small_action={small_action}
      snap={snap} nowO={nowO} prepaid={prepaid} total={total} items={items} revealed={revealed} copy={copy} hideReveal={hideReveal} revealLeft={revealLeft}
      reveal={reveal} revealing={revealing} holderName={holderName} returnDraft={returnDraft} setReturnDraft={setReturnDraft} field={field}
      noteDraft={noteDraft} setNoteDraft={setNoteDraft} isPhone={isPhone} />
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
    <RefundMoveDialog move={move} detail={detail} dr={dr} mBusy={mBusy} setMove={setMove} moveTitle={moveTitle} snap={snap} isPhone={isPhone}
      mAmount={mAmount} setMAmount={setMAmount} fieldErr={fieldErr} mDate={mDate} setMDate={setMDate} mUtr={mUtr} setMUtr={setMUtr} field={field} total={total}
      mAmountOk={mAmountOk} setMAmountOk={setMAmountOk} prepaid={prepaid} mGateway={mGateway} setMGateway={setMGateway} liveWarn={liveWarn}
      mNote={mNote} setMNote={setMNote} mLang={mLang} setMLang={setMLang} previewText={previewText} mError={mError} submitMove={submitMove} moveButton={moveButton} />
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
      <RefundFilters countOf={countOf} view={view} setView={setView} setQ={setQ} counts={counts} isPhone={isPhone} q={q} field={field} />

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
        links.length ? <div>{links.map((l) => <LinkRow key={l.id} l={l} chatHref={chatHref} />)}</div> : (
          <div className="tf-card" style={{ padding: '1.5rem 1rem', color: 'var(--fg-muted)', fontSize: '0.8125rem', textAlign: 'center' }}>
            {q ? 'Nothing matches.' : 'No open form links. Send a form from a chat in the Refund section.'}
          </div>
        )
      )}
      {list && view !== 'sent' && (rows.length ? (isPhone ? <div>{rows.map((it) => <ItemRow key={it.id} it={it} isPhone={isPhone} openDrawer={openDrawer} />)}</div> : (
        <div className="tf-card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Ref</th><th style={th}>Order</th><th style={th}>Problem</th><th style={th}>Refund to</th>
                <th style={th}>Payment</th><th style={th}>When</th><th style={th}>Status</th><th style={th}>Flags</th>
              </tr>
            </thead>
            <tbody>{rows.map((it) => <ItemRow key={it.id} it={it} isPhone={isPhone} openDrawer={openDrawer} />)}</tbody>
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
