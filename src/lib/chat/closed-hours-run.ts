// ── The closed-hours note: reading the chat and deciding (server side) ───────────────
// closed-hours.ts has the rule and the texts. Here: one read of the chat's last messages, the
// customer's frustration score (the stored one or the quick count, as effort.ts does), how many
// times they wrote since the office closed, how many notes they already got in this closed
// stretch and whether a team member is at work in the chat. Called by /api/widget/message only
// (the chat box; email is unchanged, owner answer 11). Never throws: null = today's path.
import { query, queryOne } from '@/lib/db';
import { closedSinceMs, closedWhy, type AfterHours } from '@/lib/office-hours';
import { CLOSED_NOTE_KEY, asksStatusOnly, closedNote, closedNoteStep, type ClosedNoteStep, withoutTeamLines } from './closed-hours';
import { effortScore } from './effort';
import { loadOrderFacts } from './order-facts';
import { statusLine } from './closed-hours';
import { dropReplyTimes, isCourtesyOnly, routineLine, teamWillReplyLine } from './escalation';

// step 'status' (owner 2026-10-10): the customer only asked where the order is and Chikki has not answered yet in
// this closed stretch: the status goes now (the AI's reply, or statusLine in a chat the team holds), the note with
// their next message.
export interface ClosedTurn { step: ClosedNoteStep | 'status'; text: string | null }

interface Row { sender: string; content: string | null; created_at: string; note: string | null }

// What this customer message gets while the office is closed. `afterHours` is the value the route
// read for this message (never null while `why` is set). null = not this path: the office is open,
// the customer is calm, a "thanks", a team member is active, or the read failed.
export async function closedHoursTurn(input: {
  convId: string; said: string; now: number; holidays: readonly string[]; after: AfterHours;
}): Promise<ClosedTurn | null> {
  const why = closedWhy(input.now, input.holidays);
  if (!why || !input.after) return null;
  if (isCourtesyOnly(input.said)) return null;
  const since = closedSinceMs(input.now, input.holidays) ?? input.now;
  try {
    const r = await query<Row>(
      `SELECT sender, content, created_at, metadata->>'${CLOSED_NOTE_KEY}' AS note FROM messages
        WHERE conversation_id = $1 AND sender IN ('visitor', 'ai', 'agent') AND deleted_at IS NULL
          AND COALESCE(metadata->>'hidden', 'false') <> 'true'
          AND COALESCE(metadata->>'withheld', '') = ''
          AND content IS NOT NULL AND btrim(content) <> ''
        ORDER BY created_at DESC, id DESC
        LIMIT 40`,
      [input.convId]
    );
    const rows = r.rows;
    const stored = await queryOne<{ health_score: number | null }>(`SELECT health_score FROM conversations WHERE id = $1`, [input.convId]);
    let asks = 0, sent = 0, answered = 0, lastAgent: number | null = null;
    for (const m of rows) {
      const at = Date.parse(m.created_at);
      if (m.sender === 'agent') { if (lastAgent === null || at > lastAgent) lastAgent = at; continue; }
      if (!(at >= since)) continue;
      if (m.sender === 'visitor') asks++;
      else if (m.note === 'full' || m.note === 'short') sent++;
      else if (m.sender === 'ai') answered++;
    }
    const score = effortScore(stored?.health_score ?? null, rows.slice().reverse().map((m) => ({ sender: m.sender, content: m.content || '', at: m.created_at })));
    const step = closedNoteStep({
      why, score, asks: Math.max(asks, 1), sent,
      teamActiveMin: lastAgent === null ? null : Math.floor((input.now - lastAgent) / 60_000),
    });
    if (!step) return null;
    if (step === 'full' && answered === 0 && asksStatusOnly(input.said)) return { step: 'status', text: null };
    return { step, text: closedNote(input.said, why, input.after, step) };
  } catch (err) {
    console.error(`[widget] closed-hours read failed on conv ${input.convId}:`, (err as Error).message);
    return null;
  }
}

// The reply with the note as its only promise: the fixed team lines the route could have added
// (1-hour, 24-hour, morning) and the AI's own hour promises are taken out first, and a reply that
// was only such a line becomes the note alone.
export function withClosedNote(text: string, said: string, after: AfterHours, note: string): string {
  const lines = [teamWillReplyLine(said, after), routineLine('refund', said, after), routineLine('payment', said, after),
    teamWillReplyLine(said, null), routineLine('refund', said, null)];
  const kept = dropReplyTimes(withoutTeamLines(text, lines)).text.trim();
  return kept ? `${kept}\n\n${note}` : note;
}

// The status line for a verified chat (step 'status' in a chat the team holds): its verified order, as the tracking
// page shows it. null = no verified order or it could not be read (the caller sends the note instead).
export async function closedStatusText(convId: string, said: string, businessId: string | null): Promise<string | null> {
  try {
    const c = await queryOne<{ verified_order_id: string | null }>(`SELECT verified_order_id FROM conversations WHERE id = $1`, [convId]);
    const f = await loadOrderFacts(c?.verified_order_id ?? null, businessId, 'verified');
    if (!f) return null;
    return statusLine({ order_id: f.order_id, status: f.status, eta: f.eta, late: !!f.late, tracking_link: f.tracking_link }, said);
  } catch (err) {
    console.error(`[widget] closed-hours status read failed on conv ${convId}:`, (err as Error).message);
    return null;
  }
}
