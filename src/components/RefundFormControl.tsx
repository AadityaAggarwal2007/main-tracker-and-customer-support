'use client';

// ── "Send refund form" in a Refund chat's header (owner, 2026-10-02) ──
// SUPER ADMIN ONLY, and only in a chat marked Refund: the chat page renders this only when
// isSuperAdmin(user) && activeConv.case_kind === 'refund' and the thread answer carried refund_form;
// the routes check both again on the locked chat row (src/app/api/chat/conversations/[id]/refund-form).
// The form goes into the chat as "Vastora Support" (an email chat also gets it as an email reply). The
// team never sees this control; they see the chat's messages with the link masked.
// Shows where the order's form stands (sent / opened / expired / received / approved / rejected /
// refunded / cancelled) and offers Send, Send new link, Cancel link and Open request. Spec 6.
// An email chat whose form email failed shows a red chip with "Retry email" (spec 4.5): the customer
// gets the link only by email, so the failure stays on the chip until the email goes out.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, FileText, Link2Off, Loader2, RefreshCw, X } from 'lucide-react';
import { formatAmount, formatDateTime, formatDayMonth } from '@/lib/refund/texts';

// The thread answer's refund_form (GET /api/chat/conversations/<id>, Super Admin + Refund chats only).
export interface RefundThreadState {
  can_send: boolean;
  block: null | 'setup' | 'not_refund_case' | 'not_verified' | 'order_mismatch' | 'no_panel' | 'request_open' | 'merged'
    | 'prepaid_gateway' | 'order_not_found' | 'no_mailbox' | 'cooldown' | 'too_many';
  block_text: string | null;
  // email_failed: the form message's last email failed (email chats); the chip offers Retry email.
  link: null | { id: string; state: 'active' | 'expired'; sent_at: string; expires_at: string; opened_count: number; last_opened_at: string | null; email_failed?: boolean };
  request: null | { id: string; ref: string; status: 'new' | 'approved' | 'rejected' | 'refunded' | 'cancelled'; utr_last4: string | null };
}
// GET .../refund-form: the Send dialog.
interface DialogState extends RefundThreadState {
  order: null | { order_id: string; name: string | null; total: number; payment: string; status: string | null; delivered: boolean };
  channel: 'chat' | 'email';
  email_to: string | null;
  lang: 'hinglish' | 'en';
  warnings: { code: string; text: string }[];
  preview: null | { hinglish: string; en: string };
}
type Lang = 'hinglish' | 'en';

interface Props {
  token: string;
  conversationId: string;
  state: RefundThreadState;
  onChanged: () => void;
  onAlert: (type: 'success' | 'error', message: string) => void;
  // The name the customer sees on the message (the chat page's supportLabel); "Vastora Support" if not given.
  label?: string;
}

const chip = (fg: string, bg: string): CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0, whiteSpace: 'nowrap', fontSize: '0.6875rem', fontWeight: 700,
  padding: '2px 8px', borderRadius: 9999, color: fg, background: bg, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis',
});
const GREY = chip('var(--fg-muted)', 'var(--bg-subtle)');
const BLUE = chip('var(--primary)', 'var(--primary-light)');
const AMBER = chip('#92400e', '#fef3c7');
const RED = chip('#b91c1c', '#fee2e2');
const GREEN = chip('#047857', '#d1fae5');
const btnRow: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4 };
const note: CSSProperties = { padding: '0.5rem 0.75rem', borderRadius: 8, fontSize: '0.75rem', lineHeight: 1.5, overflowWrap: 'anywhere' };

const openedText = (n: number) => (n > 0 ? `opened ${n}×` : 'not opened');
const requestUrl = (id: string) => `/admin?tab=refunds&open=${encodeURIComponent(id)}`;

