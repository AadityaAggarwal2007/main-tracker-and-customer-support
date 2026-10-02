import type { PoolClient } from 'pg';
import { query } from '@/lib/db';
import { setActor, staffActor } from '@/lib/chat/team-routing';
import { sendAgentEmailReply } from '@/lib/chat/email';
import { looksHinglish } from '@/lib/chat/escalation';
import { linkState } from './rules';
import type { Lang, Step } from './texts';
import { RefundCryptoError } from './crypto';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Row = Record<string, any>;
export interface Db { query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[]; rowCount?: number | null }> }
export const pool: Db = { query: (sql, params) => query(sql, params) as Promise<{ rows: Row[]; rowCount?: number | null }> };
export const tx = (client: PoolClient): Db => client as unknown as Db;

// What a route answers: its status and JSON body (the route adds the headers).
export interface Res { status: number; body: Record<string, unknown> }
export const res = (status: number, body: Record<string, unknown>): Res => ({ status, body });

// ── Logging: codes only ────────────────────────────────────────
// A pg error's SQLSTATE and its message (pg messages name tables and constraints, never values), else
// only the error's class name: a JSON or library message could quote what the customer typed.
export const codeOf = (e: unknown): string => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' && /^[A-Z0-9_]{1,24}$/i.test(c) ? c : '-';
};
const isSqlState = (e: unknown) => /^[0-9A-Z]{5}$/.test(codeOf(e));
export const msgOf = (e: unknown): string => (isSqlState(e)
  ? String((e as { message?: unknown }).message ?? '').slice(0, 80)
  : String((e as { name?: unknown } | null)?.name ?? 'Error').slice(0, 40));
export function logFail(where: string, e: unknown): void {
  console.error(`[refund] ${where} failed:`, codeOf(e), msgOf(e));
}
export const isMissingTable = (e: unknown) => codeOf(e) === '42P01';
export const NOT_INSTALLED = 'Refund forms are not installed yet';
const BUSY = 'Someone else is changing this right now. Try again.';
const isBusy = (e: unknown) => codeOf(e) === '55P03' || codeOf(e) === '40P01';
const noKey = (e: unknown) => e instanceof RefundCryptoError && e.code === 'no_key';

// What a Super Admin route answers for an error this file threw (a chat lock refusal, ChatActionError,
// is answered by the route through actionError). Logged with codes only.
export function adminFailure(where: string, e: unknown): Res {
  if (isMissingTable(e)) return res(503, { error: NOT_INSTALLED });
  if (isBusy(e)) return res(409, { error: BUSY });
  if (noKey(e)) return res(503, { error: 'key_missing' });
  logFail(where, e);
  return res(500, { error: 'Something went wrong. Try again.' });
}
// The same for the customer's form: before refund-forms.sql is applied, or without a key, the form is
// closed; anything else is an error the page retries (the same client_nonce keeps a submit single).
export function publicFailure(where: string, e: unknown): Res {
  if (isMissingTable(e) || noKey(e)) return res(503, { state: 'closed' });
  logFail(where, e);
  return res(500, { state: 'error' });
}

export const H = 60 * 60_000;
export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
export const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
export const ms = (v: unknown): number => {
  const t = iso(v);
  return t ? Date.parse(t) : NaN;
};
export const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
export const last4 = (phone: unknown) => String(phone ?? '').replace(/\D/g, '').slice(-4) || null;
export const baseUrl = () => (process.env.NEXT_PUBLIC_BASE_URL || 'https://shiptrack.store').trim().replace(/\/+$/, '');
export const orderKey = (business: string, order: string) => `refund:${business}:${order}`;
// A refund_links row's state (rules.ts linkState: submitted / replaced / cancelled / expired / open).
type LinkRow = { status: string; revoked_reason?: string | null; expires_at: unknown };
export const stateOf = (l: Row, now: number) => linkState(l as LinkRow, now);

