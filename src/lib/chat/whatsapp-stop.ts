// ── A customer who writes STOP gets no more automatic WhatsApp messages (owner 2026-10-10: "jo customer STOP ya
// band karo likhe, use automation se aage koi message nahi jayega") ──
// Why: a customer annoyed enough to block or report the number lowers Meta's quality rating, which can cut the daily
// limit or stop the number for every brand. So the whole message (not a word inside a longer one: "when will it
// stop?" is a question) "stop" / "unsubscribe" / "band karo" / "message mat bhejo" / "बंद करो" turns the number off:
// the automation skips it (whatsapp-auto.ts, SKIP.stopped), the team's first-message template refuses it
// (/api/whatsapp/start), and the customer gets one confirmation. "START" turns it back on. Kept in chat_settings,
// one row per number (`wa_stop:<digits>` = {"stopped": true|false, "at": ...}): no SQL file. The team can still
// answer a customer who writes to us (that is their own conversation, not an automatic message).

import { query, queryOne } from '@/lib/db';
import { sendWhatsAppText } from './whatsapp';
import { SKIP } from './whatsapp-auto-rules';

const STOPPED_TEXT = SKIP.stopped;

export const STOP_PREFIX = 'wa_stop:';

const norm = (t: string) => (t || '').toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

const STOP = new Set([
  'stop', 'stop all', 'stop it', 'stop please', 'please stop', 'pls stop', 'plz stop', 'stop msg', 'stop msgs', 'stop message', 'stop messages',
  'stop sending', 'stop sending messages', 'stop sending me messages', 'unsubscribe', 'unsub', 'opt out', 'optout',
  'no more messages', 'dont message me', 'do not message me', 'dont send messages', 'dont send me messages', 'do not send messages',
  'band karo', 'band kro', 'band kar do', 'band krdo', 'band kardo', 'band karo please', 'msg band karo', 'message band karo',
  'messages band karo', 'msg band kro', 'message band kro', 'mat bhejo', 'msg mat bhejo', 'message mat bhejo', 'messages mat bhejo',
  'mujhe message mat bhejo', 'mujhe msg mat bhejo', 'message mat karo', 'msg mat karo',
  'बंद करो', 'बंद कर दो', 'बंद करें', 'मैसेज मत भेजो', 'मत भेजो', 'मैसेज बंद करो',
]);
const START = new Set(['start', 'unstop', 'subscribe', 'resume', 'start messages', 'start again', 'chalu karo', 'shuru karo', 'चालू करो', 'शुरू करो']);

export type WaKeyword = 'stop' | 'start' | null;
export function waKeyword(text: string | null | undefined): WaKeyword {
  const t = norm(text || '');
  if (!t || t.length > 40) return null;
  if (STOP.has(t)) return 'stop';
  if (START.has(t)) return 'start';
  return null;
}

export const STOP_REPLY = 'Done. You will not get any more automatic messages from ShipTrack on this WhatsApp number. To get your order updates here again, reply START.';
export const START_REPLY = 'Done. You will get your order updates on WhatsApp again. To stop them, reply STOP.';

export function parseStop(value: string | null | undefined): boolean {
  try { return JSON.parse(value || '{}')?.stopped === true; } catch { return false; }
}

// Every number that asked us to stop (digits as the automation stores them).
export async function stoppedNumbers(): Promise<Set<string>> {
  const out = new Set<string>();
  const r = await query<{ key: string; value: string }>(`SELECT key, value FROM chat_settings WHERE key LIKE 'wa_stop:%'`);
  for (const row of r.rows) if (parseStop(row.value)) out.add(row.key.slice(STOP_PREFIX.length));
  return out;
}

export async function isWaStopped(digits: string): Promise<boolean> {
  try {
    const r = await queryOne<{ value: string }>(`SELECT value FROM chat_settings WHERE key = $1`, [STOP_PREFIX + digits]);
    return parseStop(r?.value);
  } catch { return false; }
}

async function setStopped(digits: string, stopped: boolean): Promise<void> {
  await query(
    `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [STOP_PREFIX + digits, JSON.stringify({ stopped, at: new Date().toISOString() })]
  );
}

// The webhook's step for a STOP / START message: saves the choice, then confirms once on WhatsApp (saved in the chat as
// Chikki's message, metadata `wa_stop_reply`). A second STOP from a number already stopped gets no second answer.
export async function handleWaKeyword(conversationId: string, digits: string, kw: Exclude<WaKeyword, null>, env: NodeJS.ProcessEnv = process.env): Promise<'stopped' | 'started' | 'unchanged'> {
  const was = await isWaStopped(digits);
  if ((kw === 'stop') === was) return 'unchanged';
  await setStopped(digits, kw === 'stop');
  // the automation's waiting messages to this number go nowhere now
  if (kw === 'stop') {
    await query(`UPDATE wa_auto_sends SET status = 'skipped', error = $2, updated_at = now() WHERE to_number = $1 AND status = 'pending'`, [digits, STOPPED_TEXT])
      .catch((e) => { if ((e as { code?: string })?.code !== '42P01') console.error('[whatsapp] stop pending:', (e as Error).message); });
  }
  const text = kw === 'stop' ? STOP_REPLY : START_REPLY;
  const saved = await queryOne<{ id: string }>(
    `INSERT INTO messages (id, conversation_id, sender, content, metadata, created_at)
     VALUES (gen_random_uuid()::text, $1, 'ai', $2, jsonb_build_object('channel', 'whatsapp', 'wa_stop_reply', $3::text), now())
     RETURNING id`,
    [conversationId, text, kw]
  ).catch(() => null);
  const r = await sendWhatsAppText(digits, text, env);
  if (saved) {
    await query(
      `UPDATE messages SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('wa_sent', $2::boolean, 'wa_id', $3::text, 'wa_error', $4::text)) WHERE id = $1`,
      [saved.id, r.ok, 'id' in r ? r.id : null, 'error' in r ? r.error : null]
    ).catch(() => undefined);
  }
  return kw === 'stop' ? 'stopped' : 'started';
}

