'use client';

import { Fragment, useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2, Check, AlertCircle, ShoppingBag, LogOut, Send, Mail,
  MessageCircle, User, Phone, Bot, Inbox, Paperclip, X, FileText,
  Download, ExternalLink, RotateCw, MoreHorizontal, Pencil, Trash2, Copy, Info,
  Menu, ChevronLeft, Users, UserCheck, Search,
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
  // Set once the customer proved an order (the widget's form, or order ID +
  // last 4 in the chat). Unset = a visitor. verified_via 'legacy' = found by an
  // old phone/email lookup, shown as "Old check", not as Verified.
  verified_order_id?: string | null;
  verified_via?: string | null;
  // One verified customer's chats on a site share a customer_key (their
  // 10-digit phone). The list shows them as one row: thread_count chats in
  // all, group_unread unread across them, group_needs_human when any of them
  // waits for a person. The thread's answer carries their older chats in
  // `earlier`, oldest first.
  customer_key?: string | null;
  thread_count?: number;
  group_unread?: number;
  group_needs_human?: boolean;
  earlier?: EarlierChat[];
  // The customer's current concern, written by the AI after each message
  // (src/lib/chat/subject.ts): one of its SUBJECT_LABELS plus a one-line
  // summary (<= 90 chars). Null until the first subject is made.
  subject_label?: string | null;
  subject_summary?: string | null;
  subject_updated_at?: string | null;
  // Only in a search (?q=): why this chat matched, and the text around the
  // newest message that contains what was typed.
  hit_order?: boolean;
  hit_phone?: boolean;
  hit_name?: boolean;
  hit_text?: boolean;
  match_snippet?: string | null;
}

// One of the customer's older chats, shown read-only above the latest one.
interface EarlierChat {
  conversation_id: string;
  created_at: string;
  status: string;
  messages: ChatMessage[];
}

