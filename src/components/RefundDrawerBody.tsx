'use client';

import type { CSSProperties, Dispatch, SetStateAction } from 'react';
import { AlertTriangle, Check, Copy, Eye, Loader2 } from 'lucide-react';
import { formatAmount, formatDate, formatDateTime } from '@/lib/refund/texts';
import { NOTE_MAX, RETURN_NOTE_MAX } from '@/lib/refund/rules';
import {
  ACTOR, EVENT_LABEL, LEVEL_COLOR, Row, STEP_LABEL, box, muted, n, noteBox, pill, reasonText, s, sectionTitle, small,
  type Detail, type Msg, type Revealed,
} from './RefundRequestsShared';

export default function RefundDrawerBody({
  detail, dr, rejectBanner, allowed, failedEmail, rowBusy, small_action, snap, nowO, prepaid, total, items, revealed, copy, hideReveal,
  revealLeft, reveal, revealing, holderName, returnDraft, setReturnDraft, field, noteDraft, setNoteDraft, isPhone,
}: {
  detail: Detail;
  dr: Detail['request'];
  rejectBanner: boolean;
  allowed: Set<string>;
  failedEmail: Msg | null;
  rowBusy: string | null;
  small_action: (key: string, body: Record<string, unknown>, okText: string) => Promise<boolean | undefined>;
  snap: Record<string, unknown>;
  nowO: Detail['order']['now'];
  prepaid: boolean;
  total: number | null;
  items: Record<string, unknown>[];
  revealed: Revealed | null;
  copy: (text: string, what: string) => Promise<void>;
  hideReveal: () => void;
  revealLeft: number;
  reveal: () => Promise<void>;
  revealing: boolean;
  holderName: string | null;
  returnDraft: { needed: boolean; note: string } | null;
  setReturnDraft: Dispatch<SetStateAction<{ needed: boolean; note: string } | null>>;
  field: CSSProperties;
  noteDraft: string;
  setNoteDraft: Dispatch<SetStateAction<string>>;
  isPhone: boolean;
}) {
  return (
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
        ) : detail.can_reveal === false ? (
          <div className="rf-noprint" style={{ ...small, marginTop: 8 }}>The full details are shown to the Super Admin only.</div>
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
  );
}
