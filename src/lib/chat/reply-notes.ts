// ── Saved replies ("Notes"), the database side (owner 2026-10-13; rules in reply-notes-rules.ts) ──
// One row per note in chat_settings (no SQL file; tracker_user may SELECT / INSERT / UPDATE, never DELETE): key
// `reply_note:<panel id>:<uuid>`, value JSON {segment, title, body, by, byName, at, updatedAt, deleted?}. A delete is
// an UPDATE that sets `deleted` (the row stays). Who: anyone who replies to customers (chat.reply or mail.reply) in that
// panel reads, uses and adds; the writer, the Manager (team.lead) and the Super Admin edit / delete. Nothing is sent.
import { randomUUID } from 'crypto';
import { query, queryOne } from '@/lib/db';
import type { AuthUser } from '@/lib/auth';
import { can, canAccessPanel, isSuperAdmin, isTeamLead } from '@/lib/permissions';
import { hasFormLink } from '@/lib/refund/link-mask';
import { stripLinkJunk } from './reply-guards';
import { brandOf } from './common-setup-rules';
import { NOTES_PER_PANEL_MAX, cleanNote, isNoteSegment, type NoteSegment, type ReplyNote } from './reply-notes-rules';

const PREFIX = 'reply_note:';
const esc = (s: string) => s.replace(/[\\%_]/g, '\\$&');
const keyOf = (panelId: string, id: string) => `${PREFIX}${panelId}:${id}`;
const actor = (u: AuthUser) => (u.role === 'admin' ? 'owner' : (u.id || u.username));
const actorName = (u: AuthUser) => (u.role === 'admin' ? 'Super Admin' : (u.displayName || u.username));
type Stored = { segment: NoteSegment; title: string; body: string; by: string; byName: string; at: string; updatedAt: string; deleted?: boolean };

export type NotesResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
const refuse = <T,>(status: number, error: string): NotesResult<T> => ({ ok: false, status, error });

export const mayUseNotes = (u: AuthUser) => can(u, 'chat.reply') || can(u, 'mail.reply');
const mayEdit = (u: AuthUser, n: { by: string }) => isSuperAdmin(u) || isTeamLead(u) || n.by === actor(u);

function parse(value: string): Stored | null {
  try {
    const v = JSON.parse(value) as Partial<Stored>;
    if (!v || !isNoteSegment(v.segment) || typeof v.title !== 'string' || typeof v.body !== 'string') return null;
    return { segment: v.segment, title: v.title, body: v.body, by: String(v.by || ''), byName: String(v.byName || ''), at: String(v.at || ''), updatedAt: String(v.updatedAt || v.at || ''), deleted: !!v.deleted };
  } catch { return null; }
}

// The panel's name as customers know it (its first chat site's name, else the panel's), for "Regards, <brand> Team".
// A removed note (kept, marked) never counts toward the 300 (review 2026-10-14).
const REMOVED_LIKE = '%"deleted":true%';

export async function panelBrand(panelId: string): Promise<string> {
  const r = await queryOne<{ name: string | null }>(
    `SELECT COALESCE((SELECT s.name FROM sites s WHERE s.tracker_business_id::text = $1::text ORDER BY s.created_at ASC LIMIT 1),
                     (SELECT b.name FROM businesses b WHERE b.id::text = $1::text)) AS name`, [panelId]).catch(() => null);
  return brandOf(r?.name);
}

export async function listNotes(user: AuthUser, panelId: string): Promise<NotesResult<{ brand: string; notes: ReplyNote[] }>> {
  if (!mayUseNotes(user)) return refuse(403, 'You cannot reply to customers');
  if (!panelId || !canAccessPanel(user, panelId)) return refuse(404, 'Panel not found');
  const r = await query<{ key: string; value: string }>(`SELECT key, value FROM chat_settings WHERE key LIKE $1`, [esc(`${PREFIX}${panelId}:`) + '%']);
  const notes: ReplyNote[] = [];
  for (const row of r.rows) {
    const v = parse(row.value);
    if (!v || v.deleted) continue;
    notes.push({ id: row.key.slice(`${PREFIX}${panelId}:`.length), panelId, segment: v.segment, title: v.title, body: v.body, by: v.by, byName: v.byName, at: v.at, updatedAt: v.updatedAt, canEdit: mayEdit(user, v) });
  }
  notes.sort((a, b) => a.title.localeCompare(b.title));
  return { ok: true, value: { brand: await panelBrand(panelId), notes } };
}

function checked(raw: unknown) {
  const c = cleanNote(raw);
  if ('error' in c) return c;
  if (hasFormLink(c.body)) return { error: 'Form links cannot be saved in a note' };
  return { ...c, body: stripLinkJunk(c.body).text };
}

export async function addNote(user: AuthUser, panelId: string, raw: unknown): Promise<NotesResult<ReplyNote>> {
  if (!mayUseNotes(user)) return refuse(403, 'You cannot reply to customers');
  if (!panelId || !canAccessPanel(user, panelId)) return refuse(404, 'Panel not found');
  const c = checked(raw);
  if ('error' in c) return refuse(400, c.error);
  const n = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM chat_settings WHERE key LIKE $1 AND value NOT LIKE $2`, [esc(`${PREFIX}${panelId}:`) + '%', REMOVED_LIKE]);
  if ((n?.n || 0) >= NOTES_PER_PANEL_MAX) return refuse(409, `This panel already has ${NOTES_PER_PANEL_MAX} notes`);
  const id = randomUUID(), now = new Date().toISOString();
  const v: Stored = { ...c, by: actor(user), byName: actorName(user), at: now, updatedAt: now };
  await query(`INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())`, [keyOf(panelId, id), JSON.stringify(v)]);
  console.log(`[reply-note] add panel=${panelId} segment=${c.segment} by ${v.by}`);
  return { ok: true, value: { id, panelId, ...v, canEdit: true } };
}

export async function changeNote(user: AuthUser, panelId: string, id: string, raw: unknown, remove: boolean): Promise<NotesResult<ReplyNote | null>> {
  if (!mayUseNotes(user)) return refuse(403, 'You cannot reply to customers');
  if (!panelId || !canAccessPanel(user, panelId) || !/^[0-9a-f-]{36}$/.test(id)) return refuse(404, 'Note not found');
  const row = await queryOne<{ value: string }>(`SELECT value FROM chat_settings WHERE key = $1`, [keyOf(panelId, id)]);
  const cur = row ? parse(row.value) : null;
  if (!cur || cur.deleted) return refuse(404, 'Note not found');
  if (!mayEdit(user, cur)) return refuse(403, 'Only the person who saved it, the Manager or the Super Admin can change it');
  const now = new Date().toISOString();
  if (remove) {
    await query(`UPDATE chat_settings SET value = $2, updated_at = now() WHERE key = $1`, [keyOf(panelId, id), JSON.stringify({ ...cur, deleted: true, updatedAt: now })]);
    console.log(`[reply-note] delete panel=${panelId} by ${actor(user)}`);
    return { ok: true, value: null };
  }
  const c = checked(raw);
  if ('error' in c) return refuse(400, c.error);
  const v: Stored = { ...cur, ...c, updatedAt: now };
  await query(`UPDATE chat_settings SET value = $2, updated_at = now() WHERE key = $1`, [keyOf(panelId, id), JSON.stringify(v)]);
  return { ok: true, value: { id, panelId, ...v, canEdit: true } };
}
