'use client';

import { ExternalLink } from 'lucide-react';
import { formatAmount, formatDateTime } from '@/lib/refund/texts';
import { FlagPills, StatusPill, ago, daysLeft, muted, payoutText, reasonText, small, td, type Item, type SentLink } from './RefundRequestsShared';

export function ItemRow({ it, isPhone, openDrawer }: { it: Item; isPhone: boolean; openDrawer: (id: string) => void }) {
    const unseen = !it.seen && it.status === 'new';
    const pay = `${it.payment || ''}${it.total !== null ? ` ${formatAmount(it.total)}` : ''}`.trim();
    if (isPhone) {
      return (
        <button key={it.id} type="button" onClick={() => openDrawer(it.id)} className="tf-card"
          style={{ display: 'block', width: '100%', textAlign: 'left', padding: '0.75rem', marginBottom: 8, border: '1px solid var(--border)', cursor: 'pointer', fontWeight: unseen ? 700 : 400, color: 'var(--fg)', background: 'var(--card-bg)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {unseen && <span aria-label="not seen" style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--warning)', flexShrink: 0 }} />}
            <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.8125rem' }}>{it.ref}</span>
            <StatusPill status={it.status} />
            <span style={{ ...small, marginLeft: 'auto' }}>{ago(it.created_at)}</span>
          </div>
          <div style={{ fontSize: '0.875rem', marginTop: 4, overflowWrap: 'anywhere' }}>{it.order_id} · {it.customer_name || '—'}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', marginTop: 2, overflowWrap: 'anywhere', fontWeight: 400 }}>{reasonText(it.reason, it.sub_reason)} · {payoutText(it.payout)}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 4, fontSize: '0.75rem', fontWeight: 400 }}>
            <span>{pay}</span><FlagPills codes={it.flags} />
          </div>
        </button>
      );
    }
    return (
      <tr key={it.id} onClick={() => openDrawer(it.id)} className="rf-row" style={{ cursor: 'pointer', fontWeight: unseen ? 700 : 400 }}>
        <td style={{ ...td, whiteSpace: 'nowrap', overflowWrap: 'normal' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span aria-label={unseen ? 'not seen' : undefined} style={{ width: 8, height: 8, borderRadius: 4, background: unseen ? 'var(--warning)' : 'transparent', flexShrink: 0 }} />
            <button type="button" onClick={(e) => { e.stopPropagation(); openDrawer(it.id); }}
              style={{ border: 'none', background: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', fontFamily: 'ui-monospace, monospace' }}>{it.ref}</button>
          </span>
        </td>
        <td style={td}>{it.order_id} <span style={{ color: 'var(--fg-muted)' }}>{it.customer_name || ''}</span>{it.panel ? <div style={small}>{it.panel}</div> : null}</td>
        <td style={td}>{reasonText(it.reason, it.sub_reason)}{it.return_needed ? <div style={small}>Return chahiye</div> : null}</td>
        <td style={{ ...td, fontFamily: 'ui-monospace, monospace', fontSize: '0.75rem' }}>{payoutText(it.payout)}</td>
        <td style={td}>{pay}</td>
        <td style={{ ...td, whiteSpace: 'nowrap', color: 'var(--fg-muted)' }} title={it.created_at ? formatDateTime(it.created_at) : ''}>{ago(it.created_at)}</td>
        <td style={td}><StatusPill status={it.status} /></td>
        <td style={td}><FlagPills codes={it.flags} /></td>
      </tr>
    );
}
export function LinkRow({ l, chatHref }: { l: SentLink; chatHref: (id: string) => string }) {
  return (
    <div key={l.id} className="tf-card" style={{ padding: '0.625rem 0.75rem', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '0.8125rem' }}>
      <span style={{ fontWeight: 600 }}>{l.order_id}</span>
      <span style={{ color: 'var(--fg-muted)', overflowWrap: 'anywhere' }}>{l.customer_name || ''}</span>
      <span style={small}>· sent {l.sent_at ? formatDateTime(l.sent_at) : '—'} · {l.state === 'expired' ? 'expired' : daysLeft(l.expires_at)} · {l.opened_count > 0 ? `opened ✓ (${l.opened_count}×)` : 'not opened'}{l.panel ? ` · ${l.panel}` : ''}</span>
      <a className="btn btn-sm" style={{ ...muted, marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }} href={chatHref(l.conversation_id)} target="_blank" rel="noopener noreferrer">
        Open chat <ExternalLink size={12} />
      </a>
    </div>
  );
}
