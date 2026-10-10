'use client';

// ── The WhatsApp screen (owner 2026-10-10: "isko bahar nikaal ke proper ek feature bana, jisme hum test kar
// paayein, profile pic, preview screen ...") ──
// Its own admin tab, Super Admin only: Setup (checklist + ids), Number & profile (what Meta shows, the display
// name, the business profile with the picture, the phone showing the profile), Templates (list / new / edit
// with the phone showing the message), Send (a template to a number, previewed), Activity (the chats and what
// the team sent, with Meta's delivery reports). Everything reads Meta live; ShipTrack stores only the two ids.
import { useCallback, useEffect, useState } from 'react';
import { Loader2, MessageSquareText, RefreshCw } from 'lucide-react';
import SetupPanel from './SetupPanel';
import ProfilePanel from './ProfilePanel';
import TemplatesPanel from './TemplatesPanel';
import SendPanel from './SendPanel';
import TestPanel from './TestPanel';
import ActivityPanel from './ActivityPanel';
import { spin, type Alert, type Brand, type WaActivity, type WaLists, type WaProfileData, type WaSettings, type WaTab } from './types';

const TABS: { id: WaTab; label: string }[] = [
  { id: 'setup', label: 'Setup' }, { id: 'test', label: 'Test' }, { id: 'profile', label: 'Number & profile' }, { id: 'templates', label: 'Templates' }, { id: 'send', label: 'Send' }, { id: 'activity', label: 'Activity' },
];

export default function WhatsAppPage({ token, onAlert, onOpenChat }: { token: string; onAlert: Alert; onOpenChat: (conversationId: string) => void }) {
  const [tab, setTab] = useState<WaTab>(() => {
    try { const t = localStorage.getItem('wa_tab'); return TABS.some((x) => x.id === t) ? t as WaTab : 'setup'; } catch { return 'setup'; }
  });
  const [s, setS] = useState<WaSettings | null>(null);
  const [lists, setLists] = useState<WaLists | null>(null);
  const [prof, setProf] = useState<WaProfileData | null>(null);
  const [act, setAct] = useState<WaActivity | null>(null);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(true);
  const auth = { Authorization: `Bearer ${token}` };

  const load = useCallback(async () => {
    setLoading(true);
    const get = (u: string) => fetch(u, { headers: auth, cache: 'no-store' }).then((r) => r.json()).catch(() => null);
    try {
      const [a, b, c, d, e] = await Promise.all([get('/api/whatsapp/settings'), get('/api/whatsapp/templates'), get('/api/whatsapp/profile'), get('/api/whatsapp/activity'), get('/api/whatsapp/brands')]);
      if (a && !a.error) setS(a);
      if (b) setLists(b);
      if (c) setProf(c);
      if (d) setAct(d);
      if (e && Array.isArray(e.brands)) setBrands(e.brands);
    } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  useEffect(() => { void load(); }, [load]);
  const pick = (t: WaTab) => { setTab(t); try { localStorage.setItem('wa_tab', t); } catch { /* private window */ } };

  // The checklist's quick summary in the header: how many of its steps are done.
  const steps = s ? [s.configured, s.verifyTokenSet, s.appSecretSet, !!s.panel, !!s.waba, !!s.appId, !!s.phone, !!lists && !lists.error, (lists?.templates || []).some((t) => t.status === 'APPROVED')] : [];
  const done = steps.filter(Boolean).length;

  return (
    <div className="animate-fade-in-up">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        <MessageSquareText size={22} style={{ color: '#25D366' }} />
        <div>
          <div style={{ fontWeight: 700, fontSize: '1.125rem' }}>WhatsApp</div>
          <div style={{ fontSize: '0.8125rem', color: 'var(--fg-muted)' }}>
            {s?.phone ? `${s.phone.displayPhoneNumber} · "${s.phone.verifiedName}"` : 'The business number'}{steps.length ? ` · setup ${done}/${steps.length}` : ''}
          </div>
        </div>
        <button type="button" className="btn btn-sm btn-outline" style={{ marginLeft: 'auto', gap: 4 }} onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 size={14} style={spin} /> : <RefreshCw size={14} />} Refresh
        </button>
      </div>
      <div className="wa-tabs" role="tablist">
        {TABS.map((t) => <button key={t.id} type="button" role="tab" className="seg-btn" aria-pressed={tab === t.id} onClick={() => pick(t.id)}>{t.label}</button>)}
      </div>
      {tab === 'setup' && <SetupPanel key={`${s?.waba}|${s?.appId}`} token={token} s={s} lists={lists} onAlert={onAlert} reload={load} />}
      {tab === 'test' && <TestPanel token={token} s={s} prof={prof} act={act} onAlert={onAlert} goSend={() => pick('send')} goActivity={() => pick('activity')} />}
      {tab === 'profile' && <ProfilePanel token={token} s={s} prof={prof} onAlert={onAlert} reload={load} />}
      {tab === 'templates' && <TemplatesPanel token={token} s={s} lists={lists} prof={prof} brands={brands} onAlert={onAlert} reload={load} />}
      {tab === 'send' && <SendPanel token={token} s={s} lists={lists} prof={prof} brands={brands} onAlert={onAlert} onOpenChat={onOpenChat} />}
      {tab === 'activity' && <ActivityPanel act={act} onOpenChat={onOpenChat} />}
    </div>
  );
}
