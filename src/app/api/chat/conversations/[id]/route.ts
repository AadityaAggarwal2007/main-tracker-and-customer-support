import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest, AuthUser } from '@/lib/auth';
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '@/lib/db';
import { loadOrderFacts } from '@/lib/chat/order-facts';
import { chargebackKey, openChargebackKeys } from '@/lib/chargeback/store';
import { loadOrderAddress } from '@/lib/chat/order-address-db';
import { loadOrderItems } from '@/lib/chat/order-items-db';
import { can, canRefunds, isSuperAdmin } from '@/lib/permissions';
import { maskRefundLinks } from '@/lib/refund/link-mask';
import { refundMarkLocked, refundThreadState } from '@/lib/refund/server';
import {
  canAct, canTransfer, claimsOnAct, cleanTransferNote, hotChat, hotLockMessage, hotLockNote, hotLocked,
  type Actor, type HotKind, type TakeKind,
} from '@/lib/chat/team-rules';
import {
  BUSY_MESSAGE, CASE_GATE_MESSAGE, ChatActionError, STARTING_MESSAGE, actionError, actionsReady, authorNamer, caseMarkState, heldMessage, holderOf,
  isKnownCustomer, lockChatGroup, logChatEvent, nameOfKey, pickManager, setActor, staffActor, takeFor,
  type LockedChat,
} from '@/lib/chat/team-routing';
import { loadCustomerThread, loadForUser, loadTeamLog, loadThreadMessages, loadWriters, type ConversationRow } from '@/lib/chat/thread-read';
import { staffBlock } from '@/lib/chat/thread-staff';
import { transfer } from '@/lib/chat/thread-transfer';

export const dynamic = 'force-dynamic';

const VALID_STATUSES = ['ai_handling', 'agent_handling', 'resolved', 'human_needed'];

