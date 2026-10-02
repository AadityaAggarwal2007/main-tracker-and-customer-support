'use client';

import { canChangeMessage } from '@/lib/chat/message-rules';
import type { AuthUser, ChatMessage, Conversation, StaffBlock } from '../_lib/types';
import { supportLabel, WITHHELD_LABELS, fullDate } from '../_lib/inbox';
import { renderWithLinks } from '../_lib/text';
import { MessageActions, MessageEditor, MessageAttachments } from './MessageTools';

  // One message in the thread. readOnly = a message from an older chat of the
  // same customer: shown as it was, without the edit/delete menu.
export default function MessageRow({ msg, readOnly = false, activeConv, copyMessage, editing, keepThreadPinned, meKey, menu, messageText, openDetails, saveEdit, searchTerm, setDeleting, setEditing, setMenu, staff, startEdit, toggleMenu, user }: {
  msg: ChatMessage;
  readOnly?: boolean;
  activeConv: Conversation | null;
  copyMessage: (msg: ChatMessage) => Promise<void>;
  editing: { id: string; text: string; saving: boolean; error: string } | null;
  keepThreadPinned: (img: HTMLImageElement) => void;
  meKey: string | null;
  menu: { id: string; up: boolean } | null;
  messageText: (msg: ChatMessage) => string;
  openDetails: (id: string) => Promise<void>;
  saveEdit: () => Promise<void>;
  searchTerm: string;
  setDeleting: React.Dispatch<React.SetStateAction<{ id: string; busy: boolean; error: string } | null>>;
  setEditing: React.Dispatch<React.SetStateAction<{ id: string; text: string; saving: boolean; error: string } | null>>;
  setMenu: React.Dispatch<React.SetStateAction<{ id: string; up: boolean } | null>>;
  staff: StaffBlock | null;
  startEdit: (msg: ChatMessage) => void;
  toggleMenu: (id: string, button: HTMLButtonElement) => void;
  user: AuthUser;
}) {
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
        {/* A team reply: "You" when this login wrote it, else the writer's name today ("Team" when the
            server could not tell). The customer only ever sees the brand. */}
        <span style={{ fontSize: '0.625rem', color: 'var(--fg-muted)', marginBottom: '0.25rem' }}>
          {msg.sender === 'visitor' ? 'Customer'
            : msg.sender === 'agent' ? ((msg.author_key ? msg.author_key === (staff?.me ?? meKey) : (msg.metadata?.agent && msg.metadata.agent === user.username)) ? 'You' : (msg.author || 'Team'))
            : msg.sender === 'system' ? `${supportLabel(activeConv?.site_name || activeConv?.panel_name)} · System`
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
        {!deleted && msg.sender === 'ai' && Array.isArray(msg.brain) && msg.brain.length > 0 && (
          // Which of Chikki's notes the reply used: one small chip, the list opens on a click
          // (it was a long line under every AI reply; owner, 2026-10-01).
          <details style={{ fontSize: '0.625rem', color: 'var(--fg-muted)', marginTop: '0.25rem', maxWidth: '32rem' }}>
            <summary title="Chikki's notes used for this reply" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px', borderRadius: 999, background: 'var(--muted)' }}>
              🤖 Chikki · {msg.brain.length} note{msg.brain.length === 1 ? '' : 's'}
            </summary>
            <div style={{ marginTop: 4, lineHeight: 1.5 }}>{msg.brain.map((n) => n.title).join(' · ')}</div>
          </details>
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
}
