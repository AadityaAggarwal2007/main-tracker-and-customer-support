import crypto from 'crypto';
import { query, queryOne, withTransaction } from '@/lib/db';
import { lockChatGroup, logChatEvent, setSystemActor } from './team-routing';
import { lookupVerifiedOrder } from './orders';
import { recentVisitorMessages } from './chat-history';
import { withCheckAround } from './reply-guards';
import { scanSignals } from './health-rules';
import {
  handoffReply, isRepeatedReply, routineHandOverKind, routineLine, teamWillReplyLine, urgentAck, urgentKind,
  type AfterHours, type RoutineKind, type UrgentKind,
} from './escalation';
import {
  AUTO_MARK_NAME, claimLang, claimStage, deliveredReply, followUpAction, mentionsOtherOrder, preDispatchReply, PROMISE_HOURS,
  promiseReply, REMINDER_HEADS, reminderReply, teamHasItReply, trackingClaimKind, type TrackingClaim,
} from './tracking-claim';

// ── Fake / invalid tracking claims: the server side (owner, 2026-10-02) ──
// A verified customer (order ID + full phone) who says the tracking ID / link is invalid, fake or
// stuck gets a fixed reply by code; a dispatched order goes to Ship again by itself, marked
// "Chikki (auto)". tracking-claim.ts is the pure part (detector, texts, decisions); this file reads
// the chat and the order, writes the mark and the red flag, and hands the widget route
// (src/app/api/widget/message/route.ts) the text to send. The mark or the red flag is always saved
// BEFORE the text is returned: the customer is never told something the team cannot see.
//
// Nothing here goes through withHandOverLine / dropReplyTimes: the fixed texts are the same day and
// night ("24-48 hours" is the new link, not the team's reply time). Logs carry chat ids only.

const TEN_MIN_MS = 10 * 60_000;

// Milliseconds since a time read from the database (node-pg gives a Date, the tests an ISO string).
// NaN when unknown, so an "under N minutes" test is false and the hours are unknown.
function msSince(v: string | Date | null | undefined): number {
  if (v == null) return NaN;
  return Date.now() - (v instanceof Date ? v.getTime() : Date.parse(String(v)));
}

// ── The system mark (no person logged in) ───────────────────────
// marked.red: the chat stayed in Needs you (also red in Ship again). already.status: the locked
// row's status (human_needed = it is red already).
export type AutoMark =
  | { done: 'marked'; red: boolean }
  | { done: 'already'; caseKind: string; by: string | null; ageMs: number | null; status: string }
  | { done: 'refused'; why: string };