// ── GET /api/chat/conversations/:id ────────────────────────────
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!can(user, 'chat.view')) return NextResponse.json({ error: 'You cannot open Chat Support' }, { status: 403 });

  const conversation = await loadForUser(params.id, user);
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const messages = await loadThreadMessages(params.id);

  // The same customer's older chats on this site (customer_key, see
  // chat-customer-key.sql), so the inbox shows one customer as one thread:
  // the 5 most recently active, each with its last 200 messages, returned
  // oldest first. A newer chat of the customer is named, not drawn
  // (newer_chat), so staff can switch to where the customer is now writing.
  const thread = await loadCustomerThread(conversation, user);

  // The header's order line (placed on, where it is now, estimated delivery):
  // the verified order, else the one the chat's number matched. Staff only.
  const orderFacts = conversation.verified_order_id
    ? await loadOrderFacts(conversation.verified_order_id, conversation.tracker_business_id, 'verified')
    : await loadOrderFacts(conversation.phone_match_order_id, conversation.tracker_business_id, 'phone_match');

  // The same order's delivery address, for logins that may see orders; changeable (PATCH
  // .../address) only on a verified order by logins that may change orders. Staff only.
  const orderAddress = can(user, 'orders.view')
    ? await loadOrderAddress(conversation.verified_order_id || conversation.phone_match_order_id, conversation.tracker_business_id)
    : null;

  // The same order's items (product / colour lines, owner 2026-10-03), for logins that may see
  // orders; changeable (PATCH .../items) only on a verified order by logins that may change orders.
  // Staff only.
  const orderItems = can(user, 'orders.view')
    ? await loadOrderItems(conversation.verified_order_id || conversation.phone_match_order_id, conversation.tracker_business_id)
    : null;

  // Opening a thread clears its unread badge, and the grouped inbox row
  // (group_unread) counts the customer's other chats too, so the older chats
  // shown here go as well. A newer chat keeps its badge: nothing of it is
  // shown here.
  if (conversation.unread_count > 0) {
    await query(`UPDATE conversations SET unread_count = 0, updated_at = now() WHERE id = $1`, [params.id]);
    conversation.unread_count = 0;
  }
  if (thread.shownIds.length > 0) {
    await query(
      `UPDATE conversations
          SET unread_count = 0, updated_at = now()
        WHERE id = ANY($1::text[]) AND unread_count > 0`,
      [thread.shownIds]
    );
  }

  // Who wrote each staff message, by name today ("You" is decided by the inbox). Staff only.
  // A reply sent since chat-team.sql has its writer's KEY in its 'reply' event (messages/route.ts), so
  // a member the owner renamed or removed keeps their own name (removed: the name they had then), and
  // a username given to someone new later never takes their replies. metadata.agent is only the
  // username at the time: it names the older replies (a member's today, else the Super Admin's own
  // login). author_key lets the inbox say "You" after a rename. Before the table exists: usernames.
  const author = authorNamer();
  const agentIds = [...messages.rows, ...thread.earlier.flatMap((c) => c.messages)]
    .filter((m) => m.sender === 'agent' && m.id != null)
    .map((m) => String(m.id));
  const writers = await loadWriters(agentIds);
  const withAuthor = <M extends { sender: string; metadata: unknown }>(m: M) => {
    if (m.sender !== 'agent') return m;
    const w = writers.get(String((m as { id?: unknown }).id));
    return w
      ? { ...m, author: w.name, author_key: w.key }
      : { ...m, author: author((m.metadata as { agent?: unknown } | null)?.agent), author_key: null };
  };
  // A refund form link (owner 2026-10-02) is "[refund form link]" on every staff screen, the Super
  // Admin's too: the raw link lives only in the 'system' message the customer opens. Any text that
  // names "refund" is checked (a percent-encoded "%2Frefund%23<token>" too: link-mask.ts).
  const unlink = <M extends { content: string }>(m: M) => (/refund/i.test(m.content ?? '') ? { ...m, content: maskRefundLinks(m.content) } : m);
  const earlier = thread.earlier.map((c) => ({ ...c, messages: c.messages.map((m) => unlink(withAuthor(m))) }));

  const teamLog = await loadTeamLog(params.id);
  // The red Chargeback tag (owner 2026-10-08): an open chargeback alert on this customer's verified order.
  const cbBiz = conversation.tracker_business_id == null ? null : String(conversation.tracker_business_id);
  const chargebackOpen = (await openChargebackKeys([{ business_id: cbBiz, order_id: conversation.verified_order_id }])).has(chargebackKey(cbBiz, conversation.verified_order_id));

  return NextResponse.json({
    conversation,
    messages: messages.rows.map((m) => unlink(withAuthor(m as { sender: string; metadata: unknown; content: string }))),
    earlier,
    earlier_total: thread.earlierTotal,
    newer_chat: thread.newer,
    order_facts: orderFacts,
    chargeback_open: chargebackOpen,
    order_address: orderAddress,
    address_editable: !!orderAddress && !!conversation.verified_order_id && can(user, 'orders.update'),
    order_items: orderItems,
    items_editable: !!orderItems && !!conversation.verified_order_id && can(user, 'orders.update'),
    team_log: teamLog,
    staff: await staffBlock(conversation, user),
    hot_lock: hotLockBlock(conversation, user),
    // The refund form chip (owner 2026-10-02): only the Super Admin, only in a Refund chat. Staff never
    // get this key. A read error leaves it null (the chip then hides); it never fails the thread.
    ...(canRefunds(user) && conversation.case_kind === 'refund' ? { refund_form: await refundThreadState(conversation).catch(() => null) } : {}),
  });
}

// Is this chat hot (team-rules.ts hotChat, owner 2026-10-02): a known customer's threat or fraud claim
// that no team member has answered yet (the urgent marker saved with the message, so the lock holds from
// that moment, before the scorer runs), a known customer the scorer's model rates At risk (HEALTH_PIN_MIN+),
// or Chikki's own Refund mark. Never the word counts (review fix 2026-10-02). The score, the model's number
// and the marker come from the thread's read (the locked row has none); PATCH passes the locked row for
// who the customer is.
function hotOf(conv: ConversationRow, locked?: LockedChat): HotKind | null {
  const sig = conv.health_signals && typeof conv.health_signals === 'object' ? conv.health_signals : null;
  return hotChat({
    known: isKnownCustomer(locked ?? conv),
    healthScore: conv.health_score,
    modelScore: sig && Object.prototype.hasOwnProperty.call(sig, 'llm') ? sig.llm : undefined,
    urgent: conv.urgent_open ?? null,
    caseKind: conv.case_kind,
    caseMarkedBy: conv.case_marked_by,
  });
}

