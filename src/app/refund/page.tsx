'use client';

// ── The customer's refund form, /refund (owner, 2026-10-02) ─────
// Only the Super Admin sends it ("Send refund form" in a Refund chat); it arrives in that chat as
// "Vastora Support". One link = one order, one submit, 7 days. Spec refund_form_spec.md section 5.
//
// What the customer does here (owner change 2026-10-02 ~15:00: NO photo / video upload, "humein sirf
// bank details mil jaye bahut hai"):
//   1. What went wrong: one of 4 reasons (+ its sub-option); "shows delivered, not received" also
//      needs the "checked with family / neighbours / security" tick (owner answer Q12); a details text.
//   2. Where the refund goes: UPI ID (+ the name the UPI app shows) or bank account (holder name,
//      account number typed twice, IFSC). Every order, COD and prepaid (owner answer Q1).
//   3. Check once, tick the own-name declaration (Q10), submit.
// The order ID, name and phone (last 4 only, Q9) come from the server's snapshot and are shown locked;
// they are never sent back (the server ignores them anyway, master rule 30).
//
// Privacy rules of this page (refund-isolation.js I10 pins them):
//   - the link's key is read from the URL fragment, kept only in this tab's sessionStorage (rf_t) and
//     removed from the address bar at once; it travels only in POST bodies, never in a URL;
//   - UPI / bank values live only in React state: never in any browser storage. The tab's draft
//     (rf_draft) holds the reason, sub-option, tick, details and method only; rf_n is the submit's
//     client_nonce, so a retried submit is the same submit;
//   - every text is React text; no third-party script, no logging.
// Every label is English with a Devanagari line under it (owner answer Q8), from src/lib/refund/texts.ts.
// The few strings texts.ts does not have yet are in LOCAL below.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AlertCircle, Check, ChevronDown, ChevronUp, Eye, EyeOff, Loader2, Lock } from 'lucide-react';
import {
  REASONS, SUB_REASONS, UUID_V4_RE, needsCheckedAround, checkReason, checkSubReason, checkCheckedAround, checkDetails,
  cleanDetails, checkMethod, checkHolder, checkUpi, normUpi, normHolder, checkAccount, checkAccountConfirm, normAccount,
  checkIfsc, normIfsc, checkConsent, DETAILS_MAX, type Method, type Reason,
} from '@/lib/refund/rules';
import {
  PAGE, STATUS_VIEW, SCREENS, ERRORS, REASON_TEXT, SUB_REASON_TEXT, DETAILS_PLACEHOLDER, CONSENT_TEXT, fill, formatAmount,
  formatDate, formatDayMonth, formatDateTime, maskedPhone, bankName, upiHandleKnown, type Bi, type ScreenState,
} from '@/lib/refund/texts';

// ── Look (the tracking page's colours: track/[token]/page.tsx) ──
const C = {
  bg: '#EFF3F8', card: '#FFFFFF', border: '#E2E8F0', field: '#CBD5E1', primary: '#F97316', primaryDark: '#EA580C',
  text: '#0F172A', muted: '#64748B', error: '#EF4444', errorBg: '#FEF2F2', success: '#10B981', successBg: '#ECFDF5',
  amber: '#B45309', amberBg: '#FFFBEB', soft: '#F8FAFC',
};

// Strings texts.ts does not carry yet (same English + Devanagari pattern).
const LOCAL = {
  back: { en: 'Back', hi: 'पीछे' },
  optional: { en: '(optional)', hi: '(ज़रूरी नहीं)' },
  detailsHintOptional: { en: 'You can skip this. Please do not write bank details here.', hi: 'चाहें तो छोड़ सकते हैं। यहाँ बैंक की जानकारी न लिखें।' },
  checkThese: { en: 'Please check the fields marked in red.', hi: 'कृपया लाल रंग वाली जगहें देख लें।' },
  sending: { en: 'Sending…', hi: 'भेजा जा रहा है…' },
  tryAgain: { en: 'Try again', hi: 'फिर से कोशिश करें' },
  showOrder: { en: 'Show order', hi: 'ऑर्डर देखें' },
  hideOrder: { en: 'Hide', hi: 'छिपाएँ' },
  loading: { en: 'Opening your form…', hi: 'आपका फ़ॉर्म खुल रहा है…' },
  checkedAroundDone: { en: 'Checked with family / neighbours / security', hi: 'घर वालों / पड़ोसियों / सिक्योरिटी से पूछ लिया' },
  accountsMatch: { en: 'Both numbers match', hi: 'दोनों नंबर एक जैसे हैं' },
  noDetails: { en: '(nothing written)', hi: '(कुछ नहीं लिखा)' },
  stepWord: { en: 'Step', hi: 'चरण' },
  requestNumber: { en: 'Request number', hi: 'अनुरोध नंबर' },
  alreadyRequested: {
    title: { en: 'A refund request is already open', hi: 'रिफंड अनुरोध पहले से खुला है' },
    body: { en: 'This order already has a refund request. Our team will update you in your chat.', hi: 'इस ऑर्डर का रिफंड अनुरोध पहले से है। टीम आपकी चैट में बताएगी।' },
  },
  error: { title: { en: 'Could not open the form', hi: 'फ़ॉर्म नहीं खुल पाया' }, body: ERRORS.network },
};

// The details box is optional when the shared rule accepts an empty text (owner change 2026-10-02:
// "an optional details text"); until rules.ts allows it, it asks for at least 10 letters like the server.
const DETAILS_OPTIONAL = checkDetails('').ok;

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
// This tab's sessionStorage: exactly three keys, written only here (private mode: the tab still works).
const ss = {
  get(k: 'rf_t' | 'rf_n' | 'rf_draft'): string | null { try { return window.sessionStorage.getItem(k); } catch { return null; } },
  token(v: string) { try { window.sessionStorage.setItem('rf_t', v); } catch { /* ignore */ } },
  nonce(v: string) { try { window.sessionStorage.setItem('rf_n', v); } catch { /* ignore */ } },
  draft(v: string) { try { window.sessionStorage.setItem('rf_draft', v); } catch { /* ignore */ } },
  dropNonce() { try { window.sessionStorage.removeItem('rf_n'); } catch { /* ignore */ } },
  dropDraft() { try { window.sessionStorage.removeItem('rf_draft'); } catch { /* ignore */ } },
};
// The address bar goes back to plain /refund. Again after a tick: Next.js's router writes its first URL
// (with the #key) into history after this page's own first effect, and a null state lets it take /refund.
const stripAddress = () => {
  const strip = () => {
    try { if (window.location.hash || window.location.search) window.history.replaceState(null, '', '/refund'); } catch { /* ignore */ }
  };
  strip();
  setTimeout(strip, 0);
  setTimeout(strip, 400);
};