// Marks the chat Ship again as "Chikki (auto)". One transaction, the same lock as every staff action
// (team-routing.ts lockChatGroup: the chat + the customer's open chats, id order, lock_timeout 5 s,
// 409 if merged or the customer_key changed since the unlocked read). Never overwrites a mark (a
// Refund or a person's), never marks a Closed chat or an order the locked row does not hold. A lock
// or write failure throws (the transaction rolled back, nothing was saved).
// keepNeedsYou: a chat already in Needs you before this turn (not by this turn's own AI hand-over)
// stays there, red (Ship again AND Needs you), so nobody waiting on a person drops out of Needs you.
export async function autoMarkReship(x: {
  convId: string; siteId: string; customerKey: string | null; orderId: string; trigger: TrackingClaim; fraud: boolean;
  keepNeedsYou: boolean;
}): Promise<AutoMark> {
  return withTransaction(async (client) => {
    const { chat } = await lockChatGroup(client, x.convId, x.siteId, x.customerKey);
    if (chat.case_kind) {
      // Only on this race path: who marked it and how long ago, on the locked row.
      const m = await client.query<{ case_marked_by: string | null; age_ms: number | null }>(
        `SELECT case_marked_by, (extract(epoch FROM now() - case_marked_at) * 1000)::float8 AS age_ms FROM conversations WHERE id = $1`,
        [chat.id]
      );
      return { done: 'already', caseKind: chat.case_kind, by: m.rows[0]?.case_marked_by ?? null, ageMs: m.rows[0]?.age_ms ?? null, status: chat.status };
    }
    if (chat.status === 'resolved') return { done: 'refused', why: 'closed' };
    if (chat.verified_order_id !== x.orderId) return { done: 'refused', why: 'order changed' };
    await setSystemActor(client, AUTO_MARK_NAME, 'case_auto');
    // case_prev_status: Needs you (never back to the AI with an open complaint), so Remove sends it there.
    const r = await client.query<{ status: string }>(
      `UPDATE conversations
          SET case_prev_status = CASE WHEN status = 'agent_handling' THEN 'agent_handling' ELSE 'human_needed' END,
              case_kind = 'reship', case_marked_by = $2, case_marked_at = now(), case_order_id = $3,
              status = CASE WHEN $4::boolean AND status = 'human_needed' THEN 'human_needed' ELSE 'agent_handling' END,
              auto_closed_at = NULL,
              updated_at = now()
        WHERE id = $1 AND case_kind IS NULL
        RETURNING status`,
      [chat.id, AUTO_MARK_NAME, x.orderId, x.keepNeedsYou]
    );
    if (!r.rowCount) return { done: 'already', caseKind: 'reship', by: null, ageMs: null, status: chat.status };
    const toStatus = r.rows[0]?.status === 'human_needed' ? 'human_needed' : 'agent_handling';
    // Byte-identical to the staff mark's event (conversations/[id]/route.ts setCase); actor_role
    // 'system' tells Chikki's marks from a person's ('backfill' = the one-time move).
    await client.query(
      `INSERT INTO chat_case_events (id, conversation_id, site_id, kind, action, order_id, actor, actor_role)
       VALUES ($1, $2, $3, $4, 'mark', $5, $6, $7)`,
      [crypto.randomUUID(), chat.id, chat.site_id, 'reship', x.orderId, AUTO_MARK_NAME, 'system']
    );
    await logChatEvent(client, 'system', {
      conversationId: chat.id, siteId: chat.site_id, kind: 'case_mark', fromStatus: chat.status, toStatus,
      reason: 'case_auto', meta: { case: 'reship', auto: true, trigger: x.trigger, ...(x.fraud ? { fraud: true } : {}) },
    });
    return { done: 'marked', red: toStatus === 'human_needed' };
  });
}

// ── Red: stays in Ship again and also shows in Needs you ─────────
// Red = case_kind 'reship' AND status 'human_needed' (no new column). One row, one lock (no deadlock
// with merges). Cleared by itself when a person replies, takes it over, closes it or removes the mark.
// Tried twice; false = not flagged (the caller then never promises a team reply).
export async function flagReshipRed(convId: string, why: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await withTransaction(async (client) => {
        await client.query(`SET LOCAL lock_timeout = '5s'`);
        await setSystemActor(client, AUTO_MARK_NAME, 'case_alert');
        const r = await client.query(
          `UPDATE conversations SET status = 'human_needed', updated_at = now()
            WHERE id = $1 AND case_kind = 'reship' AND status = 'agent_handling'`,
          [convId]
        );
        if (r.rowCount) console.log(`[widget] conv ${convId} Ship again chat flagged red: ${why}`);
        return (r.rowCount ?? 0) > 0;
      });
    } catch (err) {
      console.error(`[widget] red flag (${why}) failed, attempt ${attempt}:`, (err as Error).message);
    }
  }
  return false;
}

// Red now, or red already (a Ship again chat in Needs you, a person is on it): only then may the
// customer be told the team has it.
async function redOrAlready(convId: string, status: string | null | undefined, why: string): Promise<boolean> {
  if (status === 'human_needed') return true;
  return flagReshipRed(convId, why);
}

// ── The AI path: a claim in a chat the AI is answering ──────────
export interface ClaimState {
  site_id: string; customer_key: string | null; status: string;
  verified_order_id: string | null; verified_via: string | null;
  case_kind: string | null; case_marked_by: string | null; case_marked_at: string | null; merged_into: string | null;
  reship_removed: boolean; other_reship_id: string | null; other_reship_status: string | null;
}