// Close / Hand to AI for this login (owner 2026-10-02, hot chats): the thread answer's `hot_lock`, a key
// of its own beside `staff` (the team tests pin the staff block's exact shape). can_close / can_hand_to_ai:
// may this login press them at all (the inbox still shows each only where it applies: Close on an open
// chat, Hand to AI on a chat with the team); Hand to AI is never for a Refund / Ship again chat (the
// mark is removed first, as PATCH says). lock_reason: why a member may not (the line under the buttons),
// null when nothing is locked for this login. The PATCH below decides again on the locked row.
function hotLockBlock(conv: ConversationRow, user: AuthUser) {
  const actor = staffActor(user);
  const acts = !!actor && !conv.merged_into && canAct(actor, holderOf(conv.assigned_to, conv.tracker_business_id));
  const hot = hotOf(conv);
  const locked = !!actor && hotLocked(actor, hot);
  return {
    can_close: acts && !locked,
    can_hand_to_ai: acts && !locked && !conv.case_kind,
    lock_reason: locked && hot ? hotLockNote(hot, conv.health_score) : null,
  };
}

// ── PATCH /api/chat/conversations/:id ──────────────────────────
// Take over, hand back to the AI, or close. These were socket events in the old
// app; with the inbox polling they are an ordinary request.
//
// Chat team (owner, 2026-10-01; src/lib/chat/team-rules.ts). One chat has at most one holder:
//   { status }                 Take over / Hand to AI / Close: the holder, anyone on a chat nobody
//                              holds, or the Super Admin. Take over on a chat nobody holds makes it
//                              yours, with the customer's other open chats nobody holds. Close and
//                              Hand to AI never change the holder. On a HOT chat (team-rules.ts
//                              hotChat: an unanswered threat / fraud claim, At risk by the scorer's
//                              model, Chikki's own Refund) Close and Hand
//                              to AI are the Super Admin's only: a member gets a 403 (owner 2026-10-02).
//   { status: 'agent_handling', take: true }
//                              "Take from X": the Super Admin from anyone, a senior from a junior,
//                              anyone from a member away 30+ min (office hours) while the customer waits.
//   { transferTo, note }       Transfer, with a one-line note only the team sees.
//   { caseKind }               Refund / Ship again (a senior, the Manager or the Super Admin marks; setCase).
//   { forward, note }          Forward to Manager (owner 2026-10-10): any member who may act on the chat marks it
//                              Refund / Ship again AND gives it to the Manager (pickManager; nobody = Super Admin)
//                              with a one-line note, in one transaction. The customer is told nothing.
// Each runs in ONE transaction with the chat and the customer's other open chats locked
// (lockChatGroup), and every statement goes through that transaction's client. Someone else's chat
// is a 409 naming them, and nothing is saved.
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  // Rights come from the team list: right after a restart, wait for it rather than guess.
  if (!(await actionsReady())) return NextResponse.json({ error: STARTING_MESSAGE }, { status: 503 });
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!can(user, 'chat.reply')) {
    return NextResponse.json({ error: 'You cannot change conversations' }, { status: 403 });
  }
  const staff = staffActor(user);
  if (!staff) return NextResponse.json({ error: STARTING_MESSAGE }, { status: 503 });

  const conversation = await loadForUser(params.id, user);
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  try {
    const body = await request.json();
    const has = (key: string) => !!body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, key);

    if (has('transferTo')) return await transfer(conversation, staff, body.transferTo, body.note);
    // Forward to Manager (owner 2026-10-10): { forward: 'refund' | 'reship', note }.
    if (has('forward')) return await forward(conversation, user, staff, body.forward, body.note);

    // Refund / Ship again (chat-cases.sql, owner 2026-10-01): { caseKind: 'refund' | 'reship' | null }.
    if (has('caseKind')) {
      if (!can(user, 'chat.cases')) return NextResponse.json({ error: 'You cannot mark Refund / Ship again' }, { status: 403 });
      const raw = body.caseKind;
      const kind = raw === null || raw === '' ? null : String(raw);
      if (kind !== null && !CASE_KINDS.includes(kind)) {
        return NextResponse.json({ error: 'Unknown case' }, { status: 400 });
      }
      // Who marks (owner, 2026-10-01; rulebook 9.6): a senior or the Super Admin; a junior only while
      // every senior has been away 30+ minutes in office hours (logged as an override). Switching
      // between Refund and Ship again is a mark too. Remove: anyone with chat.cases (9.4).
      let override = false;
      if (kind) {
        const gate = caseMarkState(staff);
        if (!gate.allowed) return NextResponse.json({ error: CASE_GATE_MESSAGE }, { status: 403 });
        override = gate.override;
      }
      const done = await withTransaction(async (client) => {
        const { chat } = await lockChatGroup(client, conversation.id, conversation.site_id, conversation.customer_key);
        return setCase(client, chat, kind, user, staff, override);
      });
      if (done.log) console.log(done.log);
      return done.res;
    }

    const { status } = body;
    if (!VALID_STATUSES.includes(status)) {
      return NextResponse.json({ error: 'Unknown status' }, { status: 400 });
    }
    return await changeStatus(conversation, user, staff, status, body.take === true);
  } catch (err) {
    // Our own refusals (409 someone else's chat, a merged shell), a lock that took over 5 s or a
    // deadlock: nothing was saved, and the message says what to do.
    const refused = actionError(err);
    if (refused) return refused;
    return NextResponse.json({ error: 'Could not update that conversation' }, { status: 500 });
  }
}

