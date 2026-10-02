'use client';

import type { CSSProperties, ReactNode } from 'react';
import { REASON_TEXT, SUB_REASON_TEXT, formatAmount } from '@/lib/refund/texts';
import { NOTE_MAX, RETURN_NOTE_MAX, AMOUNT_CAP, type Reason } from '@/lib/refund/rules';

// ── What the routes send (spec 3.5) ────────────────────────────
export type Status = 'new' | 'approved' | 'rejected' | 'refunded' | 'cancelled';
export type ViewKey = Status | 'sent' | 'all';
export type Lang = 'hinglish' | 'en';
export interface Payout { method: 'upi' | 'bank'; mask: string }
export interface Item {
  id: string; ref: string; status: Status; seen: boolean; created_at: string | null; status_at: string | null; panel: string | null;
  order_id: string; customer_name: string | null; reason: string; sub_reason: string | null; total: number | null; payment: string | null;
  payout: Payout; flags: string[]; return_needed: boolean; conversation_id: string;
}
export interface SentLink {
  id: string; order_id: string; customer_name: string | null; panel: string | null; sent_at: string | null; expires_at: string | null;
  state: 'active' | 'expired'; opened_count: number; last_opened_at: string | null; conversation_id: string;
}
export interface Counts { new: number; unseen: number; approved: number; rejected: number; refunded: number; cancelled: number; sent: number }
export interface ListAnswer { items?: Item[]; links?: SentLink[]; counts?: Counts; next_before?: string | null; setup?: null | 'key_missing' | 'off' }
export interface Flag { code: string; level: 'red' | 'amber' | 'grey'; text: string; refs: string[] }
export interface Msg { step: string; id: string | null; at: string | null; lang: string | null; emailed: boolean | null; failed: boolean }
export interface Ev { at: string | null; kind: string; actor: string | null; from: string | null; to: string | null; note: string | null; meta: Record<string, unknown> | null }
export type Bi2 = { en: string; hinglish: string };
export interface Detail {
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
export type Revealed = { method: 'upi'; upi: string; holder: string } | { method: 'bank'; account: string; ifsc: string; bank_name: string | null; holder: string };
export type Move = 'approve' | 'reject' | 'refunded' | 'cancel';

// ── Labels ─────────────────────────────────────────────────────
export const VIEWS: { v: ViewKey; label: string; hint: string }[] = [
  { v: 'new', label: 'New', hint: 'naye' },
  { v: 'approved', label: 'Approved', hint: 'approve kiye' },
  { v: 'rejected', label: 'Rejected', hint: 'mana kiye' },
  { v: 'refunded', label: 'Refunded', hint: 'paise bhej diye' },
  { v: 'cancelled', label: 'Cancelled', hint: 'band kiye' },
  { v: 'sent', label: 'Form sent', hint: 'bheja, bhara nahi' },
  { v: 'all', label: 'All', hint: 'sab' },
];
export const STATUS_PILL: Record<Status, { label: string; fg: string; bg: string }> = {
  new: { label: 'New', fg: 'var(--warning)', bg: 'var(--warning-light)' },
  approved: { label: 'Approved', fg: 'var(--primary)', bg: 'var(--primary-light)' },
  rejected: { label: 'Rejected', fg: 'var(--danger)', bg: 'var(--danger-light)' },
  refunded: { label: 'Refunded', fg: 'var(--success)', bg: 'var(--success-light)' },
  cancelled: { label: 'Cancelled', fg: 'var(--fg-muted)', bg: 'var(--bg-subtle)' },
};
export const LEVEL_COLOR: Record<string, { fg: string; bg: string }> = {
  red: { fg: 'var(--danger)', bg: 'var(--danger-light)' },
  amber: { fg: '#b45309', bg: 'var(--warning-light)' },
  grey: { fg: 'var(--fg-muted)', bg: 'var(--bg-subtle)' },
};
// The list carries flag codes only (from stored columns); short words for the row.
export const FLAG_SHORT: Record<string, { label: string; level: 'red' | 'amber' | 'grey' }> = {
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
export const STEP_LABEL: Record<string, string> = {
  form: 'Form link', received: 'Form received', approved: 'Approved', rejected: 'Not approved', refunded: 'Refunded (reference)', return: 'Return pickup',
};
export const EVENT_LABEL: Record<string, string> = {
  link_sent: 'Form sent', link_opened: 'Customer opened the form', link_revoked: 'Link closed', submitted: 'Customer submitted the form',
  viewed: 'You opened this request', revealed: 'Full details viewed', status: 'Status changed', message_posted: 'Message in the chat',
  message_failed: 'Message NOT sent', email_sent: 'Email sent', email_failed: 'Email failed', note: 'Note', return_flag: 'Return pickup',
  return_told: 'Customer told about the return pickup',
};
export const ACTOR: Record<string, string> = { owner: 'You', customer: 'Customer', system: 'System' };
// Field errors from PATCH (rules.ts codes).
export const ADMIN_ERR: Record<string, string> = {
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

export const reasonText = (reason: string, sub: string | null) => {
  const r = REASON_TEXT[reason as Reason]?.en || reason;
  const s = sub ? SUB_REASON_TEXT[sub]?.en || sub : '';
  return s ? `${r} · ${s}` : r;
};
export const payoutText = (p: Payout | null | undefined) => (p ? `${p.method === 'upi' ? 'UPI' : 'Bank'} ${p.mask}` : '');
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function ago(iso: string | null): string {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return '';
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
export const daysLeft = (iso: string | null) => {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return '';
  const d = Math.ceil((ms - Date.now()) / 86_400_000);
  return d <= 0 ? 'expired' : d === 1 ? '1 day left' : `${d} days left`;
};
export const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
export const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export const muted: CSSProperties = { border: '1px solid var(--border)', background: 'transparent', color: 'var(--fg-muted)' };
export const chosen: CSSProperties = { border: '1px solid var(--primary)', color: 'var(--primary)', background: 'var(--primary-light)' };
export const small: CSSProperties = { fontSize: '0.6875rem', color: 'var(--fg-muted)', lineHeight: 1.4 };
export const pill = (fg: string, bg: string): CSSProperties => ({
  fontSize: '0.625rem', fontWeight: 700, padding: '0.0625rem 0.4rem', borderRadius: 999, color: fg, background: bg,
  whiteSpace: 'nowrap', display: 'inline-block', lineHeight: 1.5,
});
export const sectionTitle: CSSProperties = { fontSize: '0.6875rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)', margin: '0 0 0.375rem' };
export const box: CSSProperties = { padding: '0.75rem', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--card-bg)', marginBottom: '0.75rem' };
export const td: CSSProperties = { padding: '0.5rem 0.625rem', borderTop: '1px solid var(--border)', fontSize: '0.8125rem', verticalAlign: 'top', overflowWrap: 'anywhere' };
export const th: CSSProperties = { padding: '0.5rem 0.625rem', fontSize: '0.6875rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--fg-muted)', textAlign: 'left', whiteSpace: 'nowrap' };
export const noteBox = (fg: string, bg: string): CSSProperties => ({ padding: '0.5rem 0.75rem', borderRadius: 8, borderLeft: `3px solid ${fg}`, background: bg, fontSize: '0.75rem', lineHeight: 1.5, overflowWrap: 'anywhere', color: 'var(--fg)' });

export function StatusPill({ status }: { status: Status }) {
  const p = STATUS_PILL[status] || STATUS_PILL.cancelled;
  return <span style={pill(p.fg, p.bg)}>{p.label}</span>;
}
export function FlagPills({ codes }: { codes: string[] }) {
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
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 7.5rem) minmax(0, 1fr)', gap: 8, padding: '0.25rem 0', fontSize: '0.8125rem' }}>
      <span style={{ color: 'var(--fg-muted)' }}>{label}</span>
      <span style={{ minWidth: 0, overflowWrap: 'anywhere', color: 'var(--fg)' }}>{children}</span>
    </div>
  );
}