// One read, on the post-merge id, only after the detector matched.
export async function readClaimState(convId: string): Promise<ClaimState | null> {
  return queryOne<ClaimState>(
    `SELECT c.site_id, c.customer_key, c.status, c.verified_order_id, c.verified_via, c.case_kind, c.case_marked_by,
            c.case_marked_at, c.merged_into,
            EXISTS (SELECT 1 FROM chat_case_events e
                     WHERE e.conversation_id = c.id AND e.kind = 'reship' AND e.action = 'remove') AS reship_removed,
            r.id AS other_reship_id, r.status AS other_reship_status
       FROM conversations c
       LEFT JOIN LATERAL (
         SELECT o.id, o.status FROM conversations o
          WHERE o.site_id = c.site_id AND o.id <> c.id AND o.merged_into IS NULL
            AND o.case_kind = 'reship' AND o.case_order_id = c.verified_order_id
          ORDER BY o.case_marked_at DESC LIMIT 1) r ON true
      WHERE c.id = $1`,
    [convId]
  );
}

// What the widget route does with a claim. text null: keep the AI's own escalation text (the order
// could not be loaded and the AI already handed over; the route adds the night line as today).
// handOver: move the chat from AI handling to Needs you (the route's handOver), with this reason.
export interface ClaimTurn { text: string | null; handOver: string | null }

export interface ClaimTurnInput {
  convId: string;
  trackerBusinessId: string | null;
  said: string;                         // this message, masked
  urgent: UrgentKind | null;            // urgentKind(said), already stored on the message
  after: AfterHours;
  lookBack: () => Promise<string[]>;    // earlierVisitorMessages below ([] when verified at the start)
  toolResult: string | null;            // this turn's stored tool result (JSON), for the other-order guard
  aiText: string;
  aiEscalated: boolean;
  merged: boolean;                      // this turn folded the chat into the customer's earlier one
  earlierAi: () => Promise<string[]>;   // the last 3 visible AI replies
}

const STRICT_PROOF = ['form', 'chat_phone'];

// "Complained first, verified next" (spec 1.1): the customer's up to 3 messages before the one just
// stored, from THIS conversation only and the last 24 hours. After a merge the chat holds the older
// chat's history too; only what came in since the merged chat (`startedWith`, the id before the
// merge) was opened counts, so an old complaint there never fires a new promise. Newest first.
export async function earlierVisitorMessages(convId: string, startedWith: string): Promise<string[]> {
  const r = await query<{ content: string }>(
    `SELECT m.content FROM messages m
      WHERE m.conversation_id = $1 AND m.sender = 'visitor' AND m.deleted_at IS NULL
        AND COALESCE(m.metadata->>'hidden', 'false') <> 'true' AND btrim(m.content) <> ''
        AND m.created_at >= (SELECT s.created_at FROM conversations s WHERE s.id = $2)
        AND m.created_at > now() - interval '24 hours'
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 4`,
    [convId, startedWith]
  );
  return r.rows.map((x) => x.content).slice(1);
}