// Take over, Take from X, Hand to AI, Close.
async function changeStatus(conversation: ConversationRow, user: AuthUser, staff: Actor, status: string, take: boolean) {
  const panel = conversation.tracker_business_id;
  const updated = await withTransaction(async (client) => {
    const now = Date.now();
    const { chat, siblings } = await lockChatGroup(client, conversation.id, conversation.site_id, conversation.customer_key);
    // A hot chat (owner 2026-10-02, team-rules.ts hotChat): only the Super Admin closes it or hands it
    // to the AI. A member gets a 403 saying why, first (on Chikki's own Refund mark, "remove the mark
    // first" below would only invite them to undo it). Take over, Take from X, Transfer, replies and the
    // marks are not gated. A Refund / Ship again mark made or removed since the read above (Chikki's own
    // Refund mark comes with the customer's threat): whose mark it is now is not known here, so the
    // member is asked to try again on a fresh read. Nothing is saved either way.
    if ((status === 'resolved' || status === 'ai_handling') && !staff.superAdmin) {
      if (chat.case_kind !== conversation.case_kind) throw new ChatActionError(409, BUSY_MESSAGE);
      const hot = hotOf(conversation, chat);
      if (hot && hotLocked(staff, hot)) {
        throw new ChatActionError(403, hotLockMessage(hot, status === 'resolved' ? 'close' : 'hand_to_ai', conversation.health_score));
      }
    }
    // A Refund / Ship again chat is the team's: the AI stays off until the mark is removed.
    if (status === 'ai_handling' && chat.case_kind) {
      throw new ChatActionError(409, 'Remove the Refund / Ship again mark before handing this chat to the AI');
    }

    const h = holderOf(chat.assigned_to, panel, now);
    let newOwner: string | null = null;
    let took: TakeKind | null = null;
    if (take && status === 'agent_handling') {
      took = await takeFor(client, staff, h, chat.id);
      if (!took) {
        throw new ChatActionError(409, !h || h.key === staff.key
          ? "Nothing to take: this chat is no longer someone else's."
          : `Nothing to take: ${h.name}'s chat cannot be taken by you.`);
      }
      newOwner = staff.key;
    } else {
      if (!canAct(staff, h)) throw new ChatActionError(409, heldMessage(h!, await takeFor(client, staff, h, chat.id)));
      if (status === 'agent_handling' && claimsOnAct(staff, h)) newOwner = staff.key;
    }

    // Logged as this person's status change (chat-team.sql trigger), with why.
    await setActor(client, staff, status === 'resolved' ? 'close' : status === 'ai_handling' ? 'hand_to_ai' : took ? 'take' : 'take_over');

    // Close, Take over and Hand to AI are a person acting on the chat, so the
    // "came back after the auto-close" mark (chat-auto-close.sql) is cleared. A
    // Close also records who pressed it (chat-closed-by.sql), so a Closed chat says
    // "Closed by support" and not "Closed by AI". Closing a chat that is
    // already Closed changes neither the mark nor the name. The holder changes only on a
    // claim or a take ($4); Close and Hand to AI keep it (owner decision 4).
    const r = await client.query<{ status: string; closed_by_name: string | null; closed_at: string | null; auto_closed_at: string | null; assigned_to: string | null }>(
      `UPDATE conversations
          SET status = $1,
              unread_count = CASE WHEN $1 = 'resolved' THEN 0 ELSE unread_count END,
              closed_by_name = CASE WHEN $1 = 'resolved' AND status <> 'resolved' THEN $3::text ELSE closed_by_name END,
              closed_at = CASE WHEN $1 = 'resolved' AND status <> 'resolved' THEN now() ELSE closed_at END,
              auto_closed_at = CASE WHEN $1 = 'resolved' AND status = 'resolved' THEN auto_closed_at ELSE NULL END,
              assigned_to = CASE WHEN $4::text IS NOT NULL THEN $4::text ELSE assigned_to END,
              assigned_at = CASE WHEN $4::text IS NOT NULL THEN now() ELSE assigned_at END,
              updated_at = now()
        WHERE id = $2
        RETURNING status, closed_by_name, closed_at, auto_closed_at, assigned_to`,
      [status, conversation.id, (user.displayName || user.username || '').trim() || 'support', newOwner]
    );

    if (newOwner) {
      // The customer comes along: on a take, their other open chats the same person held; on a
      // claim, their other open chats nobody holds.
      const group = siblings
        .filter((s) => (took ? s.assigned_to === chat.assigned_to : holderOf(s.assigned_to, panel, now) === null))
        .map((s) => s.id);
      if (group.length > 0) {
        await client.query(`UPDATE conversations SET assigned_to = $1, assigned_at = now() WHERE id = ANY($2::text[])`, [newOwner, group]);
      }
      await logChatEvent(client, staff, {
        conversationId: chat.id, siteId: chat.site_id, kind: took ? 'take' : 'claim',
        fromOwner: chat.assigned_to, toOwner: newOwner, fromStatus: chat.status, toStatus: status,
        reason: took ? 'take' : 'take_over', meta: took ? { take: took, group } : { group },
      });
    }
    return r.rows[0];
  });

  // What the database now says about who closed it, so the screen shows that
  // and not its own guess (a chat the auto-close closed a moment ago stays
  // "Closed by AI" even if someone pressed Close on a stale screen).
  return NextResponse.json({
    success: true,
    status,
    closed_by_name: updated?.closed_by_name ?? null,
    closed_at: updated?.closed_at ?? null,
    auto_closed_at: updated?.auto_closed_at ?? null,
    assigned_to: updated?.assigned_to ?? null,
  });
}

