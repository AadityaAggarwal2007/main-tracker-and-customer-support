'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2, Check, AlertCircle, ShoppingBag, LogOut, Send, Mail,
  MessageCircle, User, Phone, Bot, Inbox, Paperclip, X, FileText,
  Download, ExternalLink, RotateCw, MoreHorizontal, Pencil, Trash2, Copy, Info,
} from 'lucide-react';
import { MAX_MESSAGE_LENGTH, canChangeMessage, senderLabel } from '@/lib/chat/message-rules';
import {
  ATTACHMENT_ACCEPT, MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_TOTAL_BYTES,
  TOO_MANY_MESSAGE, TOTAL_TOO_LARGE_MESSAGE, StoredAttachment, checkBrowserFile, formatFileSize,
} from '@/lib/chat/attachment-rules';

/* ═══════════ TYPES ═══════════ */
interface AuthUser { username: string; displayName: string; role: 'admin' | 'manager' | 'viewer'; businessIds: string[] | null; }
interface Business { id: string; name: string; }

interface Conversation {
  id: string;
  visitor_name: string | null;
  visitor_phone: string | null;
  status: 'ai_handling' | 'agent_handling' | 'resolved' | 'human_needed';
  source: 'chat' | 'email';
  category: 'wrong_tracking' | 'refund' | 'cancellation' | 'others';
  unread_count: number;
  last_message_at: string | null;
  created_at: string;
  site_id: string;
  site_name: string;
  tracker_business_id: string | null;
  panel_name: string | null;
  last_message: string | null;
}

interface ChatMessage {
  id: string;
  sender: 'visitor' | 'ai' | 'agent';
  content: string;
  metadata: {
    withheld?: string; emailed?: boolean; agent?: string; hidden?: boolean;
    attachments?: StoredAttachment[]; captionless?: boolean;
  } | null;
  created_at: string;
  edited_at?: string | null;
  edited_by?: string | null;
  deleted_at?: string | null;
  deleted_by?: string | null;
}

// What GET /api/chat/messages/:id returns for "View details".
interface MessageRevision {
  action: 'edit' | 'delete';
  previous_content: string;
  new_content: string | null;
  actor: string;
  actor_role: string;
  created_at: string;
}
interface MessageDetails {
  message: ChatMessage & { source: string };
  revisions: MessageRevision[];
  canChange: boolean;
}

// A file in the composer, from the moment it is picked until the reply is sent.
// It uploads straight away, so a failure shows on the file itself.
interface PendingFile {
  key: string;
  file: File;
  name: string;
  size: number;
  previewUrl: string | null;
  status: 'uploading' | 'ready' | 'failed';
  progress: number;
  error?: string;
  id?: string;
}

const STATUS_LABELS: Record<string, string> = {
  ai_handling: 'AI',
  agent_handling: 'You',
  resolved: 'Closed',
  human_needed: 'Needs you',
};

const STATUS_STYLE: Record<string, { bg: string; fg: string }> = {
  ai_handling: { bg: 'var(--primary-light)', fg: 'var(--primary)' },
  agent_handling: { bg: 'var(--primary)', fg: '#fff' },
  resolved: { bg: 'var(--bg-subtle, rgba(0,0,0,0.05))', fg: 'var(--fg-muted)' },
  human_needed: { bg: '#fee2e2', fg: '#b91c1c' },
};

const CATEGORY_LABELS: Record<string, string> = {
  wrong_tracking: 'Wrong tracking',
  refund: 'Refund',
  cancellation: 'Cancellation',
  others: '',
};

// An AI reply that was written but never sent — escalated to a person, or the
// send itself failed. The customer has not seen it.
const WITHHELD_LABELS: Record<string, string> = {
  escalated: 'needs a human',
  send_failed: 'sending failed',
  sending: 'still sending',
};

const POLL_MS = 3000;

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function renderWithLinks(text: string) {
  return text.split(/(https?:\/\/[^\s]+)/g).map((part, i) =>
    /^https?:\/\//.test(part)
      ? <a key={i} href={part} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline', wordBreak: 'break-all' }}>{part}</a>
      : <span key={i}>{part}</span>
  );
}

const draggingFiles = (e: { dataTransfer: DataTransfer | null }) =>
  !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

const fullDate = (iso: string) =>
  new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/* ═══════════ MANAGING A SENT MESSAGE ═══════════ */