// Spec 2.2, rows 0 and 4-13d (rows 1-3 and 5, and a refund / cancel / payment request in this
// message, are today's path: null). Never throws.
export async function trackingClaimTurn(x: ClaimTurnInput): Promise<ClaimTurn | null> {
  // 1. The detector: pure, no query. The earlier messages only for a chat verified in this turn
  //    ("complained first, verified next").
  let claimText = x.said;
  let kind = trackingClaimKind(x.said);
  let earlier: string[] | null = null;
  if (!kind) {
    try {
      earlier = await x.lookBack();
    } catch (err) {
      console.error(`[widget] tracking claim look-back failed on conv ${x.convId}:`, (err as Error).message);
      return null;
    }
    for (const t of earlier) {
      const k = trackingClaimKind(t);
      if (k) { kind = k; claimText = t; break; }
    }
    if (!kind) return null;
  }
  const claimKind: TrackingClaim = kind;
  const said = claimText;
  const urgentNow = claimText === x.said ? x.urgent : urgentKind(claimText);
  // A threat (owner Q2) in this message or in the one that carried the claim: it wins (below).
  const threatIn = x.urgent === 'threat' ? x.said : urgentNow === 'threat' ? claimText : null;
  const fraud = urgentNow === 'accusation';
  const log = (row: string) => console.log(`[widget] tracking claim (${claimKind}) conv ${x.convId}: ${row}`);
  const lang = async () => {
    let texts = earlier;
    if (!texts) {
      try { texts = await recentVisitorMessages(x.convId, 3); } catch { texts = []; }
    }
    return claimLang([said, ...texts]);
  };
  // Row 6: the chat or the order could not be read. Never a promise.
  const notLoaded = async (): Promise<ClaimTurn> => {
    log('order not loaded');
    return { text: x.aiEscalated ? null : teamHasItReply(await lang(), said), handOver: 'tracking claim, order not loaded' };
  };

  try {
    // 2. The chat (2.1), fail closed.
    let st: ClaimState | null;
    try {
      st = await readClaimState(x.convId);
    } catch (err) {
      console.error(`[widget] tracking claim state read failed on conv ${x.convId}:`, (err as Error).message);
      return await notLoaded();
    }
    if (!st) return await notLoaded();
    // Rows 1-2: a visitor, or a chat verified only by an old proof (last 4, legacy, a phone match): today's path.
    if (!st.verified_order_id || !STRICT_PROOF.includes(st.verified_via || '')) return null;
    // Row 3: the claim may be about another order than the verified one.
    if (mentionsOtherOrder(said, st.verified_order_id, x.toolResult)) { log('another order, today\'s path'); return null; }
    // Row 4: this chat is already in Ship again (merged into one this turn): red + hand-off (a
    // threat: the 1-hour line). "The team will reply" only when the chat really is red; else today's path.
    if (st.case_kind === 'reship') {
      // 13a here too: not merged, Chikki marked THIS chat a moment ago. The same claim sent twice: the
      // second turn ran next to the first and its read already sees the first one's mark. The reminder,
      // not red (a threat or a refund / payment request still goes red below, as on the first turn).
      if (!x.merged && threatIn === null && !routineHandOverKind(x.said) && !routineHandOverKind(said)
          && st.case_marked_by === AUTO_MARK_NAME && msSince(st.case_marked_at) < TEN_MIN_MS) {
        log('just marked by Chikki, reminder');
        return { text: reminderReply(await lang()), handOver: null };
      }
      if (!(await redOrAlready(x.convId, st.status, 'tracking claim in a Ship again chat'))) {
        log('already in Ship again, red flag not saved, today\'s path');
        return null;
      }
      log('already in Ship again, red');
      return { text: threatIn !== null ? urgentAck(threatIn, x.after) : handoffReply(said), handOver: null };
    }
    // Row 5: a Refund chat: today's path, unchanged.
    if (st.case_kind) return null;
    // Row 0: a threat wins over the claim (owner Q2), also when the claim came from an earlier
    // message: Needs you with the 1-hour line (the morning line at night), no promise, no mark.
    if (threatIn !== null) {
      log('threat, Needs you');
      return { text: urgentAck(threatIn, x.after), handOver: 'threat' };
    }
    // A refund, cancel or payment request wins too: it must reach the team. In this message: today's
    // path (the AI's text + the refund / payment line, Needs you). Only in the earlier message that
    // carried the claim (today's path would not see it): its line here, Needs you.
    if (routineHandOverKind(x.said)) { log('refund / payment request, today\'s path'); return null; }
    const routineEarlier = routineHandOverKind(said);
    if (routineEarlier) {
      log(`${routineEarlier} request with the claim, Needs you`);
      return { text: x.aiEscalated ? null : routineLine(routineEarlier, said, x.after), handOver: routineEarlier };
    }

    // 3. The order (orders.ts: the tracking page's stage for a normal order).
    const found = await lookupVerifiedOrder(st.verified_order_id, x.trackerBusinessId);
    if (!found.found || !found.orders[0]) return await notLoaded();
    const order = found.orders[0];
    const stage = claimStage(order);
    const language = await lang();

    // Row 7: cancelled, returned, an exception: Needs you, no promise.
    if (stage === 'other') {
      log('cancelled / returned order, Needs you');
      return { text: fraud ? urgentAck(said, x.after) : teamHasItReply(language, said), handOver: 'tracking claim, order not in transit' };
    }
    // Row 8: Delivered: Needs you, no promise; the check-around line once if it did not arrive.
    if (stage === 'delivered') {
      const base = fraud ? urgentAck(said, x.after) : deliveredReply(language);
      const text = withCheckAround(base, { customerLatest: said, orderDelivered: true, earlierAgentReplies: await x.earlierAi() }).text;
      log('delivered order, Needs you');
      return { text, handOver: 'tracking claim, delivered order' };
    }
    // Rows 9-10: not dispatched yet: explain once (with the tracking link), nothing moves.
    if (stage === 'pre_dispatch') {
      const explain = preDispatchReply(language, order.tracking_link);
      if (isRepeatedReply(explain, await x.earlierAi())) {
        log('not dispatched, explained before, Needs you');
        return { text: handoffReply(said), handOver: 'repeated answer' };
      }
      log('not dispatched, explained');
      if (fraud) return { text: `${explain}\n\n${teamWillReplyLine(said, x.after)}`, handOver: 'fraud claim' };
      if (x.aiEscalated) return { text: `${explain}\n\n${teamHasItReply(language, said)}`, handOver: null };
      return { text: explain, handOver: null };
    }
    // Row 11: the team took a Chikki mark out of this chat before: never marked again by itself.
    if (st.reship_removed) {
      log('Ship again removed before, Needs you');
      return { text: handoffReply(said), handOver: 'tracking claim, Ship again removed before' };
    }
    // Row 12: the same order is already in Ship again in another chat: that chat goes red, this one to Needs you.
    if (st.other_reship_id) {
      await flagReshipRed(st.other_reship_id, 'tracking claim in another chat of the same order');
      log(`same order in Ship again in conv ${st.other_reship_id}, Needs you`);
      return { text: handoffReply(said), handOver: 'tracking claim, order already in Ship again' };
    }

    // Row 13: Shipped .. Out for Delivery: the promise and Chikki's own Ship again mark.
    let mark: AutoMark;
    try {
      // Needs you only from this turn's own AI hand-over (unmerged chat) moves to Ship again alone;
      // any other Needs you chat (a merge target that was waiting on a person) stays there, red.
      mark = await autoMarkReship({
        convId: x.convId, siteId: st.site_id, customerKey: st.customer_key, orderId: st.verified_order_id,
        trigger: claimKind, fraud, keepNeedsYou: x.merged || !x.aiEscalated,
      });
    } catch (err) {
      console.error(`[widget] Ship again mark failed on conv ${x.convId}:`, (err as Error)?.message);
      mark = { done: 'refused', why: 'mark failed' };
    }
    if (mark.done === 'marked') {
      log(mark.red ? 'promise, marked Ship again, kept in Needs you (red)' : 'promise, marked Ship again');
      return { text: promiseReply(language), handOver: null };
    }
    if (mark.done === 'already' && mark.caseKind === 'reship') {
      // 13a: Chikki marked it a moment ago (the same claim from two tabs): the reminder, nothing else.
      if (mark.by === AUTO_MARK_NAME && mark.ageMs !== null && mark.ageMs < TEN_MIN_MS) {
        log('just marked by Chikki, reminder');
        return { text: reminderReply(language), handOver: null };
      }
      // 13b: someone else's Ship again mark: red. The hand-off only when it really is red.
      if (!(await redOrAlready(x.convId, mark.status, 'tracking claim in a Ship again chat'))) {
        log('already in Ship again, red flag not saved, today\'s path');
        return null;
      }
      log('already in Ship again, red');
      return { text: handoffReply(said), handOver: null };
    }
    if (mark.done === 'already') {
      // 13c: a Refund mark: stays there, unread.
      log(`already marked ${mark.caseKind}, unchanged`);
      return { text: handoffReply(said), handOver: null };
    }
    // 13d: refused or failed: Needs you. The promise is never sent without the mark.
    log(`not marked (${mark.why}), Needs you`);
    return { text: handoffReply(said), handOver: 'tracking claim, mark failed' };
  } catch (err) {
    console.error(`[widget] tracking claim failed on conv ${x.convId}:`, (err as Error)?.message);
    try { return await notLoaded(); } catch { return { text: x.aiEscalated ? null : handoffReply(said), handOver: 'tracking claim, order not loaded' }; }
  }
}