// The link's key: from #<43 chars> (then kept for this tab and removed from the address bar), else
// the one this tab already had. A new key starts a new draft and a new submit id.
function readToken(): string | null {
  let hash = '';
  try { hash = window.location.hash.slice(1); } catch { /* ignore */ }
  if (TOKEN_RE.test(hash)) {
    if (ss.get('rf_t') !== hash) { ss.dropDraft(); ss.dropNonce(); }
    ss.token(hash);
    stripAddress();
    return hash;
  }
  if (hash) stripAddress();
  const kept = ss.get('rf_t');
  return kept && TOKEN_RE.test(kept) ? kept : null;
}
function newNonce(): string {
  const c: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
// One submit id per tab: a retry after a lost answer is the same submit (the server answers the same ref).
function submitNonce(): string {
  const kept = ss.get('rf_n');
  if (kept && UUID_V4_RE.test(kept)) return kept;
  const n = newNonce();
  ss.nonce(n);
  return n;
}

type Ans = { status: number; data: Record<string, unknown> } | null;   // null = no answer (network)
async function call(path: string, body: Record<string, unknown>): Promise<Ans> {
  try {
    const r = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      cache: 'no-store', credentials: 'same-origin', referrerPolicy: 'no-referrer',
    });
    let data: unknown = null;
    try { data = await r.json(); } catch { data = null; }
    return { status: r.status, data: data && typeof data === 'object' ? data as Record<string, unknown> : {} };
  } catch {
    return null;
  }
}
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ── What the server sends (spec 3.1) ───────────────────────────
interface Brand { name: string | null; logo_url: string | null }
interface OpenOrder {
  order_id: string | null; name: string | null; phone_last4: string | null; total: number | null; payment: string | null;
  items: { name: string; qty: number }[]; placed_on: string | null;
}
type PublicStatus = 'received' | 'approved' | 'not_approved' | 'refunded' | 'closed';
interface StatusRequest {
  ref: string; submitted_at: string | null; status: PublicStatus; payout: string;
  refunded: null | { amount: number | null; date: string | null; utr: string | null };
}
type ScreenKind = ScreenState | 'error' | 'already_requested';
type View =
  | { kind: 'loading' }
  | { kind: 'screen'; screen: ScreenKind; brand: Brand | null }
  | { kind: 'form'; brand: Brand; order: OpenOrder; expiresAt: string | null }
  | { kind: 'status'; brand: Brand; request: StatusRequest }
  | { kind: 'done'; brand: Brand; ref: string };

