import { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import {
  authReady, lastSeenMs, presenceRead, refreshTeamCache, superAdminUsername, teamEntries, teamLoaded, type AuthUser,
} from '@/lib/auth';
import { query } from '@/lib/db';
import { can, canAccessPanel, isSuperAdmin } from '@/lib/permissions';
import { AWAY_AFTER_MIN, awayMinutes, isAway, isOfficeHours } from '@/lib/office-hours';
import { cachedHolidays } from './holidays';
import {
  OWNER_KEY, actorTier, caseMarkGate, takeKind, transferTargets,
  type Actor, type Holder, type Member, type TakeKind,
} from './team-rules';
import { WAITING_LATERAL, WAITING_SINCE_SQL } from './waiting-sql';

// ── The chat team on the server (owner, 2026-10-01) ─────────────
// team-rules.ts decides who may do what; this file feeds it the facts: the team list and who was
// seen when (src/lib/auth.ts, in memory), and the chat row, locked for the length of the action.
// Used by the reply route (/api/chat/messages), the thread route (/api/chat/conversations/[id]: the
// staff block, Take over / Take from X / Transfer / Close / Hand to AI / Refund marks), the list
// route (My chats, the team directory), the Super Admin's release (/api/chat/team/release) and
// merge-chats.ts (the merge event).
//
// Locking (spec, part 3): every action locks the chat and the customer's other open chats
// (lockChatGroup) inside ONE transaction and runs every statement of it through that transaction's
// client, never the pool (a pool query would wait on our own lock). FOR NO KEY UPDATE, so a
// customer's widget message (which only needs the row to exist) is never held up. lock_timeout 5 s:
// a lock that cannot be had in 5 s, or a deadlock, is a 409 "try again", never a hung request.

export const SUPER_ADMIN_NAME = 'Super Admin';
export const STARTING_MESSAGE = 'ShipTrack is starting. Try again in a moment.';
export const BUSY_MESSAGE = 'Someone else is changing this chat right now. Try again.';
export const MERGED_MESSAGE = "This chat was merged into the customer's other chat. Open that one.";
export const CASE_GATE_MESSAGE = 'A senior marks Refund / Ship again. You can mark it while no senior has been in ShipTrack for 30 minutes (10:00-19:30).';
const CASE_GATE_NOTE = 'A senior marks this. You can mark it while no senior has been in ShipTrack for 30 minutes (10:00-19:30).';

// An action the person can understand and redo (a 4xx with a message); anything else is a 500.
export class ChatActionError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// The answer for an error thrown inside an action: our own refusals keep their status and message,
// a lock that took over 5 s (55P03) or a deadlock (40P01) is a 409 "try again". null = a real
// failure (the route answers 500). Nothing was saved in any of these cases: the transaction rolled back.
export function actionError(err: unknown): NextResponse | null {
  if (err instanceof ChatActionError) return NextResponse.json({ error: err.message }, { status: err.status });
  const code = (err as { code?: string } | null)?.code;
  if (code === '55P03' || code === '40P01') return NextResponse.json({ error: BUSY_MESSAGE }, { status: 409 });
  return null;
}

// Right after a restart the team list may not be read yet. Rights must not guess (a stored holder
// would look like nobody), so an action waits up to 3 s for the list and is refused with a 503 if it
// is still not there. false = refuse.
export async function actionsReady(timeoutMs = 3000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  await authReady(timeoutMs);
  const left = until - Date.now();
  if (!teamLoaded() && left > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([refreshTeamCache(), new Promise((r) => { timer = setTimeout(r, left); })]);
    if (timer) clearTimeout(timer);
  }
  return teamLoaded();
}

// ── Who is acting, who holds the chat ───────────────────────────
// The person acting, as team-rules.ts sees them. The Super Admin is 'owner' (he has no team_users
// row) and counts as Senior. null: a member whose login carries no member id (a token from before
// member ids, before the team list is read); the action routes answer 503 then.
export function staffActor(user: AuthUser | null | undefined): Actor | null {
  if (!user) return null;
  if (isSuperAdmin(user)) {
    return { key: OWNER_KEY, name: SUPER_ADMIN_NAME, superAdmin: true, senior: true, canReply: true, canCases: true };
  }
  if (!user.id) return null;
  return {
    key: user.id, name: user.displayName || user.username, superAdmin: false,
    senior: can(user, 'chat.senior'), canReply: can(user, 'chat.reply'), canCases: can(user, 'chat.cases'),
  };
}

// How long this person (a member id, or 'owner') has been away, as office-hours.ts counts it. Until
// staff_presence has been read once since this process started, nobody is away (null, as at night):
// right after a restart everyone would otherwise look unseen since 10:00, and a junior could mark
// Refund / Ship again or take a waiting chat from a senior who was here a minute ago (fail closed:
// a restart never gives extra rights).
// The holiday list is the last one read (holidays.ts): on a holiday nobody is away, as on Sunday.
const awayOf = (key: string, now: number) => (presenceRead() ? awayMinutes(lastSeenMs(key), now, cachedHolidays()) : null);

// conversations.assigned_to as a holder the rules can use. A stored member who was removed, switched
// off, lost chat.reply or lost the chat's panel holds nothing (the chat is free; the next claim logs
// the old id as from_owner, no row is rewritten). Before the team list is read a stored holder is
// still a holder (fail closed: nobody gets extra rights from a restart), with no name or presence.
export function holderOf(raw: string | null | undefined, panelId: string | null, now = Date.now()): Holder | null {
  if (!raw) return null;
  if (!teamLoaded()) {
    return raw === OWNER_KEY
      ? { key: OWNER_KEY, name: SUPER_ADMIN_NAME, superAdmin: true, senior: false, awayMin: null }
      : { key: raw, name: 'a team member', superAdmin: false, senior: true, awayMin: null };
  }
  if (raw === OWNER_KEY) {
    return { key: OWNER_KEY, name: SUPER_ADMIN_NAME, superAdmin: true, senior: false, awayMin: awayOf(OWNER_KEY, now) };
  }
  const e = teamEntries().find((m) => m.id === raw);
  if (!e || !e.active || !can(e, 'chat.reply') || !canAccessPanel(e, panelId)) return null;
  return { key: e.id, name: e.name, superAdmin: false, senior: can(e, 'chat.senior'), awayMin: awayOf(e.id, now) };
}

// Every team member, for the transfer list (team-rules.ts transferTargets filters it).
export function membersFor(panelId: string | null, now = Date.now()): Member[] {
  return teamEntries().map((e) => ({
    key: e.id, name: e.name, active: e.active, canReply: can(e, 'chat.reply'), senior: can(e, 'chat.senior'),
    panelOk: canAccessPanel(e, panelId), awayMin: awayOf(e.id, now),
  }));
}

// The Super Admin's own away minutes (shown next to his name in the transfer list).
export function ownerAwayMin(now = Date.now()): number | null {
  return awayOf(OWNER_KEY, now);
}

// Away is shown only from 30 minutes; under that a person is simply "around".
export const shownAway = (m: number | null) => (m !== null && m >= AWAY_AFTER_MIN ? m : null);
const minutesSince = (ms: number | null, now: number) => (ms === null ? null : Math.max(0, Math.floor((now - ms) / 60_000)));

function activeSeniors(now: number) {
  return teamEntries()
    .filter((e) => e.active && can(e, 'chat.senior'))
    .map((e) => ({ key: e.id, name: e.name, lastSeen: lastSeenMs(e.id), awayMin: awayOf(e.id, now) }));
}

// For Refund / Ship again (team-rules.ts caseMarkGate): 'none' = nobody has the Senior tick (today's
// rule: chat.cases is enough); true = office hours and every senior has been away 30+ minutes;
// false = a senior is around, or it is night (nobody is "away" at night, so a junior waits), or
// presence has not been read since a restart (awayOf: nobody is away until it has).
export function seniorsAwayNow(now = Date.now()): 'none' | boolean {
  const seniors = activeSeniors(now);
  if (seniors.length === 0) return 'none';
  if (!isOfficeHours(now, cachedHolidays()) || !presenceRead()) return false;
  return seniors.every((s) => isAway(s.lastSeen, now, cachedHolidays()));
}

// The Refund / Ship again gate for this person now, with the line the inbox shows under the buttons.
export function caseMarkState(actor: Actor, now = Date.now()): { allowed: boolean; override: boolean; note: string | null } {
  const gate = caseMarkGate(actor, seniorsAwayNow(now));
  if (gate.override) {
    const seniors = activeSeniors(now);
    const mins = Math.min(...seniors.map((s) => s.awayMin ?? AWAY_AFTER_MIN));
    return { ...gate, note: `${seniors.map((s) => s.name).join(', ')} not seen for ${mins} min: you can mark Refund / Ship again` };
  }
  return { ...gate, note: !gate.allowed && actor.canCases ? CASE_GATE_NOTE : null };
}

// Who is on the team, for the inbox (names on rows, "My chats", the transfer dialog): members who
// can reply, then the Super Admin. away_min only from 30 minutes in office hours; seen_min = minutes
// since last seen (null: not seen since presence started). No usernames, no ids beyond the key.
export interface DirectoryEntry { key: string; name: string; senior: boolean; owner: boolean; away_min: number | null; seen_min: number | null }
export function teamDirectory(now = Date.now()): DirectoryEntry[] {
  const out: DirectoryEntry[] = teamEntries()
    .filter((e) => e.active && can(e, 'chat.reply'))
    .map((e) => ({
      key: e.id, name: e.name, senior: can(e, 'chat.senior'), owner: false,
      away_min: shownAway(awayOf(e.id, now)), seen_min: minutesSince(lastSeenMs(e.id), now),
    }));
  out.push({
    key: OWNER_KEY, name: SUPER_ADMIN_NAME, senior: false, owner: true,
    away_min: shownAway(awayOf(OWNER_KEY, now)), seen_min: minutesSince(lastSeenMs(OWNER_KEY), now),
  });
  return out;
}

// The holder as the inbox shows it.
export function holderView(h: Holder | null) {
  return h ? { key: h.key, name: h.name, senior: h.senior, owner: h.superAdmin, away_min: shownAway(h.awayMin) } : null;
}

// A key as a name today ('owner', a member id, 'system'...). Names change; keys do not, so the
// thread's team log shows who it is now. null = a member who is no longer in the team list.
export function nameOfKey(key: string | null | undefined): string | null {
  if (!key) return null;
  if (key === OWNER_KEY) return SUPER_ADMIN_NAME;
  if (key === 'system') return 'System';
  if (key === 'ai') return 'AI';
  if (key === 'customer') return 'Customer';
  return teamEntries().find((e) => e.id === key)?.name ?? null;
}

// Who wrote a staff message that has no 'reply' event (sent before chat-team.sql, or its event could
// not be logged); the thread route names the others by the writer's key, which survives a rename
// (messages.metadata.agent = the login's username at the time). A team member's username shows
// their name today; anything else is the Super Admin's own login, current or an older one he has
// since changed. Before the team list is read: null (the inbox says "Team"), never a guess. Staff
// screens only: the widget never gets metadata.agent.
export function authorNamer(): (username: unknown) => string | null {
  if (!teamLoaded()) return () => null;
  const byUsername = new Map(teamEntries().map((e) => [e.username, e.name]));
  const admin = (superAdminUsername() || '').toLowerCase();
  return (username) => {
    if (typeof username !== 'string' || !username) return null;
    if (admin && username.toLowerCase() === admin) return SUPER_ADMIN_NAME;
    return byUsername.get(username) ?? SUPER_ADMIN_NAME;
  };
}

// The 409 when someone else holds the chat (reply, Close, Hand to AI, Take over).
export function heldMessage(h: Holder, take: TakeKind | null): string {
  if (take) return `${h.name} has this chat. Press "Take from ${h.name}" first.`;
  if (h.superAdmin) return `${SUPER_ADMIN_NAME} has this chat. You can read it; ask ${SUPER_ADMIN_NAME} to transfer it to you.`;
  return `${h.name} has this chat. You can read it; ask ${h.name} or ${SUPER_ADMIN_NAME} to transfer it to you.`;
}

// ── Inside the transaction ──────────────────────────────────────
export interface LockedChat {
  id: string; site_id: string; status: string; assigned_to: string | null;
  case_kind: string | null; case_order_id: string | null; merged_into: string | null;
  verified_order_id: string | null; phone_match_order_id: string | null;
  customer_key: string | null; source: string;
}

// A known customer: verified, or an old phone match (the same test as chatIsVerified in verified.ts).
export const isKnownCustomer = (c: Pick<LockedChat, 'verified_order_id' | 'phone_match_order_id'>) =>
  !!(c.verified_order_id || c.phone_match_order_id);

async function lockRows(client: PoolClient, convId: string, siteId: string | null, customerKey: string | null): Promise<LockedChat[]> {
  const r = await client.query<LockedChat>(
    `SELECT c.id, c.site_id, c.status, c.assigned_to, c.case_kind, c.case_order_id, c.merged_into,
            c.verified_order_id, c.phone_match_order_id, c.customer_key, c.source
       FROM conversations c
      WHERE c.id = $1
         OR ($2::text IS NOT NULL AND c.source = 'chat' AND c.site_id = $3 AND c.customer_key = $2
             AND c.merged_into IS NULL AND c.status <> 'resolved')
      ORDER BY c.id
        FOR NO KEY UPDATE`,
    [convId, customerKey, siteId]
  );
  return r.rows;
}

// Locks the chat and the same customer's other OPEN widget chats (the holder moves with the customer:
// a claim, a take or a transfer carries their other chats along), all in ONE statement in id order,
// so two actions on the same customer (or an action and mergeChats) cannot deadlock each other.
// siteId / customerKey come from the caller's unlocked read. If the customer was identified since
// (the AI's lookup set customer_key in between), their other chats are not locked, and locking them
// now would take rows out of id order (a deadlock with mergeChats, which then loses the merge), so
// the action is refused with a 409 "try again" and nothing is saved; the retry reads the new key.
// A merged shell (a stale screen) is refused: the customer's chat is the one it was merged into.
export async function lockChatGroup(
  client: PoolClient, convId: string, siteId: string | null, customerKey: string | null,
): Promise<{ chat: LockedChat; siblings: LockedChat[] }> {
  await client.query(`SET LOCAL lock_timeout = '5s'`);
  const rows = await lockRows(client, convId, siteId, customerKey);
  const chat = rows.find((r) => r.id === convId);
  if (!chat) throw new ChatActionError(404, 'Not found');
  if (chat.merged_into) throw new ChatActionError(409, MERGED_MESSAGE);
  if (chat.source === 'chat' && chat.customer_key && chat.customer_key !== customerKey) {
    throw new ChatActionError(409, BUSY_MESSAGE);
  }
  return { chat, siblings: rows.filter((r) => r.id !== convId) };
}

// Names the person for the database triggers (chat-team.sql trg_chat_status_event), for this
// transaction only: a status change it makes is logged as theirs, with this reason.
export async function setActor(client: PoolClient, actor: Actor, reason: string): Promise<void> {
  await client.query(
    `SELECT set_config('shiptrack.actor', $1, true), set_config('shiptrack.actor_name', $2, true), set_config('shiptrack.reason', $3, true)`,
    [actor.key, actor.name, reason]
  );
}

// The same, for a change the system makes by itself (owner 2026-10-02: Chikki's own Ship again mark
// and red flag, case-auto.ts). The SAME SQL text as setActor, so the status trigger logs actor
// 'system', this name and this reason.
export async function setSystemActor(client: PoolClient, name: string, reason: string): Promise<void> {
  await client.query(
    `SELECT set_config('shiptrack.actor', $1, true), set_config('shiptrack.actor_name', $2, true), set_config('shiptrack.reason', $3, true)`,
    ['system', name, reason]
  );
}

export type ChatEventKind = 'claim' | 'take' | 'transfer' | 'merge' | 'reply' | 'case_mark' | 'case_remove' | 'reshipped';
export interface ChatEventInput {
  conversationId: string; siteId: string | null; kind: ChatEventKind;
  fromOwner?: string | null; toOwner?: string | null; fromStatus?: string | null; toStatus?: string | null;
  reason?: string | null; note?: string | null; messageId?: string | null; meta?: Record<string, unknown>;
}

// One row in chat_events (staff only: the owner's per-member report). meta.tier is always set for a
// person, so a senior's work can be told from a junior's after the ticks change. Not required (the
// default): written inside a savepoint, so a logging failure never stops a reply, a close or a mark.
// Required (a transfer: its note lives only here): a failure rolls the whole action back.
// The error is logged without the row (never the note).
export async function logChatEvent(
  client: PoolClient, who: Actor | 'system', ev: ChatEventInput, opts: { required?: boolean } = {},
): Promise<boolean> {
  const person = who === 'system' ? null : who;
  const meta = person ? { tier: actorTier(person), ...(ev.meta || {}) } : (ev.meta ?? null);
  const sql = `INSERT INTO chat_events (conversation_id, site_id, kind, actor, actor_name, from_owner, to_owner,
                                        from_status, to_status, reason, note, message_id, meta)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`;
  const params = [
    ev.conversationId, ev.siteId, ev.kind, person ? person.key : 'system', person ? person.name : 'System',
    ev.fromOwner ?? null, ev.toOwner ?? null, ev.fromStatus ?? null, ev.toStatus ?? null,
    ev.reason ?? null, ev.note ?? null, ev.messageId ?? null, meta === null ? null : JSON.stringify(meta),
  ];
  if (opts.required) {
    await client.query(sql, params);
    return true;
  }
  await client.query('SAVEPOINT ce');
  try {
    await client.query(sql, params);
    await client.query('RELEASE SAVEPOINT ce');
    return true;
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT ce');
    console.error(`[chat] ${ev.kind} event not logged for conv ${ev.conversationId}:`, (err as Error)?.message);
    return false;
  }
}

// Is the customer waiting for an answer in this chat (the inbox's Waiting rule, waiting-sql.ts)?
// Only asked for away cover ("Take (Rahul away 42 min)"), which needs a waiting customer. client:
// inside a locked action; null: a plain read (the thread GET).
export async function customerWaiting(client: PoolClient | null, convId: string): Promise<boolean> {
  const sql = `SELECT (${WAITING_SINCE_SQL}) IS NOT NULL AS w FROM conversations c ${WAITING_LATERAL} WHERE c.id = $1`;
  const r = client ? await client.query<{ w: boolean }>(sql, [convId]) : await query<{ w: boolean }>(sql, [convId]);
  return !!r.rows[0]?.w;
}

// "Take from X" for this actor (team-rules.ts takeKind), asking whether the customer waits only when
// that is what decides it (an away holder), so the usual case costs no query.
export async function takeFor(client: PoolClient | null, actor: Actor, h: Holder | null, convId: string): Promise<TakeKind | null> {
  const k = takeKind(actor, h, false);
  if (k) return k;
  if (takeKind(actor, h, true) !== 'holder_away') return null;
  return (await customerWaiting(client, convId)) ? 'holder_away' : null;
}

// The transfer list for the thread's staff block and the transfer check.
export function transferList(actor: Actor, h: Holder | null, panelId: string | null, now = Date.now()) {
  return transferTargets(actor, h, membersFor(panelId, now), ownerAwayMin(now));
}