// ── The Ship again path: the customer writes again, the AI is off ──
// reminded: an AI message since the mark carries the reminder, in any language (REMINDER_HEADS).
export interface ReshipState {
  status: string; case_marked_at: string | null; mark_role: string | null; team_wrote: boolean; reminded: boolean;
}

export async function readReshipState(convId: string): Promise<ReshipState | null> {
  return queryOne<ReshipState>(
    `SELECT c.status, c.case_marked_at,
            (SELECT e.actor_role FROM chat_case_events e
              WHERE e.conversation_id = c.id AND e.kind = 'reship' AND e.action = 'mark'
              ORDER BY e.created_at DESC LIMIT 1) AS mark_role,
            EXISTS (SELECT 1 FROM messages m
                     WHERE m.conversation_id = c.id AND m.sender = 'agent' AND m.deleted_at IS NULL
                       AND m.created_at > c.case_marked_at) AS team_wrote,
            EXISTS (SELECT 1 FROM messages m
                     WHERE m.conversation_id = c.id AND m.sender = 'ai' AND m.deleted_at IS NULL
                       AND m.created_at >= c.case_marked_at AND m.content ILIKE ANY ($2::text[])) AS reminded
       FROM conversations c WHERE c.id = $1 AND c.case_kind = 'reship'`,
    [convId, REMINDER_HEADS.map((h) => `%${h}%`)]
  );
}

