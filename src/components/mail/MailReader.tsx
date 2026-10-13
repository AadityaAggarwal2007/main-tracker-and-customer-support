'use client';

import { useEffect, useState } from 'react';
import { BadgeCheck, ChevronLeft, ChevronRight, Download, FolderCheck, FolderOpen, Image as ImageIcon, Loader2, MessageCircle, Paperclip, Reply, Send, ShieldQuestion, EyeOff, Wrench, X, Sparkles, SpellCheck } from 'lucide-react';
import Suggestions, { type SuggestState } from '@/app/admin/chat/_components/Suggestions';
import type { SuggestLang } from '@/lib/chat/suggest';
import { agoText } from '@/app/admin/_lib/format';
import { ASK_VERIFY_EN, ASK_VERIFY_HINGLISH, MAIL_MAX_FILES, MAIL_MAX_TOTAL_BYTES, frameHeight, quotedText } from '@/lib/chat/mail-view';
import { ATTACHMENT_ACCEPT, checkBrowserFile, formatFileSize } from '@/lib/chat/attachment-rules';
import { BUCKET_LABEL, initials, type CustomerCase, type MailBucket } from '@/lib/chat/mail-filters';
import MailConversation, { useFrameChars } from './MailConversation';
import CustomerCard from './CustomerCard';
import { CorrectionDialog } from '@/components/CorrectionDialog';
import { correctionLine, isOverdue, type CorrectionKind } from '@/lib/chat/corrections-rules';
import type { CorrectionRow } from '@/lib/chat/corrections-read';
import type { Att, Box, Customer, Full, ThreadItem, Ver } from './types';

