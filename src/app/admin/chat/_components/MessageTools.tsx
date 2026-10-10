'use client';

import { useEffect, useRef } from 'react';
import { Loader2, AlertCircle, X, FileText, Download, ExternalLink, MoreHorizontal, Pencil, Trash2, Copy, Info } from 'lucide-react';
import { MAX_MESSAGE_LENGTH, senderLabel } from '@/lib/chat/message-rules';
import { type StoredAttachment, formatFileSize } from '@/lib/chat/attachment-rules';
import type { ChatMessage, MessageDetails } from '../_lib/types';
import { WITHHELD_LABELS, fullDate } from '../_lib/inbox';

/* ═══════════ MANAGING A SENT MESSAGE ═══════════ */

// The ⋯ beside one of our messages and its menu. Edit and Delete appear only
// when this user may change the message; the API checks again regardless.
export function MessageActions({ msg, open, up, canChange, onToggle, onEdit, onDelete, onCopy, onDetails }: {
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
export function MessageEditor({ value, original, hasFiles, channel, saving, error, onChange, onCancel, onSave }: {
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

export function DeleteMessageDialog({ channel, busy, error, onCancel, onConfirm }: {
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
export function MessageDetailsDialog({ details, error, onClose }: {
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
    const wa = m.source === 'whatsapp';
    const withheld = m.metadata?.withheld;
    const files = Array.isArray(m.metadata?.attachments) ? m.metadata!.attachments!.length : 0;

    const status = m.deleted_at ? 'Deleted' : withheld ? `Not sent — ${WITHHELD_LABELS[withheld] ?? 'held'}` : 'Sent';
    const delivery = withheld ? 'Never reached the customer'
      : m.deleted_at ? (email ? 'The customer still has it by email (an email cannot be taken back)' : 'Removed from the customer’s chat')
      : email ? (m.metadata?.emailed === true ? 'Sent by email' : m.metadata?.emailed === false ? 'The email did not go out' : 'Email result not recorded')
      : wa ? (m.metadata?.wa_sent === true ? `Sent on WhatsApp${m.metadata?.wa_status ? ` · ${m.metadata.wa_status}` : ''}${m.metadata?.wa_error ? ` · ${m.metadata.wa_error}` : ''}`
              : m.metadata?.wa_sent === false ? `WhatsApp did not take it: ${m.metadata?.wa_error || 'unknown reason'}` : 'Received on WhatsApp')
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
export function MessageAttachments({ files, onImageLoad }: {
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
