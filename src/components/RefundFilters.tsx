'use client';

import type { CSSProperties, Dispatch, SetStateAction } from 'react';
import { Search } from 'lucide-react';
import { VIEWS, chosen, muted, pill, type Counts, type ViewKey } from './RefundRequestsShared';

export default function RefundFilters({ countOf, view, setView, setQ, counts, isPhone, q, field }: {
  countOf: (v: ViewKey) => number | null;
  view: ViewKey;
  setView: Dispatch<SetStateAction<ViewKey>>;
  setQ: Dispatch<SetStateAction<string>>;
  counts: Counts | undefined;
  isPhone: boolean;
  q: string;
  field: CSSProperties;
}) {
  return (
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {VIEWS.map((c) => {
            const k = countOf(c.v);
            const on = view === c.v;
            return (
              <button key={c.v} type="button" className="btn btn-sm" aria-pressed={on} onClick={() => { setView(c.v); setQ(''); }}
                style={{ ...muted, ...(on ? chosen : {}), height: 'auto', padding: '0.25rem 0.625rem', flexDirection: 'column', alignItems: 'flex-start', gap: 0, lineHeight: 1.25 }}>
                <span style={{ fontWeight: 600 }}>{c.label}{k !== null ? ` ${k}` : ''}{c.v === 'new' && counts && counts.unseen > 0 ? <span style={{ ...pill('#fff', 'var(--danger)'), marginLeft: 4 }}>{counts.unseen} unseen</span> : null}</span>
                <span style={{ fontSize: '0.625rem', fontWeight: 400 }}>{c.hint}</span>
              </button>
            );
          })}
        </div>
        <label style={{ position: 'relative', marginLeft: isPhone ? 0 : 'auto', flex: isPhone ? '1 1 100%' : '0 1 16rem', minWidth: 0 }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--fg-muted)' }} aria-hidden />
          <input type="search" className="form-input" placeholder="Ref / order / name" value={q} onChange={(e) => setQ(e.target.value)}
            aria-label="Search the loaded requests" style={{ paddingLeft: 30, height: '2.25rem', ...field }} />
        </label>
      </div>
  );
}
