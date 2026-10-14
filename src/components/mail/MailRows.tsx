'use client';

import { BadgeCheck, Paperclip, Reply } from 'lucide-react';
import { isBounce, orderNumbersIn } from '@/lib/chat/mail-filters';
import type { Item, Ver } from './types';

const when = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

// One line per conversation, like Gmail (owner 2026-10-11: "aisa UI UX bana de", with Gmail's inbox as the picture):
// who (and how many mails the conversation has), the verified order or "Not verified", the subject and the first words
// in grey, the attachment / replied marks, the time. Unread is bold. On a phone the line wraps into three.
// In Active / Closed cases (one line per customer, owner 2026-10-11 afternoon) the number is how many conversations the
// customer has in the last 30 days (convCount).
export default function MailRows({ items, verified, openUid, onOpen, showVerify = true }: { items: Item[]; verified: Record<string, Ver[]>; openUid: number | null; onOpen: (uid: number) => void; showVerify?: boolean }) {
  return (
    <>
      {items.map(m => {
        const v = verified[m.fromAddress]?.[0];
        const nums = orderNumbersIn(m.subject);
        const bounce = !v && isBounce(m.fromAddress, m.subject);   // a verified sender is a customer, never a bounce
        return (
          <button type="button" key={m.uid} className={`mail-row${m.unread ? ' unread' : ''}${openUid === m.uid ? ' active' : ''}`} onClick={() => onOpen(m.uid)}>
            <span className="mail-from truncate">
              {m.unread && <i className="mail-dot" aria-label="unread" />}
              {m.from}{m.convCount != null
                ? (m.convCount > 1 ? <span className="mail-n" title={`${m.convCount} conversations in the last 30 days`}>{m.convCount}</span> : null)
                : (m.threadCount && m.threadCount > 1 ? <span className="mail-n" title={`${m.threadCount} mails in this conversation`}>{m.threadCount}</span> : null)}
            </span>
            <span className="mail-tags">
              {bounce && <span className="mail-chip no" title="Gmail could not deliver one of our mails: open it to see to whom and why">Delivery failed</span>}
              {showVerify && !bounce && (v ? <span className="mail-chip ok" title={`Verified for order ${v.orderId}${v.byName ? ` · ${v.byName}` : ''}`}><BadgeCheck size={11} /> {v.orderId}</span>
                : <span className="mail-chip no" title="Nobody has verified this sender yet">Not verified</span>)}
              {showVerify && !bounce && !v && nums.map(n => <span key={n} className="mail-chip num" title="Order number written in the subject">{n}</span>)}
            </span>
            <span className="mail-line truncate">
              <span className="mail-subj">{m.subject}</span>
              {m.snippet ? <span className="mail-snip"> — {m.snippet}</span> : null}
            </span>
            <span className="mail-icons">
              {m.hasAttachment && <Paperclip size={13} className="mail-ico" aria-label="attachment" />}
              {(m.replied || m.answered) && <Reply size={13} className="mail-ico ok" aria-label="replied" />}
            </span>
            <span className="mail-when">{when(m.date)}</span>
          </button>
        );
      })}
    </>
  );
}
