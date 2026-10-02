'use client';

import { ChevronLeft, ExternalLink, Loader2, X } from 'lucide-react';
import type { ItemRow, ItemsResponse, Metric } from '@/lib/team-score/types';
import { dayLabel } from '@/lib/team-score/clock';
import { KIND_LABEL, METRIC_LABEL, STATUS_CHIP, fmtNum, muted, pill, plural, signed, small, type Drawer } from './TeamScoreShared';

  // ── Drawer rows ──
  // multi: the drawer covers more than one day, so each row says which day (review 2026-10-02).
  const itemRow = (it: ItemRow, i: number, metric: Metric, multi: boolean) => {
    const dim = !it.counted || it.pending;
    const st = it.chat ? STATUS_CHIP[it.chat.status] : undefined;
    const pc = it.pending ? { t: 'pending', fg: 'var(--fg-muted)', bg: 'var(--bg-subtle)' }
      : it.points > 0 ? { t: signed(it.points), fg: 'var(--success)', bg: 'var(--success-light)' }
      : it.points < 0 ? { t: signed(it.points), fg: 'var(--danger)', bg: 'var(--danger-light)' }
      : { t: '0', fg: 'var(--fg-muted)', bg: 'var(--bg-subtle)' };
    const showKind = metric === 'sent' || metric === 'solved' || metric === 'points';
    const messages = Array.isArray(it.messages) ? it.messages : [];
    return (
      <div key={`${it.kind}-${it.conv}-${it.at}-${i}`} style={{ padding: '0.75rem 0', borderBottom: '1px solid var(--border)', opacity: dim ? 0.62 : 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: '0.8125rem' }}>
          <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{multi && /^\d{1,2}:\d{2}$/.test(it.at_ist || '') ? `${dayLabel(it.day)} ${it.at_ist}` : it.at_ist}</span>
          <span style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{it.chat?.name || 'Chat'}</span>
          {it.chat?.source === 'email' && <span style={small}>email</span>}
          {st && <span style={pill(st.fg, st.bg)}>{st.label}</span>}
          {showKind && <span style={pill('var(--fg)', 'var(--bg-subtle)')}>{KIND_LABEL[it.kind] || it.kind}</span>}
          <span style={pill(pc.fg, pc.bg)}>{pc.t}</span>
          {(it.kind === 'thanks' || it.kind === 'convinced') && it.by && (
            <span style={pill('var(--primary)', 'var(--primary-light)')}>{it.by === 'ai' ? 'AI' : 'Keyword'}</span>
          )}
          <a href={`/admin/chat?open=${encodeURIComponent(it.conv)}`} target="_blank" rel="noopener"
            style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: '0.75rem', fontWeight: 600, whiteSpace: 'nowrap' }}>
            Open chat <ExternalLink size={12} />
          </a>
        </div>
        <div style={{ fontSize: '0.8125rem', marginTop: 4, lineHeight: 1.5, overflowWrap: 'anywhere' }}>{it.why}</div>
        {it.kind === 'chat' && typeof it.n === 'number' && (
          <div style={{ ...small, marginTop: 2 }}>{plural(it.n, 'message', 'messages')}{it.after ? ` · ${fmtNum(it.after)} after 19:30` : ''}</div>
        )}
        {messages.length > 0 && (
          <div style={{ marginTop: 6, padding: '0.375rem 0.625rem', borderRadius: 8, background: 'var(--bg-subtle)', fontSize: '0.75rem', lineHeight: 1.55 }}>
            {messages.map((m) => (
              <div key={m.id} style={{ overflowWrap: 'anywhere' }}>
                <span style={{ fontWeight: 600, color: m.role === 'customer' ? 'var(--fg)' : 'var(--primary)' }}>
                  {m.role === 'customer' ? 'Customer' : m.role === 'ai' ? 'AI' : (m.by || 'Staff')}
                </span>
                <span style={{ color: 'var(--fg-muted)' }}> {m.at_ist}{m.text ? ': ' : ''}</span>{m.text}
              </div>
            ))}
          </div>
        )}
        {it.kind === 'sent' && it.note && (
          <div style={{ ...small, marginTop: 4, fontSize: '0.75rem', overflowWrap: 'anywhere' }}>Note: {it.note}</div>
        )}
      </div>
    );
  };