// ── Shared: events, target chat, language, the system message, email ──
export interface RefundEvent {
  link_id?: string | null; request_id?: string | null; conversation_id?: string | null;
  kind: string; actor: 'owner' | 'customer' | 'system';
  from_status?: string | null; to_status?: string | null; note?: string | null; ip_hash?: string | null;
  meta?: Record<string, unknown> | null;   // ids, counts, step, device: NEVER payout, token or details
}
export async function logRefundEvent(db: Db, ev: RefundEvent): Promise<void> {
  await db.query(
    `INSERT INTO refund_events (link_id, request_id, conversation_id, kind, actor, from_status, to_status, note, ip_hash, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [ev.link_id ?? null, ev.request_id ?? null, ev.conversation_id ?? null, ev.kind, ev.actor, ev.from_status ?? null,
      ev.to_status ?? null, ev.note ?? null, ev.ip_hash ?? null, ev.meta ? JSON.stringify(ev.meta) : null]
  );
}
// Outside a transaction, best effort (an open count, a view): a failed history row never fails the answer.
export const softEvent = (ev: RefundEvent) => logRefundEvent(pool, ev).catch((e) => logFail(`event ${ev.kind}`, e));

export interface TargetChat { id: string; site_id: string; status: string; source: string; case_kind: string | null }
// The chat a message goes to: the link's chat, following merged_into (at most 5 hops, like
// widget-api.ts conversationForSite). lock: FOR NO KEY UPDATE, inside the caller's transaction.
export async function targetConversation(db: Db, startId: string, lock = false): Promise<TargetChat | null> {
  let id = startId;
  for (let hop = 0; hop <= 5; hop++) {
    const r = await db.query(
      `SELECT c.id, c.site_id, c.status, c.source, c.case_kind, c.merged_into FROM conversations c WHERE c.id = $1${lock ? ' FOR NO KEY UPDATE' : ''}`,
      [id]
    );
    const row = r.rows[0];
    if (!row) return null;
    if (!row.merged_into || hop === 5) {
      if (row.merged_into) console.log(`[refund] merge chain too long ${startId}`);
      return { id: row.id, site_id: row.site_id, status: row.status, source: row.source, case_kind: row.case_kind ?? null };
    }
    id = row.merged_into;
  }
  return null;
}

// Hinglish when the customer's last 3 visible messages look Hinglish (escalation.ts), else English;
// no customer text yet: the fallback (the link's language).
export async function chatLang(db: Db, convId: string, fallback: Lang): Promise<Lang> {
  const r = await db.query(
    `SELECT content FROM messages
      WHERE conversation_id = $1 AND sender = 'visitor' AND deleted_at IS NULL
        AND COALESCE(metadata->>'hidden', 'false') <> 'true'
      ORDER BY created_at DESC LIMIT 3`,
    [convId]
  );
  if (!r.rows.length) return fallback;
  return looksHinglish(r.rows.map((x) => String(x.content ?? '')).join('\n')) ? 'hinglish' : 'en';
}
export const pickLang = (v: unknown): Lang | null => (v === 'hinglish' || v === 'en' ? v : null);

// One 'system' message ("Vastora Support") inside the caller's transaction. Never claims the chat,
// never touches the holder or chat_events. 'received' counts as unread and reopens a Closed chat to the
// team (agent_handling while still marked, else human_needed; actor 'customer', reason 'reopen', the same
// rule as a customer's own message); 'rejected' reopens it the same way, named as the Super Admin's (Q14).
export async function postRefundMessage(
  db: Db, target: { id: string }, step: Step, text: string, lang: Lang, opts: { actor?: ReturnType<typeof staffActor> } = {},
): Promise<{ id: string; created_at: string }> {
  const m = await db.query(
    `INSERT INTO messages (id, conversation_id, sender, content, metadata, created_at)
     VALUES (gen_random_uuid()::text, $1, 'system', $2, jsonb_build_object('system', 'refund', 'step', $3::text, 'lang', $4::text), now())
     RETURNING id, created_at`,
    [target.id, text, step, lang]
  );
  const reopen = step === 'received' || step === 'rejected';
  if (step === 'rejected' && opts.actor) await setActor(db as unknown as PoolClient, opts.actor, 'refund_rejected');
  await db.query(
    `UPDATE conversations
        SET last_message_at = now(), updated_at = now(), unread_count = unread_count + $2::int,
            status = CASE WHEN $3::boolean AND status = 'resolved'
                          THEN CASE WHEN case_kind IS NOT NULL THEN 'agent_handling' ELSE 'human_needed' END
                          ELSE status END
      WHERE id = $1`,
    [target.id, step === 'received' ? 1 : 0, reopen]
  );
  return { id: String(m.rows[0].id), created_at: iso(m.rows[0].created_at) || new Date().toISOString() };
}

// An email chat also gets the message as an email reply, after commit (spec 4.5). sendAgentEmailReply
// returns silently with no mailbox, so the mailbox is checked first. The message is kept either way;
// the result goes on the message (metadata.emailed, like a staff reply) and in the history.
export async function deliverEmail(
  target: { id: string; site_id: string }, messageId: string, content: string,
  ids: { step: Step; link_id?: string | null; request_id?: string | null },
): Promise<boolean> {
  let emailed = false;
  let code: string | null = null;
  try {
    const box = await query(
      `SELECT 1 AS ok FROM site_emails WHERE site_id = $1 AND email IS NOT NULL AND app_password IS NOT NULL LIMIT 1`,
      [target.site_id]
    );
    if (!box.rows.length) code = 'no_mailbox';
    else {
      await sendAgentEmailReply(target.id, content, []);
      emailed = true;
    }
  } catch (e) {
    code = codeOf(e) === '-' ? 'send' : codeOf(e);
  }
  await query(
    `UPDATE messages SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('emailed', $2::boolean) WHERE id = $1`,
    [messageId, emailed]
  ).catch((e) => logFail('email status', e));
  await softEvent({
    link_id: ids.link_id ?? null, request_id: ids.request_id ?? null, conversation_id: target.id,
    kind: emailed ? 'email_sent' : 'email_failed', actor: 'system',
    meta: { step: ids.step, message_id: messageId, ...(code ? { code } : {}) },
  });
  if (!emailed) console.error(`[refund] email not sent conv ${target.id} (${code})`);
  return emailed;
}
