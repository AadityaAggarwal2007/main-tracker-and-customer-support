'use client';

// The phone of the Test screen: the whole conversation with one number as WhatsApp draws it (the customer's
// messages white on the left, ours green on the right with WhatsApp's ticks: ✓ sent, ✓✓ delivered, blue ✓✓ read,
// red "!" failed). Pure drawing; the Test panel feeds it.
import { waText } from './PhonePreview';
import { useEffect, useRef, type ReactNode } from 'react';

export interface ThreadMessage { id: string; from: 'customer' | 'us'; auto?: boolean; text: string; at: string; template: string | null; sent: boolean | null; status: string | null; error: string | null }

export function tickOf(m: ThreadMessage): { mark: string; color: string; label: string } {
  if (m.sent === false || m.status === 'failed') return { mark: '!', color: '#d92d20', label: 'Not sent' };
  if (m.status === 'read') return { mark: '✓✓', color: '#53bdeb', label: 'Read' };
  if (m.status === 'delivered') return { mark: '✓✓', color: '#8696a0', label: 'Delivered' };
  if (m.status === 'sent' || m.sent === true) return { mark: '✓', color: '#8696a0', label: 'Sent' };
  return { mark: '·', color: '#8696a0', label: '' };
}

const dayOf = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toDateString() === new Date().toDateString() ? 'Today' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};
const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
};

export default function PhoneThread({ name, phone, picture, messages, loading, composer }: { name: string; phone: string; picture: string | null; messages: ThreadMessage[]; loading?: boolean; composer?: ReactNode }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [messages.length]);
  return (
    <div className="wa-phone" aria-label="The conversation on the customer's WhatsApp" style={{ minHeight: 520 }}>
      <div className="wa-phone-top"><span className="wa-phone-time">{clock(new Date().toISOString()).replace(/ ?[ap]m/, '')}</span><span className="wa-phone-signal">●●● ▲ ▮</span></div>
      <div className="wa-header">
        <span style={{ color: '#fff', fontSize: '1.1rem' }}>‹</span>
        <div style={{ width: 34, height: 34, borderRadius: '50%', overflow: 'hidden', background: '#dfe5e7', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          {picture ? <img src={picture} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ fontWeight: 700, color: '#54656f' }}>{(name || '?').slice(0, 1).toUpperCase()}</span>}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: '#fff', fontWeight: 600, fontSize: '0.9rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name || phone || 'Customer'}</div>
          <div style={{ color: 'rgba(255,255,255,0.8)', fontSize: '0.7rem' }}>{loading ? 'checking…' : 'the customer\'s phone'}</div>
        </div>
      </div>
      <div className="wa-chat" style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 420 }}>
        {messages.length === 0 && <div className="wa-day">Today</div>}
        {messages.length === 0 && <div style={{ textAlign: 'center', color: '#667781', fontSize: '0.75rem', marginTop: '2rem' }}>No messages with this number yet</div>}
        {messages.map((m, i) => {
          const t = tickOf(m);
          const day = dayOf(m.at);
          const newDay = day && (i === 0 || dayOf(messages[i - 1].at) !== day) ? <div key={'d' + m.id} className="wa-day">{day}</div> : null;
          return [newDay, m.from === 'customer' ? (
            <div key={m.id} className="wa-bubble wa-in"><div>{waText(m.text)}</div><div className="wa-meta">{clock(m.at)}</div></div>
          ) : (
            <div key={m.id} className="wa-bubble">
              {(m.template || m.auto) && <div style={{ fontSize: '0.65rem', color: '#667781', marginBottom: 2 }}>{m.auto ? 'automatic · ' : ''}{m.template ? `template ${m.template}` : 'message'}</div>}
              <div>{waText(m.text)}</div>
              <div className="wa-meta">{clock(m.at)} <span style={{ color: t.color, fontWeight: 700 }}>{t.mark}</span></div>
              {(t.label === 'Not sent' || m.error) && <div style={{ color: '#d92d20', fontSize: '0.68rem', marginTop: 2 }}>{m.error || 'Not sent'}</div>}
            </div>
          )];
        })}
        <div ref={end} />
      </div>
      {composer || <div className="wa-compose"><span>Message</span><span className="wa-mic">🎤</span></div>}
    </div>
  );
}
