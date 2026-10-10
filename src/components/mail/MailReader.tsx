'use client';

import { useEffect, useState } from 'react';
import { BadgeCheck, ChevronLeft, ChevronRight, Download, Image as ImageIcon, Loader2, Maximize2, MessageCircle, Minimize2, Paperclip, Reply, Send, ShieldQuestion, EyeOff, X } from 'lucide-react';
import { ASK_VERIFY_EN, ASK_VERIFY_HINGLISH, MAIL_MAX_FILES, MAIL_MAX_TOTAL_BYTES, quotedText } from '@/lib/chat/mail-view';
import { ATTACHMENT_ACCEPT, checkBrowserFile, formatFileSize } from '@/lib/chat/attachment-rules';
import { initials } from '@/lib/chat/mail-filters';
import MailThread from './MailThread';
import type { Att, Box, Full, ThreadItem, Ver } from './types';

const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// The open mail: who, the verification bar, actions, the body in a sandboxed frame, the reply box (owner 2026-10-08).
export default function MailReader({ token, box, mail, versions, thread, threadLoading, threadFailed, onRetryThread, canReply, onAlert, onBack, wide, onToggleWide, onPrev, onNext, onShowImages, onMarkUnread, onChanged, onSent }: {
  token: string; box: Box | null; mail: Full; versions: Ver[]; canReply: boolean;
  thread: ThreadItem[] | null; threadLoading: boolean; threadFailed?: boolean; onRetryThread?: () => void;
  onAlert: (type: string, message: string) => void;
  onBack: () => void; onPrev: (() => void) | null; onNext: (() => void) | null;
  // Full width (the list and filters hidden) or next to the list (owner 2026-10-09).
  wide?: boolean; onToggleWide?: () => void;
  onShowImages: () => void; onMarkUnread: () => void;
  onChanged: () => void;            // a verification was added or removed: read the list again
  onSent: () => void;
}) {
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [includeQuote, setIncludeQuote] = useState(true);
  const [attach, setAttach] = useState<File[]>([]);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [vOrder, setVOrder] = useState('');
  const [vPhone, setVPhone] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [vError, setVError] = useState('');

  // Another mail: a clean reply box and verify form.
  useEffect(() => { setReplyOpen(false); setReplyText(''); setAttach([]); setIncludeQuote(true); setVerifyOpen(false); setVOrder(''); setVPhone(''); setVError(''); }, [mail.uid]);

  const download = async (a: Att) => {
    try {
      const r = await fetch(`/api/mail/attachment?box=${encodeURIComponent(box?.id || '')}&uid=${mail.uid}&index=${a.index}`, { headers: { Authorization: auth.Authorization } });
      if (!r.ok) { const d = await r.json().catch(() => ({})); onAlert('error', d.error || 'Could not download that file.'); return; }
      const url = URL.createObjectURL(await r.blob());
      const el = document.createElement('a'); el.href = url; el.download = a.filename; document.body.appendChild(el); el.click(); el.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch { onAlert('error', 'Could not download that file.'); }
  };

  // Files for the reply: the chat's own rules (JPG / PNG / WEBP / GIF / PDF, 10 MB each) and at most 5, 10 MB in all;
  // the server judges every file again from its bytes.
  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const next = [...attach];
    for (const f of Array.from(list)) {
      const problem = checkBrowserFile(f);
      if (problem) { onAlert('error', `${f.name}: ${problem}`); continue; }
      if (next.length >= MAIL_MAX_FILES) { onAlert('error', `You can attach up to ${MAIL_MAX_FILES} files.`); break; }
      if (next.reduce((n, x) => n + x.size, 0) + f.size > MAIL_MAX_TOTAL_BYTES) { onAlert('error', 'Files on one reply can add up to 10 MB.'); break; }
      next.push(f);
    }
    setAttach(next);
  };

  const send = async () => {
    if (!box || sending) return;
    setSending(true);
    try {
      const form = new FormData();
      form.append('box', box.id); form.append('uid', String(mail.uid)); form.append('text', replyText); form.append('includeQuote', includeQuote ? '1' : '0');
      for (const f of attach) form.append('files', f, f.name);
      const r = await fetch('/api/mail/send', { method: 'POST', headers: { Authorization: auth.Authorization }, body: form });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', d.error || 'The reply was not sent.'); return; }
      onAlert('success', `Reply sent to ${d.to}.`);
      setReplyOpen(false); setReplyText(''); setAttach([]); onSent();
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
        {onToggleWide && <button type="button" className="btn btn-ghost btn-sm mail-widebtn" onClick={onToggleWide} title={wide ? 'Show the list next to the mail' : 'Open the mail full width'}>{wide ? <Minimize2 size={16} /> : <Maximize2 size={16} />} {wide ? 'With list' : 'Full width'}</button>}
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

      {mail.cut && <div className="mail-warn" style={{ margin: '0 0 0.5rem' }}>This mail is very large, so only its first part is shown here. Open it in Gmail to see everything. Its files can still be downloaded.</div>}
      <MailThread token={token} boxId={box?.id || ''} currentUid={mail.uid} items={thread} loading={threadLoading} failed={threadFailed} onRetry={onRetryThread} />

      {/* Scripts, forms and remote pictures are blocked twice: the sandbox and the policy inside the frame. */}
      <iframe className="mail-frame" title="Mail" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={mail.frame} />

      {replyOpen && (
        <div className="mail-reply">
          <div className="meta">Goes from <b>{box?.email}</b> to {mail.replyTo || mail.fromAddress}, in the same Gmail conversation. Gmail keeps a copy in Sent.</div>
          <textarea className="form-input" rows={6} value={replyText} onChange={e => setReplyText(e.target.value)} placeholder="Write your reply" maxLength={8000} autoFocus />
          <label className="mail-quote-opt">
            <input type="checkbox" checked={includeQuote} onChange={e => setIncludeQuote(e.target.checked)} /> Quote the original message below my reply (like Gmail)
          </label>
          {includeQuote && (
            <details className="mail-quote-preview">
              <summary>See the quoted original</summary>
              <pre>{quotedText(mail.date, mail.from, mail.text || '')}</pre>
            </details>
          )}
          {attach.length > 0 && (
            <div className="mail-files">
              {attach.map((f, i) => (
                <span key={`${f.name}-${i}`} className="chip chip-muted"><Paperclip size={11} /> {f.name} <span className="meta">{formatFileSize(f.size)}</span>
                  <button type="button" className="mail-file-x" onClick={() => setAttach(attach.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}><X size={11} /></button>
                </span>
              ))}
            </div>
          )}
          <div className="mail-actions" style={{ margin: 0 }}>
            <button type="button" className="btn btn-primary btn-sm" disabled={sending || !replyText.trim()} onClick={send}>
              {sending ? <Loader2 size={14} className="spin" /> : <Send size={14} />} Send reply
            </button>
            <label className="btn btn-outline btn-sm" style={{ cursor: 'pointer' }} title="JPG, PNG, WEBP, GIF or PDF; up to 5 files, 10 MB in all">
              <Paperclip size={14} /> Attach
              <input type="file" multiple accept={ATTACHMENT_ACCEPT} style={{ display: 'none' }} onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
            </label>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setReplyOpen(false); setReplyText(''); setAttach([]); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
