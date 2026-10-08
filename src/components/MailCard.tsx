'use client';

// ── Mail: the real Gmail inbox of a panel (owner 2026-10-08) ──────────────────────────────────
// The Super Admin's tab; a team member sees it only with the Mail ticks and only for their panels (every
// /api/mail/* route checks both again). It reads the last 30 days of the Gmail inbox LIVE over IMAP when
// opened or refreshed and stores nothing. Opening a mail marks it read in Gmail ("Mark unread" undoes it).
// An HTML mail is shown in an iframe with sandbox (no scripts, no same origin) and a Content-Security-Policy
// that blocks remote pictures until "Show images" (src/lib/chat/mail-view.ts). Attachments are downloads only.
// Chikki is not involved here: the AI only drafts in Chat Support. Words: src/lib/chat/mail-view.ts.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BadgeCheck, ChevronLeft, Download, Image as ImageIcon, Loader2, MailOpen, Mail as MailIcon, MessageCircle, Paperclip, RefreshCw, Reply, Send, ShieldQuestion } from 'lucide-react';
import { ASK_VERIFY_EN, ASK_VERIFY_HINGLISH } from '@/lib/chat/mail-view';
import { agoText } from '@/app/admin/_lib/format';

interface Box { id: string; email: string; siteName: string; panelId: string | null; panelName: string; status: { ok: boolean; error: string | null; checkedAt: number } | null }
interface Item { uid: number; from: string; fromAddress: string; subject: string; date: string; unread: boolean; hasAttachment: boolean; answered: boolean }
interface Att { index: number; filename: string; contentType: string; size: number; inline: boolean }
interface Full {
  uid: number; subject: string; date: string; from: string; fromAddress: string; to: string; cc: string; replyTo: string;
  frame: string; remoteImages: boolean; imagesShown: boolean; attachments: Att[]; unread: boolean; answered: boolean;
}

interface Ver { orderId: string; byName: string; at: string; chatId: string | null }

// initialBox / initialUid: a link from a chat thread ("Emails") opens that mail once.
interface Props { token: string; onAlert: (type: string, message: string) => void; activePanelId?: string; initialBox?: string | null; initialUid?: number | null }

