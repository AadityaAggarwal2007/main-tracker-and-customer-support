'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronsUpDown, Search, Store } from 'lucide-react';

export interface SwitcherPanel {
  id: string;
  name: string;
  logo_url?: string | null;
  primary_color?: string | null;
  is_shopify_connected?: boolean;
}

// One panel picker for the admin page and the chat inbox (owner 2026-10-08: the old drop-down
// was "bilkul bakwass"). A clear card showing the open panel, and a pop-over with search (once
// there are more than five panels), "All panels" first, a logo or initial, whether Shopify is
// connected, the open one marked. Closes on a click outside or Escape. `onSelect('')` = All panels.
export default function PanelSwitcher({ panels, activeId, onSelect, allowAll = true }: {
  panels: SwitcherPanel[];
  activeId: string;
  onSelect: (id: string) => void;
  allowAll?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const active = panels.find(p => p.id === activeId) || null;
  const searchable = panels.length > 5;

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? panels.filter(p => p.name.toLowerCase().includes(n)) : panels;
  }, [panels, q]);

  const pick = (id: string) => { setOpen(false); setQ(''); onSelect(id); };
  const Logo = ({ p, size }: { p: SwitcherPanel | null; size: number }) => (
    p?.logo_url
      // eslint-disable-next-line @next/next/no-img-element
      ? <img src={p.logo_url} alt="" className="psw-logo" style={{ width: size, height: size }} />
      : (
        <span className="psw-logo psw-initial" style={{ width: size, height: size, background: p?.primary_color || 'var(--primary)' }}>
          {p ? p.name.charAt(0).toUpperCase() : <Store size={size * 0.5} />}
        </span>
      )
  );

  return (
    <div className="psw" ref={box}>
      <button type="button" className={`psw-trigger${open ? ' open' : ''}`} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <Logo p={active} size={36} />
        <span className="psw-text">
          <span className="psw-label">Panel</span>
          <span className="psw-name">{active ? active.name : 'All panels'}</span>
        </span>
        <ChevronsUpDown size={16} className="psw-chev" />
      </button>

      {open && (
        <div className="psw-pop" role="listbox" aria-label="Choose a panel">
          {searchable && (
            <div className="psw-search">
              <Search size={14} />
              <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search panels…" aria-label="Search panels" maxLength={60} />
            </div>
          )}
          <div className="psw-list">
            {allowAll && !q.trim() && (
              <button type="button" role="option" aria-selected={!activeId} className={`psw-row${!activeId ? ' on' : ''}`} onClick={() => pick('')}>
                <Logo p={null} size={28} />
                <span className="psw-rtext"><b>All panels</b><small>{panels.length} panel{panels.length === 1 ? '' : 's'}</small></span>
                {!activeId && <Check size={16} className="psw-check" />}
              </button>
            )}
            {shown.map(p => (
              <button key={p.id} type="button" role="option" aria-selected={activeId === p.id} className={`psw-row${activeId === p.id ? ' on' : ''}`} onClick={() => pick(p.id)}>
                <Logo p={p} size={28} />
                <span className="psw-rtext"><b>{p.name}</b>{p.is_shopify_connected !== undefined && <small>{p.is_shopify_connected ? 'Shopify connected' : 'CSV upload'}</small>}</span>
                {activeId === p.id && <Check size={16} className="psw-check" />}
              </button>
            ))}
            {shown.length === 0 && <div className="psw-empty">No panel named “{q.trim()}”.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
