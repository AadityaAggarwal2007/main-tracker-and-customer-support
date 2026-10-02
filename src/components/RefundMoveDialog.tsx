'use client';

import type { CSSProperties, Dispatch, ReactNode, SetStateAction } from 'react';
import { Loader2, X } from 'lucide-react';
import { formatAmount } from '@/lib/refund/texts';
import { istDay, NOTE_MAX, AMOUNT_CAP } from '@/lib/refund/rules';
import { noteBox, payoutText, s, small, type Detail, type Lang, type Move } from './RefundRequestsShared';

export default function RefundMoveDialog({
  move, detail, dr, mBusy, setMove, moveTitle, snap, isPhone, mAmount, setMAmount, fieldErr, mDate, setMDate, mUtr, setMUtr, field, total,
  mAmountOk, setMAmountOk, prepaid, mGateway, setMGateway, liveWarn, mNote, setMNote, mLang, setMLang, previewText, mError, submitMove, moveButton,
}: {
  move: Move;
  detail: Detail;
  dr: Detail['request'];
  mBusy: boolean;
  setMove: Dispatch<SetStateAction<Move | null>>;
  moveTitle: string;
  snap: Record<string, unknown>;
  isPhone: boolean;
  mAmount: string;
  setMAmount: Dispatch<SetStateAction<string>>;
  fieldErr: (k: string) => ReactNode;
  mDate: string;
  setMDate: Dispatch<SetStateAction<string>>;
  mUtr: string;
  setMUtr: Dispatch<SetStateAction<string>>;
  field: CSSProperties;
  total: number | null;
  mAmountOk: boolean;
  setMAmountOk: Dispatch<SetStateAction<boolean>>;
  prepaid: boolean;
  mGateway: boolean;
  setMGateway: Dispatch<SetStateAction<boolean>>;
  liveWarn: string[];
  mNote: string;
  setMNote: Dispatch<SetStateAction<string>>;
  mLang: Lang;
  setMLang: Dispatch<SetStateAction<Lang>>;
  previewText: string | null;
  mError: string | null;
  submitMove: () => Promise<void>;
  moveButton: string;
}) {
  return (
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
  );
}