const when = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};
const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export default function MailCard({ token, onAlert, activePanelId, initialBox, initialUid }: Props) {
  const alertRef = useRef(onAlert);
  alertRef.current = onAlert;
  const auth = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const [boxes, setBoxes] = useState<Box[] | null>(null);
  const [canReply, setCanReply] = useState(false);
  const [boxId, setBoxId] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [meta, setMeta] = useState<{ truncated: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [down, setDown] = useState<string | null>(null);
  const [filter, setFilter] = useState<'unread' | 'all' | 'unverified'>('unread');
  const [verified, setVerified] = useState<Record<string, Ver[]>>({});
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [vOrder, setVOrder] = useState('');
  const [vPhone, setVPhone] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [vError, setVError] = useState('');
  const initialDone = useRef(false);
  const [q, setQ] = useState('');
  const [openUid, setOpenUid] = useState<number | null>(null);
  const [mail, setMail] = useState<Full | null>(null);
  const [opening, setOpening] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const listSeq = useRef(0);
  const openSeq = useRef(0);

  // The mailboxes this login may open.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetch('/api/mail/boxes', { headers: auth, cache: 'no-store' });
        const d = await r.json().catch(() => ({}));
        if (!live) return;
        if (!r.ok) { setBoxes([]); setDown(d.error || 'Mail could not be opened.'); return; }
        const list: Box[] = d.boxes || [];
        setBoxes(list); setCanReply(!!d.canReply);
      } catch { if (live) { setBoxes([]); setDown('Mail could not be opened.'); } }
    })();
    return () => { live = false; };
  }, [auth]);

  // The Gmail follows the panel switcher (owner 2026-10-08): only the active panel's Gmail(s) are listed. A link
  // from a chat may name a mailbox outside it; that one is kept so the link still works.
  const visibleBoxes = useMemo(
    () => (boxes ?? []).filter(b => !activePanelId || b.panelId === activePanelId || b.id === initialBox),
    [boxes, activePanelId, initialBox],
  );
  useEffect(() => {
    if (boxes === null) return;
    setBoxId(prev => {
      if (!initialDone.current && initialBox && visibleBoxes.some(b => b.id === initialBox)) return initialBox;
      return prev && visibleBoxes.some(b => b.id === prev) ? prev : (visibleBoxes[0]?.id ?? null);
    });
  }, [boxes, visibleBoxes, initialBox]);

  const loadList = useCallback(async (id: string) => {
    const seq = ++listSeq.current;
    setLoading(true); setDown(null);
    try {
      const r = await fetch(`/api/mail/messages?box=${encodeURIComponent(id)}`, { headers: auth, cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (seq !== listSeq.current) return;
      if (!r.ok) { setItems([]); setMeta(null); setDown(d.error || 'Could not read Gmail.'); return; }
      setItems(d.mails || []); setVerified(d.verified || {}); setMeta({ truncated: !!d.truncated }); setLoadedAt(Date.now());
    } catch { if (seq === listSeq.current) { setItems([]); setDown('Could not reach Gmail. Try again.'); } }
    finally { if (seq === listSeq.current) setLoading(false); }
  }, [auth]);

  useEffect(() => {
    setOpenUid(null); setMail(null); setReplyOpen(false); setReplyText(''); setItems([]); setMeta(null); setVerified({}); setVerifyOpen(false);
    if (boxId) void loadList(boxId);
  }, [boxId, loadList]);

  const openMail = async (uid: number, images = false) => {
    if (!boxId) return;
    const seq = ++openSeq.current;
    setOpenUid(uid); setOpening(true); setReplyOpen(false); setReplyText(''); setVerifyOpen(false); setVOrder(''); setVPhone(''); setVError('');
    if (!images) setMail(null);
    try {
      const r = await fetch(`/api/mail/message?box=${encodeURIComponent(boxId)}&uid=${uid}${images ? '&images=1' : ''}`, { headers: auth, cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (seq !== openSeq.current) return;
      if (!r.ok) { alertRef.current('error', d.error || 'Could not open that mail.'); setOpenUid(null); return; }
      setMail(d.mail);
      setItems(prev => prev.map(x => x.uid === uid ? { ...x, unread: false } : x));
    } catch { if (seq === openSeq.current) { alertRef.current('error', 'Could not open that mail.'); setOpenUid(null); } }
    finally { if (seq === openSeq.current) setOpening(false); }
  };

  // Opens the mail a chat's "Emails" link pointed at, once, when its mailbox's list has loaded.
  useEffect(() => {
    if (initialDone.current || !initialUid || !boxId || boxId !== initialBox || loading || items.length === 0) return;
    initialDone.current = true;
    void openMail(initialUid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, loading, boxId, initialBox, initialUid]);

  const verify = async () => {
    if (!boxId || !mail || verifying) return;
    setVerifying(true); setVError('');
    try {
      const r = await fetch('/api/mail/verify', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ box: boxId, email: mail.fromAddress, orderId: vOrder, phone: vPhone }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setVError(d.error || 'Could not verify.'); return; }
      alertRef.current('success', `Verified for order ${d.orderId}${d.customerName ? ` (${d.customerName})` : ''}.`);
      setVerifyOpen(false); setVOrder(''); setVPhone('');
      if (boxId) await loadList(boxId);
    } catch { setVError('Could not verify.'); }
    finally { setVerifying(false); }
  };

  const unverify = async (orderId: string) => {
    if (!boxId || !mail) return;
    if (!window.confirm(`Remove the verification of ${mail.fromAddress} for order ${orderId}? Do this only if it was a wrong click.`)) return;
    try {
      const r = await fetch('/api/mail/verify', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ box: boxId, email: mail.fromAddress, orderId, remove: true }) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); alertRef.current('error', d.error || 'Could not remove it.'); return; }
      if (boxId) await loadList(boxId);
    } catch { alertRef.current('error', 'Could not remove it.'); }
  };

  const askVerify = (lang: 'en' | 'hi') => { setReplyOpen(true); setReplyText(lang === 'en' ? ASK_VERIFY_EN : ASK_VERIFY_HINGLISH); };

  const markUnread = async () => {
    if (!boxId || !mail) return;
    try {
      const r = await fetch('/api/mail/message', { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ box: boxId, uid: mail.uid, seen: false }) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); alertRef.current('error', d.error || 'Could not mark it unread.'); return; }
      setItems(prev => prev.map(x => x.uid === mail.uid ? { ...x, unread: true } : x));
      setOpenUid(null); setMail(null);
    } catch { alertRef.current('error', 'Could not mark it unread.'); }
  };

  const download = async (a: Att) => {
    if (!boxId || !mail) return;
    try {
      const r = await fetch(`/api/mail/attachment?box=${encodeURIComponent(boxId)}&uid=${mail.uid}&index=${a.index}`, { headers: auth });
      if (!r.ok) { const d = await r.json().catch(() => ({})); alertRef.current('error', d.error || 'Could not download that file.'); return; }
      const url = URL.createObjectURL(await r.blob());
      const el = document.createElement('a'); el.href = url; el.download = a.filename; document.body.appendChild(el); el.click(); el.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch { alertRef.current('error', 'Could not download that file.'); }
  };

  const send = async () => {
    if (!boxId || !mail || sending) return;
    setSending(true);
    try {
      const r = await fetch('/api/mail/send', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ box: boxId, uid: mail.uid, text: replyText }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { alertRef.current('error', d.error || 'The reply was not sent.'); return; }
      alertRef.current('success', `Reply sent to ${d.to}.`);
      setReplyOpen(false); setReplyText('');
      setItems(prev => prev.map(x => x.uid === mail.uid ? { ...x, answered: true } : x));
      setMail(m => m ? { ...m, answered: true } : m);
    } catch { alertRef.current('error', 'The reply was not sent.'); }
    finally { setSending(false); }
  };

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return items.filter(x => (filter === 'all' || (filter === 'unverified' ? !verified[x.fromAddress]?.length : x.unread) || x.uid === openUid)
      && (!t || x.subject.toLowerCase().includes(t) || x.from.toLowerCase().includes(t) || x.fromAddress.includes(t)));
  }, [items, filter, q, openUid, verified]);
  const unreadNow = items.filter(x => x.unread).length;
  const unverifiedNow = items.filter(x => !verified[x.fromAddress]?.length).length;
  const box = visibleBoxes.find(b => b.id === boxId) ?? null;
  const panelName = (boxes ?? []).find(b => b.panelId === activePanelId)?.panelName;

  if (boxes === null) return <div className="mail-empty"><Loader2 size={18} className="spin" /> Opening Mail…</div>;
  if (visibleBoxes.length === 0) {
    return (
      <div className="mail-empty">
        <MailIcon size={28} />
        <b>{down || (boxes.length === 0 ? 'No Gmail is connected yet.' : `No Gmail is connected to ${panelName || 'this panel'}.`)}</b>
        {!down && <span className="meta">{boxes.length === 0 ? 'The Super Admin connects a Gmail in Settings → panel → Email Support. Then it shows here.' : 'Switch the panel at the top left to see another panel’s Gmail, or connect one in Settings → Email Support.'}</span>}
      </div>
    );
  }

  return (
    <div className={`mail-wrap${openUid ? ' mail-open' : ''}`}>
      <section className="mail-list">
        <div className="mail-bar">
          {visibleBoxes.length > 1 ? (
            <select className="form-input" value={boxId ?? ''} onChange={e => setBoxId(e.target.value)} aria-label="Gmail inbox">
              {visibleBoxes.map(b => <option key={b.id} value={b.id}>{b.panelName} · {b.email}</option>)}
            </select>
          ) : <div className="mail-box-name" title={box?.email}>{box?.panelName} · {box?.email}</div>}
          <button type="button" className="btn btn-outline btn-sm" onClick={() => boxId && loadList(boxId)} disabled={loading} title="Read Gmail again">
            {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Refresh
          </button>
        </div>
        <div className="mail-bar">
          <button type="button" className="seg-btn" aria-pressed={filter === 'unread'} onClick={() => setFilter('unread')}>Unread{unreadNow ? ` (${unreadNow})` : ''}</button>
          <button type="button" className="seg-btn" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All 30 days{items.length ? ` (${items.length})` : ''}</button>
          <button type="button" className="seg-btn" aria-pressed={filter === 'unverified'} onClick={() => setFilter('unverified')} title="Senders nobody has verified with an Order ID and phone yet">Not verified{items.length ? ` (${unverifiedNow})` : ''}</button>
          <input className="form-input" style={{ flex: 1, minWidth: 0 }} placeholder="Search sender or subject" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        {box?.status && !box.status.ok && <div className="mail-warn">{box.status.error}</div>}
        {down && <div className="mail-warn">{down}</div>}
        <div className="mail-rows">
          {loading && items.length === 0 && <div className="mail-empty"><Loader2 size={16} className="spin" /> Reading Gmail…</div>}
          {!loading && !down && shown.length === 0 && (
            <div className="mail-empty">{items.length === 0 ? 'No mail in the last 30 days.' : filter === 'unread' ? 'No unread mail. Choose “All 30 days” to see the rest.' : 'Nothing matches.'}</div>
          )}
          {shown.map(m => (
            <button type="button" key={m.uid} className={`mail-row${m.unread ? ' unread' : ''}${openUid === m.uid ? ' active' : ''}`} onClick={() => openMail(m.uid)}>
              <span className="mail-from truncate">{m.unread && <i className="mail-dot" aria-label="unread" />}{m.from}{verified[m.fromAddress]?.length ? <BadgeCheck size={13} className="t-ok" aria-label="verified" /> : null}</span>
              <span className="mail-when">{when(m.date)}</span>
              <span className="mail-subj truncate">{m.subject}</span>
              <span className="mail-icons">{m.hasAttachment && <Paperclip size={12} />}{m.answered && <Reply size={12} />}</span>
            </button>
          ))}
          {meta?.truncated && <div className="meta" style={{ padding: '0.5rem 0.75rem' }}>Showing the newest 200 mails of the last 30 days.</div>}
        </div>
        {loadedAt && <div className="meta mail-foot">Read from Gmail {agoText(loadedAt)}. Nothing is stored here.</div>}
      </section>

      <section className="mail-reader">
        {!openUid && <div className="mail-empty"><MailOpen size={28} /> Choose a mail to read it.</div>}
        {openUid && (
          <>
            <button type="button" className="btn btn-ghost btn-sm mail-back" onClick={() => { setOpenUid(null); setMail(null); }}><ChevronLeft size={16} /> Back to the list</button>
            {opening && !mail && <div className="mail-empty"><Loader2 size={16} className="spin" /> Opening…</div>}
            {mail && (
              <>
                <header className="mail-head">
                  <h2>{mail.subject}</h2>
                  <div className="meta"><b>{mail.from}</b> · {new Date(mail.date).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</div>
                  <div className="meta">To: {mail.to || box?.email}{mail.cc ? ` · Cc: ${mail.cc}` : ''}</div>
                  <div className="mail-actions">
                    {canReply && <button type="button" className="btn btn-primary btn-sm" onClick={() => setReplyOpen(o => !o)}><Reply size={14} /> Reply</button>}
                    <button type="button" className="btn btn-outline btn-sm" onClick={markUnread}>Mark unread</button>
                    {mail.remoteImages && !mail.imagesShown && (
                      <button type="button" className="btn btn-outline btn-sm" title="Pictures from the internet tell the sender you opened the mail" onClick={() => openMail(mail.uid, true)}><ImageIcon size={14} /> Show images</button>
                    )}
                    {mail.answered && <span className="chip chip-muted">Replied</span>}
                  </div>
                </header>
                {/* Verification (owner 2026-10-08): ask for the Order ID + full phone, then verify the sender */}
                {(() => {
                  const vs = verified[mail.fromAddress] || [];
                  return vs.length > 0 ? (
                    <div className="mail-verify ok">
                      <BadgeCheck size={15} /> <span><b>Verified</b> · order {vs.map(v => v.orderId).join(', ')} · by {vs[0].byName || 'team'}</span>
                      {vs[0].chatId && <a className="btn btn-outline btn-sm" href={`/admin/chat?open=${encodeURIComponent(vs[0].chatId)}`}><MessageCircle size={13} /> Open chat</a>}
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setVerifyOpen(o => !o)}>Verify another order</button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => unverify(vs[0].orderId)} title="Only for a wrong click">Remove</button>
                    </div>
                  ) : (
                    <div className="mail-verify warn">
                      <ShieldQuestion size={15} /> <span><b>Not verified.</b> Ask for the Order ID and the full phone number, then verify.</span>
                      {canReply && <button type="button" className="btn btn-outline btn-sm" onClick={() => askVerify('en')}>Ask (English)</button>}
                      {canReply && <button type="button" className="btn btn-outline btn-sm" onClick={() => askVerify('hi')}>Ask (Hinglish)</button>}
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => setVerifyOpen(o => !o)}>Verify</button>
                    </div>
                  );
                })()}
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
                {mail.attachments.filter(a => !a.inline).length > 0 && (
                  <div className="mail-atts">
                    {mail.attachments.filter(a => !a.inline).map(a => (
                      <button type="button" key={a.index} className="btn btn-outline btn-sm" onClick={() => download(a)} title={a.contentType}>
                        <Download size={13} /> {a.filename} <span className="meta">{kb(a.size)}</span>
                      </button>
                    ))}
                  </div>
                )}
                {/* Scripts, forms and remote pictures are blocked twice: the sandbox and the policy inside the frame. */}
                <iframe className="mail-frame" title="Mail" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={mail.frame} />
                {replyOpen && (
                  <div className="mail-reply">
                    <div className="meta">Goes from <b>{box?.email}</b> to {mail.replyTo || mail.fromAddress}. Gmail keeps a copy in Sent.</div>
                    <textarea className="form-input" rows={6} value={replyText} onChange={e => setReplyText(e.target.value)} placeholder="Write your reply" maxLength={8000} autoFocus />
                    <div className="mail-actions">
                      <button type="button" className="btn btn-primary btn-sm" disabled={sending || !replyText.trim()} onClick={send}>
                        {sending ? <Loader2 size={14} className="spin" /> : <Send size={14} />} Send reply
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setReplyOpen(false); setReplyText(''); }}>Cancel</button>
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
