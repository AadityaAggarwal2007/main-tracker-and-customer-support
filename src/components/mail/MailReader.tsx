'use client';

import { useEffect, useState } from 'react';
import { BadgeCheck, ChevronLeft, ChevronRight, Download, Image as ImageIcon, Loader2, MessageCircle, Reply, Send, ShieldQuestion, EyeOff } from 'lucide-react';
import { ASK_VERIFY_EN, ASK_VERIFY_HINGLISH } from '@/lib/chat/mail-view';
import { initials } from '@/lib/chat/mail-filters';
import type { Att, Box, Full, Ver } from './types';

const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// The open mail: who, the verification bar, actions, the body in a sandboxed frame, the reply box (owner 2026-10-08).
export default function MailReader({ token, box, mail, versions, canReply, onAlert, onBack, onPrev, onNext, onShowImages, onMarkUnread, onChanged, onSent }: {
  token: string; box: Box | null; mail: Full; versions: Ver[]; canReply: boolean;
  onAlert: (type: string, message: string) => void;
  onBack: () => void; onPrev: (() => void) | null; onNext: (() => void) | null;
  onShowImages: () => void; onMarkUnread: () => void;
  onChanged: () => void;            // a verification was added or removed: read the list again
  onSent: () => void;
}) {
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [vOrder, setVOrder] = useState('');
  const [vPhone, setVPhone] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [vError, setVError] = useState('');

  // Another mail: a clean reply box and verify form.
  useEffect(() => { setReplyOpen(false); setReplyText(''); setVerifyOpen(false); setVOrder(''); setVPhone(''); setVError(''); }, [mail.uid]);

  const download = async (a: Att) => {
    try {
      const r = await fetch(`/api/mail/attachment?box=${encodeURIComponent(box?.id || '')}&uid=${mail.uid}&index=${a.index}`, { headers: { Authorization: auth.Authorization } });
      if (!r.ok) { const d = await r.json().catch(() => ({})); onAlert('error', d.error || 'Could not download that file.'); return; }
      const url = URL.createObjectURL(await r.blob());
      const el = document.createElement('a'); el.href = url; el.download = a.filename; document.body.appendChild(el); el.click(); el.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch { onAlert('error', 'Could not download that file.'); }
  };

  const send = async () => {
    if (!box || sending) return;
    setSending(true);
    try {
      const r = await fetch('/api/mail/send', { method: 'POST', headers: auth, body: JSON.stringify({ box: box.id, uid: mail.uid, text: replyText }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', d.error || 'The reply was not sent.'); return; }
      onAlert('success', `Reply sent to ${d.to}.`);
      setReplyOpen(false); setReplyText(''); onSent();
    } catch { onAlert('error', 'The reply was not sent.'); }
    finally { setSending(false); }
  };

  const verify = async () => {
    if (!box || verifying) return;
    setVerifying(true); setVError('');
    try {
      const r = await fetch('/api/mail/verify', { method: 'POST', headers: auth, body: JSON.stringify({ box: box.id, email: mail.fromAddress, orderId: vOrder, phone: vPhone }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setVError(d.error || 'Could not verify.'); return; }
      onAlert('success', `Verified for order ${d.orderId}${d.customerName ? ` (${d.customerName})` : ''}.`);
      setVerifyOpen(false); setVOrder(''); setVPhone(''); onChanged();
    } catch { setVError('Could not verify.'); }
    finally { setVerifying(false); }
  };

  const unverify = async (orderId: string) => {
    if (!box || !window.confirm(`Remove the verification of ${mail.fromAddress} for order ${orderId}? Do this only if it was a wrong click. It will not be verified by itself again.`)) return;
    try {
      const r = await fetch('/api/mail/verify', { method: 'POST', headers: auth, body: JSON.stringify({ box: box.id, email: mail.fromAddress, orderId, remove: true }) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); onAlert('error', d.error || 'Could not remove it.'); return; }
      onChanged();
    } catch { onAlert('error', 'Could not remove it.'); }
  };

  const auto = versions[0] && (versions[0].byName === 'Email match' || versions[0].byName === 'Email + order number');
  const files = mail.attachments.filter(a => !a.inline);

  return (
    <div className="mail-reader">
      <div className="mail-readbar">
        <button type="button" className="btn btn-ghost btn-sm mail-back" onClick={onBack}><ChevronLeft size={16} /> List</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onPrev?.()} disabled={!onPrev} title="Previous mail in the list"><ChevronLeft size={16} /></button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onNext?.()} disabled={!onNext} title="Next mail in the list"><ChevronRight size={16} /></button>
      </div>

      <header className="mail-head">
        <div className="mail-avatar" aria-hidden="true">{initials(mail.from)}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2>{mail.subject}</h2>
          <div className="meta"><b>{mail.from}</b> · {new Date(mail.date).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</div>
          <div className="meta truncate">To: {mail.to || box?.email}{mail.cc ? ` · Cc: ${mail.cc}` : ''}</div>
        </div>
        {mail.answered && <span className="chip chip-muted">Replied</span>}
      </header>

      {/* Verification: automatic first, then the team (owner 2026-10-08) */}
      {versions.length > 0 ? (
        <div className="mail-verify ok">
          <BadgeCheck size={16} />
          <span><b>Verified</b> · order {versions.map(v => v.orderId).join(', ')} · {auto ? `automatic (${versions[0].byName.toLowerCase()})` : `by ${versions[0].byName || 'team'}`}</span>
          {versions[0].chatId && <a className="btn btn-outline btn-sm" href={`/admin/chat?open=${encodeURIComponent(versions[0].chatId)}`}><MessageCircle size={13} /> Open chat</a>}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setVerifyOpen(o => !o)}>Verify another order</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => unverify(versions[0].orderId)} title="Only for a wrong click">Remove</button>
        </div>
      ) : (
        <div className="mail-verify warn">
          <ShieldQuestion size={16} />
          <span><b>Not verified.</b> Ask for the Order ID and the full phone number, then verify.</span>
          {canReply && <button type="button" className="btn btn-outline btn-sm" onClick={() => { setReplyOpen(true); setReplyText(ASK_VERIFY_EN); }}>Ask (English)</button>}
          {canReply && <button type="button" className="btn btn-outline btn-sm" onClick={() => { setReplyOpen(true); setReplyText(ASK_VERIFY_HINGLISH); }}>Ask (Hinglish)</button>}
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setVerifyOpen(o => !o)}>Verify</button>
        </div>
      )}
      {verifyOpen && (
        <div className="mail-verify-form">
          <div className="meta">Type what <b>{mail.fromAddress}</b> wrote back. Both must match one order of {box?.panelName}. The phone is only checked, never saved.</div>
          <div className="mail-bar" style={{ border: 0, padding: 0 }}>
            <input className="form-input" style={{ flex: 1, minWidth: 120 }} placeholder="Order ID (e.g. #1553)" value={vOrder} onChange={e => setVOrder(e.target.value)} />
            <input className="form-input" style={{ flex: 1, minWidth: 140 }} placeholder="Full phone (10 digits)" inputMode="tel" value={vPhone} onChange={e => setVPhone(e.target.value)} />
            <button type="button" className="btn btn-primary btn-sm" disabled={verifying || !vOrder.trim() || !vPhone.trim()} onClick={verify}>
              {verifying ? <Loader2 size={14} className="spin" /> : <BadgeCheck size={14} />} Verify
            </button>
          </div>
          {vError && <div className="mail-warn" style={{ margin: 0 }}>{vError}</div>}
        </div>
      )}

      <div className="mail-actions">
        {canReply && <button type="button" className="btn btn-primary btn-sm" onClick={() => setReplyOpen(o => !o)}><Reply size={14} /> Reply</button>}
        <button type="button" className="btn btn-outline btn-sm" onClick={onMarkUnread}><EyeOff size={14} /> Mark unread</button>
        {mail.remoteImages && !mail.imagesShown && (
          <button type="button" className="btn btn-outline btn-sm" title="Pictures from the internet tell the sender you opened the mail" onClick={onShowImages}><ImageIcon size={14} /> Show images</button>
        )}
        {files.map(a => (
          <button type="button" key={a.index} className="btn btn-outline btn-sm" onClick={() => download(a)} title={a.contentType}>
            <Download size={13} /> {a.filename} <span className="meta">{kb(a.size)}</span>
          </button>
        ))}
      </div>

      {/* Scripts, forms and remote pictures are blocked twice: the sandbox and the policy inside the frame. */}
      <iframe className="mail-frame" title="Mail" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={mail.frame} />

      {replyOpen && (
        <div className="mail-reply">
          <div className="meta">Goes from <b>{box?.email}</b> to {mail.replyTo || mail.fromAddress}. Gmail keeps a copy in Sent.</div>
          <textarea className="form-input" rows={6} value={replyText} onChange={e => setReplyText(e.target.value)} placeholder="Write your reply" maxLength={8000} autoFocus />
          <div className="mail-actions" style={{ margin: 0 }}>
            <button type="button" className="btn btn-primary btn-sm" disabled={sending || !replyText.trim()} onClick={send}>
              {sending ? <Loader2 size={14} className="spin" /> : <Send size={14} />} Send reply
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setReplyOpen(false); setReplyText(''); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
