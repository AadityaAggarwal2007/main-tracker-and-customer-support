'use client';

// ── Chargeback Shield: the orders to save today (owner 2026-10-10) ──
// GET /api/chargebacks/risk: every prepaid order of the last 45 days whose customer sounds like a chargeback is coming,
// riskiest first, with the reasons and the ONE next step (src/lib/chargeback/risk-rules.ts). Open chat goes to the chat.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Mail, MessageCircle, RefreshCw, Smartphone } from 'lucide-react';
import { agoText } from '@/app/admin/_lib/format';

type Level = 'watch' | 'high' | 'critical';
interface Item {
  orderId: string; panelName: string; customerName: string; total: number; status: string; score: number; level: Level;
  signals: { key: string; points: number; text: string }[]; action: { key: string; text: string };
  daysLate: number; waitingHours: number | null; lastCustomerAt: number | null; channels: string[];
  chatId: string | null; holder: string | null; caseKind: 'refund' | 'reship' | null;
}
interface List { at: string; items: Item[]; counts: Record<Level, number>; scanned: number }

const LEVEL_CHIP: Record<Level, string> = { critical: 'chip-danger', high: 'chip-warn', watch: 'chip-muted' };
const LEVEL_TEXT: Record<Level, string> = { critical: 'Critical', high: 'High', watch: 'Watch' };
const ACTION_CHIP: Record<string, string> = { charged_back: 'chip-danger', refund: 'chip-danger', reship: 'chip-warn', family_check: 'chip-warn', reassure: 'chip-info', reply: 'chip-info', watch: 'chip-muted' };
const ACTION_NAME: Record<string, string> = { charged_back: 'Chargeback raised', refund: 'Refund', reship: 'Ship again', family_check: 'Family check', reassure: 'Reassure', reply: 'Reply now', watch: 'Watch' };
const ChannelIcon = ({ c }: { c: string }) => c === 'email' ? <Mail size={12} aria-label="email" /> : c === 'whatsapp' ? <Smartphone size={12} aria-label="WhatsApp" /> : <MessageCircle size={12} aria-label="chat" />;

export default function RiskPanel({ token, onAlert }: { token: string; onAlert: (type: string, message: string) => void }) {
  const [data, setData] = useState<List | null>(null);
  const [loading, setLoading] = useState(true);
  const [show, setShow] = useState<Level | 'all'>('all');
  const [panel, setPanel] = useState('');
  const [action, setAction] = useState('');

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/chargebacks/risk${fresh ? '?fresh=1' : ''}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Could not read the risk list.'); return; }
      setData(j);
    } catch { onAlert('error', 'Could not read the risk list.'); }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  const panels = useMemo(() => Array.from(new Set((data?.items || []).map((i) => i.panelName))).sort(), [data]);
  const items = (data?.items || []).filter((i) => (show === 'all' || i.level === show) && (!panel || i.panelName === panel) && (!action || i.action.key === action));
  const actions = useMemo(() => Array.from(new Set((data?.items || []).map((i) => i.action.key))), [data]);

  return (
    <div style={{ display: 'grid', gap: '0.625rem' }}>
      <div className="meta">
        Prepaid orders of the last 45 days whose customer sounds like a chargeback is coming: fake store / fake link, late, refund asks, threats,
        waiting for us. Each line says the ONE next step. Cash on Delivery orders cannot be charged back, so they are not here; a customer who never wrote to us is not here either.
      </div>
      <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', alignItems: 'center' }}>
        {(['all', 'critical', 'high', 'watch'] as const).map((k) => (
          <button key={k} type="button" className="seg-btn" aria-pressed={show === k} onClick={() => setShow(k)}>
            {k === 'all' ? `All ${(data?.items.length ?? 0)}` : `${LEVEL_TEXT[k]} ${data?.counts[k] ?? 0}`}
          </button>
        ))}
        {panels.length > 1 && (
          <select className="form-input" style={{ height: '2rem', width: 'auto' }} value={panel} onChange={(e) => setPanel(e.target.value)} aria-label="Panel">
            <option value="">All panels</option>
            {panels.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        )}
        <select className="form-input" style={{ height: '2rem', width: 'auto' }} value={action} onChange={(e) => setAction(e.target.value)} aria-label="Next step">
          <option value="">Every next step</option>
          {actions.map((a) => <option key={a} value={a}>{ACTION_NAME[a] || a}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-outline btn-sm" onClick={() => load(true)} disabled={loading}>{loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Refresh</button>
      </div>
      {data && <div className="meta">{data.scanned} prepaid orders checked · {agoText(Date.parse(data.at))}</div>}
      {!loading && data && items.length === 0 && <div className="mail-empty">Nobody at risk here right now.</div>}
      <div style={{ display: 'grid', gap: '0.5rem' }}>
        {items.map((i) => (
          <div key={`${i.panelName}|${i.orderId}`} className="tf-card" style={{ padding: '0.75rem 1rem', display: 'grid', gap: '0.375rem', borderColor: i.level === 'critical' ? 'var(--danger)' : undefined }}>
            <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <span className={`chip ${LEVEL_CHIP[i.level]}`} title="Chargeback risk score">{LEVEL_TEXT[i.level]} {i.score}</span>
              <b style={{ fontSize: '0.875rem' }}>{i.customerName || 'Customer'}</b>
              <span className="chip chip-primary">Order {i.orderId}</span>
              <span className="chip chip-muted">{i.panelName}</span>
              <span className="chip chip-muted">{i.status}</span>
              {i.daysLate > 0 && <span className="chip chip-warn">{i.daysLate}d late</span>}
              {i.waitingHours !== null && i.waitingHours >= 1 && <span className={`chip ${i.waitingHours >= 2 ? 'chip-danger' : 'chip-warn'}`}>Waiting {Math.floor(i.waitingHours)}h</span>}
              {i.caseKind && <span className="chip chip-info">{i.caseKind === 'refund' ? 'In Refund' : 'In Ship again'}</span>}
              <span className="meta" style={{ display: 'inline-flex', gap: '0.25rem', alignItems: 'center' }}>{i.channels.map((c) => <ChannelIcon key={c} c={c} />)}{i.lastCustomerAt ? ` wrote ${agoText(i.lastCustomerAt)}` : ''}</span>
            </div>
            <div style={{ fontSize: '0.8125rem' }}>{i.signals.filter((s) => s.points > 0).slice(0, 4).map((s) => s.text).join(' · ')}</div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <span className={`chip ${ACTION_CHIP[i.action.key] || 'chip-muted'}`}>{ACTION_NAME[i.action.key] || i.action.key}</span>
              <span style={{ fontSize: '0.8125rem', fontWeight: 600, flex: 1, minWidth: 200 }}>{i.action.text}</span>
              {i.chatId && <a className="btn btn-outline btn-sm" href={`/admin/chat?open=${encodeURIComponent(i.chatId)}`}><MessageCircle size={13} /> Open chat</a>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
