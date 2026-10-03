'use client';

import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';

// The rest of the thread's actions (Hand to AI, Close, Refund / Ship again / Remove).
// On a laptop the children sit inline in the header's first row (globals.css .th-more);
// on a phone they hide behind a ⋯ button and drop down under the action bar (owner,
// 2026-10-03: "phone pe header bhara hua"). Presentational only: every button inside
// keeps its own handler, condition and title; this only opens and closes.
export function MoreMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  return (
    // display: contents, so the toggle and the list are laid out as the action bar's own children.
    <div ref={ref} style={{ display: 'contents' }}>
      <button type="button" className="btn btn-outline btn-sm th-more-toggle" aria-label="More actions" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(o => !o)}>
        <MoreHorizontal size={16} />
      </button>
      {/* A press on any action closes the list (the action's own onClick has run by then). */}
      <div className={`th-more${open ? ' open' : ''}`} onClick={() => setOpen(false)}>
        {children}
      </div>
    </div>
  );
}