const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// The open mail like Gmail (owner 2026-10-11): back / mark unread / newer-older on top, the subject with its box (To reply /
// Replied / Not a customer), the verification bar, the whole conversation as cards (the open mail expanded), and the reply
// box right under it (Reply, or ask for the order details when the sender is not verified). The frame is as tall as the
// mail (no white box below a three-line mail), and the "Customer" card (CustomerCard) stands on the right on a desktop,
// above the conversation on a phone.
export default function MailReader({ token, box, mail, versions, thread, threadLoading, threadFailed, onRetryThread, onRetrySend, customer, customerLoading, canReply, onAlert, onBack, backLabel, position, bucket, caseInfo, onCase, onNextAfterSend, onPrev, onNext, onShowImages, onMarkUnread, onChanged, onSent }: {
  token: string; box: Box | null; mail: Full; versions: Ver[]; canReply: boolean;
  thread: ThreadItem[] | null; threadLoading: boolean; threadFailed?: boolean; onRetryThread?: () => void;
  onRetrySend?: (outboxId: string) => void;      // "Try again" on a reply the outbox could not send
  customer: Customer | null; customerLoading: boolean;
  onAlert: (type: string, message: string) => void;
  onBack: () => void; onPrev: (() => void) | null; onNext: (() => void) | null;
  backLabel?: string; position?: string;   // "To reply" / "3 of 41"
  bucket?: MailBucket;                      // To reply / Replied / Not a customer (mail-filters.ts bucketOf)
  caseInfo?: CustomerCase | null;           // the customer's case (owner 2026-10-11 afternoon; closed by a reply or by hand since 12:45); null = not a customer
  onCase?: (action: 'close' | 'reopen') => void;                                       // Close case / Reopen case (canReply only)
  onNextAfterSend?: boolean;                // after Send the screen opens the next mail to reply to
  onShowImages: () => void; onMarkUnread: () => void;
  onChanged: () => void;            // a verification was added or removed: read the list again
  onSent: (queued: boolean) => void;
}) {
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const chars = useFrameChars();
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
  // "Correction" (owner 2026-10-11): what a verified sender wants changed on their order; POST /api/corrections { mail }.
  // The mail's own rows come from one light GET when it opens (a missing table = none).
  const [corrOpen, setCorrOpen] = useState(false);
  const [corrBusy, setCorrBusy] = useState(false);
  const [corrError, setCorrError] = useState('');
  const [corrRows, setCorrRows] = useState<CorrectionRow[]>([]);
  // Suggestions + "Sudharo" (owner 2026-10-13: "gmail pa grammer sudharna wala aur suggestion wala bhi dede, yeh log baar
  // baar chat gpt sa kar rha ha"): the same drafting as Chat Support, on this mail's conversation (/api/mail/suggest,
  // /api/mail/polish). Only when pressed; a pick fills the reply box, the team member still presses Send.
  const [sugg, setSugg] = useState<SuggestState | null>(null);
  const [polishing, setPolishing] = useState(false);

  // Another mail: a clean reply box and verify form.
  useEffect(() => { setReplyOpen(false); setReplyText(''); setAttach([]); setIncludeQuote(true); setVerifyOpen(false); setVOrder(''); setVPhone(''); setVError(''); setCorrOpen(false); setCorrError(''); setCorrRows([]); setSugg(null); setPolishing(false); }, [mail.uid]);
  const suggest = async (lang: SuggestLang = sugg?.lang || 'auto', refresh = false) => {
    if (!box) return;
    const key = `${box.id}:${mail.uid}`;
    setReplyOpen(true);
    setSugg(prev => ({ convId: key, lang, loading: true, error: '', id: null, options: prev && prev.convId === key && prev.lang === lang && !refresh ? prev.options : [] }));
    try {
      const r = await fetch('/api/mail/suggest', { method: 'POST', headers: auth, body: JSON.stringify({ box: box.id, uid: mail.uid, lang, refresh }) });
      const d = await r.json().catch(() => ({}));
      setSugg(cur => (cur && cur.convId === key ? { ...cur, lang, loading: false, error: r.ok ? '' : (d.error || 'Chikki could not draft right now.'), options: r.ok ? (d.options || []) : cur.options } : cur));
    } catch { setSugg(cur => (cur && cur.convId === key ? { ...cur, loading: false, error: 'Chikki could not draft right now.' } : cur)); }
  };
  const polish = async () => {
    if (!box || !replyText.trim() || polishing) return;
    setPolishing(true);
    try {
      const r = await fetch('/api/mail/polish', { method: 'POST', headers: auth, body: JSON.stringify({ box: box.id, uid: mail.uid, text: replyText }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', d.error || 'Sudharo could not fix it right now.'); return; }
      if (d.changed && typeof d.text === 'string') setReplyText(d.text); else onAlert('success', 'Looks fine already: nothing to fix.');
    } catch { onAlert('error', 'Sudharo could not fix it right now.'); }
    finally { setPolishing(false); }
  };
  useEffect(() => {
    if (!box || !token) return;
    let gone = false;
    fetch(`/api/corrections?box=${encodeURIComponent(box.id)}&uid=${mail.uid}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : null)).then(j => { if (!gone && j && Array.isArray(j.rows)) setCorrRows(j.rows); }).catch(() => { /* no line */ });
    return () => { gone = true; };
  }, [box, token, mail.uid]);

  const saveCorrection = async (kinds: CorrectionKind[], note: string, orderId: string) => {
    if (!box || corrBusy) return;
    setCorrBusy(true); setCorrError('');
    try {
      const r = await fetch('/api/corrections', { method: 'POST', headers: auth, body: JSON.stringify({ mail: { box: box.id, uid: mail.uid, email: mail.fromAddress, orderId }, kinds, note }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setCorrError(d.error || 'Could not save the correction.'); return; }
      setCorrOpen(false);
      if (d.correction) setCorrRows(rows => [d.correction as CorrectionRow, ...rows]);
      onAlert('success', 'Correction noted. Tell the customer in your reply; the Manager will fix the order.');
    } catch { setCorrError('Could not save the correction.'); }
    finally { setCorrBusy(false); }
  };

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
      // Queued (the outbox): the screen moves on at once; the conversation shows Sending… until Gmail took it.
      onAlert('success', d.queued ? `Reply to ${d.to} is on its way.` : `Reply sent to ${d.to}.`);
      setReplyOpen(false); setReplyText(''); setAttach([]); onSent(!!d.queued);
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

  const replyBox = canReply && (replyOpen ? (
    <div className="mail-reply mail-msg open">
      <div className="mail-msg-head static">
        <span className="mail-avatar sm ours" aria-hidden="true">{initials(`${box?.siteName || ''} Support`)}</span>
        <span className="mail-msg-who"><b className="truncate">Reply to {mail.replyTo || mail.fromAddress}</b><span className="meta truncate">from {box?.email}, in the same Gmail conversation</span></span>
      </div>
      <Suggestions state={sugg} replyOpen onPick={(i) => { if (sugg?.options[i]) setReplyText(sugg.options[i]); }}
        onRefresh={() => void suggest(sugg?.lang || 'auto', true)} onLang={(l) => void suggest(l)} onClose={() => setSugg(null)} />
      <textarea className="form-input" rows={10} value={replyText} onChange={e => setReplyText(e.target.value)} placeholder="Write your reply" maxLength={8000} autoFocus />
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
          {sending ? <Loader2 size={14} className="spin" /> : <Send size={14} />} Send{onNextAfterSend ? ' and open next' : ''}
        </button>
        <label className="btn btn-outline btn-sm" style={{ cursor: 'pointer' }} title="JPG, PNG, WEBP, GIF or PDF; up to 5 files, 10 MB in all">
          <Paperclip size={14} /> Attach
          <input type="file" multiple accept={ATTACHMENT_ACCEPT} style={{ display: 'none' }} onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
        </label>
        <button type="button" className="btn btn-outline btn-sm" disabled={!!sugg?.loading} onClick={() => void suggest()} title="Chikki drafts 3 replies from this conversation; pick one, edit it, send it">
          {sugg?.loading ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} Suggestions
        </button>
        <button type="button" className="btn btn-outline btn-sm" disabled={polishing || !replyText.trim()} onClick={() => void polish()} title="Sudharo: fix the spelling and grammar of what you typed (the meaning stays)">
          {polishing ? <Loader2 size={14} className="spin" /> : <SpellCheck size={14} />} Sudharo
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setReplyOpen(false); setReplyText(''); setAttach([]); setSugg(null); }}>Discard</button>
      </div>
    </div>
  ) : (
    <div className="mail-replybar">
      <button type="button" className="btn btn-outline mail-replybtn" onClick={() => setReplyOpen(true)}><Reply size={15} /> Reply</button>
      <button type="button" className="btn btn-outline mail-replybtn" onClick={() => void suggest()} title="Chikki drafts 3 replies from this conversation"><Sparkles size={15} /> Suggest a reply</button>
      {versions.length === 0 && <button type="button" className="btn btn-outline mail-replybtn" onClick={() => { setReplyOpen(true); setReplyText(ASK_VERIFY_EN); }}><ShieldQuestion size={15} /> Ask for order details (English)</button>}
      {versions.length === 0 && <button type="button" className="btn btn-outline mail-replybtn" onClick={() => { setReplyOpen(true); setReplyText(ASK_VERIFY_HINGLISH); }}><ShieldQuestion size={15} /> (Hinglish)</button>}
    </div>
  ));

  return (
    <div className="mail-reader">
      <div className="mail-readbar">
        <button type="button" className="btn btn-ghost btn-sm mail-back" onClick={onBack} title="Back to the list"><ChevronLeft size={16} /> {backLabel || 'List'}</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onMarkUnread} title="Mark unread"><EyeOff size={15} /> Mark unread</button>
        {/* Close case / Reopen case (owner 2026-10-11 afternoon): a customer's mail only; nothing goes to the customer.
            A reply closes the case by itself (owner 12:45); Close case is for a mail that needs no reply. */}
        {canReply && caseInfo && onCase && (caseInfo.state === 'active'
          ? <button type="button" className="btn btn-ghost btn-sm mail-casebtn" onClick={() => onCase('close')} title="For a mail that needs no reply: the case moves to Closed cases and leaves To reply (a reply closes it by itself). A new mail from them makes it active again."><FolderCheck size={15} /> Close case</button>
          : <button type="button" className="btn btn-ghost btn-sm mail-casebtn" onClick={() => onCase('reopen')} title="Put this customer back among the active cases, until you reply again or close it again"><FolderOpen size={15} /> Reopen case</button>)}
        {canReply && (
          <button type="button" className="btn btn-ghost btn-sm mail-casebtn" onClick={() => setCorrOpen(true)}
            title={versions.length > 0 ? 'The customer wants something changed on the order (address, size, colour ...): note it for the Manager' : 'Verify this sender first; the dialog shows the two ways'}>
            <Wrench size={15} /> Correction
          </button>
        )}
        <span style={{ flex: 1 }} />
        {position && <span className="meta" style={{ whiteSpace: 'nowrap' }}>{position}</span>}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onPrev?.()} disabled={!onPrev} title="Newer"><ChevronLeft size={16} /></button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onNext?.()} disabled={!onNext} title="Older"><ChevronRight size={16} /></button>
      </div>

      <header className="mail-subjecthead">
        <h2>{mail.subject}</h2>
        {bucket && <span className={`chip ${bucket === 'todo' ? 'chip-warn' : bucket === 'done' ? 'chip-ok' : 'chip-muted'}`}>{BUCKET_LABEL[bucket]}</span>}
        {/* how the case closed (owner 2026-10-11 12:45): by our reply after their newest mail, or by hand */}
        {caseInfo?.state === 'closed' && caseInfo.closedAt && (
          <span className="meta mail-caseline"><FolderCheck size={13} /> {caseInfo.closedBy === 'reply'
            ? `Case closed · replied ${agoText(Date.parse(caseInfo.closedAt))}`
            : `Case closed${caseInfo.byName ? ` by ${caseInfo.byName}` : ''} · ${agoText(Date.parse(caseInfo.closedAt))}`}</span>
        )}
        {/* Corrections noted on this mail (owner 2026-10-11): pending ones in full, red once over a day */}
        {corrRows.filter(r => r.status === 'pending').map(r => (
          <span key={r.id} className={`meta mail-caseline${isOverdue(r) ? ' t-danger' : ''}`} title={r.note}><Wrench size={13} /> {correctionLine(r)}</span>
        ))}
        {corrRows.some(r => r.status !== 'pending') && !corrRows.some(r => r.status === 'pending') && (
          <span className="meta mail-caseline"><Wrench size={13} /> {correctionLine(corrRows.find(r => r.status !== 'pending') as CorrectionRow)}</span>
        )}
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

      <div className="mail-readwrap">
      <div className="mail-readmain">
      <MailConversation
        token={token} boxId={box?.id || ''} mail={mail} items={thread} loading={threadLoading} failed={threadFailed} onRetry={onRetryThread} onRetrySend={onRetrySend}
        storeName={box?.siteName || 'Store'} chars={chars}
        current={(
          <>
            {(mail.remoteImages && !mail.imagesShown) || files.length > 0 ? (
              <div className="mail-actions">
                {mail.remoteImages && !mail.imagesShown && (
                  <button type="button" className="btn btn-outline btn-sm" title="Pictures from the internet tell the sender you opened the mail" onClick={onShowImages}><ImageIcon size={14} /> Show images</button>
                )}
                {files.map(a => (
                  <button type="button" key={a.index} className="btn btn-outline btn-sm" onClick={() => download(a)} title={a.contentType}>
                    <Download size={13} /> {a.filename} <span className="meta">{kb(a.size)}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {mail.cut && <div className="mail-warn" style={{ margin: '0 0 0.5rem' }}>This mail is very large, so only its first part is shown here. Open it in Gmail to see everything. Its files can still be downloaded.</div>}
            {/* Scripts, forms and remote pictures are blocked twice: the sandbox and the policy inside the frame. */}
            <iframe className="mail-frame" style={{ height: frameHeight(mail, chars) }} title="Mail" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={mail.frame} />
          </>
        )}
      />

      {replyBox}
      </div>
      <CustomerCard customer={customer} loading={customerLoading} onAlert={onAlert} token={token} onChanged={onChanged} box={box?.id ?? null} onVerify={() => { setVerifyOpen(true); document.querySelector('.mail-verify-form')?.scrollIntoView({ block: 'nearest' }); }} />
      </div>
      {corrOpen && (
        <CorrectionDialog who="sender" verified={versions.length > 0} orders={versions.map(v => v.orderId)} busy={corrBusy} error={corrError}
          onCancel={() => setCorrOpen(false)} onSave={saveCorrection}
          onVerifyNow={() => { setCorrOpen(false); setVerifyOpen(true); document.querySelector('.mail-verify-form')?.scrollIntoView({ block: 'nearest' }); }}
          ask={{ en: ASK_VERIFY_EN, hi: ASK_VERIFY_HINGLISH }}
          onAsk={(text) => { setCorrOpen(false); setReplyOpen(true); setReplyText(text); }} />
      )}
    </div>
  );
}