function brandOf(v: unknown): Brand {
  const b = v && typeof v === 'object' ? v as Record<string, unknown> : {};
  const logo = str(b.logo_url);
  return { name: str(b.name), logo_url: logo && /^https?:\/\//i.test(logo) ? logo : null };
}
function orderOf(v: unknown): OpenOrder {
  const o = v && typeof v === 'object' ? v as Record<string, unknown> : {};
  const items = Array.isArray(o.items) ? o.items : [];
  return {
    order_id: str(o.order_id), name: str(o.name), phone_last4: str(o.phone_last4), total: numOrNull(o.total),
    payment: str(o.payment), placed_on: str(o.placed_on),
    items: items.map((i) => {
      const x = i && typeof i === 'object' ? i as Record<string, unknown> : {};
      return { name: typeof x.name === 'string' ? x.name : '', qty: numOrNull(x.qty) ?? 1 };
    }).filter((i) => i.name),
  };
}
function statusOf(v: unknown): StatusRequest | null {
  const r = v && typeof v === 'object' ? v as Record<string, unknown> : null;
  if (!r || !str(r.ref)) return null;
  const st = (['received', 'approved', 'not_approved', 'refunded', 'closed'] as PublicStatus[]).includes(r.status as PublicStatus)
    ? r.status as PublicStatus : 'received';
  const rf = r.refunded && typeof r.refunded === 'object' ? r.refunded as Record<string, unknown> : null;
  return {
    ref: str(r.ref) as string, submitted_at: str(r.submitted_at), status: st, payout: str(r.payout) || '',
    refunded: rf ? { amount: numOrNull(rf.amount), date: str(rf.date), utr: str(rf.utr) } : null,
  };
}
const screenFor = (state: unknown): ScreenKind =>
  (['invalid', 'expired', 'replaced', 'cancelled', 'used', 'closed', 'slow_down'].includes(String(state)) ? state as ScreenState : 'error');

// ── Small pieces ───────────────────────────────────────────────
const hiLine: CSSProperties = { display: 'block', fontSize: 13, color: C.muted, lineHeight: 1.45, fontWeight: 400 };
function Hi({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <span lang="hi" style={{ ...hiLine, ...style }}>{children}</span>;
}
function Title({ t, size = 18, as: Tag = 'h2', id }: { t: Bi; size?: number; as?: 'h1' | 'h2' | 'h3'; id?: string }) {
  return (
    <Tag id={id} style={{ fontSize: size, fontWeight: 700, color: C.text, lineHeight: 1.3, margin: '0 0 12px' }}>
      {t.en}<Hi style={{ fontSize: Math.max(13, size - 4), marginTop: 2 }}>{t.hi}</Hi>
    </Tag>
  );
}
function FieldLabel({ t, htmlFor, id, extra }: { t: Bi; htmlFor?: string; id?: string; extra?: Bi }) {
  const inner = (
    <>
      <span style={{ display: 'block', fontSize: 15, fontWeight: 600, color: C.text, lineHeight: 1.35 }}>
        {t.en}{extra ? <span style={{ fontWeight: 400, color: C.muted }}> {extra.en}</span> : null}
      </span>
      <Hi>{t.hi}{extra ? ` ${extra.hi}` : ''}</Hi>
    </>
  );
  return htmlFor
    ? <label htmlFor={htmlFor} id={id} style={{ display: 'block', marginBottom: 6 }}>{inner}</label>
    : <div id={id} style={{ marginBottom: 6 }}>{inner}</div>;
}
function Hint({ t, id, tone = 'muted' }: { t: Bi; id?: string; tone?: 'muted' | 'amber' | 'success' }) {
  const color = tone === 'amber' ? C.amber : tone === 'success' ? C.success : C.muted;
  return (
    <div id={id} style={{ fontSize: 13, color, lineHeight: 1.45, marginTop: 6 }}>
      {t.en}<span lang="hi" style={{ display: 'block' }}>{t.hi}</span>
    </div>
  );
}
function FieldError({ id, code }: { id: string; code?: string }) {
  if (!code) return null;
  const t = ERRORS[code] || ERRORS.bad_request;
  return (
    <div id={id} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', color: C.error, fontSize: 13, lineHeight: 1.45, marginTop: 6 }}>
      <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden />
      <span>{t.en}<span lang="hi" style={{ display: 'block' }}>{t.hi}</span></span>
    </div>
  );
}
function Btn({ t, onClick, kind = 'primary', disabled, busy, icon }: {
  t: Bi; onClick?: () => void; kind?: 'primary' | 'secondary'; disabled?: boolean; busy?: boolean; icon?: ReactNode;
}) {
  const primary = kind === 'primary';
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={primary ? 'rf-btn rf-btn-primary' : 'rf-btn'}
      style={{
        width: '100%', minHeight: 52, padding: '8px 16px', borderRadius: 10, cursor: disabled ? 'not-allowed' : 'pointer',
        border: primary ? 'none' : `1px solid ${C.field}`, background: primary ? (disabled ? '#FDBA74' : C.primary) : C.card,
        color: primary ? '#FFFFFF' : C.text, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, textAlign: 'center',
      }}>
      {busy ? <Loader2 size={18} style={{ animation: 'rf-spin 1s linear infinite', flexShrink: 0 }} aria-hidden /> : icon}
      <span>
        <span style={{ display: 'block', fontSize: 16, fontWeight: 700, lineHeight: 1.25 }}>{t.en}</span>
        <span lang="hi" style={{ display: 'block', fontSize: 12, fontWeight: 500, opacity: 0.9, lineHeight: 1.3 }}>{t.hi}</span>
      </span>
    </button>
  );
}
const card: CSSProperties = { background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 12 };

function Header({ brand }: { brand: Brand | null }) {
  const name = brand?.name || '';
  return (
    <header style={{ background: C.card, borderBottom: `1px solid ${C.border}` }}>
      <div style={{ maxWidth: 520, margin: '0 auto', padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          {brand?.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={brand.logo_url} alt="" width={36} height={36} referrerPolicy="no-referrer"
              style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', border: `1px solid ${C.border}`, flexShrink: 0 }} />
          ) : name ? (
            <div aria-hidden style={{ width: 36, height: 36, borderRadius: '50%', background: '#1E293B', color: '#FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 15, flexShrink: 0 }}>
              {name.charAt(0).toUpperCase()}
            </div>
          ) : null}
          {name && <span style={{ fontWeight: 700, fontSize: 17, color: C.text, overflowWrap: 'anywhere' }}>{name}</span>}
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: C.text }}>{PAGE.title.en}</div>
          <Hi style={{ fontSize: 12 }}>{PAGE.title.hi}</Hi>
        </div>
      </div>
    </header>
  );
}

function Advisory() {
  return (
    <div role="note" style={{ background: '#FFF7ED', borderBottom: '1px solid #FFEDD5', color: '#C2410C', fontSize: 13, lineHeight: 1.45, padding: '10px 16px', textAlign: 'center', fontWeight: 500 }}>
      {PAGE.advisory.en}<span lang="hi" style={{ display: 'block', fontWeight: 400 }}>{PAGE.advisory.hi}</span>
    </div>
  );
}

function OrderBlock({ order, expiresAt, compact }: { order: OpenOrder; expiresAt: string | null; compact: boolean }) {
  const [open, setOpen] = useState(false);
  const payment = order.payment === 'COD' ? PAGE.paymentCod : PAGE.paymentPrepaid;
  const till = expiresAt ? formatDayMonth(expiresAt) : '';
  const total = order.total !== null ? formatAmount(order.total) : '';
  if (compact && !open) {
    return (
      <div style={{ ...card, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Lock size={15} color={C.muted} aria-hidden style={{ flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: C.text, overflowWrap: 'anywhere' }}>
          {[order.order_id, order.name, total].filter(Boolean).join(' · ')}
        </span>
        <button type="button" onClick={() => setOpen(true)} aria-expanded={false}
          style={{ flexShrink: 0, minHeight: 44, padding: '0 8px', border: 'none', background: 'none', color: C.primaryDark, fontWeight: 600, fontSize: 13, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {LOCAL.showOrder.en} <span lang="hi" style={{ fontWeight: 400 }}>/ {LOCAL.showOrder.hi}</span> <ChevronDown size={15} aria-hidden />
        </button>
      </div>
    );
  }
  const rows: { t: Bi; v: ReactNode }[] = [
    { t: PAGE.orderId, v: order.order_id || '—' },
    { t: PAGE.name, v: order.name || '—' },
    { t: PAGE.phone, v: order.phone_last4 ? maskedPhone(order.phone_last4) : '—' },
    {
      t: PAGE.items,
      v: order.items.length
        ? order.items.map((i, k) => <span key={k} style={{ display: 'block' }}>{i.name} × {i.qty}</span>)
        : '—',
    },
    { t: PAGE.orderTotal, v: total || '—' },
    { t: PAGE.payment, v: <>{payment.en}<Hi>{payment.hi}</Hi></> },
  ];
  return (
    <section aria-labelledby="rf-order-title" style={card}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
        <Lock size={16} color={C.muted} aria-hidden style={{ flexShrink: 0, marginTop: 3 }} />
        <div id="rf-order-title" style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 15, fontWeight: 700, color: C.text }}>{PAGE.yourOrder.en}</span>
          <Hi>{PAGE.yourOrder.hi}</Hi>
        </div>
        {compact && (
          <button type="button" onClick={() => setOpen(false)} aria-expanded
            style={{ flexShrink: 0, minHeight: 44, padding: '0 8px', border: 'none', background: 'none', color: C.primaryDark, fontWeight: 600, fontSize: 13, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {LOCAL.hideOrder.en} <span lang="hi" style={{ fontWeight: 400 }}>/ {LOCAL.hideOrder.hi}</span> <ChevronUp size={15} aria-hidden />
          </button>
        )}
      </div>
      <dl style={{ margin: 0 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 0.85fr) minmax(0, 1.15fr)', gap: 10, padding: '8px 0', borderTop: i ? `1px solid ${C.border}` : 'none' }}>
            <dt style={{ fontSize: 13, color: C.muted, lineHeight: 1.4 }}>{r.t.en}<span lang="hi" style={{ display: 'block' }}>{r.t.hi}</span></dt>
            <dd style={{ margin: 0, fontSize: 14, fontWeight: 600, color: C.text, textAlign: 'right', overflowWrap: 'anywhere', lineHeight: 1.45 }}>{r.v}</dd>
          </div>
        ))}
      </dl>
      <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8, background: C.soft, fontSize: 13, color: C.muted, lineHeight: 1.45 }}>
        {PAGE.wholeOrder.en}<span lang="hi" style={{ display: 'block' }}>{PAGE.wholeOrder.hi}</span>
        {till && (
          <span style={{ display: 'block', marginTop: 6 }}>
            {fill(PAGE.validTill.en, { date: till })}<span lang="hi" style={{ display: 'block' }}>{fill(PAGE.validTill.hi, { date: till })}</span>
          </span>
        )}
      </div>
    </section>
  );
}

const STEPS: Bi[] = [PAGE.progress.problem, PAGE.progress.refundTo, PAGE.progress.check];
function Progress({ step }: { step: 1 | 2 | 3 }) {
  return (
    <ol aria-label={`${LOCAL.stepWord.en} ${step} / ${STEPS.length}`} style={{ listStyle: 'none', display: 'grid', gridTemplateColumns: `repeat(${STEPS.length}, minmax(0, 1fr))`, gap: 6, margin: '4px 0 14px', padding: 0 }}>
      {STEPS.map((s, i) => {
        const n = i + 1, done = n < step, now = n === step;
        return (
          <li key={i} aria-current={now ? 'step' : undefined} style={{ minWidth: 0 }}>
            <div style={{ height: 4, borderRadius: 4, background: done || now ? C.primary : C.field, marginBottom: 6 }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: now ? 700 : 500, color: now ? C.text : C.muted }}>
              {done ? <Check size={13} color={C.success} aria-hidden /> : <span aria-hidden>{n}.</span>}
              <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{s.en}</span>
            </div>
            <Hi style={{ fontSize: 11 }}>{s.hi}</Hi>
          </li>
        );
      })}
    </ol>
  );
}

function ScreenCard({ title, body, onRetry }: { title: Bi; body: Bi; onRetry?: () => void }) {
  return (
    <section style={{ ...card, textAlign: 'center', padding: '28px 18px' }}>
      <div aria-hidden style={{ width: 52, height: 52, borderRadius: '50%', background: '#FFF7ED', color: C.primary, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
        <AlertCircle size={26} />
      </div>
      <Title t={title} as="h1" size={19} />
      <p style={{ fontSize: 15, color: C.text, lineHeight: 1.5, margin: 0 }}>{body.en}</p>
      <Hi style={{ fontSize: 14, marginTop: 2 }}>{body.hi}</Hi>
      {onRetry && <div style={{ marginTop: 18 }}><Btn t={LOCAL.tryAgain} onClick={onRetry} /></div>}
    </section>
  );
}

function StatusCard({ request }: { request: StatusRequest }) {
  const order: PublicStatus[] = ['received', 'approved', 'refunded'];
  const reached = request.status === 'refunded' ? 2 : request.status === 'approved' ? 1 : 0;
  const labels = [STATUS_VIEW.timeline.received, STATUS_VIEW.timeline.approved, STATUS_VIEW.timeline.refunded];
  const stopped = request.status === 'not_approved' || request.status === 'closed';
  const at = request.submitted_at ? formatDateTime(request.submitted_at) : '';
  const rf = request.status === 'refunded' ? request.refunded : null;
  return (
    <section style={card} aria-labelledby="rf-status-title">
      <Title t={PAGE.received} id="rf-status-title" as="h1" size={19} />
      <p style={{ fontSize: 15, color: C.text, margin: '0 0 14px' }}>
        {LOCAL.requestNumber.en}: <b style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{request.ref}</b>
        <Hi>{LOCAL.requestNumber.hi}: {request.ref}</Hi>
      </p>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {order.map((s, i) => {
          const done = !stopped ? i <= reached : i === 0;
          return (
            <li key={s} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', paddingBottom: i < order.length - 1 ? 12 : 0 }}>
              <span aria-hidden style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: done ? C.success : C.card, border: `2px solid ${done ? C.success : C.field}`, color: '#fff' }}>
                {done ? <Check size={13} /> : null}
              </span>
              <span style={{ fontSize: 15, fontWeight: done ? 700 : 500, color: done ? C.text : C.muted }}>
                {labels[i].en}<Hi>{labels[i].hi}</Hi>
              </span>
            </li>
          );
        })}
      </ol>
      {rf && (
        <dl style={{ margin: '14px 0 0', padding: '10px 12px', borderRadius: 10, background: C.successBg }}>
          {([
            [STATUS_VIEW.amount, rf.amount !== null ? formatAmount(rf.amount) : '—'],
            [STATUS_VIEW.date, rf.date ? formatDate(rf.date) : '—'],
            [STATUS_VIEW.reference, rf.utr || '—'],
          ] as [Bi, string][]).map(([t, v], i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 10, padding: '4px 0' }}>
              <dt style={{ fontSize: 13, color: C.muted }}>{t.en}<span lang="hi" style={{ display: 'block' }}>{t.hi}</span></dt>
              <dd style={{ margin: 0, fontSize: 15, fontWeight: 700, color: C.text, textAlign: 'right', overflowWrap: 'anywhere' }}>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {stopped && (
        <div role="status" style={{ marginTop: 14, padding: '10px 12px', borderRadius: 10, background: C.amberBg, color: C.amber, fontSize: 14, lineHeight: 1.5 }}>
          {(request.status === 'closed' ? STATUS_VIEW.closed : STATUS_VIEW.notApproved).en}
          <span lang="hi" style={{ display: 'block' }}>{(request.status === 'closed' ? STATUS_VIEW.closed : STATUS_VIEW.notApproved).hi}</span>
        </div>
      )}
      <p style={{ fontSize: 13, color: C.muted, lineHeight: 1.5, margin: '14px 0 0', overflowWrap: 'anywhere' }}>
        {fill(STATUS_VIEW.submittedOn.en, { at, payout: request.payout })}
        <span lang="hi" style={{ display: 'block' }}>{fill(STATUS_VIEW.submittedOn.hi, { at, payout: request.payout })}</span>
      </p>
      <p style={{ fontSize: 13, color: C.text, lineHeight: 1.5, margin: '10px 0 0', fontWeight: 600 }}>
        {STATUS_VIEW.notYou.en}<Hi>{STATUS_VIEW.notYou.hi}</Hi>
      </p>
    </section>
  );
}

// ── The page ───────────────────────────────────────────────────
type Errors = Partial<Record<'reason' | 'sub_reason' | 'checked_around' | 'details' | 'method' | 'upi' | 'holder' | 'account' | 'account_confirm' | 'ifsc' | 'consent', string>>;
const STEP_OF: Record<keyof Errors, 1 | 2 | 3> = {
  reason: 1, sub_reason: 1, checked_around: 1, details: 1,
  method: 2, upi: 2, holder: 2, account: 2, account_confirm: 2, ifsc: 2,
  consent: 3,
};
const groupDigits = (s: string) => normAccount(s).replace(/(\d{4})(?=\d)/g, '$1 ');

export default function RefundPage() {
  const tokenRef = useRef<string | null>(null);
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [step, setStep] = useState<1 | 2 | 3>(1);
  // Step 1 (kept in this tab's draft)
  const [reason, setReason] = useState<Reason | null>(null);
  const [sub, setSub] = useState<string | null>(null);
  const [checkedAround, setCheckedAround] = useState(false);
  const [details, setDetails] = useState('');
  // Step 2 (React state only: never stored)
  const [method, setMethod] = useState<Method | null>(null);
  const [upi, setUpi] = useState('');
  const [holder, setHolder] = useState('');
  const [account, setAccount] = useState('');
  const [account2, setAccount2] = useState('');
  const [showAccount, setShowAccount] = useState(false);
  const [ifsc, setIfsc] = useState('');
  const [ifscFixed, setIfscFixed] = useState(false);
  // Step 3
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [summary, setSummary] = useState(false);
  const [topError, setTopError] = useState<Bi | null>(null);
  const [busy, setBusy] = useState(false);
  const summaryRef = useRef<HTMLDivElement | null>(null);

  const clearPayout = () => { setUpi(''); setHolder(''); setAccount(''); setAccount2(''); setIfsc(''); setIfscFixed(false); setConsent(false); };

  const open = useCallback(async () => {
    const token = tokenRef.current;
    if (!token) { setView({ kind: 'screen', screen: 'invalid', brand: null }); return; }
    setView({ kind: 'loading' });
    const r = await call('/api/refund/open', { token });
    if (!r) { setView({ kind: 'screen', screen: 'error', brand: null }); return; }
    const d = r.data;
    const brand = brandOf(d.brand);
    if (r.status === 200 && d.state === 'open') {
      // The tab's draft (never the payout) comes back after a refresh.
      try {
        const draft = JSON.parse(ss.get('rf_draft') || 'null') as Record<string, unknown> | null;
        if (draft && typeof draft === 'object') {
          const rs = checkReason(draft.reason);
          if (rs.ok) {
            setReason(rs.value);
            const sb = checkSubReason(rs.value, draft.sub_reason);
            setSub(sb.ok ? sb.value : null);
          }
          setCheckedAround(draft.checked_around === true);
          if (typeof draft.details === 'string') setDetails(draft.details.slice(0, DETAILS_MAX + 200));
          const m = checkMethod(draft.method);
          if (m.ok) setMethod(m.value);
        }
      } catch { /* a broken draft is ignored */ }
      setView({ kind: 'form', brand, order: orderOf(d.order), expiresAt: str(d.expires_at) });
      return;
    }
    if (r.status === 200 && d.state === 'submitted') {
      const req = statusOf(d.request);
      setView(req ? { kind: 'status', brand, request: req } : { kind: 'screen', screen: 'used', brand });
      return;
    }
    if (r.status === 200 && d.state === 'used') { setView({ kind: 'screen', screen: 'used', brand }); return; }
    if (r.status === 404) { setView({ kind: 'screen', screen: 'invalid', brand: null }); return; }
    if (r.status === 410) { setView({ kind: 'screen', screen: screenFor(d.state), brand }); return; }
    if (r.status === 429) { setView({ kind: 'screen', screen: 'slow_down', brand: null }); return; }
    if (r.status === 503) { setView({ kind: 'screen', screen: 'closed', brand: null }); return; }
    setView({ kind: 'screen', screen: 'error', brand: null });
  }, []);

  useEffect(() => {
    tokenRef.current = readToken();
    void open();
    // A newer link opened in this same tab only changes the #fragment (no reload): start again with it.
    const onHash = () => {
      let h = '';
      try { h = window.location.hash.slice(1); } catch { /* ignore */ }
      if (!TOKEN_RE.test(h)) return;
      const fresh = h !== tokenRef.current;
      tokenRef.current = readToken();
      if (fresh) {
        setStep(1); setReason(null); setSub(null); setCheckedAround(false); setDetails(''); setMethod(null);
        setUpi(''); setHolder(''); setAccount(''); setAccount2(''); setIfsc(''); setIfscFixed(false); setConsent(false);
        setErrors({}); setSummary(false); setTopError(null);
        void open();
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [open]);

  // The tab's draft: reason, sub-option, tick, details and method only (never UPI / bank values).
  useEffect(() => {
    if (view.kind !== 'form') return;
    ss.draft(JSON.stringify({ reason, sub_reason: sub, checked_around: checkedAround, details, method }));
  }, [view.kind, reason, sub, checkedAround, details, method]);

  const top = () => { try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch { window.scrollTo(0, 0); } };

  // ── Checks (the same rules the server runs again) ──
  const check1 = (): Errors => {
    const e: Errors = {};
    const r = checkReason(reason);
    if (!r.ok) e.reason = r.code;
    else {
      const s = checkSubReason(r.value, sub);
      if (!s.ok) e.sub_reason = s.code;
      else {
        const a = checkCheckedAround(r.value, s.value, checkedAround);
        if (!a.ok) e.checked_around = a.code;
      }
    }
    const d = checkDetails(details);
    if (!d.ok) e.details = d.code;
    return e;
  };
  const check2 = (): Errors => {
    const e: Errors = {};
    const m = checkMethod(method);
    if (!m.ok) { e.method = m.code; return e; }
    const h = checkHolder(holder);
    if (!h.ok) e.holder = h.code;
    if (m.value === 'upi') {
      const u = checkUpi(upi);
      if (!u.ok) e.upi = u.code;
    } else {
      const a = checkAccount(account);
      if (!a.ok) e.account = a.code;
      else {
        const c = checkAccountConfirm(account, account2);
        if (!c.ok) e.account_confirm = c.code;
      }
      const f = checkIfsc(ifsc);
      if (!f.ok) e.ifsc = f.code;
    }
    return e;
  };
  const check3 = (): Errors => {
    const c = checkConsent(consent);
    return c.ok ? {} : { consent: c.code };
  };

  const showErrors = (e: Errors) => {
    setErrors(e);
    const keys = Object.keys(e) as (keyof Errors)[];
    setSummary(keys.length > 0);
    if (keys.length) {
      setStep(Math.min(...keys.map((k) => STEP_OF[k])) as 1 | 2 | 3);
      setTimeout(() => { summaryRef.current?.focus(); summaryRef.current?.scrollIntoView({ block: 'start' }); }, 30);
    }
  };
  const next = () => {
    const e = step === 1 ? check1() : check2();
    if (Object.keys(e).length) { showErrors(e); return; }
    setErrors({}); setSummary(false); setTopError(null);
    setStep((step + 1) as 2 | 3);
    top();
  };
  const goTo = (s: 1 | 2 | 3) => { setErrors({}); setSummary(false); setTopError(null); setStep(s); top(); };

  const submit = async () => {
    if (busy) return;
    const e = { ...check1(), ...check2(), ...check3() };
    if (Object.keys(e).length) { showErrors(e); return; }
    const token = tokenRef.current;
    if (!token) { setView({ kind: 'screen', screen: 'invalid', brand: null }); return; }
    setBusy(true); setTopError(null); setSummary(false);
    const bank = method === 'bank';
    const body: Record<string, unknown> = {
      token, client_nonce: submitNonce(), reason, sub_reason: sub,
      checked_around: needsCheckedAround(reason, sub) ? checkedAround : false,
      details: cleanDetails(details), method, holder,
      upi: bank ? null : normUpi(upi),
      account: bank ? normAccount(account) : null, account_confirm: bank ? normAccount(account2) : null,
      ifsc: bank ? normIfsc(ifsc).value : null,
      consent: true,
    };
    // A lost answer or a server hiccup: the same request again (same client_nonce = the same submit).
    let r: Ans = null;
    for (const wait of [0, 1000, 3000]) {
      if (wait) await sleep(wait);
      r = await call('/api/refund/submit', body);
      if (r && r.status !== 500) break;
    }
    const brand = view.kind === 'form' ? view.brand : { name: null, logo_url: null };
    if (!r || r.status === 500) { setBusy(false); setTopError(ERRORS.network); return; }
    const d = r.data;
    if (r.status === 200 && d.state === 'submitted' && str(d.ref)) {
      ss.dropDraft();
      clearPayout();
      setView({ kind: 'done', brand, ref: str(d.ref) as string });
      setBusy(false);
      top();
      return;
    }
    setBusy(false);
    if (r.status === 400 && d.state === 'invalid_input' && d.errors && typeof d.errors === 'object') {
      const se = d.errors as Record<string, string>;
      const mine: Errors = {};
      for (const k of Object.keys(STEP_OF) as (keyof Errors)[]) if (typeof se[k] === 'string') mine[k] = se[k];
      if (Object.keys(mine).length) { showErrors(mine); return; }
      setTopError(ERRORS[se.file_ids || se.client_nonce || 'bad_request'] || ERRORS.bad_request);
      return;
    }
    if (r.status === 404) { setView({ kind: 'screen', screen: 'invalid', brand: null }); return; }
    if (r.status === 409 && d.state === 'used') { clearPayout(); void open(); return; }
    if (r.status === 409 && d.state === 'already_requested') { clearPayout(); setView({ kind: 'screen', screen: 'already_requested', brand }); return; }
    if (r.status === 410) { clearPayout(); setView({ kind: 'screen', screen: screenFor(d.state), brand }); return; }
    if (r.status === 429) { setTopError(SCREENS.slow_down.body); return; }
    if (r.status === 503) { clearPayout(); setView({ kind: 'screen', screen: 'closed', brand }); return; }
    setTopError(ERRORS.bad_request);
  };

  // ── Field helpers ──
  const err = (k: keyof Errors) => errors[k];
  const aria = (k: keyof Errors, hint?: string) => ({
    'aria-invalid': err(k) ? true : undefined,
    'aria-describedby': [err(k) ? `rf-err-${k}` : '', hint || ''].filter(Boolean).join(' ') || undefined,
  });
  const fix = (k: keyof Errors) => { if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined })); };

  const pickReason = (r: Reason) => {
    if (r !== reason) { setReason(r); setSub(null); setCheckedAround(false); }
    setErrors((e) => ({ ...e, reason: undefined, sub_reason: undefined, checked_around: undefined }));
  };
  const onIfsc = (v: string) => {
    let s = v.toUpperCase().replace(/\s+/g, '').slice(0, 11);
    let fixed = false;
    if (s.length === 11 && s[4] === 'O') { s = normIfsc(s).value; fixed = true; }
    setIfsc(s);
    if (fixed) setIfscFixed(true);
    else if (s.length < 11) setIfscFixed(false);
    fix('ifsc');
  };

  // ── Screens ──
  let main: ReactNode;
  const brandNow: Brand | null = view.kind === 'loading' ? null : view.brand;
  if (view.kind === 'loading') {
    main = (
      <div role="status" style={{ ...card, textAlign: 'center', padding: '36px 16px', color: C.muted }}>
        <Loader2 size={26} style={{ animation: 'rf-spin 1s linear infinite' }} aria-hidden />
        <div style={{ marginTop: 10, fontSize: 15, color: C.text }}>{LOCAL.loading.en}</div>
        <Hi>{LOCAL.loading.hi}</Hi>
      </div>
    );
  } else if (view.kind === 'screen') {
    const s = view.screen;
    const t = s === 'error' ? LOCAL.error : s === 'already_requested' ? LOCAL.alreadyRequested : SCREENS[s];
    main = <ScreenCard title={t.title} body={t.body} onRetry={s === 'error' ? () => { void open(); } : undefined} />;
  } else if (view.kind === 'status') {
    main = <StatusCard request={view.request} />;
  } else if (view.kind === 'done') {
    main = (
      <section role="status" style={{ ...card, textAlign: 'center', padding: '30px 18px' }}>
        <div aria-hidden style={{ width: 68, height: 68, borderRadius: '50%', background: C.successBg, color: C.success, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
          <Check size={38} strokeWidth={3} />
        </div>
        <Title t={PAGE.received} as="h1" size={21} />
        <p style={{ fontSize: 16, color: C.text, margin: '0 0 2px', overflowWrap: 'anywhere' }}>
          {LOCAL.requestNumber.en}: <b style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{view.ref}</b>
        </p>
        <Hi style={{ fontSize: 14 }}>{fill(PAGE.requestNumber.hi, { ref: view.ref })}</Hi>
        <p style={{ fontSize: 15, color: C.text, lineHeight: 1.5, margin: '14px 0 0' }}>{PAGE.willUpdate.en}</p>
        <Hi style={{ fontSize: 14 }}>{PAGE.willUpdate.hi}</Hi>
        <p style={{ fontSize: 14, color: C.muted, margin: '14px 0 0' }}>{PAGE.canClose.en}</p>
        <Hi>{PAGE.canClose.hi}</Hi>
      </section>
    );
  } else {
    const subList = reason ? SUB_REASONS[reason] : [];
    const upiOk = checkUpi(upi).ok;
    const accountsMatch = !!account2 && checkAccount(account).ok && normAccount(account) === normAccount(account2);
    const bankTitle = bankName(ifsc.length >= 4 ? ifsc : '');
    const errorKeys = Object.keys(errors).filter((k) => errors[k as keyof Errors]) as (keyof Errors)[];
    main = (
      <>
        <OrderBlock order={view.order} expiresAt={view.expiresAt} compact={step > 1} />
        <Progress step={step} />

        {summary && errorKeys.length > 0 && (
          <div ref={summaryRef} tabIndex={-1} role="alert"
            style={{ ...card, background: C.errorBg, borderColor: '#FECACA', color: C.error, outline: 'none' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 14, fontWeight: 600 }}>
              <AlertCircle size={18} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden />
              <span>{LOCAL.checkThese.en}<span lang="hi" style={{ display: 'block', fontWeight: 400 }}>{LOCAL.checkThese.hi}</span></span>
            </div>
            <ul style={{ margin: '8px 0 0 26px', padding: 0, fontSize: 13, lineHeight: 1.5 }}>
              {errorKeys.map((k) => {
                const t = ERRORS[errors[k] as string] || ERRORS.bad_request;
                return <li key={k}>{t.en}<span lang="hi" style={{ display: 'block' }}>{t.hi}</span></li>;
              })}
            </ul>
          </div>
        )}

        {step === 1 && (
          <>
            <section style={card} aria-labelledby="rf-step1">
              <Title t={PAGE.step1} id="rf-step1" />
              <div role="radiogroup" aria-labelledby="rf-step1" {...aria('reason')} style={{ display: 'grid', gap: 10 }}>
                {REASONS.map((r) => {
                  const on = reason === r;
                  return (
                    <div key={r} className={`rf-option${on ? ' rf-on' : ''}`}>
                      <label style={{ display: 'flex', gap: 12, alignItems: 'flex-start', cursor: 'pointer', minHeight: 48, padding: '12px 14px' }}>
                        <input type="radio" name="rf-reason" value={r} checked={on} onChange={() => pickReason(r)} className="rf-radio" />
                        <span style={{ minWidth: 0 }}>
                          <span style={{ display: 'block', fontSize: 16, fontWeight: 600, color: C.text, lineHeight: 1.35 }}>{REASON_TEXT[r].en}</span>
                          <Hi>{REASON_TEXT[r].hi}</Hi>
                        </span>
                      </label>
                      {on && subList.length > 0 && (
                        <div style={{ padding: '0 14px 14px' }}>
                          <div id="rf-sub-label" style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 8 }}>
                            {PAGE.chooseOne.en} <span lang="hi" style={{ fontWeight: 400, color: C.muted }}>/ {PAGE.chooseOne.hi}</span>
                          </div>
                          <div role="radiogroup" aria-labelledby="rf-sub-label" {...aria('sub_reason')} style={{ display: 'grid', gap: 8 }}>
                            {subList.map((s) => (
                              <label key={s} className={`rf-chip${sub === s ? ' rf-on' : ''}`}>
                                <input type="radio" name="rf-sub" value={s} checked={sub === s} className="rf-radio"
                                  onChange={() => { setSub(s); if (!needsCheckedAround(r, s)) setCheckedAround(false); setErrors((x) => ({ ...x, sub_reason: undefined, checked_around: undefined })); }} />
                                <span style={{ minWidth: 0 }}>
                                  <span style={{ display: 'block', fontSize: 15, fontWeight: 500, color: C.text }}>{(SUB_REASON_TEXT[s] || { en: s }).en}</span>
                                  {SUB_REASON_TEXT[s] && <Hi>{SUB_REASON_TEXT[s].hi}</Hi>}
                                </span>
                              </label>
                            ))}
                          </div>
                          <FieldError id="rf-err-sub_reason" code={err('sub_reason')} />
                          {needsCheckedAround(r, sub) && (
                            <>
                              <label className="rf-tick" style={{ marginTop: 10 }}>
                                <input type="checkbox" checked={checkedAround} className="rf-check" {...aria('checked_around')}
                                  onChange={(e) => { setCheckedAround(e.target.checked); fix('checked_around'); }} />
                                <span style={{ fontSize: 14, color: C.text, lineHeight: 1.45 }}>{PAGE.checkedAround.en}<Hi>{PAGE.checkedAround.hi}</Hi></span>
                              </label>
                              <FieldError id="rf-err-checked_around" code={err('checked_around')} />
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <FieldError id="rf-err-reason" code={err('reason')} />
            </section>

            <section style={card}>
              <FieldLabel t={PAGE.tellUs} htmlFor="rf-details" extra={DETAILS_OPTIONAL ? LOCAL.optional : undefined} />
              <textarea id="rf-details" className="rf-input" rows={4} value={details} {...aria('details', 'rf-details-hint')}
                placeholder={reason ? DETAILS_PLACEHOLDER[reason] : ''}
                onChange={(e) => { setDetails(e.target.value); fix('details'); }}
                style={{ resize: 'vertical', minHeight: 110 }} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', fontSize: 12, marginTop: 4, color: Array.from(cleanDetails(details)).length > DETAILS_MAX ? C.error : C.muted }}>
                {fill(PAGE.detailsCounter.en, { n: Array.from(cleanDetails(details)).length })}
              </div>
              <Hint id="rf-details-hint" t={DETAILS_OPTIONAL ? LOCAL.detailsHintOptional : PAGE.detailsHint} />
              <FieldError id="rf-err-details" code={err('details')} />
            </section>

            <Btn t={PAGE.next} onClick={next} />
          </>
        )}

        {step === 2 && (
          <>
            <section style={card} aria-labelledby="rf-step2">
              <Title t={PAGE.step3} id="rf-step2" />
              <div role="radiogroup" aria-labelledby="rf-step2" {...aria('method')} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 8 }}>
                {(['upi', 'bank'] as Method[]).map((m) => {
                  const t = m === 'upi' ? PAGE.methodUpi : PAGE.methodBank;
                  return (
                    <label key={m} className={`rf-seg${method === m ? ' rf-on' : ''}`}>
                      <input type="radio" name="rf-method" value={m} checked={method === m} className="rf-radio"
                        onChange={() => { setMethod(m); setErrors({}); setSummary(false); }} />
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 15, fontWeight: 700, color: C.text }}>{t.en}</span>
                        <Hi style={{ fontSize: 12 }}>{t.hi}</Hi>
                      </span>
                    </label>
                  );
                })}
              </div>
              <FieldError id="rf-err-method" code={err('method')} />

              {method === 'upi' && (
                <div style={{ display: 'grid', gap: 16, marginTop: 16 }}>
                  <div>
                    <FieldLabel t={PAGE.upiId} htmlFor="rf-upi" />
                    <input id="rf-upi" className="rf-input" type="text" value={upi} {...aria('upi', 'rf-upi-hint')}
                      autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} inputMode="email" maxLength={330}
                      placeholder="name@okaxis" onChange={(e) => { setUpi(e.target.value); fix('upi'); }} />
                    <Hint id="rf-upi-hint" t={PAGE.upiHint} />
                    {upiOk && !upiHandleKnown(normUpi(upi)) && <Hint t={PAGE.upiUnknownHandle} tone="amber" />}
                    <FieldError id="rf-err-upi" code={err('upi')} />
                  </div>
                  <div>
                    <FieldLabel t={PAGE.upiName} htmlFor="rf-holder" />
                    <input id="rf-holder" className="rf-input" type="text" value={holder} {...aria('holder', 'rf-holder-hint')}
                      autoComplete="off" autoCorrect="off" spellCheck={false} maxLength={80}
                      onChange={(e) => { setHolder(e.target.value); fix('holder'); }} />
                    <Hint id="rf-holder-hint" t={PAGE.upiNameHint} />
                    <FieldError id="rf-err-holder" code={err('holder')} />
                  </div>
                </div>
              )}

              {method === 'bank' && (
                <div style={{ display: 'grid', gap: 16, marginTop: 16 }}>
                  <div>
                    <FieldLabel t={PAGE.holder} htmlFor="rf-holder" />
                    <input id="rf-holder" className="rf-input" type="text" value={holder} {...aria('holder', 'rf-holder-hint')}
                      autoComplete="off" autoCorrect="off" spellCheck={false} maxLength={80}
                      onChange={(e) => { setHolder(e.target.value); fix('holder'); }} />
                    <Hint id="rf-holder-hint" t={PAGE.holderHint} />
                    <FieldError id="rf-err-holder" code={err('holder')} />
                  </div>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8 }}>
                      <FieldLabel t={PAGE.account} htmlFor="rf-account" />
                      <button type="button" onClick={() => setShowAccount((v) => !v)} aria-pressed={showAccount}
                        style={{ flexShrink: 0, minHeight: 44, padding: '0 6px', border: 'none', background: 'none', color: C.primaryDark, fontWeight: 600, fontSize: 13, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                        {showAccount ? <EyeOff size={15} aria-hidden /> : <Eye size={15} aria-hidden />}
                        {showAccount ? PAGE.hide.en : PAGE.show.en} <span lang="hi" style={{ fontWeight: 400 }}>/ {showAccount ? PAGE.hide.hi : PAGE.show.hi}</span>
                      </button>
                    </div>
                    <input id="rf-account" className={`rf-input rf-mono${showAccount ? '' : ' rf-secret'}`} type="text" value={account}
                      {...aria('account')} inputMode="numeric" autoComplete="off" autoCorrect="off" spellCheck={false} maxLength={24}
                      onChange={(e) => { setAccount(e.target.value.replace(/[^\d\s-]/g, '')); fix('account'); fix('account_confirm'); }} />
                    <FieldError id="rf-err-account" code={err('account')} />
                  </div>
                  <div>
                    <FieldLabel t={PAGE.accountAgain} htmlFor="rf-account2" />
                    <input id="rf-account2" className={`rf-input rf-mono${showAccount ? '' : ' rf-secret'}`} type="text" value={account2}
                      {...aria('account_confirm', 'rf-account2-hint')} inputMode="numeric" autoComplete="off" autoCorrect="off" spellCheck={false} maxLength={24}
                      onPaste={(e) => e.preventDefault()} onDrop={(e) => e.preventDefault()}
                      onChange={(e) => { setAccount2(e.target.value.replace(/[^\d\s-]/g, '')); fix('account_confirm'); }} />
                    <Hint id="rf-account2-hint" t={PAGE.accountAgainHint} />
                    {accountsMatch && (
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: C.success, fontSize: 13, marginTop: 6, fontWeight: 600 }}>
                        <Check size={15} aria-hidden /> {LOCAL.accountsMatch.en} <span lang="hi" style={{ fontWeight: 400 }}>/ {LOCAL.accountsMatch.hi}</span>
                      </div>
                    )}
                    <FieldError id="rf-err-account_confirm" code={err('account_confirm')} />
                  </div>
                  <div>
                    <FieldLabel t={PAGE.ifsc} htmlFor="rf-ifsc" />
                    <input id="rf-ifsc" className="rf-input rf-mono" type="text" value={ifsc} {...aria('ifsc', 'rf-ifsc-hint')}
                      autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} maxLength={11}
                      placeholder="SBIN0001234" onChange={(e) => onIfsc(e.target.value)} />
                    {bankTitle && (
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: C.success, fontSize: 13, marginTop: 6, fontWeight: 600 }}>
                        <Check size={15} aria-hidden /> {bankTitle}
                      </div>
                    )}
                    {ifscFixed && <Hint t={PAGE.ifscFixedO} tone="amber" />}
                    <Hint id="rf-ifsc-hint" t={PAGE.ifscHint} />
                    <FieldError id="rf-err-ifsc" code={err('ifsc')} />
                  </div>
                </div>
              )}

              {method && (
                <div style={{ marginTop: 16, padding: '10px 12px', borderRadius: 10, background: C.soft, fontSize: 13, color: C.text, lineHeight: 1.45 }}>
                  {PAGE.refundGoesOnlyHere.en}<Hi>{PAGE.refundGoesOnlyHere.hi}</Hi>
                </div>
              )}
            </section>
            <div style={{ display: 'grid', gap: 10 }}>
              <Btn t={PAGE.next} onClick={next} />
              <Btn t={LOCAL.back} kind="secondary" onClick={() => goTo(1)} />
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <section style={card} aria-labelledby="rf-step3">
              <Title t={PAGE.step4} id="rf-step3" />
              <ReviewBox title={PAGE.progress.problem} onChange={() => goTo(1)}>
                {reason && (
                  <div style={{ fontSize: 15, fontWeight: 600, color: C.text }}>
                    {REASON_TEXT[reason].en}{sub && SUB_REASON_TEXT[sub] ? ` · ${SUB_REASON_TEXT[sub].en}` : ''}
                    <Hi>{REASON_TEXT[reason].hi}{sub && SUB_REASON_TEXT[sub] ? ` · ${SUB_REASON_TEXT[sub].hi}` : ''}</Hi>
                  </div>
                )}
                {needsCheckedAround(reason, sub) && checkedAround && (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 13, color: C.success, marginTop: 6 }}>
                    <Check size={15} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
                    <span>{LOCAL.checkedAroundDone.en}<span lang="hi" style={{ display: 'block' }}>{LOCAL.checkedAroundDone.hi}</span></span>
                  </div>
                )}
                <div style={{ marginTop: 8, fontSize: 14, color: cleanDetails(details) ? C.text : C.muted, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.5 }}>
                  {cleanDetails(details) || `${LOCAL.noDetails.en} ${LOCAL.noDetails.hi}`}
                </div>
              </ReviewBox>
              <ReviewBox title={PAGE.progress.refundTo} onChange={() => goTo(2)}>
                {method === 'upi' ? (
                  <ReviewRows rows={[
                    [PAGE.upiId, <span key="u" className="rf-mono" style={{ fontSize: 18 }}>{normUpi(upi)}</span>],
                    [PAGE.upiName, normHolder(holder)],
                  ]} />
                ) : method === 'bank' ? (
                  <ReviewRows rows={[
                    [PAGE.holder, normHolder(holder)],
                    [PAGE.account, <span key="a" className="rf-mono" style={{ fontSize: 20, letterSpacing: '0.04em' }}>{groupDigits(account)}</span>],
                    [PAGE.ifsc, <span key="i"><span className="rf-mono">{normIfsc(ifsc).value}</span>{bankName(normIfsc(ifsc).value) ? <Hi>{bankName(normIfsc(ifsc).value)}</Hi> : null}</span>],
                  ]} />
                ) : null}
              </ReviewBox>
              <label className="rf-tick" style={{ marginTop: 4 }}>
                <input type="checkbox" checked={consent} className="rf-check" {...aria('consent')}
                  onChange={(e) => { setConsent(e.target.checked); fix('consent'); }} />
                <span style={{ fontSize: 14, color: C.text, lineHeight: 1.5 }}>{CONSENT_TEXT.en}<Hi>{CONSENT_TEXT.hi}</Hi></span>
              </label>
              <FieldError id="rf-err-consent" code={err('consent')} />
            </section>
            <p style={{ fontSize: 13, color: C.muted, lineHeight: 1.5, margin: '0 0 12px' }}>
              {PAGE.notApprovedYet.en}<span lang="hi" style={{ display: 'block' }}>{PAGE.notApprovedYet.hi}</span>
            </p>
            {topError && (
              <div role="alert" style={{ ...card, background: C.errorBg, borderColor: '#FECACA', color: C.error, fontSize: 14, lineHeight: 1.5, display: 'flex', gap: 8 }}>
                <AlertCircle size={18} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden />
                <span>{topError.en}<span lang="hi" style={{ display: 'block' }}>{topError.hi}</span></span>
              </div>
            )}
            <div style={{ display: 'grid', gap: 10 }}>
              <Btn t={busy ? LOCAL.sending : PAGE.submit} onClick={submit} disabled={busy} busy={busy} />
              <Btn t={LOCAL.back} kind="secondary" onClick={() => goTo(2)} disabled={busy} />
            </div>
          </>
        )}
      </>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', display: 'flex', flexDirection: 'column' }}>
      <Advisory />
      <Header brand={brandNow} />
      <main style={{ width: '100%', maxWidth: 520, margin: '0 auto', padding: '16px 16px 40px', flex: 1 }}>
        {main}
      </main>
      <style>{`
        @keyframes rf-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .rf-input {
          display: block; width: 100%; min-height: 48px; padding: 12px 14px; font-size: 16px; line-height: 1.4;
          color: ${C.text}; background: ${C.card}; border: 1px solid ${C.field}; border-radius: 10px; outline: none;
          font-family: inherit;
        }
        .rf-input:focus { border-color: ${C.primary}; box-shadow: 0 0 0 3px rgba(249, 115, 22, 0.18); }
        .rf-input[aria-invalid=true] { border-color: ${C.error}; }
        .rf-input::placeholder { color: #94A3B8; }
        .rf-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
        .rf-secret { -webkit-text-security: disc; }
        .rf-option { border: 1px solid ${C.field}; border-radius: 12px; background: ${C.card}; }
        .rf-option.rf-on { border: 2px solid ${C.primary}; background: #FFF7ED; }
        .rf-chip, .rf-seg {
          display: flex; gap: 10px; align-items: flex-start; min-height: 48px; padding: 10px 12px; cursor: pointer;
          border: 1px solid ${C.field}; border-radius: 10px; background: ${C.card};
        }
        .rf-chip.rf-on, .rf-seg.rf-on { border: 2px solid ${C.primary}; background: #FFFFFF; }
        .rf-seg { align-items: center; }
        .rf-tick { display: flex; gap: 12px; align-items: flex-start; cursor: pointer; padding: 10px 12px; border-radius: 10px; background: ${C.soft}; border: 1px solid ${C.border}; }
        .rf-radio, .rf-check { width: 20px; height: 20px; flex-shrink: 0; margin-top: 2px; accent-color: ${C.primary}; }
        .rf-btn:focus-visible, .rf-option:focus-within, .rf-chip:focus-within, .rf-seg:focus-within, .rf-tick:focus-within {
          outline: 3px solid rgba(249, 115, 22, 0.45); outline-offset: 2px;
        }
        .rf-btn-primary:hover:not(:disabled) { background: ${C.primaryDark} !important; }
      `}</style>
    </div>
  );
}

function ReviewBox({ title, onChange, children }: { title: Bi; onChange: () => void; children: ReactNode }) {
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.03em' }}>
          {title.en}<Hi style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>{title.hi}</Hi>
        </div>
        <button type="button" onClick={onChange}
          style={{ flexShrink: 0, minHeight: 44, minWidth: 44, padding: '0 6px', border: 'none', background: 'none', color: C.primaryDark, fontWeight: 700, fontSize: 14, cursor: 'pointer', textAlign: 'right', lineHeight: 1.2 }}>
          {PAGE.change.en}<span lang="hi" style={{ display: 'block', fontSize: 11, fontWeight: 500 }}>{PAGE.change.hi}</span>
        </button>
      </div>
      {children}
    </div>
  );
}
function ReviewRows({ rows }: { rows: [Bi, ReactNode][] }) {
  return (
    <dl style={{ margin: 0 }}>
      {rows.map(([t, v], i) => (
        <div key={i} style={{ padding: '6px 0', borderTop: i ? `1px solid ${C.border}` : 'none' }}>
          <dt style={{ fontSize: 12, color: C.muted }}>{t.en} <span lang="hi">/ {t.hi}</span></dt>
          <dd style={{ margin: '2px 0 0', fontSize: 16, fontWeight: 700, color: C.text, overflowWrap: 'anywhere' }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