// The customer's chat they wrote in after the open one (newer_chat in the
// thread's answer): named in a bar, not drawn in the thread.
interface NewerChat {
  conversation_id: string;
  created_at: string;
  last_message_at: string | null;
  status: string;
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

// The name the widget shows the customer above AI replies ("Vastora Support"),
// built from the site name the same way public/widget.js builds it. The owner
// asked for the brand, not "AI", on these messages; team replies say "You".
function supportLabel(siteName?: string | null): string {
  const name = (siteName || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!name) return 'Support';
  const brand = name.charAt(0).toUpperCase() + name.slice(1);
  return /\bsupport$/i.test(brand) ? brand : `${brand} Support`;
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

// Colour of a subject label, by kind of concern, so the team can tell at a
// glance: money (amber), a change the customer asks for (blue), something
// that went wrong (red), anything else (grey).
const SUBJECT_MONEY = ['Refund', 'Payment issue', 'Payment method / COD'];
const SUBJECT_CHANGE = ['Address change', 'Wrong address', 'Size exchange', 'Product exchange', 'Return', 'Cancellation'];
const SUBJECT_PROBLEM = ['Not received', 'Damaged item', 'Wrong item', 'Missing item', 'Wrong tracking link', 'Delivery delay', 'Complaint'];

function subjectStyle(label: string): { bg: string; fg: string } {
  if (SUBJECT_MONEY.includes(label)) return { bg: '#fef3c7', fg: '#b45309' };
  if (SUBJECT_CHANGE.includes(label)) return { bg: '#dbeafe', fg: '#1d4ed8' };
  if (SUBJECT_PROBLEM.includes(label)) return { bg: '#fee2e2', fg: '#b91c1c' };
  return { bg: 'var(--bg-subtle, rgba(0,0,0,0.05))', fg: 'var(--fg-muted)' };
}

// An AI reply that was written but never sent — escalated to a person, or the
// send itself failed. The customer has not seen it.
const WITHHELD_LABELS: Record<string, string> = {
  escalated: 'needs a human',
  send_failed: 'sending failed',
  sending: 'still sending',
};

const POLL_MS = 3000;

// The inbox tabs. All and Customers show verified customers only (plus the
// "Old check" legacy tags), Visitors the rest; the status tabs show everyone, whatever they have verified.
type InboxTab = 'all' | 'visitors' | 'customers' | 'human_needed' | 'agent_handling' | 'ai_handling' | 'resolved';
const INBOX_TABS: { v: InboxTab; label: string; icon: typeof Inbox; status: string; segment: '' | 'visitors' | 'customers' }[] = [
  { v: 'all', label: 'All', icon: Inbox, status: '', segment: 'customers' },
  { v: 'visitors', label: 'Visitors', icon: Users, status: '', segment: 'visitors' },
  { v: 'customers', label: 'Customers', icon: UserCheck, status: '', segment: 'customers' },
  { v: 'human_needed', label: 'Needs you', icon: AlertCircle, status: 'human_needed', segment: '' },
  { v: 'agent_handling', label: 'You are on it', icon: User, status: 'agent_handling', segment: '' },
  { v: 'ai_handling', label: 'AI handling', icon: Bot, status: 'ai_handling', segment: '' },
  { v: 'resolved', label: 'Closed', icon: Check, status: 'resolved', segment: '' },
];

// How another chat's status reads on its divider or bar ("Earlier chat ·
// 28 Sept · Closed"): the inbox tab names.
function chatStatusLabel(status: string): string {
  return INBOX_TABS.find(t => t.status === status)?.label || '';
}

// Green "Verified" tag for a customer who proved their order. A 'legacy' tag
// (chat-verified-legacy.sql) gets an amber "Old check" instead: that order was
// found by an older phone/email lookup in this chat. Since 2026-09-30 the AI
// treats it as verified in this chat too (the owner: never ask a verified
// customer again); the amber badge only tells staff how it was found.
function VerifiedBadge({ orderId, via }: { orderId?: string | null; via?: string | null }) {
  if (via === 'legacy') {
    return (
      <span title="Found by an older phone/email lookup in this chat, not with order ID + last 4. The AI still treats this chat as verified for this order." style={{
        fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600, flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
        background: '#fef3c7', color: '#b45309',
      }}>
        <Info size={10} /> Old check{orderId ? ` · ${orderId}` : ''}
      </span>
    );
  }
  return (
    <span title={orderId ? `Verified order ${orderId}` : 'Verified customer'} style={{
      fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600, flexShrink: 0,
      display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
      background: '#dcfce7', color: '#15803d',
    }}>
      <UserCheck size={10} /> Verified{orderId ? ` · ${orderId}` : ''}
    </span>
  );
}

// A centred line across the thread between one chat of the customer and the next.
function ThreadDivider({ children }: { children: React.ReactNode }) {
  return (
    <div role="separator" style={{
      display: 'flex', alignItems: 'center', gap: '0.625rem', margin: '0.25rem 0',
      fontSize: '0.6875rem', fontWeight: 600, color: 'var(--fg-muted)',
    }}>
      <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
      <span style={{ whiteSpace: 'nowrap' }}>{children}</span>
      <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
    </div>
  );
}

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// A link stops at an asterisk, so "**https://…/abc**" still opens the page.
// " · matched: order, message": which kind of match put a chat in the results.
function matchedText(c: Conversation): string {
  const why = [c.hit_order && 'order', c.hit_phone && 'phone', c.hit_name && 'name', c.hit_text && 'message'].filter(Boolean);
  return why.length ? ` · matched: ${why.join(', ')}` : '';
}

// Every match of what was searched for, in yellow, as plain text (never a
// pattern). data-search lets the thread scroll to the newest match.
function highlightText(text: string, term: string, keyBase: string) {
  if (!term) return text;
  const re = new RegExp('(' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
  return text.split(re).map((part, i) => i % 2 === 1
    ? <mark key={`${keyBase}-${i}`} data-search="1" style={{ background: '#fde047', color: '#111', borderRadius: 3, padding: '0 1px' }}>{part}</mark>
    : part);
}

function renderWithLinks(text: string, term = '') {
  return text.split(/(https?:\/\/[^\s*]+)/g).map((part, i) =>
    /^https?:\/\//.test(part)
      ? <a key={i} href={part} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline', wordBreak: 'break-all' }}>{highlightText(part, term, `l${i}`)}</a>
      : <span key={i}>{highlightText(part, term, `s${i}`)}</span>
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
        <div role="menu" className="msg-menu" style={{
          position: 'absolute', zIndex: 20, minWidth: 176,
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
  const [tab, setTab] = useState<InboxTab>('all');
  const tabDef = INBOX_TABS.find(t => t.v === tab) || INBOX_TABS[0];
  const statusFilter = tabDef.status;
  const segment = tabDef.segment;

  // The search box. searchQ trails what is typed by a moment, so the list is
  // not asked for on every key. A search looks at ALL chats of the chosen
  // panel (Closed ones and visitors too), whatever tab is open.
  const [searchInput, setSearchInput] = useState('');
  const [searchQ, setSearchQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearchQ(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);
  const searchActive = searchQ.length >= 2;
  const searchActiveRef = useRef(false);
  searchActiveRef.current = searchActive;
  // "#1234" highlights the 1234 in "#1234" and in "1234" alike.
  const searchTerm = searchActive ? (searchQ.replace(/^[#\s]+/, '') || searchQ) : '';
  const listSeqRef = useRef(0);
  const scrolledToHitRef = useRef('');
  const unreadRef = useRef(0);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeConv, setActiveConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // The same customer's older chats on this site (read-only, oldest first),
  // how many older chats they have in all, and their newer chat if any.
  const [earlier, setEarlier] = useState<EarlierChat[]>([]);
  const [earlierTotal, setEarlierTotal] = useState(0);
  const [newerChat, setNewerChat] = useState<NewerChat | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [alert, setAlert] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

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
    // Only the newest answer is used: a slow answer for what was typed a
    // moment ago must not replace the list for what is typed now.
    const seq = ++listSeqRef.current;
    if (!quiet) setLoadingList(true);
    try {
      const params = new URLSearchParams();
      if (activePanelId) params.set('businessId', activePanelId);
      if (searchActive) {
        params.set('q', searchQ);
      } else {
        if (statusFilter) params.set('status', statusFilter);
        if (segment) params.set('segment', segment);
      }
      const res = await fetch(`/api/chat/conversations?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (res.ok && seq === listSeqRef.current) setConversations(data.conversations || []);
    } catch { /* keep the last good list */ }
    finally { if (!quiet) setLoadingList(false); }
  }, [token, activePanelId, statusFilter, segment, searchActive, searchQ]);

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
      const older = data.earlier ?? data.conversation?.earlier;
      setEarlier(Array.isArray(older) ? older : []);
      setEarlierTotal(typeof data.earlier_total === 'number' ? data.earlier_total : 0);
      setNewerChat(data.newer_chat && data.newer_chat.conversation_id !== id ? data.newer_chat : null);
    } catch { /* keep what is on screen */ }
  }, [token]);

  useEffect(() => {
    if (activeId) fetchThread(activeId);
    else { setActiveConv(null); setMessages([]); setEarlier([]); setEarlierTotal(0); setNewerChat(null); }
  }, [activeId, fetchThread]);

  /* ═══ POLLING ═══ */
  // There is no websocket in ShipTrack — the inbox asks again every few
  // seconds instead, and stops entirely while the tab is in the background.
  useEffect(() => {
    if (!token) return;
    const tick = () => {
      if (document.hidden) return;
      // A search is not re-run every few seconds; the open chat still is.
      if (!searchActiveRef.current) fetchConversations(true);
      if (activeIdRef.current) fetchThread(activeIdRef.current, true);
    };
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [token, fetchConversations, fetchThread]);

  const pinUntilRef = useRef(0);
  const earlierCount = earlier.reduce((n, e) => n + (e.messages?.length || 0), 0);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    pinUntilRef.current = Date.now() + 2000;
  }, [messages.length, earlierCount]);

  // Opened from a search: go to the newest place the search text appears,
  // once per chat and search (the poll must not pull the thread back to it).
  useEffect(() => {
    if (!searchActive || !activeId) { scrolledToHitRef.current = ''; return; }
    const key = `${activeId}|${searchQ}`;
    if (scrolledToHitRef.current === key) return;
    if (!threadRef.current?.querySelector('mark[data-search]')) return;
    scrolledToHitRef.current = key;
    pinUntilRef.current = 0;
    // After the scroll to the bottom above has settled.
    setTimeout(() => {
      const hits = threadRef.current?.querySelectorAll('mark[data-search]');
      hits?.[hits.length - 1]?.scrollIntoView({ block: 'center' });
    }, 600);
  }, [messages, earlier, activeId, searchActive, searchQ]);

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

  /* ═══ PHONE LAYOUT ═══ */
  // On a phone the open conversation replaces the list (see .chat-shell in
  // globals.css). Opening one adds a history entry, so the phone's own back
  // gesture returns to the list instead of leaving the inbox. Next.js copies
  // its router state into entries added this way, so going back does not
  // reload the page.
  const openConversation = (id: string) => {
    if (!activeIdRef.current && window.matchMedia('(max-width: 767px)').matches) {
      window.history.pushState({ chatThread: true }, '');
    }
    setActiveId(id);
  };

  const closeConversation = () => {
    if (window.history.state?.chatThread) window.history.back();
    else setActiveId(null);
  };

  useEffect(() => {
    const onBack = () => { if (activeIdRef.current) setActiveId(null); };
    window.addEventListener('popstate', onBack);
    return () => window.removeEventListener('popstate', onBack);
  }, []);

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
  // A grouped row (one customer's chats) carries the unread count of all of them.
  const rowUnread = (c: Conversation) => c.group_unread ?? c.unread_count ?? 0;
  // The unread count is the inbox's; a search shows other chats, so it keeps
  // the last count from before it.
  const unreadNow = conversations.reduce((n, c) => n + (rowUnread(c) || 0), 0);
  if (!searchActive) unreadRef.current = unreadNow;
  const unreadTotal = searchActive ? unreadRef.current : unreadNow;
  // The open chat's row: its own, or its customer's grouped row, which moves
  // to the customer's newest chat when they write in a new one.
  const isActiveRow = (c: Conversation) => activeId === c.id || (
    !!activeConv?.customer_key && activeConv.source === 'chat' && c.source === 'chat'
    && c.customer_key === activeConv.customer_key && c.site_id === activeConv.site_id
  );
  const hiddenEarlier = Math.max(0, earlierTotal - earlier.length);
  // The thread's own answer carries the verified fields, so the header stays
  // right after the chat drops out of the Visitors list; the list row is the
  // fallback while the thread is still loading.
  const activeVerifiedSrc = !activeConv ? null
    : activeConv.verified_order_id !== undefined ? activeConv
    : conversations.find(c => c.id === activeConv.id) ?? null;
  const activeVerifiedOrder = activeVerifiedSrc?.verified_order_id ?? null;
  const activeVerifiedVia = activeVerifiedSrc?.verified_via ?? null;
  // The subject bar reads the thread's own answer the same way, with the
  // list row as the fallback.
  const activeSubjectSrc = !activeConv ? null
    : activeConv.subject_label !== undefined ? activeConv
    : conversations.find(c => c.id === activeConv.id) ?? null;
  const activeSubject = activeSubjectSrc?.subject_label ? {
    label: activeSubjectSrc.subject_label,
    summary: activeSubjectSrc.subject_summary || '',
    updatedAt: activeSubjectSrc.subject_updated_at ?? null,
  } : null;
  // Worked out from the files each time, so it goes away as soon as they are ready.
  const sendHint = !sendBlocked ? ''
    : pendingFiles.some(p => p.status === 'uploading') ? 'Wait for the files to finish uploading.'
    : pendingFiles.some(p => p.status === 'failed') ? 'Retry or remove the file that failed before sending.'
    : '';
  const composerNotice = [fileError, sendHint].filter(Boolean).join(' · ');

  // One message in the thread. readOnly = a message from an older chat of the
  // same customer: shown as it was, without the edit/delete menu.
  const renderMessage = (msg: ChatMessage, readOnly = false) => {
    const mine = msg.sender !== 'visitor';
    const deleted = !!msg.deleted_at;
    const withheld = msg.metadata?.withheld;
    const attached = msg.metadata?.attachments;
    const files = Array.isArray(attached) ? attached : [];
    // A files-only reply carries a text stand-in for older views; the files say it here.
    const showText = !(files.length > 0 && msg.metadata?.captionless);
    const isEditing = !readOnly && mine && !deleted && editing?.id === msg.id;

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
            {showText && renderWithLinks(msg.content, searchTerm)}
          </>
        )}
      </div>
    );

    return (
      <div key={msg.id} className={mine ? 'msg-row chat-msg' : 'chat-msg'} style={{
        alignSelf: mine ? 'flex-start' : 'flex-end',
        display: 'flex', flexDirection: 'column',
        alignItems: mine ? 'flex-start' : 'flex-end',
      }}>
        <span style={{ fontSize: '0.625rem', color: 'var(--fg-muted)', marginBottom: '0.25rem' }}>
          {msg.sender === 'visitor' ? 'Customer' : msg.sender === 'agent' ? 'You'
            : supportLabel(activeConv?.site_name || activeConv?.panel_name)}
        </span>
        {!mine || readOnly ? bubble : (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.25rem', maxWidth: '100%' }}>
            {isEditing && editing ? (
              <MessageEditor
                value={editing.text}
                original={messageText(msg)}
                hasFiles={files.length > 0}
                channel={activeConv?.source === 'email' ? 'email' : 'chat'}
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
  };

  return (
    <div className="admin-layout">
      {/* ── Sidebar ── (a slide-in menu below 1024px, as in the admin panel) */}
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
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
              setSidebarOpen(false);
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
          {INBOX_TABS.map(s => (
            <button
              key={s.v}
              onClick={() => { setTab(s.v); setSearchInput(''); setSearchQ(''); setActiveId(null); setSidebarOpen(false); }}
              className={`nav-btn ${tab === s.v ? 'active' : ''}`}
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
      <main className="main-content chat-main">
        {alert && (
          <div className={`toast toast-${alert.type}`} style={{ position: 'fixed', top: '1rem', right: '1rem', zIndex: 9999 }}>
            {alert.type === 'success' ? <Check size={16} /> : <AlertCircle size={16} />}
            {alert.message}
          </div>
        )}

        {/* Top bar below 1024px, where the sidebar is a slide-in menu */}
        <div className="mobile-header">
          <button type="button" className="btn-icon" aria-label="Open menu" onClick={() => setSidebarOpen(true)}>
            <Menu size={20} />
          </button>
          <span className="mobile-header-title">Chat Support</span>
          {unreadTotal > 0 && (
            <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--fg-muted)' }}>{unreadTotal} unread</span>
          )}
        </div>

        <div className={`chat-shell${activeId ? ' thread-open' : ''}`}>
          {/* Conversation list */}
          <div className="chat-list">
            <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 700, fontSize: '0.875rem' }}>
                {searchActive ? 'Search results' : 'Conversations'}
                <span style={{ color: 'var(--fg-muted)', fontWeight: 400, marginLeft: '0.375rem', fontSize: '0.75rem' }}>
                  {conversations.length}{searchActive && conversations.length >= 200 ? '+' : ''}
                </span>
              </div>
              <div style={{ position: 'relative', marginTop: '0.5rem' }}>
                <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--fg-muted)', pointerEvents: 'none' }} />
                <input
                  className="chat-search"
                  type="search"
                  value={searchInput}
                  onChange={e => setSearchInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Escape') { setSearchInput(''); setSearchQ(''); } }}
                  placeholder="Search name, phone, order ID or message"
                  aria-label="Search chats"
                  maxLength={80}
                  autoComplete="off"
                  style={{
                    width: '100%', padding: '0.4375rem 1.875rem 0.4375rem 1.875rem', borderRadius: 8,
                    border: '1px solid var(--border)', background: 'var(--card-bg)', color: 'var(--fg)',
                  }}
                />
                {searchInput && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => { setSearchInput(''); setSearchQ(''); }}
                    style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--fg-muted)', display: 'flex', padding: 4 }}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              {searchActive && (
                <div style={{ marginTop: '0.375rem', fontSize: '0.6875rem', color: 'var(--fg-muted)' }}>
                  In all chats{activePanelId ? ` of ${businesses.find(b => b.id === activePanelId)?.name || 'this panel'}` : ''}, including Closed ones and visitors.
                </div>
              )}
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
                  {searchActive ? (
                    <>
                      <p>No chats found for “{searchQ}”.</p>
                      <p style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                        Try the order ID, the phone number or the customer&apos;s name. Closed chats and visitors are searched too.
                      </p>
                    </>
                  ) : segment === 'customers' ? (
                    <>
                      <p>No verified customers yet.</p>
                      <p style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                        Chats from people who have not verified an order, and most email threads, are under Visitors.
                      </p>
                    </>
                  ) : (
                    <>
                      <p>Nothing here yet.</p>
                      <p style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                        Chats from the widget and email to a connected mailbox both land here.
                      </p>
                    </>
                  )}
                </div>
              )}

              {conversations.map(c => (
                <button
                  key={c.id}
                  onClick={() => openConversation(c.id)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                    padding: '0.75rem 1rem', border: 'none',
                    borderBottom: '1px solid var(--border)',
                    borderLeft: isActiveRow(c) ? '3px solid var(--primary)' : '3px solid transparent',
                    background: isActiveRow(c) ? 'var(--primary-light)' : 'transparent',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginBottom: '0.25rem' }}>
                    {c.source === 'email' ? <Mail size={12} style={{ color: 'var(--fg-muted)' }} /> : <MessageCircle size={12} style={{ color: 'var(--fg-muted)' }} />}
                    <span style={{ fontWeight: 600, fontSize: '0.8125rem', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.visitor_name || 'Visitor'}
                    </span>
                    {(c.thread_count ?? 0) > 1 && (
                      <span title={`${c.thread_count} chats from this customer, shown as one thread`} style={{
                        fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600, flexShrink: 0,
                        background: 'var(--bg-subtle, rgba(0,0,0,0.05))', color: 'var(--fg-muted)',
                      }}>
                        {c.thread_count} chats
                      </span>
                    )}
                    {c.verified_order_id && <VerifiedBadge via={c.verified_via} />}
                    {rowUnread(c) > 0 && (
                      <span style={{ background: 'var(--danger)', color: '#fff', borderRadius: 9999, fontSize: '0.625rem', padding: '1px 6px', fontWeight: 700 }}>
                        {rowUnread(c)}
                      </span>
                    )}
                    <span style={{
                      fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600,
                      background: STATUS_STYLE[c.status]?.bg, color: STATUS_STYLE[c.status]?.fg,
                    }}>
                      {STATUS_LABELS[c.status]}
                    </span>
                    {c.group_needs_human && c.status !== 'human_needed' && (
                      <span title="An older chat of this customer is waiting for a person" style={{
                        fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600, flexShrink: 0,
                        background: STATUS_STYLE.human_needed.bg, color: STATUS_STYLE.human_needed.fg,
                      }}>
                        {STATUS_LABELS.human_needed}
                      </span>
                    )}
                  </div>

                  <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginBottom: '0.25rem', display: 'flex', gap: '0.375rem', alignItems: 'center', minWidth: 0 }}>
                    <span style={{ flexShrink: 0 }}>{c.panel_name || c.site_name}</span>
                    {c.subject_label ? (
                      <><span>·</span><span title={c.subject_summary || c.subject_label} style={{
                        fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
                        background: subjectStyle(c.subject_label).bg, color: subjectStyle(c.subject_label).fg,
                      }}>{c.subject_label}</span></>
                    ) : CATEGORY_LABELS[c.category] && (
                      <><span>·</span><span>{CATEGORY_LABELS[c.category]}</span></>
                    )}
                  </div>

                  {searchActive && c.match_snippet ? (
                    <div style={{
                      fontSize: '0.75rem', color: 'var(--fg-muted)', overflow: 'hidden', wordBreak: 'break-word',
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                    }}>
                      {highlightText(c.match_snippet.replace(/\s+/g, ' '), searchTerm, `r${c.id}`)}
                    </div>
                  ) : (
                    <div style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.last_message || '—'}
                    </div>
                  )}
                  <div style={{ fontSize: '0.625rem', color: 'var(--fg-muted)', marginTop: '0.25rem' }}>
                    {timeAgo(c.last_message_at)}{searchActive ? matchedText(c) : ''}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Thread */}
          <div className="chat-thread">
            {!activeConv && !activeId && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-muted)' }}>
                <MessageCircle size={40} style={{ opacity: 0.2, marginBottom: '0.75rem' }} />
                <p style={{ fontWeight: 600 }}>Pick a conversation</p>
                <p style={{ fontSize: '0.8125rem' }}>Chats and emails both appear on the left.</p>
              </div>
            )}

            {!activeConv && activeId && (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-muted)' }}>
                <Loader2 size={20} style={{ animation: 'spin 0.6s linear infinite' }} />
              </div>
            )}

            {activeConv && (
              <>
                {/* Thread header */}
                <div style={{ padding: '0.875rem 1.25rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                  <button type="button" className="btn-icon chat-back" aria-label="Back to conversations" onClick={closeConversation}>
                    <ChevronLeft size={20} />
                  </button>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
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
                      {activeVerifiedOrder && <VerifiedBadge orderId={activeVerifiedOrder} via={activeVerifiedVia} />}
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

                  {/* Subject: the customer's current concern, on its own line across the header */}
                  {activeSubject && (
                    <div title={activeSubject.summary ? `${activeSubject.label}: ${activeSubject.summary}` : activeSubject.label} style={{
                      flexBasis: '100%', minWidth: 0, display: 'flex', alignItems: 'center', gap: '0.5rem',
                      padding: '0.375rem 0.625rem', borderRadius: 8,
                      background: 'var(--bg-subtle, rgba(0,0,0,0.04))', border: '1px solid var(--border)',
                    }}>
                      <span style={{
                        fontSize: '0.6875rem', padding: '2px 8px', borderRadius: 9999, fontWeight: 700,
                        flexShrink: 0, whiteSpace: 'nowrap',
                        background: subjectStyle(activeSubject.label).bg, color: subjectStyle(activeSubject.label).fg,
                      }}>
                        {activeSubject.label}
                      </span>
                      {activeSubject.summary && (
                        <span style={{
                          flex: 1, minWidth: 0, fontSize: '0.8125rem', fontWeight: 500, color: 'var(--fg)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {activeSubject.summary}
                        </span>
                      )}
                      {activeSubject.updatedAt && (
                        <span style={{ marginLeft: 'auto', fontSize: '0.625rem', color: 'var(--fg-muted)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                          updated {timeAgo(activeSubject.updatedAt)}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Messages */}
                <div ref={threadRef} style={{ flex: 1, overflowY: 'auto', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {hiddenEarlier > 0 && (
                    <div style={{ textAlign: 'center', fontSize: '0.6875rem', color: 'var(--fg-muted)' }}>
                      {hiddenEarlier} older {hiddenEarlier === 1 ? 'chat' : 'chats'} not shown (empty, or before the last 5)
                    </div>
                  )}
                  {earlier.map(block => (
                    <Fragment key={block.conversation_id}>
                      <ThreadDivider>
                        Earlier chat · {new Date(block.created_at).toLocaleDateString([], { day: 'numeric', month: 'short' })}
                        {chatStatusLabel(block.status) ? ` · ${chatStatusLabel(block.status)}` : ''}
                        {' · '}
                        <button type="button" onClick={() => openConversation(block.conversation_id)} style={{
                          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                          font: 'inherit', color: 'var(--primary)',
                        }}>
                          Open
                        </button>
                      </ThreadDivider>
                      {(block.messages || []).map(msg => renderMessage(msg, true))}
                    </Fragment>
                  ))}
                  {earlier.length > 0 && <ThreadDivider>{newerChat ? 'This chat' : 'Latest chat'}</ThreadDivider>}
                  {messages.map(msg => renderMessage(msg))}
                  <div ref={bottomRef} />
                </div>

                {/* The customer wrote in a newer chat: replies here would go to this one. */}
                {newerChat && (
                  <div role="status" style={{
                    borderTop: '1px solid var(--border)', padding: '0.5rem 1rem',
                    display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap',
                    fontSize: '0.75rem', background: 'var(--primary-light)', color: 'var(--fg)',
                  }}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      This customer has a newer chat
                      {(() => {
                        const bits = [chatStatusLabel(newerChat.status), timeAgo(newerChat.last_message_at)].filter(Boolean);
                        return bits.length ? ` (${bits.join(', ')})` : '';
                      })()}. Replies here go to this older chat.
                    </span>
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => openConversation(newerChat.conversation_id)}>
                      Open newer chat
                    </button>
                  </div>
                )}

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
