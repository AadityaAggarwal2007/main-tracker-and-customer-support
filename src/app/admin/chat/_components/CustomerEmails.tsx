'use client';

import { useEffect, useState } from 'react';
import { Mail, ExternalLink, Loader2 } from 'lucide-react';

// ── "Emails" in a verified customer's thread (owner 2026-10-08) ───────────────────────────────
// A team member verifies a Gmail sender for an order in the Mail tab (Order ID + full phone). This line then
// shows, in that customer's chat, the mails from those verified addresses (last 30 days, read live from
// Gmail when pressed, never by the thread's polling) with a link that opens each one in the Mail tab.
// Only shown to a login with Open Mail (the server checks again). Nothing here is sent to a customer.
interface Row { uid: number; boxId: string; subject: string; date: string; unread: boolean; from: string }

export default function CustomerEmails({ token, conversationId, orderId }: { token: string; conversationId: string; orderId: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<{ emails: string[]; mails: Row[]; hasMailbox: boolean; failed: number } | null>(null);
  const [error, setError] = useState('');

  // Another chat, another list.
  useEffect(() => { setOpen(false); setData(null); setError(''); }, [conversationId]);

  const load = async () => {
    setBusy(true); setError('');
    try {
      const r = await fetch(`/api/mail/by-chat?conversationId=${encodeURIComponent(conversationId)}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) setError(d.error || 'Could not read the emails.');
      else setData({ emails: d.emails || [], mails: d.mails || [], hasMailbox: d.hasMailbox !== false, failed: d.failed || 0 });
    } catch { setError('Could not read the emails.'); }
    finally { setBusy(false); }
  };

  const toggle = () => { const next = !open; setOpen(next); if (next && !data && !busy) void load(); };

  return (
    <div className="th-emails meta">
      <button type="button" className="meta-btn" aria-expanded={open} onClick={toggle} title={`Mails from the Gmail addresses verified for order ${orderId}`}>
        <Mail size={12} /> Emails
      </button>
      {open && (
        <div className="th-emails-body">
          {busy && <span><Loader2 size={12} className="spin" /> Reading Gmail…</span>}
          {error && <span className="t-danger">{error}</span>}
          {data && !busy && (
            data.emails.length === 0
              ? <span>No Gmail address is verified for {orderId} yet. In Mail, open the customer&apos;s mail and press Verify (Order ID + full phone).</span>
              : !data.hasMailbox
                ? <span>No Gmail is connected to this panel for you to read.</span>
                : data.mails.length === 0
                  ? <span>No mail from {data.emails.join(', ')} in the last 30 days.{data.failed ? ' (Gmail could not be read for some.)' : ''}</span>
                  : data.mails.map(m => (
                    <a key={`${m.boxId}-${m.uid}`} className="th-email-row" href={`/admin?tab=mail&box=${encodeURIComponent(m.boxId)}&uid=${m.uid}`} title="Open in Mail">
                      <span className={m.unread ? 'th-email-subj unread' : 'th-email-subj'}>{m.subject}</span>
                      <span>{new Date(m.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
                      <ExternalLink size={11} />
                    </a>
                  ))
          )}
        </div>
      )}
    </div>
  );
}
