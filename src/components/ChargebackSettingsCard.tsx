'use client';

// ── Chargeback protection, in Panel Settings (owner 2026-10-08), Super Admin only ──────────────
// One extra Gmail per panel: the address typed into every payment gateway as its chargeback / dispute email.
// ShipTrack only READS it (every minute) and turns each mail into an alert; nothing is sent from it and the AI
// never sees it. The WhatsApp number gets a message for each alert; the gateway checklist is a reminder of
// where the address has been added (ShipTrack fills nothing in a gateway). Server: src/lib/chargeback/*.
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, ShieldAlert, Trash2 } from 'lucide-react';
import { agoText } from '@/app/admin/_lib/format';

interface Data {
  installed: boolean;
  mailbox: { id: string; email: string; createdAt: string; status: { ok: boolean; error: string | null; checkedAt: number; lastMailAt: number | null } | null } | null;
  whatsapp: string;
  gateways: Record<string, { done: boolean; by: string; at: string }>;
  whatsappReady: boolean;
  gatewayList: { key: string; label: string }[];
}

export default function ChargebackSettingsCard({ token, businessId, panelName, onAlert }: { token: string; businessId: string; panelName: string; onAlert: (type: string, message: string) => void }) {
  const [d, setD] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [wa, setWa] = useState('');
  const [busy, setBusy] = useState('');
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/panel-chargeback?businessId=${encodeURIComponent(businessId)}`, { headers: auth, cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { setD(j); setWa(j.whatsapp || ''); } else { setD(null); onAlert('error', j.error || 'Could not read the chargeback settings.'); }
    } catch { setD(null); }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId, token]);
  useEffect(() => { void load(); }, [load]);

  const call = async (what: string, method: string, body?: unknown, url = '/api/panel-chargeback') => {
    setBusy(what);
    try {
      const r = await fetch(url, { method, headers: auth, body: body ? JSON.stringify(body) : undefined });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Could not save that.'); return false; }
      return true;
    } catch { onAlert('error', 'Could not save that.'); return false; }
    finally { setBusy(''); }
  };

  const connect = async () => {
    if (await call('connect', 'POST', { businessId, email, appPassword: pass })) { setEmail(''); setPass(''); onAlert('success', 'Chargeback Gmail connected. New mail in it will raise an alert.'); await load(); }
  };
  const remove = async () => {
    if (!window.confirm(`Disconnect the chargeback Gmail of ${panelName}? Old alerts stay. New chargeback mails will no longer be seen.`)) return;
    if (await call('remove', 'DELETE', undefined, `/api/panel-chargeback?businessId=${encodeURIComponent(businessId)}`)) await load();
  };
  const saveWa = async () => { if (await call('wa', 'PATCH', { businessId, whatsapp: wa })) { onAlert('success', wa.trim() ? 'WhatsApp number saved.' : 'WhatsApp number removed.'); await load(); } };
  const tick = async (key: string, done: boolean) => { if (await call(`g-${key}`, 'PATCH', { businessId, gateway: { key, done } })) await load(); };

  return (
    <div className="tf-card" style={{ padding: '1.5rem', marginTop: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <ShieldAlert size={18} style={{ color: 'var(--danger)' }} />
        <span style={{ fontWeight: 700, fontSize: '0.9375rem' }}>Chargeback protection</span>
        {d?.mailbox && <span className="chip chip-ok">On</span>}
      </div>
      <p className="meta" style={{ marginBottom: '1rem' }}>
        Give each payment gateway of <b>{panelName}</b> one separate Gmail as its chargeback email. ShipTrack reads it every minute and, when a mail comes, shows a red badge, tags that customer&apos;s chat and sends a WhatsApp message. Nothing is ever sent from this Gmail.
      </p>
      {loading && !d && <div className="meta"><Loader2 size={14} className="spin" /> Loading…</div>}
      {d && !d.installed && <div className="mail-warn" style={{ margin: 0 }}>Not installed yet: run chargeback.sql on the server first.</div>}
      {d && d.installed && (
        <div style={{ display: 'grid', gap: '1.25rem' }}>
          {/* 1. The chargeback Gmail */}
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.8125rem', marginBottom: '0.375rem' }}>1. Chargeback Gmail</div>
            {d.mailbox ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0.75rem', border: '1px solid var(--border)', borderRadius: '0.5rem' }}>
                <span style={{ color: !d.mailbox.status ? 'var(--fg-muted)' : d.mailbox.status.ok ? 'var(--success)' : 'var(--danger)', fontSize: '0.5rem' }}>●</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '0.8125rem', fontWeight: 500 }}>{d.mailbox.email}</div>
                  <div className="meta" style={{ color: d.mailbox.status && !d.mailbox.status.ok ? 'var(--danger)' : undefined }}>
                    {!d.mailbox.status ? 'Not checked yet. It is checked every minute.'
                      : !d.mailbox.status.ok ? `${d.mailbox.status.error || 'Could not read this Gmail.'} Last tried ${agoText(d.mailbox.status.checkedAt)}.`
                      : `Working. Checked ${agoText(d.mailbox.status.checkedAt)}.${d.mailbox.status.lastMailAt ? ` Last chargeback mail ${agoText(d.mailbox.status.lastMailAt)}.` : ''}`}
                  </div>
                </div>
                <button className="btn-icon" style={{ marginLeft: 'auto', color: 'var(--danger)' }} title="Disconnect" disabled={busy === 'remove'} onClick={remove}><Trash2 size={14} /></button>
              </div>
            ) : (
              <>
                <div className="meta" style={{ marginBottom: '0.5rem' }}>Use a new Gmail made only for this (Google App Password, same steps as Email Support). Mail already in it is left alone; alerts start with the next mail.</div>
                <div className="mail-bar" style={{ border: 0, padding: 0 }}>
                  <input className="form-input" style={{ flex: 1, minWidth: 180 }} placeholder="chargeback.panelname@gmail.com" value={email} onChange={e => setEmail(e.target.value)} />
                  <input className="form-input" style={{ flex: 1, minWidth: 180 }} placeholder="App password abcd efgh ijkl mnop" value={pass} onChange={e => setPass(e.target.value)} />
                  <button className="btn btn-primary btn-sm" disabled={!email.trim() || !pass.trim() || busy === 'connect'} onClick={connect}>{busy === 'connect' ? <Loader2 size={14} className="spin" /> : null} Connect</button>
                </div>
              </>
            )}
          </div>

          {/* 2. WhatsApp */}
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.8125rem', marginBottom: '0.375rem' }}>2. WhatsApp number for the alert</div>
            <div className="mail-bar" style={{ border: 0, padding: 0 }}>
              <input className="form-input" style={{ flex: 1, minWidth: 180, maxWidth: 280 }} placeholder="919876543210" inputMode="tel" value={wa} onChange={e => setWa(e.target.value)} />
              <button className="btn btn-outline btn-sm" disabled={busy === 'wa' || wa === d.whatsapp} onClick={saveWa}>Save number</button>
            </div>
            <div className="meta" style={{ marginTop: '0.375rem', color: d.whatsappReady ? undefined : 'var(--danger)' }}>
              {d.whatsappReady ? 'WhatsApp sending is set up on the server.' : 'WhatsApp sending is not set up on the server yet (it needs the WhatsApp Business token and a message template). Until then the alert shows only in ShipTrack.'}
            </div>
          </div>

          {/* 3. Gateway checklist */}
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.8125rem', marginBottom: '0.375rem' }}>3. Where this email has been added</div>
            <div className="meta" style={{ marginBottom: '0.5rem' }}>Tick a gateway after you typed the chargeback Gmail into its dashboard (Settings → Notifications / Disputes). This is only your checklist.</div>
            <div style={{ display: 'grid', gap: '0.25rem', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
              {d.gatewayList.map(g => {
                const m = d.gateways[g.key];
                return (
                  <label key={g.key} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.375rem 0.5rem', border: '1px solid var(--border)', borderRadius: '0.5rem', fontSize: '0.8125rem', cursor: 'pointer' }}>
                    <input type="checkbox" checked={!!m?.done} disabled={busy === `g-${g.key}`} onChange={e => tick(g.key, e.target.checked)} />
                    <span style={{ flex: 1 }}>{g.label}</span>
                    {m?.done && <span className="meta" title={`${m.by}, ${new Date(m.at).toLocaleDateString('en-IN')}`}><CheckCircle2 size={12} className="t-ok" /> {m.by.split(' ')[0]}</span>}
                  </label>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
