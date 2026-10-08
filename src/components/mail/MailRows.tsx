'use client';

import { BadgeCheck, Paperclip, Reply } from 'lucide-react';
import { orderNumbersIn } from '@/lib/chat/mail-filters';
import type { Item, Ver } from './types';

const when = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

// One row per mail, the same height: who + when, the subject, and what matters for support (verified order or
// "Not verified", an order number in the subject, attachment, replied).
export default function MailRows({ items, verified, openUid, onOpen }: { items: Item[]; verified: Record<string, Ver[]>; openUid: number | null; onOpen: (uid: number) => void }) {
  return (
    <>
      {items.map(m => {
        const v = verified[m.fromAddress]?.[0];
        const nums = orderNumbersIn(m.subject);
        return (
          <button type="button" key={m.uid} className={`mail-row${m.unread ? ' unread' : ''}${openUid === m.uid ? ' active' : ''}`} onClick={() => onOpen(m.uid)}>
            <span className="mail-from truncate">{m.unread && <i className="mail-dot" aria-label="unread" />}{m.from}</span>
            <span className="mail-when">{when(m.date)}</span>
            <span className="mail-subj truncate">{m.subject}</span>
            <span className="mail-tags">
              {v ? <span className="mail-chip ok" title={`Verified for order ${v.orderId}${v.byName ? ` · ${v.byName}` : ''}`}><BadgeCheck size={11} /> {v.orderId}</span>
                 : <span className="mail-chip no" title="Nobody has verified this sender yet">Not verified</span>}
              {!v && nums.map(n => <span key={n} className="mail-chip num" title="Order number written in the subject">{n}</span>)}
              {m.hasAttachment && <Paperclip size={12} className="mail-ico" aria-label="attachment" />}
              {m.answered && <Reply size={12} className="mail-ico" aria-label="replied" />}
            </span>
          </button>
        );
      })}
    </>
  );
}
