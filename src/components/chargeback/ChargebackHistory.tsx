'use client';

// ── Chargeback history on screen (owner 2026-10-13: "chargeback ... order ki chat, gmail, whatsapp sa connect toh ho
// jaee takki tuh kuch read kar paee") ──
// Inside an opened chargeback (Chargebacks) and an order of Stop them: the order, the chats / Gmail / WhatsApp tied to it
// and one timeline, oldest first. "Copy for Claude" copies it as text with names, phones, emails, links and order
// numbers masked (history-rules.ts historyText), to paste into Claude. Reads GET /api/chargebacks/history.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, ClipboardCopy, ExternalLink, Loader2, Mail, MessageCircle, RefreshCw, ShieldAlert, Smartphone, Zap } from 'lucide-react';
import { channelName, istStamp, whoName, type ChargebackHistory as History, type HistoryChannel } from '@/lib/chargeback/history-rules';

const ICON: Record<HistoryChannel, JSX.Element> = {
  chat: <MessageCircle size={12} />, email: <Mail size={12} />, gmail: <Mail size={12} />, whatsapp: <Smartphone size={12} />,
  wa_auto: <Zap size={12} />, chargeback: <ShieldAlert size={12} />,
};
const SOURCE_NAME = { chat: 'Website chat', email: 'Email chat', whatsapp: 'WhatsApp chat' } as const;
type Show = 'all' | 'customer';