// ── Refund / Ship again ─────────────────────────────────────────────
// Marking: only a known customer's chat (verified, or an old phone match: the Customers list),
// never a visitor's. The chat leaves every other inbox list and shows only under its section, the
// AI stops (agent_handling), and nothing is sent to the customer. Removing: the chat goes back to
// the status it had before. Every mark and remove is kept in chat_case_events.
// Runs inside PATCH's transaction on the locked row (`chat`); who may mark is checked before it.
// Marking never needs or changes the holder. Returns the answer and the line to log after commit.
const CASE_KINDS = ['refund', 'reship'];

// Forward to Manager (owner 2026-10-10: "support team refund / reship ke case manager ko forward karegi, fir manager
// handle karega"; answer: the chat gets the mark AND becomes the Manager's). The same mark as the buttons (setCase,
// logged override 'forward', no senior needed) and the same holder change as a transfer (the customer's other open
// chats with the same holder move too; the note lives only in chat_events). Verified customers only (setCase).
async function forward(conversation: ConversationRow, user: AuthUser, staff: Actor, rawKind: unknown, rawNote: unknown) {
  if (!can(user, 'chat.cases')) return NextResponse.json({ error: 'You cannot mark Refund / Ship again' }, { status: 403 });
  const kind = rawKind === 'refund' || rawKind === 'reship' ? rawKind : null;
  if (!kind) return NextResponse.json({ error: 'Pick Refund or Ship again' }, { status: 400 });
  const note = cleanTransferNote(rawNote);
  if (!note) return NextResponse.json({ error: 'Write one line for the Manager: what does the customer need?' }, { status: 400 });
  const panel = conversation.tracker_business_id;
  const out = await withTransaction(async (client) => {
    const now = Date.now();
    const { chat, siblings } = await lockChatGroup(client, conversation.id, conversation.site_id, conversation.customer_key);
    if (chat.status === 'resolved') throw new ChatActionError(400, 'This chat is Closed. Forward it when the customer writes again.');
    const h = holderOf(chat.assigned_to, panel, now);
    if (!canTransfer(staff, h)) throw new ChatActionError(409, heldMessage(h!, null));
    const marked = await setCase(client, chat, kind, user, staff, 'forward');
    if (marked.res.status !== 200) return { res: marked.res, log: null };
    const to = await pickManager(client, panel, now);
    if (to !== chat.assigned_to) {
      await setActor(client, staff, 'transfer');
      await client.query(`UPDATE conversations SET assigned_to = $2::text, assigned_at = now(), updated_at = now() WHERE id = $1`, [chat.id, to]);
      const group = siblings.filter((x) => x.assigned_to === chat.assigned_to).map((x) => x.id);
      if (group.length > 0) {
        await client.query(`UPDATE conversations SET assigned_to = $1::text, assigned_at = now() WHERE id = ANY($2::text[])`, [to, group]);
      }
      await logChatEvent(client, staff, {
        conversationId: chat.id, siteId: chat.site_id, kind: 'transfer', fromOwner: chat.assigned_to, toOwner: to,
        fromStatus: chat.status, toStatus: 'agent_handling', reason: 'forward', note, meta: { forward: kind, group },
      }, { required: true });
    }
    return {
      res: NextResponse.json({ success: true, case_kind: kind, assigned_to: to, holder_name: nameOfKey(to) ?? 'Super Admin' }),
      log: `[chat] conv ${chat.id} forwarded (${kind}) to ${to} by ${staff.key}`,
    };
  });
  if (out.log) console.log(out.log);
  return out.res;
}

