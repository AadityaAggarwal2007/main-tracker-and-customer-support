import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import { query, queryOne } from '@/lib/db';
import { getClient, isRetryable, sideAttemptOrder } from './ai';
import { VISIBLE_MESSAGE_SQL } from './widget-api';

// ── The subject line of a chat ─────────────────────────────────
// Asked for by the owner on 2026-09-30: staff could not tell what a customer
// wanted without reading the whole chat. Every chat now carries a short
// subject (conversations.subject_label / subject_summary / subject_updated_at,
// chat-subject.sql) that the inbox shows at the top of the thread and in the
// list: one label for the customer's CURRENT concern plus a one-line summary.
//
// It is written by one small extra model call (no tools) after each new
// customer message: /api/widget/message once the reply is saved, and email.ts
// once an inbound email is stored. Both fire it without awaiting, so nobody
// waits on it, and it never throws. It only reads the visible chat and writes
// those three columns; the AI's own reply and `category` are untouched.
//
// Copied into /Users/jatinaggarwal/shiptrack/backups/subject-backfill.js (not
// in Git) for the one-off backfill: change the prompt or the clean-up rules
// here and there together.

// Refund and Cancellation are ONE label since 2026-09-30 (the owner: a customer
// who wants their money back does not care which word we file it under, and two
// tabs split one queue). Chats labelled before that still say 'Refund' or
// 'Cancellation'; the inbox shows and files both as 'Refund / Cancellation'
// (inbox-topics.ts), and a model that still answers 'Refund' is read as it.
export const SUBJECT_LABELS = [
  'Order status', 'Delivery delay', 'Not received', 'Address change', 'Wrong address',
  'Size exchange', 'Product exchange', 'Return', 'Refund / Cancellation',
  'Damaged item', 'Wrong item', 'Missing item', 'Wrong tracking link',
  'Payment issue', 'Payment method / COD', 'Product question', 'Complaint', 'Other',
] as const;

export type SubjectLabel = (typeof SUBJECT_LABELS)[number];

export const SUBJECT_SUMMARY_MAX = 90;

// Messages the model reads, newest last, each cut to this many characters.
const SUBJECT_WINDOW = 12;
const MESSAGE_CHARS = 600;
// ~30 tokens of answer; the rest is room for deepseek-v4-flash's reasoning,
// which returns nothing at all when it runs out (see MAX_REPLY_TOKENS in ai.ts).
const SUBJECT_MAX_TOKENS = 800;
const SUBJECT_TIMEOUT_MS = 20_000;

export const SUBJECT_INSTRUCTION = `You label customer support chats for the support team of an online store.
Read the chat and pick the ONE label that best fits the customer's CURRENT main concern: the latest thing they want, not an older one that was already resolved.
Labels: ${SUBJECT_LABELS.join(', ')}.
Then write a one-line summary for the support team in English, at most 90 characters. Mention the order ID if it is known. Never include a phone number or any of its digits, an email, an address or place name, or a link.
Answer with exactly one line: LABEL | summary`;

// ── Pure helpers (no I/O) ──────────────────────────────────────

