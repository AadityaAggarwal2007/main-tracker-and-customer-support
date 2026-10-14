'use client';

// ── Brand managers, in Team (owner 2026-10-14: "anurag is handling kurtiya, rahul is handling vastrika") ──
// One member per panel (every panel, also the ones added later). Their brand's chats go to them first while they are on
// duty (auto-assign.ts), their screens open on that brand, and a team member always looks at one brand at a time (never
// mixed); they can still switch to another brand. /api/team/brand-managers; rules in brand-managers-rules.ts.
import { useCallback, useEffect, useState } from 'react';
import { Store } from 'lucide-react';
import { can, canAccessPanel, type Permission } from '@/lib/permissions';

interface PanelLite { id: string; name: string }
interface MemberLite { id: string; display_name: string; is_active: boolean; role: string; permissions: string[] | null; business_ids: string[] | null; effective: Permission[] }

export default function BrandManagersCard({ token, panels, members, onAlert }: {
  token: string | null; panels: PanelLite[]; members: MemberLite[]; onAlert: (type: string, message: string) => void;
}) {
  const [map, setMap] = useState<Record<string, { id: string; name: string }>>({});
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch('/api/team/brand-managers', { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json().catch(() => ({}));
      if (r.ok) setMap(d.managers || {});
    } catch { /* the card stays empty */ }
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  // Who may manage a panel: an active member who replies to chats and may see that panel (the server checks again).
  const fits = (m: MemberLite, panelId: string) => m.is_active
    && can({ role: m.role as never, permissions: m.effective }, 'chat.reply')
    && !can({ role: m.role as never, permissions: m.effective }, 'team.lead')   // a Manager is never auto-assigned
    && canAccessPanel({ role: m.role as never, permissions: m.effective, businessIds: m.business_ids }, panelId);
  const save = async (panelId: string, memberId: string) => {
    if (!token) return;
    setBusy(panelId);
    try {
      const r = await fetch('/api/team/brand-managers', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ panelId, memberId: memberId || null }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', d.error || 'Could not save'); return; }
      const p = panels.find(x => x.id === panelId)?.name || 'this panel';
      const m = members.find(x => x.id === memberId)?.display_name;
      onAlert('success', m ? `${m} is now the brand manager of ${p}.` : `${p} has no brand manager now.`);
      await load();
    } catch { onAlert('error', 'Could not save'); }
    finally { setBusy(''); }
  };

  return (
    <div className="tf-card" style={{ padding: '0.875rem 1.25rem', marginBottom: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <Store size={16} /> <b>Brand managers</b>
      </div>
      <p className="meta" style={{ margin: '0 0 0.75rem' }}>
        One person per brand. Their brand&apos;s chats go to them first while they are logged in (others get them only when they are away),
        and ShipTrack opens on their brand. Team members always see one brand at a time, never mixed; they can switch brands from the panel picker.
      </p>
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
        {panels.map(p => (
          <label key={p.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.8125rem', fontWeight: 600 }}>
            {p.name}
            <select className="form-input" value={map[p.id]?.id || ''} disabled={busy === p.id} onChange={e => void save(p.id, e.target.value)}>
              <option value="">No brand manager</option>
              {members.filter(m => fits(m, p.id) || map[p.id]?.id === m.id).map(m => (
                <option key={m.id} value={m.id}>{m.display_name}{m.is_active ? '' : ' (switched off)'}</option>
              ))}
            </select>
          </label>
        ))}
      </div>
    </div>
  );
}
