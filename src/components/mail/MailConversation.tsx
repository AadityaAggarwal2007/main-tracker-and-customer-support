'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, Check, Loader2 } from 'lucide-react';
import { initials } from '@/lib/chat/mail-filters';
import { frameHeight } from '@/lib/chat/mail-view';
import { mailCache, mailKey } from './cache';
import type { Full, ThreadItem } from './types';

const when = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
};
const EARLY_SHOWN = 2;   // the earlier messages shown as cards; the rest fold into "N earlier messages", like Gmail

// How many characters fit on one line of the frame (the frame's height follows the mail's lines, owner 2026-10-11:
// "neeche ka gap"): about 110 on a desktop, 44 on a phone. Read after mount so the server and the browser draw the same.
export function useFrameChars(): number {
  const [chars, setChars] = useState(110);
  useEffect(() => {
    const read = () => setChars(window.innerWidth < 600 ? 44 : window.innerWidth < 1000 ? 80 : 110);
    read();
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, []);
  return chars;
}

// The conversation as Gmail shows it (owner 2026-10-11): every mail of the Gmail thread as a card, oldest first, theirs
// and ours; the open mail is the expanded card (its body comes from `current`); any other card opens on a click (from
// the server's copy, never marking anything read). A reply sent from here shows at once, with its state from the outbox:
// Sending… / Sent / Not sent: <why> · Try again (onRetrySend).
export default function MailConversation({ token, boxId, mail, items, loading, failed, onRetry, onRetrySend, storeName, current, chars = 110 }: {
  token: string; boxId: string; mail: Full; items: ThreadItem[] | null; loading: boolean; failed?: boolean; onRetry?: () => void;
  onRetrySend?: (outboxId: string) => void; storeName: string; current: ReactNode; chars?: number;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [bodies, setBodies] = useState<Record<string, Full | 'loading' | 'error'>>({});
  const [showAll, setShowAll] = useState(false);

  const all = (items ?? []).slice();
  if (!all.some(m => m.folder === 'inbox' && m.uid === mail.uid)) all.push({ folder: 'inbox', uid: mail.uid, from: mail.from, to: mail.to, subject: mail.subject, date: mail.date });
  all.sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0));
  const here = all.findIndex(m => m.folder === 'inbox' && m.uid === mail.uid);
  const before = all.slice(0, here), after = all.slice(here + 1);
  const hidden = !showAll && before.length > EARLY_SHOWN + 1 ? before.length - EARLY_SHOWN : 0;

  const toggle = async (m: ThreadItem) => {
    const k = mailKey(boxId, m.uid, m.folder);
    const next = !open[k];
    setOpen(o => ({ ...o, [k]: next }));
    if (!next || m.local || bodies[k]) return;
    const kept = mailCache.mails.get(k);
    if (kept) { setBodies(b => ({ ...b, [k]: kept })); return; }
    setBodies(b => ({ ...b, [k]: 'loading' }));
    try {
      const r = await fetch(`/api/mail/message?box=${encodeURIComponent(boxId)}&uid=${m.uid}&peek=1${m.folder === 'sent' ? '&via=thread&folder=sent' : '&via=read'}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.mail) { setBodies(b => ({ ...b, [k]: 'error' })); return; }
      mailCache.mails.set(k, d.mail);
      setBodies(b => ({ ...b, [k]: d.mail }));
    } catch { setBodies(b => ({ ...b, [k]: 'error' })); }
  };

  const sendLine = (m: ThreadItem) => {
    if (!m.local) return null;
    if (m.sendState === 'failed') return <span className="mail-send failed"><AlertCircle size={12} /> Not sent: {m.sendError || 'Gmail did not take it'}{m.outboxId && onRetrySend && <> · <button type="button" className="mail-send-retry" onClick={e => { e.stopPropagation(); onRetrySend(m.outboxId!); }}>Try again</button></>}</span>;
    if (m.sendState === 'sent') return <span className="mail-send sent"><Check size={12} /> Sent</span>;
    return <span className="mail-send sending"><Loader2 size={12} className="spin" /> Sending…</span>;
  };

  const card = (m: ThreadItem) => {
    const k = mailKey(boxId, m.uid, m.folder);
    const ours = m.folder === 'sent';
    const isOpen = !!open[k];
    const body = bodies[k];
    const who = ours ? `${storeName} Support` : m.from;
    return (
      <article key={k} className={`mail-msg${ours ? ' ours' : ''}${isOpen ? ' open' : ''}`}>
        <button type="button" className="mail-msg-head" onClick={() => void toggle(m)} aria-expanded={isOpen}>
          <span className={`mail-avatar sm${ours ? ' ours' : ''}`} aria-hidden="true">{initials(who)}</span>
          <span className="mail-msg-who">
            <b className="truncate">{who}</b>
            {m.local && m.sendState === 'failed'
              ? sendLine(m)   // the reason takes the whole line (a phone has no room next to the name)
              : isOpen || !m.preview
                ? <span className="meta truncate">{ours ? `to ${m.to || mail.fromAddress}` : 'to us'}{m.local ? ' · from ShipTrack' : ''}</span>
                : <span className="meta truncate">{m.preview}</span>}
          </span>
          <span className="meta mail-msg-when">{m.local && m.sendState !== 'failed' ? sendLine(m) : when(m.date)}</span>
        </button>
        {isOpen && (
          <div className="mail-msg-body">
            {m.local && <div className="mail-msg-text">{m.preview}</div>}
            {!m.local && body === 'loading' && <div className="meta"><Loader2 size={12} className="spin" /> Opening…</div>}
            {!m.local && body === 'error' && <div className="meta t-danger">Could not open that message.</div>}
            {!m.local && body && typeof body === 'object' && <iframe className="mail-thread-frame" style={{ height: frameHeight(body, chars) }} title="Message" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={body.frame} />}
          </div>
        )}
      </article>
    );
  };

  return (
    <div className="mail-conv">
      {(loading || failed) && (
        <div className="meta mail-conv-status" role="status">
          {loading && <><Loader2 size={12} className="spin" /> loading the rest of the conversation…</>}
          {failed && !loading && <>the rest of the conversation could not be read just now {onRetry && <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>Try again</button>}</>}
        </div>
      )}
      {before.slice(0, hidden ? 1 : before.length).map(card)}
      {hidden > 0 && <button type="button" className="mail-conv-more" onClick={() => setShowAll(true)}>{hidden} earlier {hidden === 1 ? 'message' : 'messages'}</button>}
      {hidden > 0 && before.slice(before.length - (EARLY_SHOWN - 1)).map(card)}
      <article className="mail-msg open here">
        <div className="mail-msg-head static">
          <span className="mail-avatar sm" aria-hidden="true">{initials(mail.from)}</span>
          <span className="mail-msg-who">
            <b className="truncate">{mail.from}</b>
            <span className="meta truncate">to {mail.to || 'us'}{mail.cc ? ` · cc ${mail.cc}` : ''}</span>
          </span>
          <span className="meta mail-msg-when">{when(mail.date)}</span>
        </div>
        <div className="mail-msg-body">{current}</div>
      </article>
      {after.map(card)}
    </div>
  );
}