// The ⋯ beside one of our messages and its menu. Edit and Delete appear only
// when this user may change the message; the API checks again regardless.
function MessageActions({ msg, open, up, canChange, onToggle, onEdit, onDelete, onCopy, onDetails }: {
  msg: ChatMessage; open: boolean; up: boolean; canChange: boolean;
  onToggle: (button: HTMLButtonElement) => void;
  onEdit: () => void; onDelete: () => void; onCopy: () => void; onDetails: () => void;
}) {
  const deleted = !!msg.deleted_at;
  const items: { label: string; icon: typeof Pencil; action: () => void; danger?: boolean }[] = [];
  if (canChange && !deleted) items.push({ label: 'Edit message', icon: Pencil, action: onEdit });
  if (canChange && !deleted) items.push({ label: 'Delete message', icon: Trash2, action: onDelete, danger: true });
  if (!deleted) items.push({ label: 'Copy message', icon: Copy, action: onCopy });
  items.push({ label: 'View details', icon: Info, action: onDetails });

  return (
    <div data-menu={msg.id} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        className="btn-icon msg-actions-btn"
        aria-label="Message actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={e => onToggle(e.currentTarget)}
        style={{ width: 24, height: 24, marginTop: 4 }}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div role="menu" style={{
          position: 'absolute', left: 0, zIndex: 20, minWidth: 176,
          ...(up ? { bottom: '100%', marginBottom: 4 } : { top: '100%', marginTop: 4 }),
          padding: '0.25rem', borderRadius: 'var(--radius)', background: 'var(--card-bg)',
          border: '1px solid var(--border)', boxShadow: 'var(--shadow-md)',
        }}>
          {items.map(item => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="msg-menu-item"
              onClick={item.action}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%', textAlign: 'left',
                padding: '0.4375rem 0.625rem', border: 'none', borderRadius: 6, background: 'transparent',
                cursor: 'pointer', fontSize: '0.8125rem',
                color: item.danger ? 'var(--danger)' : 'var(--fg)',
              }}
            >
              <item.icon size={14} /> {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// The message turned into a text box, in its own place in the thread.
function MessageEditor({ value, original, hasFiles, channel, saving, error, onChange, onCancel, onSave }: {
  value: string; original: string; hasFiles: boolean; channel: 'chat' | 'email';
  saving: boolean; error: string;
  onChange: (v: string) => void; onCancel: () => void; onSave: () => void;
}) {
  const trimmed = value.trim();
  const tooLong = trimmed.length > MAX_MESSAGE_LENGTH;
  const canSave = !saving && !tooLong && trimmed !== original.trim() && (trimmed !== '' || hasFiles);
  const lines = value.split('\n').length;

  // Opens with the cursor after the last word, ready to type.
  const boxRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, []);

  return (
    <div style={{ width: 520, maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
      <textarea
        ref={boxRef}
        className="form-input"
        value={value}
        disabled={saving}
        aria-label="Edit message"
        rows={Math.min(Math.max(lines, 3), 12)}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (canSave) onSave(); }
        }}
        style={{ height: 'auto', resize: 'vertical', padding: '0.5rem 0.75rem', fontSize: '0.8125rem', lineHeight: 1.5 }}
      />
      <p style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)' }}>
        {channel === 'email'
          ? 'This customer already has the original by email — saving changes it here and in the AI’s memory only.'
          : 'The customer’s chat shows the new text within a few seconds, marked Edited. They may already have read the original.'}
        {hasFiles && ' Attached files stay as they are.'}
      </p>
      {tooLong && (
        <p style={{ fontSize: '0.6875rem', color: 'var(--danger)' }}>
          A message can be at most {MAX_MESSAGE_LENGTH} characters.
        </p>
      )}
      {error && (
        <p role="alert" style={{ fontSize: '0.6875rem', color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
          <AlertCircle size={12} style={{ flexShrink: 0 }} /> {error}
        </p>
      )}
      <div style={{ display: 'flex', gap: '0.375rem', justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-outline btn-sm" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={onSave} disabled={!canSave}>
          {saving ? <><Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> Saving…</> : 'Save'}
        </button>
      </div>
    </div>
  );
}

function DeleteMessageDialog({ channel, busy, error, onCancel, onConfirm }: {
  channel: 'chat' | 'email'; busy: boolean; error: string;
  onCancel: () => void; onConfirm: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={() => { if (!busy) onCancel(); }}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-msg-title" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title" id="delete-msg-title">Delete this message?</div>
        </div>
        <p style={{ fontSize: '0.875rem', marginBottom: '0.5rem' }}>This message will be removed from the conversation.</p>
        <p style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', marginBottom: '1rem' }}>
          {channel === 'email'
            ? 'This customer already received it by email, and an email cannot be taken back. It is removed here and from the AI’s memory.'
            : 'It disappears from the customer’s chat within a few seconds. They may already have read it.'}
          {' '}The text stays in the message history.
        </p>
        {error && (
          <p role="alert" style={{ fontSize: '0.75rem', color: 'var(--danger)', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
            <AlertCircle size={12} style={{ flexShrink: 0 }} /> {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="btn" onClick={onConfirm} disabled={busy} style={{ background: 'var(--danger)', color: '#fff' }}>
            {busy ? <><Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> Deleting…</> : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

// "View details": who sent it, where it went, and every earlier version.
function MessageDetailsDialog({ details, error, onClose }: {
  details: MessageDetails | null; error: string; onClose: () => void;
}) {
  const row = (label: string, value: React.ReactNode) => (
    <div key={label} style={{ display: 'grid', gridTemplateColumns: '8.5rem 1fr', gap: '0.5rem', padding: '0.375rem 0', borderBottom: '1px solid var(--border)', fontSize: '0.8125rem' }}>
      <span style={{ color: 'var(--fg-muted)' }}>{label}</span>
      <span style={{ wordBreak: 'break-word' }}>{value}</span>
    </div>
  );

  let body: React.ReactNode;
  if (error) {
    body = <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.8125rem' }}>{error}</p>;
  } else if (!details) {
    body = <div style={{ textAlign: 'center', padding: '1.5rem' }}><Loader2 size={20} style={{ animation: 'spin 0.6s linear infinite' }} /></div>;
  } else {
    const m = details.message;
    const who = senderLabel(m);
    const email = m.source === 'email';
    const withheld = m.metadata?.withheld;
    const files = Array.isArray(m.metadata?.attachments) ? m.metadata!.attachments!.length : 0;

    const status = m.deleted_at ? 'Deleted' : withheld ? `Not sent — ${WITHHELD_LABELS[withheld] ?? 'held'}` : 'Sent';
    const delivery = withheld ? 'Never reached the customer'
      : m.deleted_at ? (email ? 'The customer still has it by email (an email cannot be taken back)' : 'Removed from the customer’s chat')
      : email ? (m.metadata?.emailed === true ? 'Sent by email' : m.metadata?.emailed === false ? 'The email did not go out' : 'Email result not recorded')
      : 'Shown in the customer’s chat';

    body = (
      <>
        <div style={{ marginBottom: '1rem' }}>
          {row('Message ID', <code style={{ fontSize: '0.75rem' }}>{m.id}</code>)}
          {row('Sender', who.who)}
          {row('Sender type', `${who.type} · ${who.origin}`)}
          {row('Created', fullDate(m.created_at))}
          {row('Channel', email ? 'Email' : 'Chat widget')}
          {row('Status', status)}
          {row('Delivery', delivery)}
          {row('Read by customer', 'Not tracked')}
          {row('Edited', m.edited_at
            ? `Yes — last by ${m.edited_by || 'unknown'}, ${fullDate(m.edited_at)}${email ? ' (here only; the email is unchanged)' : ''}`
            : 'No')}
          {m.deleted_at && row('Deleted', `By ${m.deleted_by || 'unknown'}, ${fullDate(m.deleted_at)}`)}
          {files > 0 && row('Attachments', `${files} file${files === 1 ? '' : 's'}`)}
        </div>

        <div style={{ fontWeight: 600, fontSize: '0.8125rem', marginBottom: '0.5rem' }}>History</div>
        {details.revisions.length === 0 ? (
          <p style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>Never changed since it was sent.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {details.revisions.map((r, i) => (
              <div key={i} style={{ fontSize: '0.75rem' }}>
                <div style={{ color: 'var(--fg-muted)', marginBottom: '0.25rem' }}>
                  {r.action === 'delete' ? 'Deleted' : 'Edited'} by {r.actor} ({r.actor_role}) · {fullDate(r.created_at)}
                </div>
                <div style={{ padding: '0.5rem 0.625rem', borderRadius: 8, background: 'var(--bg-subtle)', border: '1px solid var(--border)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  <span style={{ color: 'var(--fg-muted)' }}>{i === 0 ? (m.sender === 'ai' ? 'Original (AI): ' : 'Original: ') : 'Before: '}</span>
                  {r.previous_content}
                </div>
                {r.action === 'edit' && r.new_content !== null && (
                  <div style={{ marginTop: '0.25rem', padding: '0.5rem 0.625rem', borderRadius: 8, border: '1px solid var(--border)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    <span style={{ color: 'var(--fg-muted)' }}>After: </span>{r.new_content}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg" role="dialog" aria-modal="true" aria-labelledby="msg-details-title" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title" id="msg-details-title">Message details</div>
          <button type="button" className="btn-icon" aria-label="Close" onClick={onClose}><X size={16} /></button>
        </div>
        {body}
      </div>
    </div>
  );
}

// Files inside a sent message: images as clickable previews, anything else as a
// card with open and download links.
function MessageAttachments({ files, onImageLoad }: {
  files: StoredAttachment[];
  onImageLoad?: (img: HTMLImageElement) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem', whiteSpace: 'normal' }}>
      {files.map(f => f.kind === 'image' ? (
        <a key={f.id} href={f.url} target="_blank" rel="noopener noreferrer" title={f.name} style={{ display: 'block', lineHeight: 0 }}>
          <img
            src={f.url} alt={f.name} loading="lazy"
            onLoad={e => onImageLoad?.(e.currentTarget)}
            style={{ display: 'block', width: 220, maxWidth: '100%', height: 'auto', maxHeight: 240, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--muted)' }}
          />
        </a>
      ) : (
        <div key={f.id} style={{
          display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0, maxWidth: 280,
          padding: '0.5rem 0.625rem', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)',
        }}>
          <FileText size={18} style={{ color: 'var(--primary)', flexShrink: 0 }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <a href={f.url} target="_blank" rel="noopener noreferrer" title={f.name} style={{
              display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--fg)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {f.name}
            </a>
            <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)' }}>{formatFileSize(f.size)}</div>
          </div>
          <a href={f.url} target="_blank" rel="noopener noreferrer" className="btn-icon" title="Open" aria-label={`Open ${f.name}`} style={{ width: 28, height: 28 }}>
            <ExternalLink size={14} />
          </a>
          <a href={`${f.url}?download=1`} className="btn-icon" title="Download" aria-label={`Download ${f.name}`} style={{ width: 28, height: 28 }}>
            <Download size={14} />
          </a>
        </div>
      ))}
    </div>
  );
}

export default function ChatSupportPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState('');

  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [activePanelId, setActivePanelId] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeConv, setActiveConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [alert, setAlert] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const [menu, setMenu] = useState<{ id: string; up: boolean } | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string; saving: boolean; error: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; busy: boolean; error: string } | null>(null);
  const [details, setDetails] = useState<{ id: string; data: MessageDetails | null; error: string } | null>(null);

  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [fileError, setFileError] = useState('');
  const [sendBlocked, setSendBlocked] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const pendingRef = useRef<PendingFile[]>([]);
  pendingRef.current = pendingFiles;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadsRef = useRef(new Map<string, XMLHttpRequest>());
  const dragDepthRef = useRef(0);
  const composerRef = useRef<HTMLDivElement>(null);
  const fileKeyRef = useRef(0);

  const showAlert = (type: 'success' | 'error', message: string) => {
    setAlert({ type, message });
    setTimeout(() => setAlert(null), 4000);
  };

  /* ═══ AUTH ═══ */
  useEffect(() => {
    const t = localStorage.getItem('auth_token');
    const u = localStorage.getItem('auth_user');
    if (!t || !u) { router.push('/login'); return; }
    setToken(t);
    setUser(JSON.parse(u));
    setActivePanelId(localStorage.getItem('active_panel_id') || '');
    // An expired token, or one from before tokens were signed, is refused by
    // every API — send the person to log in again instead of showing nothing.
    fetch('/api/auth/session', { headers: { Authorization: `Bearer ${t}` } })
      .then(res => {
        if (res.status !== 401) return;
        localStorage.removeItem('auth_token');
        localStorage.removeItem('auth_user');
        router.push('/login');
      })
      .catch(() => { /* offline: leave the page as it is */ });
  }, [router]);

  /* ═══ PANELS ═══ */
  useEffect(() => {
    if (!token) return;
    fetch('/api/businesses', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setBusinesses(d.businesses || []))
      .catch(() => {});
  }, [token]);

  /* ═══ CONVERSATION LIST ═══ */
  const fetchConversations = useCallback(async (quiet = false) => {
    if (!token) return;
    if (!quiet) setLoadingList(true);
    try {
      const params = new URLSearchParams();
      if (activePanelId) params.set('businessId', activePanelId);
      if (statusFilter) params.set('status', statusFilter);
      const res = await fetch(`/api/chat/conversations?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (res.ok) setConversations(data.conversations || []);
    } catch { /* keep the last good list */ }
    finally { if (!quiet) setLoadingList(false); }
  }, [token, activePanelId, statusFilter]);

  useEffect(() => { fetchConversations(); }, [fetchConversations]);

  /* ═══ OPEN THREAD ═══ */
  const fetchThread = useCallback(async (id: string, quiet = false) => {
    if (!token) return;
    try {
      const res = await fetch(`/api/chat/conversations/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) { if (!quiet) showAlert('error', data.error || 'Could not open that conversation'); return; }
      setActiveConv(data.conversation);
      setMessages(data.messages || []);
    } catch { /* keep what is on screen */ }
  }, [token]);

  useEffect(() => {
    if (activeId) fetchThread(activeId);
    else { setActiveConv(null); setMessages([]); }
  }, [activeId, fetchThread]);

  /* ═══ POLLING ═══ */
  // There is no websocket in ShipTrack — the inbox asks again every few
  // seconds instead, and stops entirely while the tab is in the background.
  useEffect(() => {
    if (!token) return;
    const tick = () => {
      if (document.hidden) return;
      fetchConversations(true);
      if (activeIdRef.current) fetchThread(activeIdRef.current, true);
    };
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [token, fetchConversations, fetchThread]);

  const pinUntilRef = useRef(0);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    pinUntilRef.current = Date.now() + 2000;
  }, [messages.length]);

  // An image has no height until it loads, so the scroll above stops short of
  // it. Follow it down while that scroll is still settling, or if the agent is
  // at the bottom anyway — not when they have scrolled up to read.
  const keepThreadPinned = (img: HTMLImageElement) => {
    const box = threadRef.current;
    if (!box) return;
    const gap = box.scrollHeight - box.scrollTop - box.clientHeight;
    if (Date.now() < pinUntilRef.current || gap <= img.offsetHeight + 80) {
      bottomRef.current?.scrollIntoView();
    }
  };

  /* ═══ ACTIONS ═══ */
  const changeStatus = async (status: string) => {
    if (!activeId) return;
    try {
      const res = await fetch(`/api/chat/conversations/${activeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status }),
      });
      if (res.ok) {
        setActiveConv(c => (c ? { ...c, status: status as Conversation['status'] } : c));
        fetchConversations(true);
      } else {
        const d = await res.json();
        showAlert('error', d.error || 'Could not update that conversation');
      }
    } catch { showAlert('error', 'Could not update that conversation'); }
  };

  /* ═══ ATTACHMENTS ═══ */
  const updateFile = (key: string, patch: Partial<PendingFile>) =>
    setPendingFiles(list => list.map(p => (p.key === key ? { ...p, ...patch } : p)));

  // XMLHttpRequest rather than fetch, because only it reports upload progress.
  const uploadFile = useCallback((key: string, file: File, conversationId: string) => {
    const xhr = new XMLHttpRequest();
    uploadsRef.current.set(key, xhr);

    const form = new FormData();
    form.append('conversationId', conversationId);
    form.append('file', file);

    xhr.upload.onprogress = e => {
      if (e.lengthComputable) updateFile(key, { progress: Math.round((e.loaded / e.total) * 100) });
    };
    xhr.onload = () => {
      uploadsRef.current.delete(key);
      let data: { attachment?: { id: string; name: string }; error?: string } | null = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON, e.g. a proxy error page */ }
      if (xhr.status >= 200 && xhr.status < 300 && data?.attachment?.id) {
        updateFile(key, { status: 'ready', progress: 100, id: data.attachment.id, name: data.attachment.name, error: undefined });
      } else {
        updateFile(key, {
          status: 'failed',
          error: data?.error || (xhr.status === 413 ? 'File size exceeds the allowed limit.' : 'Upload failed'),
        });
      }
    };
    xhr.onerror = () => {
      uploadsRef.current.delete(key);
      updateFile(key, { status: 'failed', error: 'Upload failed — check your connection' });
    };
    xhr.onabort = () => { uploadsRef.current.delete(key); };

    xhr.open('POST', '/api/chat/attachments');
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.send(form);
  }, [token]);

  const forgetFile = (p: PendingFile, deleteUpload: boolean) => {
    uploadsRef.current.get(p.key)?.abort();
    if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    if (deleteUpload && p.id) {
      fetch(`/api/chat/attachments/${p.id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      }).catch(() => { /* an unsent upload is cleared after a day anyway */ });
    }
  };

  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    if (!activeId || activeConv?.status !== 'agent_handling') {
      setFileError('Take over the conversation to attach files.');
      return;
    }
    if (sending) {
      setFileError('Wait for the reply to finish sending.');
      return;
    }

    const problems: string[] = [];
    const added: PendingFile[] = [];
    let count = pendingRef.current.length;
    let total = pendingRef.current.reduce((n, p) => n + p.size, 0);

    for (const file of files) {
      const problem = checkBrowserFile(file)
        ?? (count >= MAX_ATTACHMENTS_PER_MESSAGE ? TOO_MANY_MESSAGE : null)
        ?? (total + file.size > MAX_ATTACHMENT_TOTAL_BYTES ? TOTAL_TOO_LARGE_MESSAGE : null);
      if (problem) { problems.push(`${file.name}: ${problem}`); continue; }

      count += 1;
      total += file.size;
      added.push({
        key: `f${++fileKeyRef.current}`,
        file,
        name: file.name,
        size: file.size,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
        status: 'uploading',
        progress: 0,
      });
    }

    setFileError(problems.join(' · '));
    if (added.length > 0) {
      setPendingFiles(list => [...list, ...added]);
      added.forEach(p => uploadFile(p.key, p.file, activeId));
    }
  };

  const removeFile = (key: string) => {
    const p = pendingRef.current.find(x => x.key === key);
    if (p) forgetFile(p, true);
    setPendingFiles(list => list.filter(x => x.key !== key));
    setFileError('');
  };

  const retryFile = (key: string) => {
    const p = pendingRef.current.find(x => x.key === key);
    if (!p || p.status !== 'failed' || !activeId) return;
    updateFile(key, { status: 'uploading', progress: 0, error: undefined });
    uploadFile(key, p.file, activeId);
  };

  // Files are uploaded against one conversation, so they do not follow the
  // agent to another one.
  useEffect(() => {
    pendingRef.current.forEach(p => forgetFile(p, true));
    setPendingFiles([]);
    setFileError('');
    setSendBlocked(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  useEffect(() => () => {
    pendingRef.current.forEach(p => forgetFile(p, false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A file dropped anywhere else on the page would make the browser open it
  // and leave the inbox.
  useEffect(() => {
    const keepPage = (e: DragEvent) => {
      if (!draggingFiles(e)) return;
      e.preventDefault();
      // Only the composer takes files; everywhere else shows a no-drop cursor.
      if (e.type === 'dragover' && e.dataTransfer && !composerRef.current?.contains(e.target as Node)) {
        e.dataTransfer.dropEffect = 'none';
      }
      if (e.type === 'drop') { dragDepthRef.current = 0; setDragOver(false); }
    };
    window.addEventListener('dragover', keepPage);
    window.addEventListener('drop', keepPage);
    return () => {
      window.removeEventListener('dragover', keepPage);
      window.removeEventListener('drop', keepPage);
    };
  }, []);

  const sendReply = async () => {
    if (!activeId || sending) return;
    const text = draft.trim();
    const files = pendingRef.current;
    // Enter still works while a file is not ready; it explains instead of sending.
    if (files.some(p => p.status !== 'ready')) { setSendBlocked(true); return; }
    if (!text && files.length === 0) return;

    setSending(true);
    try {
      const res = await fetch('/api/chat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          conversationId: activeId,
          content: text,
          ...(files.length > 0 ? { attachmentIds: files.map(p => p.id) } : {}),
        }),
      });
      const data = await res.json();
      // On failure the text and files stay in the composer, ready to send again.
      if (!res.ok) { showAlert('error', data.error || 'Could not send that reply'); return; }

      setDraft('');
      const sentKeys = new Set(files.map(p => p.key));
      files.forEach(p => forgetFile(p, false));
      setPendingFiles(list => list.filter(p => !sentKeys.has(p.key)));
      setFileError('');
      setSendBlocked(false);
      if (data.emailed === false) {
        showAlert('error', 'Saved, but the email did not go out — check the mailbox settings');
      }
      await fetchThread(activeId, true);
      fetchConversations(true);
    } catch { showAlert('error', 'Could not send that reply'); }
    finally { setSending(false); }
  };

  /* ═══ MANAGING A SENT MESSAGE ═══ */
  // Open message tools belong to the conversation they were opened in.
  useEffect(() => {
    setMenu(null);
    setEditing(null);
    setDeleting(null);
    setDetails(null);
  }, [activeId]);

  // The ⋯ menu closes on a click anywhere else or on Escape.
  useEffect(() => {
    if (!menu) return;
    const onPointer = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.(`[data-menu="${menu.id}"]`)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const toggleMenu = (id: string, button: HTMLButtonElement) => {
    if (menu?.id === id) { setMenu(null); return; }
    // Near the bottom of the thread the menu opens upwards, so it is not cut off.
    const box = threadRef.current?.getBoundingClientRect();
    const up = !!box && box.bottom - button.getBoundingClientRect().bottom < 190;
    setMenu({ id, up });
  };

  const replaceMessage = (updated: ChatMessage) =>
    setMessages(list => list.map(m => (m.id === updated.id ? { ...m, ...updated } : m)));

  const messageText = (msg: ChatMessage) => {
    const files = Array.isArray(msg.metadata?.attachments) ? msg.metadata!.attachments! : [];
    return files.length > 0 && msg.metadata?.captionless ? '' : msg.content;
  };

  const startEdit = (msg: ChatMessage) => {
    setMenu(null);
    setEditing({ id: msg.id, text: messageText(msg), saving: false, error: '' });
  };

  const saveEdit = async () => {
    if (!editing || editing.saving) return;
    const { id, text } = editing;
    setEditing(e => (e && e.id === id ? { ...e, saving: true, error: '' } : e));
    const failed = (reason?: string) =>
      setEditing(e => (e && e.id === id ? { ...e, saving: false, error: reason || 'Unable to update message. Please try again.' } : e));
    try {
      const res = await fetch(`/api/chat/messages/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content: text }),
      });
      const data = await res.json().catch(() => ({}));
      // The typed text stays in the editor on any failure.
      if (!res.ok) { failed(res.status < 500 && data.error ? `Unable to update message: ${data.error}` : undefined); return; }
      replaceMessage(data.message);
      // Only this message's editor closes; another one opened meanwhile stays.
      setEditing(e => (e && e.id === id ? null : e));
      showAlert('success', 'Message updated');
      fetchConversations(true);
    } catch { failed(); }
  };

  const confirmDelete = async () => {
    if (!deleting || deleting.busy) return;
    const { id } = deleting;
    setDeleting(d => (d ? { ...d, busy: true, error: '' } : d));
    try {
      const res = await fetch(`/api/chat/messages/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDeleting(d => (d ? {
          ...d, busy: false,
          error: res.status < 500 && data.error ? `Unable to delete message: ${data.error}` : 'Unable to delete message. Please try again.',
        } : d));
        return;
      }
      replaceMessage(data.message);
      if (editing?.id === id) setEditing(null);
      setDeleting(null);
      showAlert('success', 'Message deleted');
      fetchConversations(true);
    } catch {
      setDeleting(d => (d ? { ...d, busy: false, error: 'Unable to delete message. Please try again.' } : d));
    }
  };

  const copyMessage = async (msg: ChatMessage) => {
    setMenu(null);
    const files = Array.isArray(msg.metadata?.attachments) ? msg.metadata!.attachments! : [];
    const text = messageText(msg) || files.map(f => `${f.name} ${window.location.origin}${f.url}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      showAlert('success', 'Message copied');
    } catch {
      showAlert('error', 'Could not copy — select the text and copy it instead');
    }
  };

  const openDetails = async (id: string) => {
    setMenu(null);
    setDetails({ id, data: null, error: '' });
    try {
      const res = await fetch(`/api/chat/messages/${id}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => ({}));
      setDetails(d => (d && d.id === id
        ? (res.ok ? { ...d, data } : { ...d, error: data.error || 'Could not load the details' })
        : d));
    } catch {
      setDetails(d => (d && d.id === id ? { ...d, error: 'Could not load the details' } : d));
    }
  };

  const logout = () => {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
    router.push('/login');
  };

  if (!user) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <Loader2 size={32} style={{ animation: 'spin 0.6s linear infinite' }} />
      </div>
    );
  }

  const canReply = user.role !== 'viewer';
  const unreadTotal = conversations.reduce((n, c) => n + (c.unread_count || 0), 0);
  // Worked out from the files each time, so it goes away as soon as they are ready.
  const sendHint = !sendBlocked ? ''
    : pendingFiles.some(p => p.status === 'uploading') ? 'Wait for the files to finish uploading.'
    : pendingFiles.some(p => p.status === 'failed') ? 'Retry or remove the file that failed before sending.'
    : '';
  const composerNotice = [fileError, sendHint].filter(Boolean).join(' · ');

  return (
    <div className="admin-layout">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div style={{ padding: '1rem', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--primary)', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
            <MessageCircle size={15} /> Chat Support
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--fg-muted)', marginTop: '0.25rem' }}>
            {unreadTotal > 0 ? `${unreadTotal} unread` : 'Chat and email in one place'}
          </div>
        </div>

        {/* Panel selector */}
        <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)' }}>
          <label style={{ fontSize: '0.7rem', color: 'var(--fg-muted)', fontWeight: 600 }}>PANEL</label>
          <select
            value={activePanelId}
            onChange={e => {
              setActivePanelId(e.target.value);
              localStorage.setItem('active_panel_id', e.target.value);
              setActiveId(null);
            }}
            style={{ width: '100%', marginTop: '0.25rem', padding: '0.375rem', borderRadius: 6, border: '1px solid var(--border)', fontSize: '0.8125rem', background: 'var(--card-bg)', color: 'var(--fg)' }}
          >
            <option value="">All panels</option>
            {businesses
              .filter(b => !user.businessIds || user.businessIds.includes(b.id))
              .map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>

        {/* Status filters */}
        <nav style={{ padding: '0.5rem' }}>
          {([
            { v: '', label: 'All', icon: Inbox },
            { v: 'human_needed', label: 'Needs you', icon: AlertCircle },
            { v: 'agent_handling', label: 'You are on it', icon: User },
            { v: 'ai_handling', label: 'AI handling', icon: Bot },
            { v: 'resolved', label: 'Closed', icon: Check },
          ] as const).map(s => (
            <button
              key={s.v || 'all'}
              onClick={() => { setStatusFilter(s.v); setActiveId(null); }}
              className={`nav-btn ${statusFilter === s.v ? 'active' : ''}`}
              style={{ width: '100%' }}
            >
              <s.icon size={16} /> {s.label}
            </button>
          ))}
        </nav>

        <div style={{ marginTop: 'auto', padding: '0.75rem' }}>
          <button className="nav-btn" onClick={() => router.push('/admin')} style={{ width: '100%' }}>
            <ShoppingBag size={16} /> Back to Orders
          </button>
          <button className="nav-btn" onClick={logout} style={{ width: '100%', marginTop: '0.25rem' }}>
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="main-content">
        {alert && (
          <div className={`toast toast-${alert.type}`} style={{ position: 'fixed', top: '1rem', right: '1rem', zIndex: 9999 }}>
            {alert.type === 'success' ? <Check size={16} /> : <AlertCircle size={16} />}
            {alert.message}
          </div>
        )}

        <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
          {/* Conversation list */}
          <div style={{ width: 320, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
            <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid var(--border)', fontWeight: 700, fontSize: '0.875rem' }}>
              Conversations
              <span style={{ color: 'var(--fg-muted)', fontWeight: 400, marginLeft: '0.375rem', fontSize: '0.75rem' }}>
                {conversations.length}
              </span>
            </div>

            <div style={{ flex: 1, overflowY: 'auto' }}>
              {loadingList && conversations.length === 0 && (
                <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--fg-muted)' }}>
                  <Loader2 size={20} style={{ animation: 'spin 0.6s linear infinite' }} />
                </div>
              )}

              {!loadingList && conversations.length === 0 && (
                <div style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--fg-muted)', fontSize: '0.8125rem' }}>
                  <Inbox size={28} style={{ opacity: 0.25, marginBottom: '0.5rem' }} />
                  <p>Nothing here yet.</p>
                  <p style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                    Chats from the widget and email to a connected mailbox both land here.
                  </p>
                </div>
              )}

              {conversations.map(c => (
                <button
                  key={c.id}
                  onClick={() => setActiveId(c.id)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                    padding: '0.75rem 1rem', border: 'none',
                    borderBottom: '1px solid var(--border)',
                    borderLeft: activeId === c.id ? '3px solid var(--primary)' : '3px solid transparent',
                    background: activeId === c.id ? 'var(--primary-light)' : 'transparent',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginBottom: '0.25rem' }}>
                    {c.source === 'email' ? <Mail size={12} style={{ color: 'var(--fg-muted)' }} /> : <MessageCircle size={12} style={{ color: 'var(--fg-muted)' }} />}
                    <span style={{ fontWeight: 600, fontSize: '0.8125rem', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.visitor_name || 'Visitor'}
                    </span>
                    {c.unread_count > 0 && (
                      <span style={{ background: 'var(--danger)', color: '#fff', borderRadius: 9999, fontSize: '0.625rem', padding: '1px 6px', fontWeight: 700 }}>
                        {c.unread_count}
                      </span>
                    )}
                    <span style={{
                      fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600,
                      background: STATUS_STYLE[c.status]?.bg, color: STATUS_STYLE[c.status]?.fg,
                    }}>
                      {STATUS_LABELS[c.status]}
                    </span>
                  </div>

                  <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginBottom: '0.25rem', display: 'flex', gap: '0.375rem' }}>
                    <span>{c.panel_name || c.site_name}</span>
                    {CATEGORY_LABELS[c.category] && (
                      <><span>·</span><span>{CATEGORY_LABELS[c.category]}</span></>
                    )}
                  </div>

                  <div style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.last_message || '—'}
                  </div>
                  <div style={{ fontSize: '0.625rem', color: 'var(--fg-muted)', marginTop: '0.25rem' }}>
                    {timeAgo(c.last_message_at)}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Thread */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            {!activeConv && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-muted)' }}>
                <MessageCircle size={40} style={{ opacity: 0.2, marginBottom: '0.75rem' }} />
                <p style={{ fontWeight: 600 }}>Pick a conversation</p>
                <p style={{ fontSize: '0.8125rem' }}>Chats and emails both appear on the left.</p>
              </div>
            )}

            {activeConv && (
              <>
                {/* Thread header */}
                <div style={{ padding: '0.875rem 1.25rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{ fontWeight: 700 }}>{activeConv.visitor_name || 'Visitor'}</span>
                      <span style={{
                        fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600,
                        display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
                        background: 'var(--primary-light)', color: 'var(--primary)',
                      }}>
                        {activeConv.source === 'email' ? <><Mail size={10} /> Email</> : <><MessageCircle size={10} /> Chat</>}
                      </span>
                      <span style={{
                        fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600,
                        background: STATUS_STYLE[activeConv.status]?.bg, color: STATUS_STYLE[activeConv.status]?.fg,
                      }}>
                        {STATUS_LABELS[activeConv.status]}
                      </span>
                    </div>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginTop: '0.125rem', display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
                      <span>{activeConv.panel_name || activeConv.site_name}</span>
                      {activeConv.visitor_phone && (
                        <>
                          <span>·</span>
                          <a href={`tel:${activeConv.visitor_phone}`} style={{ color: 'var(--primary)', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                            <Phone size={10} /> {activeConv.visitor_phone}
                          </a>
                        </>
                      )}
                    </div>
                  </div>

                  {canReply && (
                    <div style={{ display: 'flex', gap: '0.375rem', flexShrink: 0 }}>
                      {activeConv.status !== 'agent_handling' && (
                        <button className="btn btn-primary btn-sm" onClick={() => changeStatus('agent_handling')}>Take over</button>
                      )}
                      {activeConv.status === 'agent_handling' && (
                        <button className="btn btn-outline btn-sm" onClick={() => changeStatus('ai_handling')}>Hand to AI</button>
                      )}
                      {activeConv.status !== 'resolved' && (
                        <button className="btn btn-outline btn-sm" onClick={() => changeStatus('resolved')}>Close</button>
                      )}
                    </div>
                  )}
                </div>

                {/* Messages */}
                <div ref={threadRef} style={{ flex: 1, overflowY: 'auto', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {messages.map(msg => {
                    const mine = msg.sender !== 'visitor';
                    const deleted = !!msg.deleted_at;
                    const withheld = msg.metadata?.withheld;
                    const attached = msg.metadata?.attachments;
                    const files = Array.isArray(attached) ? attached : [];
                    // A files-only reply carries a text stand-in for older views; the files say it here.
                    const showText = !(files.length > 0 && msg.metadata?.captionless);
                    const isEditing = mine && !deleted && editing?.id === msg.id;

                    // A deleted message stays in the inbox as a marker, so the team can
                    // see something was removed; its text is under View details.
                    const bubble = (
                      <div style={{
                        padding: '0.625rem 0.875rem', borderRadius: 12, fontSize: '0.8125rem', lineHeight: 1.5,
                        whiteSpace: 'pre-wrap', wordBreak: 'break-word', minWidth: 0,
                        background: msg.sender === 'visitor' ? 'var(--primary)' : 'var(--card-bg)',
                        color: msg.sender === 'visitor' ? '#fff' : 'var(--fg)',
                        border: withheld ? '1px dashed #f59e0b' : '1px solid var(--border)',
                        opacity: withheld ? 0.65 : 1,
                        ...(deleted ? { background: 'transparent', color: 'var(--fg-muted)', fontStyle: 'italic', border: '1px dashed var(--border)', opacity: 1 } : {}),
                      }}>
                        {deleted ? 'This message was deleted' : (
                          <>
                            {files.length > 0 && <MessageAttachments files={files} onImageLoad={keepThreadPinned} />}
                            {files.length > 0 && showText && <div style={{ height: '0.5rem' }} />}
                            {showText && renderWithLinks(msg.content)}
                          </>
                        )}
                      </div>
                    );

                    return (
                      <div key={msg.id} className={mine ? 'msg-row' : undefined} style={{
                        alignSelf: mine ? 'flex-start' : 'flex-end',
                        maxWidth: '72%', display: 'flex', flexDirection: 'column',
                        alignItems: mine ? 'flex-start' : 'flex-end',
                      }}>
                        <span style={{ fontSize: '0.625rem', color: 'var(--fg-muted)', marginBottom: '0.25rem' }}>
                          {msg.sender === 'visitor' ? 'Customer' : msg.sender === 'agent' ? 'You' : 'AI'}
                        </span>
                        {!mine ? bubble : (
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.25rem', maxWidth: '100%' }}>
                            {isEditing && editing ? (
                              <MessageEditor
                                value={editing.text}
                                original={messageText(msg)}
                                hasFiles={files.length > 0}
                                channel={activeConv.source === 'email' ? 'email' : 'chat'}
                                saving={editing.saving}
                                error={editing.error}
                                onChange={text => setEditing(e => (e ? { ...e, text } : e))}
                                onCancel={() => setEditing(null)}
                                onSave={saveEdit}
                              />
                            ) : (
                              <>
                                {bubble}
                                <MessageActions
                                  msg={msg}
                                  open={menu?.id === msg.id}
                                  up={!!menu?.up}
                                  canChange={canChangeMessage(user, msg)}
                                  onToggle={button => toggleMenu(msg.id, button)}
                                  onEdit={() => startEdit(msg)}
                                  onDelete={() => { setMenu(null); setDeleting({ id: msg.id, busy: false, error: '' }); }}
                                  onCopy={() => copyMessage(msg)}
                                  onDetails={() => openDetails(msg.id)}
                                />
                              </>
                            )}
                          </div>
                        )}
                        {withheld && !deleted && (
                          <span style={{
                            fontSize: '0.625rem', color: '#b45309', background: '#fffbeb',
                            border: '1px solid #fde68a', borderRadius: 4, padding: '1px 6px', marginTop: '0.25rem',
                          }}>
                            Not sent — {WITHHELD_LABELS[withheld] ?? 'held for you'}
                          </span>
                        )}
                        <span style={{ fontSize: '0.625rem', color: 'var(--fg-muted)', marginTop: '0.25rem' }}>
                          {new Date(msg.created_at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                          {msg.edited_at && !deleted && (
                            <span title={`Edited by ${msg.edited_by || 'unknown'}, ${fullDate(msg.edited_at)}`}> · Edited</span>
                          )}
                          {deleted && ` · Deleted${msg.deleted_by ? ` by ${msg.deleted_by}` : ''}`}
                        </span>
                      </div>
                    );
                  })}
                  <div ref={bottomRef} />
                </div>

                {/* Composer */}
                {activeConv.status !== 'resolved' && canReply && (
                  <div
                    ref={composerRef}
                    style={{ borderTop: '1px solid var(--border)', padding: '0.75rem 1rem', position: 'relative' }}
                    onDragEnter={e => {
                      if (!draggingFiles(e)) return;
                      e.preventDefault();
                      dragDepthRef.current += 1;
                      setDragOver(true);
                    }}
                    onDragOver={e => {
                      if (!draggingFiles(e)) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'copy';
                    }}
                    onDragLeave={e => {
                      if (!draggingFiles(e)) return;
                      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
                      if (dragDepthRef.current === 0) setDragOver(false);
                    }}
                    onDrop={e => {
                      if (!draggingFiles(e)) return;
                      e.preventDefault();
                      dragDepthRef.current = 0;
                      setDragOver(false);
                      addFiles(Array.from(e.dataTransfer.files));
                    }}
                  >
                    {dragOver && (
                      <div style={{
                        position: 'absolute', inset: '0.375rem', zIndex: 2, pointerEvents: 'none',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem',
                        border: '1.5px dashed var(--primary)', borderRadius: 'var(--radius-lg)',
                        background: 'var(--primary-light)', color: 'var(--primary)',
                        fontSize: '0.8125rem', fontWeight: 600,
                      }}>
                        <Paperclip size={15} />
                        {activeConv.status === 'agent_handling' ? 'Drop file here' : 'Take over to attach files'}
                      </div>
                    )}
                    {activeConv.status !== 'agent_handling' && (
                      <p style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginBottom: '0.5rem' }}>
                        {activeConv.status === 'human_needed'
                          ? 'This one is waiting on a person — take over to reply.'
                          : 'The AI is handling this — take over to reply yourself.'}
                      </p>
                    )}
                    {pendingFiles.length > 0 && (
                      <div style={{ display: 'flex', gap: '0.5rem', overflowX: 'auto', paddingBottom: '0.5rem', scrollbarWidth: 'thin' }}>
                        {pendingFiles.map(p => (
                          <div key={p.key} style={{
                            position: 'relative', flex: '0 0 auto', width: 210, maxWidth: '100%', overflow: 'hidden',
                            display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.375rem 0.375rem 0.375rem 0.5rem',
                            borderRadius: 'var(--radius)',
                            border: `1px solid ${p.status === 'failed' ? 'var(--danger)' : 'var(--border)'}`,
                            background: p.status === 'failed' ? 'var(--danger-light)' : 'var(--bg-subtle)',
                          }}>
                            {p.previewUrl ? (
                              <img src={p.previewUrl} alt="" style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />
                            ) : (
                              <div style={{
                                width: 36, height: 36, borderRadius: 6, flexShrink: 0,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                background: 'var(--primary-light)', color: 'var(--primary)',
                              }}>
                                <FileText size={18} />
                              </div>
                            )}
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div title={p.name} style={{ fontSize: '0.75rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {p.name}
                              </div>
                              <div title={p.error} style={{
                                fontSize: '0.6875rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                color: p.status === 'failed' ? 'var(--danger)' : 'var(--fg-muted)',
                              }}>
                                {p.status === 'uploading' ? `Uploading… ${p.progress}%`
                                  : p.status === 'failed' ? p.error
                                  : formatFileSize(p.size)}
                              </div>
                            </div>
                            {p.status === 'failed' && (
                              <button type="button" className="btn-icon" title="Try again" aria-label={`Retry ${p.name}`}
                                onClick={() => retryFile(p.key)} style={{ width: 24, height: 24, flexShrink: 0 }}>
                                <RotateCw size={14} />
                              </button>
                            )}
                            <button type="button" className="btn-icon" title="Remove" aria-label={`Remove ${p.name}`}
                              onClick={() => removeFile(p.key)} disabled={sending} style={{ width: 24, height: 24, flexShrink: 0 }}>
                              <X size={14} />
                            </button>
                            {p.status === 'uploading' && (
                              <div style={{
                                position: 'absolute', left: 0, bottom: 0, height: 2,
                                width: `${p.progress}%`, background: 'var(--primary)', transition: 'width 0.2s',
                              }} />
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {composerNotice && (
                      <p role="alert" style={{ fontSize: '0.6875rem', color: 'var(--danger)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <AlertCircle size={12} style={{ flexShrink: 0 }} /> {composerNotice}
                      </p>
                    )}
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        accept={ATTACHMENT_ACCEPT}
                        style={{ display: 'none' }}
                        onChange={e => {
                          addFiles(Array.from(e.target.files || []));
                          e.target.value = '';
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn-outline"
                        title="Attach files — JPG, PNG, WEBP, GIF or PDF, up to 10 MB each"
                        aria-label="Attach files"
                        disabled={activeConv.status !== 'agent_handling' || sending || pendingFiles.length >= MAX_ATTACHMENTS_PER_MESSAGE}
                        onClick={() => fileInputRef.current?.click()}
                        style={{ padding: 0, width: '2.5rem', flexShrink: 0 }}
                      >
                        <Paperclip size={16} />
                      </button>
                      <textarea
                        className="form-input"
                        rows={2}
                        placeholder={activeConv.status === 'agent_handling'
                          ? (activeConv.source === 'email' ? 'Type your reply — it goes out by email…' : 'Type your reply…')
                          : 'Take over to reply…'}
                        value={draft}
                        disabled={activeConv.status !== 'agent_handling' || sending}
                        onChange={e => setDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); }
                        }}
                        style={{ flex: 1, height: 'auto', resize: 'vertical', minHeight: 44 }}
                      />
                      <button
                        className="btn btn-primary"
                        disabled={
                          sending || activeConv.status !== 'agent_handling'
                          || pendingFiles.some(p => p.status !== 'ready')
                          || (!draft.trim() && pendingFiles.length === 0)
                        }
                        onClick={sendReply}
                      >
                        {sending
                          ? <Loader2 size={16} style={{ animation: 'spin 0.6s linear infinite' }} />
                          : <Send size={16} />}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {deleting && (
          <DeleteMessageDialog
            channel={activeConv?.source === 'email' ? 'email' : 'chat'}
            busy={deleting.busy}
            error={deleting.error}
            onCancel={() => setDeleting(null)}
            onConfirm={confirmDelete}
          />
        )}
        {details && (
          <MessageDetailsDialog details={details.data} error={details.error} onClose={() => setDetails(null)} />
        )}
      </main>
    </div>
  );
}