export default function RefundFormControl({ token, conversationId, state, onChanged, onAlert, label }: Props) {
  const [dialog, setDialog] = useState<null | 'send' | 'cancel'>(null);
  const [dstate, setDstate] = useState<DialogState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lang, setLang] = useState<Lang>('hinglish');
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const seq = useRef(0);
  const alertRef = useRef(onAlert);
  alertRef.current = onAlert;
  useEffect(() => { setMounted(true); }, []);
  // Another chat opened: close whatever was open for the last one.
  useEffect(() => { setDialog(null); setDstate(null); setError(null); }, [conversationId]);

  const base = `/api/chat/conversations/${encodeURIComponent(conversationId)}/refund-form`;
  const headers = { Authorization: `Bearer ${token}` };

  const loadDialog = async (keepError = false) => {
    const s = ++seq.current;
    setLoading(true);
    if (!keepError) setError(null);
    try {
      const r = await fetch(base, { headers, cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (s !== seq.current) return;
      if (r.ok) {
        setDstate(d as DialogState);
        setLang((d as DialogState).lang === 'en' ? 'en' : 'hinglish');
      } else {
        setDstate(null);
        setError(d.error || 'Could not load the refund form state.');
      }
    } catch {
      if (s === seq.current) setError('Could not load the refund form state. Check the internet and try again.');
    } finally {
      if (s === seq.current) setLoading(false);
    }
  };

  const openSend = () => { setDialog('send'); setDstate(null); void loadDialog(); };
  const close = () => { if (busy) return; setDialog(null); setError(null); };

  const send = async () => {
    if (!dstate || busy) return;
    const link = dstate.link;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(base, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        // An open link is replaced on purpose (this dialog said so); an expired one is replaced anyway.
        body: JSON.stringify({ lang, replace: !!link && link.state === 'active', expectLinkId: link ? link.id : null }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) {
        setDialog(null);
        if (d.emailed === false) alertRef.current('error', 'Saved in the chat, email not sent. Retry from the chip.');
        else alertRef.current('success', 'Refund form sent');
        onChanged();
        return;
      }
      setError(d.error || 'Could not send the refund form.');
      // Something changed meanwhile (a link sent from another tab, a request came in): show it as it is now.
      if (d.state && typeof d.state === 'object' && 'can_send' in d.state && 'warnings' in d.state) setDstate(d.state as DialogState);
      else void loadDialog(true);
      onChanged();
    } catch {
      setError('Could not send the refund form. Check the internet and try again.');
    } finally {
      setBusy(false);
    }
  };

  const cancelLink = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(base, { method: 'DELETE', headers });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) {
        setDialog(null);
        alertRef.current('success', 'Link cancelled. The customer was not told anything.');
      } else {
        setDialog(null);
        alertRef.current('error', d.error || 'Could not cancel the link.');
      }
      onChanged();
    } catch {
      setError('Could not cancel the link. Check the internet and try again.');
    } finally {
      setBusy(false);
    }
  };

  // The chip's "Retry email": the same form message emailed again (no new link, no new message).
  const retryEmail = async (linkId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch(base, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry_email', linkId }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok && d.emailed) alertRef.current('success', 'Email sent');
      else if (r.ok && d.ok) alertRef.current('error', 'The email still did not go out. Check the mailbox in Panel Settings, then retry.');
      else alertRef.current('error', d.error || 'Could not send the email again.');
      onChanged();
    } catch {
      alertRef.current('error', 'Could not send the email again. Check the internet and try again.');
    } finally {
      setBusy(false);
    }
  };

  // ── The chip and buttons in the header row ──
  const { link, request } = state;
  const reqOpen = !!request && ['new', 'approved', 'refunded'].includes(request.status);
  // A link sent after a rejected / cancelled request is the newer fact: it is shown first.
  const showLink = !!link && !reqOpen;
  const blocked = !state.can_send && state.block !== 'request_open';
  const blockLine = blocked && state.block_text ? state.block_text : null;

  const openRequest = request ? (
    <a className="btn btn-outline btn-sm" href={requestUrl(request.id)} target="_blank" rel="noopener noreferrer" style={btnRow}
      title={`Open ${request.ref} in Refund requests`}>
      Open request <ExternalLink size={12} />
    </a>
  ) : null;
  const sendBtn = (text: string) => (
    <button type="button" className="btn btn-outline btn-sm" style={btnRow} disabled={blocked} onClick={openSend}
      title={blocked ? state.block_text || undefined : 'Send the refund form into this chat (Super Admin only)'}>
      <FileText size={13} /> {text}
    </button>
  );

  let chipEl: ReactNode = null;
  let buttons: ReactNode = null;
  if (showLink && link) {
    if (link.state === 'active') {
      const opened = link.opened_count > 0;
      chipEl = link.email_failed ? (
        <span style={RED} role="status" title={`Saved in the chat ${formatDateTime(link.sent_at)}, but the email to the customer did not go out. Retry email, or check the mailbox in Panel Settings.`}>
          <FileText size={11} /> Form saved · email NOT sent
        </span>
      ) : (
        <span style={opened ? BLUE : GREY} title={`Sent ${formatDateTime(link.sent_at)} · valid till ${formatDateTime(link.expires_at)}${link.last_opened_at ? ` · last opened ${formatDateTime(link.last_opened_at)}` : ''}`}>
          <FileText size={11} /> Form sent · valid till {formatDayMonth(link.expires_at)} · {openedText(link.opened_count)}
        </span>
      );
      buttons = (
        <>
          {link.email_failed && (
            <button type="button" className="btn btn-outline btn-sm" style={btnRow} disabled={busy} onClick={() => void retryEmail(link.id)}
              title="Email the same form message to the customer again (no new link)">
              {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={13} />} Retry email
            </button>
          )}
          {sendBtn('Send new link')}
          <button type="button" className="btn btn-outline btn-sm" style={btnRow} onClick={() => { setError(null); setDialog('cancel'); }}
            title="The customer's link stops working at once. Nothing is sent to the customer.">
            <Link2Off size={13} /> Cancel link
          </button>
        </>
      );
    } else {
      chipEl = <span style={GREY} title={`Sent ${formatDateTime(link.sent_at)} · expired ${formatDateTime(link.expires_at)}`}><FileText size={11} /> Form link expired · not filled</span>;
      buttons = sendBtn('Send new link');
    }
    if (request && (request.status === 'rejected' || request.status === 'cancelled')) {
      buttons = <>{buttons}{openRequest}</>;
    }
  } else if (request) {
    const r = request;
    if (r.status === 'new') chipEl = <span style={AMBER}>Form received · New · {r.ref}</span>;
    else if (r.status === 'approved') chipEl = <span style={BLUE}>Refund approved · {r.ref}</span>;
    else if (r.status === 'rejected') chipEl = <span style={RED}>Refund rejected · {r.ref}</span>;
    else if (r.status === 'refunded') chipEl = <span style={GREEN} title={r.ref}>Refunded{r.utr_last4 ? ` · UTR ••${r.utr_last4}` : ` · ${r.ref}`}</span>;
    else chipEl = <span style={GREY}>Request cancelled · {r.ref}</span>;
    buttons = (r.status === 'rejected' || r.status === 'cancelled')
      ? <>{openRequest}{sendBtn('Send new form')}</>
      : openRequest;
  } else {
    buttons = sendBtn('Send refund form');
  }

  // ── The Send dialog ──
  const d = dstate;
  const preview = d?.preview ? d.preview[lang] : null;
  const activeLink = d?.link && d.link.state === 'active' ? d.link : null;
  const otherWarnings = (d?.warnings || []).filter((w) => w.code !== 'active_link');
  const facts = d?.order
    ? [`Order ${d.order.order_id}`, d.order.name, d.order.payment, formatAmount(d.order.total), d.order.status].filter(Boolean).join(' · ')
    : '';
  const who = label || 'Vastora Support';

  const sendDialog = dialog === 'send' && (
    <div className="modal-overlay" onClick={close}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="rf-send-title" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '34rem' }}>
        <div className="modal-header" style={{ alignItems: 'flex-start', gap: 8 }}>
          <div style={{ minWidth: 0 }}>
            <h3 id="rf-send-title" className="modal-title">{activeLink ? 'Send a new refund form link?' : 'Send refund form?'}</h3>
            <p className="modal-subtitle" style={{ overflowWrap: 'anywhere' }}>
              {d?.channel === 'email' && d.email_to ? `Goes as an email reply to ${d.email_to}` : `Goes into this chat as ${who}`}
            </p>
          </div>
          <button type="button" className="btn-icon" onClick={close} aria-label="Close" disabled={busy}><X size={16} /></button>
        </div>

        {loading && !d && (
          <div style={{ padding: '1rem 0', textAlign: 'center', color: 'var(--fg-muted)', fontSize: '0.8125rem' }}>
            <Loader2 size={16} style={{ animation: 'spin 1s linear infinite', verticalAlign: 'middle' }} /> Loading…
          </div>
        )}

        {d && (
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            {facts && (
              <div style={{ fontSize: '0.8125rem', color: 'var(--fg)', overflowWrap: 'anywhere' }}>
                <div style={{ fontWeight: 600 }}>{facts}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>1 order · 1 submit · 7 days</div>
              </div>
            )}

            {d.block_text && !d.can_send && (
              <div role="alert" style={{ ...note, background: 'var(--danger-light)', color: 'var(--danger)' }}>{d.block_text}</div>
            )}

            {activeLink && (
              <div style={{ ...note, background: 'var(--warning-light)', borderLeft: '3px solid var(--warning)', color: 'var(--fg)' }}>
                The link sent on {formatDateTime(activeLink.sent_at)} ({openedText(activeLink.opened_count)}) closes at once. The customer gets a new link.
              </div>
            )}
            {otherWarnings.length > 0 && (
              <div style={{ ...note, background: 'var(--warning-light)', borderLeft: '3px solid var(--warning)', color: 'var(--fg)', display: 'grid', gap: 4 }}>
                {otherWarnings.map((w) => <div key={w.code}>{w.text}</div>)}
              </div>
            )}

            {d.preview && (
              <>
                <div role="radiogroup" aria-label="Message language" style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: '0.8125rem' }}>
                  {(['hinglish', 'en'] as Lang[]).map((l) => (
                    <label key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="radio" name="rf-send-lang" checked={lang === l} onChange={() => setLang(l)} />
                      {l === 'hinglish' ? 'Hinglish' : 'English'}{d.lang === l ? <span style={{ color: 'var(--fg-muted)' }}>(this chat)</span> : null}
                    </label>
                  ))}
                </div>
                <div>
                  <div style={{ fontSize: '0.6875rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--fg-muted)', marginBottom: 4 }}>
                    The customer gets this message
                  </div>
                  <div style={{ padding: '0.625rem 0.75rem', borderRadius: 10, background: 'var(--bg-subtle)', border: '1px solid var(--border)', fontSize: '0.8125rem', lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {preview}
                  </div>
                  <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginTop: 4 }}>
                    The real link goes to the customer only; every staff screen shows it as [refund form link].
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {error && (
          <div role="alert" style={{ ...note, marginTop: '0.75rem', background: 'var(--danger-light)', color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ flex: 1, minWidth: 0 }}>{error}</span>
            {!d && !loading && <button type="button" className="btn btn-outline btn-sm" onClick={() => loadDialog()}>Retry</button>}
          </div>
        )}

        <div className="modal-actions" style={{ marginTop: '1rem' }}>
          <button type="button" className="btn btn-outline" onClick={close} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={send} disabled={busy || loading || !d || !d.can_send}>
            {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <FileText size={14} />}
            {activeLink ? 'Send new link' : 'Send form'}
          </button>
        </div>
      </div>
    </div>
  );

  const cancelDialog = dialog === 'cancel' && (
    <div className="modal-overlay" onClick={close}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="rf-cancel-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3 id="rf-cancel-title" className="modal-title">Cancel the refund form link?</h3>
            <p className="modal-subtitle">{"The customer's link stops working at once. Nothing is sent to the customer."}</p>
          </div>
          <button type="button" className="btn-icon" onClick={close} aria-label="Close" disabled={busy}><X size={16} /></button>
        </div>
        {error && <div role="alert" style={{ ...note, marginBottom: '0.75rem', background: 'var(--danger-light)', color: 'var(--danger)' }}>{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={close} disabled={busy}>Keep the link</button>
          <button type="button" className="btn btn-primary" onClick={cancelLink} disabled={busy} style={{ background: 'var(--danger)' }}>
            {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Link2Off size={14} />} Cancel link
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {chipEl}
      {buttons}
      {/* Why Send is off, as a small line of its own (a phone has no hover). */}
      {blockLine && (
        <div style={{ flexBasis: '100%', minWidth: 0, fontSize: '0.6875rem', color: 'var(--fg-muted)', textAlign: 'right', wordBreak: 'break-word' }}>
          Refund form: {blockLine}
        </div>
      )}
      {/* The dialogs go to <body>: a transformed ancestor would pin position:fixed to it. */}
      {mounted && (sendDialog || cancelDialog) ? createPortal(<>{sendDialog}{cancelDialog}</>, document.body) : null}
    </>
  );
}