// Case-insensitive, ignoring spacing, punctuation, markdown, a "Label:" prefix
// and a trailing full stop ("payment method/cod" is 'Payment method / COD').
// Anything that is not one of the labels is 'Other'.
const labelKey = (s: string) => s.replace(/^\W*label\s*:/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export function matchSubjectLabel(raw: string): SubjectLabel {
  const key = labelKey(raw || '');
  if (key === 'refund' || key === 'cancellation' || key === 'refundcancel' || key === 'refundandcancellation') return 'Refund / Cancellation';
  return SUBJECT_LABELS.find((l) => labelKey(l) === key) || 'Other';
}

const DATE = /^\d{1,4}[-./]\d{1,2}[-./]\d{1,4}$/;

// One line for staff: no markdown or quotes, no phone numbers, emails or links,
// at most 90 characters cut on a word boundary. Null when nothing is left.
export function cleanSubjectSummary(raw: string): string | null {
  let s = (raw || '')
    .replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966)) // Devanagari digits
    .replace(/[\r\n]+/g, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')                  // links
    .replace(/[^\s@]+@[^\s@]+\.[a-z]{2,}\S*/gi, ' ')                // emails
    // Phone-like runs: 8+ digits, spaces/dashes/dots/brackets allowed between.
    // A date (30-09-2026, 2026/09/30) is not a phone number and stays.
    .replace(/\+?\d[\d\s().-]{6,}\d/g, (run) => (
      run.replace(/\D/g, '').length >= 8 && !DATE.test(run.trim()) ? ' ' : run))
    .replace(/\*\*|__|`|#{1,6}\s/g, '')                           // markdown
    .replace(/["“”]/g, '')                                        // double quotes
    .replace(/^\s*summary\s*:\s*/i, '')
    .replace(/\(\s*\)|\[\s*\]/g, ' ')                               // brackets emptied above
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^['‘’*\-–—|:,\s]+/, '').replace(/['‘’*\-–—|:,\s]+$/, '').trim();
  if (!s) return null;
  if (s.length > SUBJECT_SUMMARY_MAX) {
    const room = SUBJECT_SUMMARY_MAX - 1; // leave space for the ellipsis
    let cut = s.slice(0, room + 1);
    const space = cut.lastIndexOf(' ');
    cut = space >= room / 2 ? cut.slice(0, space) : s.slice(0, room);
    s = cut.replace(/[\s,;:.\-–—]+$/, '') + '…';
  }
  return s;
}

export interface ParsedSubject { label: SubjectLabel; summary: string | null }

// "LABEL | summary". A model may add a line of preamble or wrap it in quotes,
// so the first line with a '|' wins; without one, a line that is exactly a
// label is taken as the label alone, and anything else becomes 'Other' with
// the text as the summary. Null for a blank answer (the next model is tried).
export function parseSubjectReply(text: string | null | undefined): ParsedSubject | null {
  const lines = (text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const piped = lines.find((l) => l.includes('|'));
  if (piped) {
    const at = piped.indexOf('|');
    return {
      label: matchSubjectLabel(piped.slice(0, at)),
      summary: cleanSubjectSummary(piped.slice(at + 1).replace(/\|/g, ' ')),
    };
  }
  const only = matchSubjectLabel(lines[0]);
  if (only !== 'Other' || /^\W*other\W*$/i.test(lines[0])) return { label: only, summary: null };
  return { label: 'Other', summary: cleanSubjectSummary(lines[0]) };
}

// The chat as the model reads it. ai and agent are both "Support".
export function buildSubjectTranscript(rows: { sender: string; content: string }[]): string {
  return rows
    .map((r) => {
      const who = r.sender === 'visitor' ? 'Customer' : 'Support';
      let text = (r.content || '').replace(/\s+/g, ' ').trim();
      if (text.length > MESSAGE_CHARS) text = text.slice(0, MESSAGE_CHARS) + '…';
      return `${who}: ${text}`;
    })
    .join('\n');
}

// ── The update ─────────────────────────────────────────────────

// Conversations with an update running, and whether another was asked for
// meanwhile (then it runs once more when the first finishes). One PM2 process
// runs the app, so this is the only place two updates could meet.
const inFlight = new Map<string, { again: boolean }>();

class BlankSubjectError extends Error {
  status = 502; // a model failure like any other, so the next model is tried
}

async function askModel(transcript: string): Promise<ParsedSubject> {
  let lastErr: unknown = null;
  for (const model of sideAttemptOrder()) {
    try {
      const body = {
        model,
        messages: [
          { role: 'system' as const, content: SUBJECT_INSTRUCTION },
          { role: 'user' as const, content: transcript },
        ],
        max_tokens: SUBJECT_MAX_TOKENS,
        // A one-line label needs no thinking. With reasoning on, deepseek-v4-flash
        // answered blank 2 times in 5 in a live test; off, 0 in 12 and ~1 s.
        // An OpenRouter field the SDK does not type; providers without it ignore it.
        reasoning: { enabled: false },
      };
      const res = await getClient().chat.completions.create(
        body as ChatCompletionCreateParamsNonStreaming,
        { timeout: SUBJECT_TIMEOUT_MS, maxRetries: 0 }
      );
      const parsed = parseSubjectReply(res.choices?.[0]?.message?.content);
      if (!parsed) throw new BlankSubjectError(`${model} sent a blank answer (finish=${res.choices?.[0]?.finish_reason})`);
      return parsed;
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('no model answered');
}

async function runOnce(conversationId: string): Promise<void> {
  // read_at is when the chat was read, and becomes subject_updated_at: a
  // customer message that arrives while the model is thinking is newer than
  // it, so the next trigger still sees something new. (now() at the UPDATE
  // would be later than that message and the new concern would be skipped.)
  const state = await queryOne<{ read_at: string; has_visitor: boolean; fresh: boolean }>(
    `SELECT now()::timestamp(3)::text AS read_at,
            v.last_visitor_at IS NOT NULL AS has_visitor,
            COALESCE(c.subject_updated_at > v.last_visitor_at, false) AS fresh
       FROM conversations c
       CROSS JOIN LATERAL (
         SELECT max(m.created_at) AS last_visitor_at
           FROM messages m
          WHERE m.conversation_id = c.id
            AND m.sender = 'visitor'
            AND ${VISIBLE_MESSAGE_SQL}
       ) v
      WHERE c.id = $1`,
    [conversationId]
  );
  // Gone, never written in by the customer, or nothing new since the last one.
  if (!state || !state.has_visitor || state.fresh) return;

  const rows = await query<{ sender: string; content: string }>(
    `SELECT sender, content
       FROM (
         SELECT sender, content, created_at, id
           FROM messages
          WHERE conversation_id = $1
            AND sender IN ('visitor', 'ai', 'agent')
            AND ${VISIBLE_MESSAGE_SQL}
          ORDER BY created_at DESC, id DESC
          LIMIT ${SUBJECT_WINDOW}
       ) t
      ORDER BY created_at ASC, id ASC`,
    [conversationId]
  );
  if (!rows.rows.some((r) => r.sender === 'visitor')) return;

  const subject = await askModel(buildSubjectTranscript(rows.rows));

  // Only these three columns: updated_at stays, so the inbox order does not
  // move. Never replaces a subject written from a later read (the backfill
  // script can run beside the app).
  await query(
    `UPDATE conversations
        SET subject_label = $2, subject_summary = $3, subject_updated_at = $4::timestamp(3)
      WHERE id = $1
        AND (subject_updated_at IS NULL OR subject_updated_at < $4::timestamp(3))`,
    [conversationId, subject.label, subject.summary, state.read_at]
  );
  console.log(`[subject] ${conversationId}: ${subject.label}`);
}

// Fire and forget: `void updateConversationSubject(id)`. Never throws.
export async function updateConversationSubject(conversationId: string): Promise<void> {
  try {
    if (!conversationId) return;
    const running = inFlight.get(conversationId);
    if (running) { running.again = true; return; }
    const entry = { again: false };
    inFlight.set(conversationId, entry);
    try {
      do {
        entry.again = false;
        try {
          await runOnce(conversationId);
        } catch (err) {
          console.error(`[subject] ${conversationId} failed: ${(err as Error)?.message || String(err)}`);
        }
      } while (entry.again);
    } finally {
      inFlight.delete(conversationId);
    }
  } catch (err) {
    console.error(`[subject] ${conversationId} failed: ${(err as Error)?.message || String(err)}`);
  }
}