export default function ChargebackHistory({ token, alertId, businessId, orderId, onAlert, onLinked }: {
  token: string; alertId?: string; businessId?: string; orderId?: string;
  onAlert: (type: string, message: string) => void;
  onLinked?: () => void;
}) {
  const [h, setH] = useState<History | null>(null);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(true);
  const [show, setShow] = useState<Show>('all');
  const [open, setOpen] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const qs = alertId ? `id=${encodeURIComponent(alertId)}` : `businessId=${encodeURIComponent(businessId || '')}&orderId=${encodeURIComponent(orderId || '')}`;
      const r = await fetch(`/api/chargebacks/history?${qs}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.error || 'Could not read the history.'); return; }
      setH(j.history); setText(j.text || ''); setErr('');
    } catch { setErr('Could not read the history.'); }
    finally { setBusy(false); }
  }, [token, alertId, businessId, orderId]);
  useEffect(() => { void load(); }, [load]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(text); onAlert('success', 'Copied (names, phones, emails and links hidden). Paste it to Claude.'); }
    catch { onAlert('error', 'Could not copy: the browser did not allow it.'); }
  };
  const link = async (order: string) => {
    if (!alertId) return;
    try {
      const r = await fetch('/api/chargebacks', { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: alertId, orderId: order.replace(/[^0-9]/g, '') }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Could not link it.'); return; }
      onAlert('success', `Linked to order ${j.orderId}.`); onLinked?.(); await load();
    } catch { onAlert('error', 'Could not link it.'); }
  };

  const items = useMemo(() => (h?.timeline || []).filter((e) => show === 'all' || e.who === 'customer'), [h, show]);

  if (busy && !h) return <div className="cbh"><Loader2 size={16} className="spin" /> <span className="meta">Reading the order&apos;s chats, Gmail and WhatsApp…</span></div>;
  if (err) return <div className="cbh"><span className="meta" style={{ color: 'var(--danger)' }}>{err}</span> <button type="button" className="btn btn-ghost btn-sm" onClick={load}>Try again</button></div>;
  if (!h) return null;
  const o = h.order;

  return (
    <div className="cbh">
      <div className="cbh-head">
        <b>Customer history</b>
        <span className="meta">everything tied to this order, oldest first</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-outline btn-sm" onClick={copy} disabled={!text} title="Copies the history as text with names, phones, emails, links and order numbers hidden"><ClipboardCopy size={13} /> Copy for Claude</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={load} disabled={busy} aria-label="Refresh">{busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}</button>
      </div>

      {o ? (
        <div className="cbh-order">
          <span className="chip chip-primary">Order {o.orderId}</span>
          <b>{o.customerName || 'Customer'}</b>
          <span className="meta">placed {istStamp(o.placedAt)} · ₹{Math.round(o.total).toLocaleString('en-IN')} · {o.payment}</span>
          <span className={`chip ${o.status === 'Delivered' ? 'chip-ok' : 'chip-muted'}`}>{o.cancelled ? 'Cancelled' : o.status}</span>
          {o.estimatedDelivery && !o.deliveredAt && <span className="meta">estimated {o.estimatedDelivery}</span>}
          {o.trackingLink && <a className="btn btn-ghost btn-sm" href={o.trackingLink} target="_blank" rel="noopener noreferrer"><ExternalLink size={12} /> Tracking page</a>}
          {h.matchedBy && h.matchedBy !== 'order' && h.matchedBy !== 'typed' && <span className="chip chip-warn" title="The mail named no order number; this order was found by what the mail carries">Found by {h.matchedBy}</span>}
          {alertId && h.matchedBy && h.matchedBy !== 'order' && h.matchedBy !== 'typed' && <button type="button" className="btn btn-outline btn-sm" onClick={() => void link(o.orderId)} title="Ties this chargeback to this order for good (the order chip, the chat's red tag, the Study)">Save this link</button>}
        </div>
      ) : (
        <div className="cbh-none">
          <div className="meta"><b>Order not found.</b> The gateway&apos;s mail names no order number of ours, so nothing can be tied to it yet.{h.candidates.length ? ' These orders fit what the mail says; link the right one:' : ' Find it in the gateway (amount / date / customer) and type it in Link order above.'}</div>
          {h.candidates.map((c) => (
            <div key={c.orderId} className="cbh-cand">
              <span className="chip chip-muted">{c.orderId}</span>
              <span>{c.customerName || 'Customer'}</span>
              <span className="meta">{istStamp(c.placedAt).slice(0, 10)} · ₹{Math.round(c.total).toLocaleString('en-IN')} · {c.status} · {c.why}</span>
              {alertId && <button type="button" className="btn btn-outline btn-sm" onClick={() => void link(c.orderId)}>Link this order</button>}
            </div>
          ))}
        </div>
      )}

      {o && (
        <div className="cbh-sources">
          {h.sources.chats.map((c) => (
            <a key={c.id} className="chip chip-info" href={c.link}>{c.kind === 'whatsapp' ? <Smartphone size={11} /> : c.kind === 'email' ? <Mail size={11} /> : <MessageCircle size={11} />} {SOURCE_NAME[c.kind]} · {c.status} · {c.messages}</a>
          ))}
          <span className="chip chip-muted"><Mail size={11} /> Gmail · {h.sources.gmail} mails</span>
          <span className="chip chip-muted"><Zap size={11} /> WhatsApp automatic · {h.sources.waAuto}</span>
          <span className="chip chip-muted"><ShieldAlert size={11} /> Chargeback mails · {h.sources.chargebacks}</span>
          {h.sources.chats.length === 0 && h.sources.gmail === 0 && <span className="meta">The customer never wrote to us on the chat box, Gmail or WhatsApp.</span>}
        </div>
      )}

      {h.timeline.length > 0 && (
        <>
          <div className="cbh-filter">
            <button type="button" className="seg-btn" aria-pressed={show === 'all'} onClick={() => setShow('all')}>Everything {h.timeline.length}</button>
            <button type="button" className="seg-btn" aria-pressed={show === 'customer'} onClick={() => setShow('customer')}>Customer only {h.timeline.filter((e) => e.who === 'customer').length}</button>
            {h.cut && <span className="meta">only the newest {h.timeline.length}</span>}
          </div>
          <div className="cbh-list">
            {items.map((e, i) => {
              const long = e.text.length > 280, isOpen = open.has(i);
              return (
                <div key={i} className={`cbh-row cbh-${e.who}`}>
                  <div className="cbh-meta">
                    <span className="cbh-ch">{ICON[e.channel]} {channelName(e.channel)}</span>
                    <b>{e.who === 'chikki' ? <><Bot size={11} /> Chikki</> : whoName(e.who).charAt(0) + whoName(e.who).slice(1).toLowerCase()}</b>
                    <span className="meta">{istStamp(e.at)}</span>
                    {e.status && <span className="chip chip-muted">{e.status}</span>}
                    {e.link && <a className="meta" href={e.link} target={e.link.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer">open</a>}
                  </div>
                  {e.subject && <div className="cbh-subject">{e.subject}</div>}
                  <div className="cbh-text">{long && !isOpen ? `${e.text.slice(0, 280)}…` : e.text}</div>
                  {long && <button type="button" className="btn btn-ghost btn-sm" style={{ padding: 0 }} onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; })}>{isOpen ? 'Less' : 'More'}</button>}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