async function setCase(
  client: PoolClient, chat: LockedChat, kind: string | null, user: AuthUser, staff: Actor, override: boolean | 'forward',
): Promise<{ res: NextResponse; log: string | null }> {
  const actor = (user.displayName || user.username || '').trim() || 'support';
  const orderId = chat.verified_order_id || chat.phone_match_order_id || null;

  // Owner answer Q6 (2026-10-02, rulebook 9.4): while a refund form link is open or a refund request is
  // New / Approved, only the Super Admin removes or switches the Refund mark (the chat would otherwise
  // go back to an AI that never saw the form messages). Before refund-forms.sql: not locked.
  if (chat.case_kind === 'refund' && kind !== 'refund' && !isSuperAdmin(user) && await refundMarkLocked(client, chat)) {
    return { res: NextResponse.json({ error: 'A refund form is open for this chat. Only the Super Admin can change or remove the Refund mark now.' }, { status: 409 }), log: null };
  }

  if (kind) {
    if (!orderId) {
      return { res: NextResponse.json({ error: 'Only a verified customer can be marked for a refund or to ship again' }, { status: 400 }), log: null };
    }
    if (chat.case_kind === kind) return { res: NextResponse.json({ success: true, case_kind: kind }), log: null };
    await setActor(client, staff, 'case');
    // Switching from one to the other keeps the status the chat had before the first mark.
    const r = await client.query(
      `UPDATE conversations
          SET case_prev_status = CASE WHEN case_kind IS NULL THEN status ELSE case_prev_status END,
              case_kind = $2, case_marked_by = $3, case_marked_at = now(), case_order_id = $4,
              reshipped_at = NULL, reshipped_by = NULL, reship_awb = NULL, reship_link = NULL,
              status = CASE WHEN status = 'resolved' THEN status ELSE 'agent_handling' END,
              auto_closed_at = NULL,
              updated_at = now()
        WHERE id = $1
        RETURNING case_kind, case_marked_by, case_marked_at, case_order_id, status`,
      [chat.id, kind, actor, orderId]
    );
    if (chat.case_kind) {
      await client.query(
        `INSERT INTO chat_case_events (id, conversation_id, site_id, kind, action, order_id, actor, actor_role)
         VALUES ($1, $2, $3, $4, 'remove', $5, $6, $7)`,
        [crypto.randomUUID(), chat.id, chat.site_id, chat.case_kind, chat.case_order_id, actor, user.role]
      );
    }
    await client.query(
      `INSERT INTO chat_case_events (id, conversation_id, site_id, kind, action, order_id, actor, actor_role)
       VALUES ($1, $2, $3, $4, 'mark', $5, $6, $7)`,
      [crypto.randomUUID(), chat.id, chat.site_id, kind, orderId, actor, user.role]
    );
    const row = r.rows[0];
    await logChatEvent(client, staff, {
      conversationId: chat.id, siteId: chat.site_id, kind: 'case_mark', fromStatus: chat.status, toStatus: row?.status ?? null,
      reason: 'case', meta: { case: kind, ...(chat.case_kind ? { from_case: chat.case_kind } : {}), ...(override ? { override: override === 'forward' ? 'forward' : 'senior_away' } : {}) },
    });
    return { res: NextResponse.json({ success: true, ...row }), log: `[chat] conv ${chat.id} marked ${kind} by ${actor}${override === true ? ' (no senior around)' : override === 'forward' ? ' (forward)' : ''}` };
  }

  if (!chat.case_kind) return { res: NextResponse.json({ success: true, case_kind: null }), log: null };
  await setActor(client, staff, 'case');
  const r = await client.query(
    `UPDATE conversations
        SET status = CASE WHEN status = 'resolved' THEN status
                          ELSE COALESCE(case_prev_status, 'agent_handling') END,
            case_kind = NULL, case_marked_by = NULL, case_marked_at = NULL, case_order_id = NULL, case_prev_status = NULL,
            reshipped_at = NULL, reshipped_by = NULL, reship_awb = NULL, reship_link = NULL,
            updated_at = now()
      WHERE id = $1
      RETURNING status`,
    [chat.id]
  );
  await client.query(
    `INSERT INTO chat_case_events (id, conversation_id, site_id, kind, action, order_id, actor, actor_role)
     VALUES ($1, $2, $3, $4, 'remove', $5, $6, $7)`,
    [crypto.randomUUID(), chat.id, chat.site_id, chat.case_kind, chat.case_order_id, actor, user.role]
  );
  const row = r.rows[0];
  await logChatEvent(client, staff, {
    conversationId: chat.id, siteId: chat.site_id, kind: 'case_remove', fromStatus: chat.status, toStatus: row?.status ?? null,
    reason: 'case', meta: { case: chat.case_kind },
  });
  return { res: NextResponse.json({ success: true, case_kind: null, status: row?.status }), log: `[chat] conv ${chat.id} ${chat.case_kind} mark removed by ${actor}` };
}
