'use client';

// ── Chargeback protection, in Panel Settings (owner 2026-10-08), Super Admin only ──────────────
// One extra Gmail per panel: the address typed into every payment gateway as its chargeback / dispute email.
// ShipTrack only READS it (every minute) and turns each mail into an alert; nothing is sent from it and the AI
// never sees it. The WhatsApp number gets a message for each alert; the gateway checklist is a reminder of
// where the address has been added (ShipTrack fills nothing in a gateway). Server: src/lib/chargeback/*.
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, ShieldAlert, Trash2 } from 'lucide-react';
import { agoText } from '@/app/admin/_lib/format';
import { SHIPTRACK_ALERT_PRESET } from '@/lib/chat/whatsapp-brand-rules';

interface Data {
  installed: boolean;
  sharedWith?: string[];
  mailbox: { id: string; email: string; createdAt: string; status: { ok: boolean; error: string | null; checkedAt: number; lastMailAt: number | null } | null } | null;
  whatsapp: string;
  gateways: Record<string, { done: boolean; by: string; at: string }>;
  whatsappReady: boolean;
  // alert-send.ts (owner 2026-10-14): token on the server, the "shiptrack_alert" template's status at Meta.
  whatsappSetup?: { ready: boolean; token: boolean; envTemplate: boolean; template: { name: string; status: string } | null; error: string | null };
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

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/panel-chargeback?businessId=${encodeURIComponent(businessId)}${fresh ? '&fresh=1' : ''}`, { headers: auth, cache: 'no-store' });
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
  // The ShipTrack alert template, made from here (owner 2026-10-14: "template banala"): the same preset as WhatsApp >
  // Templates > "ShipTrack alert template"; Meta reviews it (usually minutes), then alerts go by themselves.
  const makeTemplate = async () => {
    const p = SHIPTRACK_ALERT_PRESET;
    if (await call('tpl', 'POST', { name: p.name, language: p.language, category: p.category, header: p.header, body: p.body, footer: p.footer, examples: [...p.examples] }, '/api/whatsapp/templates')) {
      onAlert('success', 'Template sent to Meta for review. It is usually approved within minutes; alerts start by themselves after that.');
      await load(true);
    }
  };
  const sendTest = async () => {
    if (await call('test', 'PATCH', { businessId, action: 'test' })) onAlert('success', `Test alert sent to ${d?.whatsapp}. Check the phone.`);
  };
  const remove = async () => {
    if (!window.confirm(`Disconnect the CHARGEBACK Gmail of ${panelName}?\n\nOld alerts stay. New chargeback mails will no longer be seen. (The customer support Gmail is a different account and is not touched.)`)) return;
    if (await call('remove', 'DELETE', undefined, `/api/panel-chargeback?businessId=${encodeURIComponent(businessId)}`)) await load();
  };
  const saveWa = async () => { if (await call('wa', 'PATCH', { businessId, whatsapp: wa })) { onAlert('success', wa.trim() ? 'WhatsApp number saved.' : 'WhatsApp number removed.'); await load(); } };
  const tick = async (key: string, done: boolean) => { if (await call(`g-${key}`, 'PATCH', { businessId, gateway: { key, done } })) await load(); };

  return (
    <div className="tf-card" style={{ padding: '1.5rem', borderLeft: '4px solid var(--danger)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <ShieldAlert size={18} style={{ color: 'var(--danger)' }} />
        <span style={{ fontWeight: 700, fontSize: '0.9375rem' }}>Gmail 2 · Chargeback protection</span>
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
            <div style={{ fontWeight: 700, fontSize: '0.8125rem', marginBottom: '0.375rem' }}>Chargeback Gmail address</div>
            {d.mailbox && d.sharedWith && d.sharedWith.length > 0 && (
              <div className="meta" style={{ marginBottom: '0.5rem', padding: '0.5rem 0.625rem', background: 'var(--primary-light)', borderRadius: '0.5rem' }}>
                This Gmail is also used by <b>{d.sharedWith.join(', ')}</b>. Each chargeback mail goes to the panel that has the order it names, or else to the panel whose gateway is ticked in Step B below. <b>Tick the gateway this panel uses</b> (for example PayU here and PayGlocal on the other panel), or the mail cannot be told apart and waits for you to move it.
              </div>
            )}
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
                <button className="btn btn-outline btn-sm" style={{ marginLeft: 'auto', color: 'var(--danger)' }} title="Disconnect the chargeback Gmail" disabled={busy === 'remove'} onClick={remove}><Trash2 size={13} /> Disconnect</button>
              </div>
            ) : (
              <>
                <div className="meta" style={{ marginBottom: '0.5rem' }}>Use a Gmail made only for this (Google App Password, same steps as Email Support). It may be the same Gmail another panel already uses for chargebacks: then each mail is sent to the panel by its gateway or order. Mail already in it is left alone; alerts start with the next mail.</div>
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
            <div style={{ fontWeight: 700, fontSize: '0.8125rem', marginBottom: '0.375rem' }}>Step A · WhatsApp number for the alert</div>
            <div className="mail-bar" style={{ border: 0, padding: 0 }}>
              <input className="form-input" style={{ flex: 1, minWidth: 180, maxWidth: 280 }} placeholder="919876543210" inputMode="tel" value={wa} onChange={e => setWa(e.target.value)} />
              <button className="btn btn-outline btn-sm" disabled={busy === 'wa' || wa === d.whatsapp} onClick={saveWa}>Save number</button>
            </div>
            {(() => {
              const w = d.whatsappSetup;
              const st = w?.template?.status || '';
              const line = (color: string | undefined, text: string) => <div className="meta" style={{ marginTop: '0.375rem', color }}>{text}</div>;
              if (d.whatsappReady) return (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.375rem' }}>
                  <span className="meta t-ok"><CheckCircle2 size={12} /> WhatsApp alert is set up{w?.envTemplate ? '' : ' (template "shiptrack_alert")'}: every chargeback mail sends one message to this number (panel, gateway and order only).</span>
                  <button className="btn btn-outline btn-sm" disabled={busy === 'test' || !d.whatsapp} onClick={sendTest}>{busy === 'test' ? <Loader2 size={14} className="spin" /> : null} Send a test</button>
                </div>
              );
              if (!w || !w.token) return line('var(--danger)', 'WhatsApp is not set up on the server (WHATSAPP_CLOUD_TOKEN / WHATSAPP_PHONE_NUMBER_ID). Until then the alert shows only in ShipTrack.');
              if (w.error) return line('var(--danger)', `Could not read the WhatsApp templates: ${w.error}`);
              if (!w.template) return (
                <div style={{ marginTop: '0.375rem' }}>
                  <div className="meta" style={{ color: 'var(--danger)' }}>One step left: the WhatsApp alert template is not made yet. Until then the alert shows only in ShipTrack.</div>
                  <button className="btn btn-primary btn-sm" style={{ marginTop: '0.375rem' }} disabled={busy === 'tpl'} onClick={makeTemplate}>{busy === 'tpl' ? <Loader2 size={14} className="spin" /> : null} Create the alert template</button>
                </div>
              );
              if (st === 'PENDING') return (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.375rem' }}>
                  <span className="meta" style={{ color: 'var(--warn, #b45309)' }}>Template "shiptrack_alert" is waiting for Meta's approval (usually minutes). Alerts start by themselves once it is approved.</span>
                  <button className="btn btn-ghost btn-sm" disabled={loading} onClick={() => void load(true)}>Check again</button>
                </div>
              );
              return line('var(--danger)', `Template "shiptrack_alert" is ${st || 'not usable'} at Meta. Open WhatsApp > Templates to fix it.`);
            })()}
          </div>

          {/* 3. Gateway checklist */}
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.8125rem', marginBottom: '0.375rem' }}>Step B · Where this email has been added</div>
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
