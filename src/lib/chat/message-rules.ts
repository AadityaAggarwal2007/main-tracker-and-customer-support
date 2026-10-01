// ── Who may change a message we sent ───────────────────────────
// Shared by the inbox (to decide which actions to offer) and the API (which
// decides for real on every request). No server-only imports: the inbox page
// bundles this file.
//
// Messages from our side are everything a customer did not write: AI replies
// (sender 'ai') and team replies (sender 'agent', username in metadata.agent).
// tool_result rows and hidden tool bookkeeping are never shown, so never
// managed.
//
//   'chat.edit'   edit/delete any of our messages (the super admin and Team "Admin")
//   'chat.reply'  edit/delete AI messages and their own replies
//   neither       read only (copy, view details)
// (src/lib/permissions.ts; until 2026-10-01 these were the roles admin / manager / viewer.)

import { can, type PermissionHolder } from '../permissions';

export const MAX_MESSAGE_LENGTH = 4000;

export interface MessageForRules {
  sender: string;
  metadata: { agent?: string; hidden?: boolean | string } | null;
  deleted_at?: string | null;
}

export interface RulesUser extends PermissionHolder {
  username: string;
}

export function isOurMessage(m: MessageForRules): boolean {
  if (m.sender === 'visitor' || m.sender === 'tool_result') return false;
  const hidden = m.metadata?.hidden;
  return hidden !== true && hidden !== 'true';
}

export function canChangeMessage(user: RulesUser, m: MessageForRules): boolean {
  if (!isOurMessage(m) || m.deleted_at) return false;
  if (can(user, 'chat.edit')) return true;
  if (!can(user, 'chat.reply')) return false;
  if (m.sender === 'agent') return m.metadata?.agent === user.username;
  return true;
}

export function senderLabel(m: MessageForRules): { who: string; type: string; origin: string } {
  if (m.sender === 'ai') return { who: 'AI assistant', type: 'AI', origin: 'AI-generated' };
  if (m.sender === 'agent') {
    return { who: m.metadata?.agent || 'Team member', type: 'Team member', origin: 'Written by a person' };
  }
  if (m.sender === 'visitor') return { who: 'Customer', type: 'Customer', origin: 'Written by the customer' };
  return { who: m.sender, type: 'System', origin: 'System-generated' };
}
