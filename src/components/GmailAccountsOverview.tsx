'use client';

// ── "Which Gmail is which?" (owner 2026-10-08: "hum confuse ho rahe hain ... support wali email jodni hai ya chargeback wali, kabhi kuch delete kar dete hain") ──
// One strip at the top of Connections, per panel, with the TWO Gmail accounts side by side, each with its job in
// plain words, its address and whether it is being read right now. The two forms (and the Disconnect buttons) are the
// cards right below, in the same order and colours. Read only: nothing here changes anything.
import { useEffect, useState } from 'react';
import { CheckCircle2, Inbox, ShieldAlert, AlertTriangle } from 'lucide-react';
import { agoText } from '@/app/admin/_lib/format';

interface Status { ok: boolean; error: string | null; checkedAt: number; lastMailAt: number | null }
interface Support { email: string; status: Status | null }

export default function GmailAccountsOverview({ token, businessId, panelName, support }: {
  token: string; businessId: string; panelName: string; support: Support[];
}) {
  const [cb, setCb] = useState<{ email: string; status: Status | null } | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setCb(undefined);
    fetch(`/api/panel-chargeback?businessId=${encodeURIComponent(businessId)}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      .then(r => r.json().then(j => ({ ok: r.ok, j })))
      .then(({ ok, j }) => { if (live) setCb(ok && j?.mailbox ? { email: j.mailbox.email, status: j.mailbox.status ?? null } : null); })
      .catch(() => { if (live) setCb(null); });
    return () => { live = false; };
  }, [businessId, token]);

  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const line = (email: string | null, st: Status | null, none: string) => {
    if (!email) return { tone: 'var(--danger)', icon: <AlertTriangle size={13} />, text: none };
    if (!st) return { tone: 'var(--fg-muted)', icon: <CheckCircle2 size={13} />, text: `${email} · connected, checked every minute` };
    if (!st.ok) return { tone: 'var(--danger)', icon: <AlertTriangle size={13} />, text: `${email} · cannot be read (${st.error || 'unknown'}), last tried ${agoText(st.checkedAt)}` };
    return { tone: 'var(--success)', icon: <CheckCircle2 size={13} />, text: `${email} · working, checked ${agoText(st.checkedAt)}` };
  };
  const s = support[0] ?? null;
  const sl = line(s?.email ?? null, s?.status ?? null, 'Not connected yet');
  const cl = cb === undefined ? { tone: 'var(--fg-muted)', icon: null, text: 'Loading…' } : line(cb?.email ?? null, cb?.status ?? null, 'Not connected yet');

  const tile = (accent: string, icon: React.ReactNode, title: string, job: string, never: string, st: { tone: string; icon: React.ReactNode; text: string }, extra: string, target: string) => (
    <div style={{ flex: '1 1 320px', minWidth: 0, borderLeft: `4px solid ${accent}`, border: `1px solid var(--border)`, borderLeftWidth: 4, borderLeftColor: accent, borderRadius: 10, padding: '0.875rem 1rem', background: 'var(--card, #fff)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: '0.9375rem' }}>{icon}{title}</div>
      <p style={{ fontSize: '0.8125rem', margin: '6px 0 2px' }}>{job}</p>
      <p className="meta" style={{ margin: 0 }}>{never}</p>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 10, fontSize: '0.8125rem', fontWeight: 600, color: st.tone, wordBreak: 'break-word' }}>{st.icon}<span>{st.text}</span></div>
      {extra && <p className="meta" style={{ margin: '4px 0 0' }}>{extra}</p>}
      <button type="button" className="btn btn-outline btn-sm" style={{ marginTop: 10 }} onClick={() => go(target)}>Open settings ↓</button>
    </div>
  );

  return (
    <div className="tf-card" style={{ padding: '1.25rem 1.5rem' }}>
      <div style={{ fontWeight: 700, fontSize: '1rem' }}>Gmail accounts of {panelName}</div>
      <p className="meta" style={{ margin: '4px 0 12px' }}>
        Every panel has <b>two different Gmail accounts</b>. They do two different jobs, so use a different Gmail for each. Nothing here changes anything; use the buttons to open the right form below.
      </p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {tile('var(--primary)', <Inbox size={16} style={{ color: 'var(--primary)' }} />, '1 · Customer support Gmail',
          'The Gmail your customers write to. Chikki reads it and writes a draft; your team replies from the Mail tab.',
          'Not for payment-gateway mails.', sl, '', 'set-gmail-support')}
        {tile('var(--danger)', <ShieldAlert size={16} style={{ color: 'var(--danger)' }} />, '2 · Chargeback Gmail',
          'Type this one into your payment gateway as its chargeback / dispute email. A chargeback mail makes a red alert and a WhatsApp message.',
          'Customers never write here. Nothing is ever sent from it.', cl, '', 'set-gmail-chargeback')}
      </div>
    </div>
  );
}