// Spec section 4. A message in a Ship again chat (case_kind 'reship'): from the widget route for a chat
// in agent_handling, and after an AI turn that ended in one (merged into it, or Chikki marked it while
// the model answered; a chat already red is not flagged again). null: not a Ship again chat. A
// Chikki-marked chat with no team message since the mark: one reminder, else red with the line for the
// case. A chat a person marked (or wrote in): red on a new tracking claim, never a message (rule 9.2).
// The red flag is saved before the text. Site AI off: the red flag still happens, no text.
export async function reshipFollowUp(x: {
  convId: string; said: string; urgent: UrgentKind | null; routine: RoutineKind | null; after: AfterHours;
  aiOn: boolean; earlierAi: () => Promise<string[]>;
}): Promise<{ text: string | null } | null> {
  const st = await readReshipState(x.convId);
  if (!st) return null;
  const auto = (st.mark_role === 'system' || st.mark_role === 'backfill') && !st.team_wrote;
  const claim = trackingClaimKind(x.said);
  const sig = scanSignals([{ sender: 'visitor', content: x.said }]);
  const angry = !!(sig.abuse || sig.rude || sig.escalate || sig.caps || sig.burst);
  const sinceMark = msSince(st.case_marked_at);
  const hoursSinceMark = Number.isFinite(sinceMark) ? sinceMark / 3600_000 : null;
  const late = hoursSinceMark !== null && hoursSinceMark >= PROMISE_HOURS;
  let reminder = '';
  let repeated = false;
  if (auto) {
    let texts: string[] = [];
    try { texts = await recentVisitorMessages(x.convId, 3); } catch { texts = []; }
    reminder = reminderReply(claimLang(texts.length ? texts : [x.said]));
    // One reminder (rule 9.7): sent since the mark in any language, or the same text among the last 3 replies.
    repeated = !!st.reminded || isRepeatedReply(reminder, await x.earlierAi());
  }
  const act = followUpAction({ auto, said: x.said, urgent: x.urgent, routine: x.routine, claim, angry, hoursSinceMark, repeated });
  // Why it went red, for the log line only (no customer text).
  const why = x.urgent === 'threat' ? 'threat' : x.routine ? x.routine : x.urgent === 'accusation' ? 'fraud claim'
    : claim ? 'tracking claim again' : angry ? 'anger' : `follow-up (${act.reply ?? 'no reply'})`;
  let red = true;
  if (act.red) red = await redOrAlready(x.convId, st.status, why);
  if (!x.aiOn || !act.reply) return { text: null };
  if (!red) {
    // Not flagged: nobody is told a person has it. Only the reminder, only once, and never after the 48 hours.
    const remind = auto && !repeated && !late;
    console.error(`[widget] conv ${x.convId} Ship again chat not flagged red (${why}): ${remind ? 'reminder only' : 'no message'}`);
    return { text: remind ? reminder : null };
  }
  switch (act.reply) {
    case 'reminder': return { text: reminder };
    case 'reminder+team': return { text: `${reminder}\n\n${teamWillReplyLine(x.said, x.after)}` };
    case 'threat': return { text: urgentAck(x.said, x.after) };
    case 'routine': return { text: routineLine(x.routine || 'payment', x.said, x.after) };
    case 'handoff': return { text: handoffReply(x.said) };
    default: return { text: null };
  }
}
