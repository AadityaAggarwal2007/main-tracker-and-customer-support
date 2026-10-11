'use client';

import { useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { mailCache, mailKey } from './cache';
import type { Full, ThreadItem } from './types';

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

// The conversation with this sender, like Gmail's thread (owner 2026-10-08): what they sent and what we sent them, oldest
// first, every message folded to one line; a click opens its body in a safe frame. The mail already open below is marked.
export default function MailThread({ token, boxId, currentUid, items, loading, failed, onRetry }: { token: string; boxId: string; currentUid: number; items: ThreadItem[] | null; loading: boolean; failed?: boolean; onRetry?: () => void }) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [bodies, setBodies] = useState<Record<string, Full | 'loading' | 'error'>>({});

  const toggle = async (m: ThreadItem) => {
    const k = mailKey(boxId, m.uid, m.folder);
    if (expanded === k) { setExpanded(null); return; }
    setExpanded(k);
    const cached = mailCache.mails.get(k);
    if (cached) { setBodies(b => ({ ...b, [k]: cached })); return; }
    setBodies(b => ({ ...b, [k]: 'loading' }));
    try {
      // peek=1: looking at an old mail here never marks it read in Gmail
      // ours: the conversation's own Gmail connection (owner 2026-10-10); theirs: the click's connection (usually already in
      // the server's copy). Never behind the read-ahead.
      const r = await fetch(`/api/mail/message?box=${encodeURIComponent(boxId)}&uid=${m.uid}&peek=1${m.folder === 'sent' ? '&via=thread&folder=sent' : '&via=read'}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.mail) { setBodies(b => ({ ...b, [k]: 'error' })); return; }
      mailCache.mails.set(k, d.mail);
      setBodies(b => ({ ...b, [k]: d.mail }));
    } catch { setBodies(b => ({ ...b, [k]: 'error' })); }
  };

  // Their mails come from the list at once; only OUR replies are read from Gmail (owner 2026-10-11). The header says
  // where that stands, and a failure there never hides the rest.
  const others = (items ?? []).length;
  if (others <= 1 && !loading && !failed) return null;   // nothing but this very mail: no section
  const ours = (items ?? []).filter(m => m.folder === 'sent').length;
  return (
    <section className="mail-thread">
      <div className="mail-thread-head" role="status">
        <button type="button" className="mail-thread-toggle" onClick={() => setOpen(o => !o)} aria-expanded={open}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          Conversation <b>· {others} {others === 1 ? 'message' : 'messages'}</b>{ours ? <span className="meta"> ({ours} from us)</span> : null}
        </button>
        {loading && <span className="meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Loader2 size={12} className="spin" /> checking our replies in Gmail…</span>}
        {failed && !loading && (
          <span className="meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            our replies could not be read from Gmail just now
            {onRetry && <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>Try again</button>}
          </span>
        )}
      </div>
      {open && (items ?? []).map(m => {
        const k = mailKey(boxId, m.uid, m.folder);
        const here = m.folder === 'inbox' && m.uid === currentUid;
        const body = bodies[k];
        return (
          <div key={k} className={`mail-thread-item${here ? ' here' : ''}`}>
            <button type="button" className="mail-thread-row" onClick={() => void toggle(m)} disabled={here} title={here ? 'This is the mail open below' : 'Show this message'}>
              {m.folder === 'sent' ? <ArrowUpRight size={13} className="out" aria-label="we sent" /> : <ArrowDownLeft size={13} className="in" aria-label="they sent" />}
              <span className="who truncate">{m.folder === 'sent' ? `You → ${m.to || ''}` : m.from}</span>
              <span className="sub truncate">{here ? 'This mail' : m.subject}</span>
              <span className="when">{when(m.date)}</span>
            </button>
            {expanded === k && (
              <div className="mail-thread-body">
                {body === 'loading' && <div className="meta"><Loader2 size={12} className="spin" /> Opening…</div>}
                {body === 'error' && <div className="meta t-danger">Could not open that message.</div>}
                {body && typeof body === 'object' && <iframe className="mail-thread-frame" title="Earlier message" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={body.frame} />}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