export default function TeamScoreDrawer({ drawer, closeDrawer, isPhone, items, itemsLoading, itemsErr, loadItems }: {
  drawer: Drawer; closeDrawer: () => void; isPhone: boolean; items: ItemsResponse | null; itemsLoading: boolean;
  itemsErr: string | null; loadItems: (dw: Drawer) => Promise<void>;
}) {
  return (
        <div className="modal-overlay" onClick={closeDrawer} style={{ padding: 0, justifyContent: 'flex-end', alignItems: 'stretch' }}>
          <div role="dialog" aria-modal="true" aria-label={`${drawer.who.name} · ${METRIC_LABEL[drawer.metric]}`} onClick={(e) => e.stopPropagation()}
            style={{ width: isPhone ? '100%' : 480, maxWidth: '100%', height: '100%', background: 'var(--card-bg)', borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', animation: 'slideInRight 0.2s ease' }}>
            <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid var(--border)' }}>
              {isPhone && (
                <button type="button" className="btn btn-sm" style={{ ...muted, marginBottom: 8 }} onClick={closeDrawer}><ChevronLeft size={14} /> Back</button>
              )}
              <div className="modal-header" style={{ marginBottom: 0, alignItems: 'flex-start', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <h3 className="modal-title" style={{ overflowWrap: 'anywhere' }}>{drawer.who.name} · {METRIC_LABEL[drawer.metric]} · {drawer.label}</h3>
                  <p className="modal-subtitle">
                    {items ? `${fmtNum(items.counted)} counted · ${fmtNum(Math.max(0, items.total - items.counted))} not counted` : itemsLoading ? 'Loading…' : ''}
                  </p>
                </div>
                {!isPhone && <button type="button" className="btn-icon" onClick={closeDrawer} aria-label="Close"><X size={16} /></button>}
              </div>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 1rem 1rem' }}>
              {itemsLoading && !items && (
                <div style={{ padding: '1.5rem 0', textAlign: 'center', color: 'var(--fg-muted)', fontSize: '0.8125rem' }}>
                  <Loader2 size={16} style={{ animation: 'spin 1s linear infinite', verticalAlign: 'middle' }} /> Loading…
                </div>
              )}
              {itemsErr && (
                <div style={{ padding: '1rem 0', color: 'var(--danger)', fontSize: '0.8125rem', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  {itemsErr}
                  <button type="button" className="btn btn-sm" style={muted} onClick={() => loadItems(drawer)}>Retry</button>
                </div>
              )}
              {items && (() => {
                const list = items.items;
                const good = list.filter((x) => x.counted && !x.pending);
                const rest = list.filter((x) => !x.counted || x.pending);
                return (
                  <>
                    {!list.length && <div style={{ padding: '1.5rem 0', color: 'var(--fg-muted)', fontSize: '0.8125rem' }}>Nothing here for this period.</div>}
                    {good.map((it, i) => itemRow(it, i, drawer.metric, drawer.from !== drawer.to))}
                    {rest.length > 0 && (
                      <>
                        <div style={{ marginTop: '1rem', fontSize: '0.6875rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>Not counted</div>
                        {rest.map((it, i) => itemRow(it, i, drawer.metric, drawer.from !== drawer.to))}
                      </>
                    )}
                    {items.total > list.length && (
                      <div style={{ ...small, marginTop: '0.75rem' }}>Showing the newest {fmtNum(list.length)} of {fmtNum(items.total)}.</div>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        </div>
  );
}
