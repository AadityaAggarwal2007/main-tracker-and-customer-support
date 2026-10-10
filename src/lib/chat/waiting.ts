// ── "Waiting for a reply" ───────────────────────────────────────
// Asked for by the owner on 2026-09-30: the list shows how long each customer
// has been waiting for an answer, and chats waiting 2 hours or more go to the
// top, so nobody is left unanswered until they charge back. No imports: the
// list route (the SQL) and the inbox page (the timer) share it.
//
// A customer is WAITING when the chat is open and
//   - their last visible message has not been answered by anyone, or
//   - the chat is in Needs you and no team member has written since their last
//     message (the AI's "the team will reply here" is not the team's answer),
// and that last message is not just "ok" / "thanks" / "hi". An AI draft that
// was held back and never sent (an email waiting for review) is not an answer.
// The clock runs from the customer's last message. Worked out in the list
// route (waiting_since), not stored.

// From this long a waiting chat is OVERDUE: red in the list, and listed first.
export const WAITING_OVERDUE_HOURS = 2;
export const WAITING_OVERDUE_MS = WAITING_OVERDUE_HOURS * 3_600_000;

// A last message that needs no reply. A Postgres regex, matched (case-
// insensitively) against the whole message.
export const NO_REPLY_NEEDED_REGEX =
  '^[[:space:]]*(ok|okay|okk|k|kk|thanks?|thank you|thankyou|thx|ty|ok thanks?|ok thank you|noted|fine|done|bye|shukriya|dhanyavad|dhanyawad|theek hai|thik hai|ji|hmm)[[:space:].!,]*$';

// An AI message that is NOT an answer to the customer, matched (case-insensitively)
// against the AI's last visible message: the apology sent when every model failed
// (AI_BUSY_REPLY in ai.ts, older wording too) and "let me get that confirmed by our
// team", which promises a follow-up the AI never turned into an escalation. A chat
// ending in one of these has been answered by nobody. The auto-close (auto-close.ts)
// treats it as still waiting, so it is never closed over the customer's head. The
// inbox's Waiting timer and its Unread filter use it too (conversations route, 2026-10-01). No apostrophes: it goes into SQL.
// Since 2026-10-02 (owner, fake / invalid tracking claims) also the new-tracking-link promise and
// the reminder (tracking-claim.ts promiseReply / reminderReply, English / Hinglish / Hindi): the
// team still owes that customer the link, so a Ship again chat stays waiting (and is never
// auto-closed) until a team member writes. Stricter, never looser.
// Since 2026-10-02 18:45 (owner, chargeback / court / police threats on a late order) also Chikki's refund
// promise and its one reminder (refund-threat.ts refundPromiseReply / refundReminderReply, all three
// languages): the team still owes that customer the refund form, so the Refund chat stays waiting.
// Since 2026-10-05 (owner, the closed-hours note for an upset customer, closed-hours.ts): "our team
// will sit down with / take up your case" and the Hinglish "sabse pehle aapka case" (the same text
// as CLOSED_NOTE_REGEX there; unit.js compares them). The team owes that customer the Monday-morning
// (or next-morning) answer, so the chat stays waiting. Stricter, never looser.
export const AI_NOT_AN_ANSWER_REGEX =
  '^sorry, that took longer than expected|(get|have|let me|will|can)[^.]{0,30}confirm[a-z]*[^.]{0,30}(team|colleague)' +
  '|(naya|new|नया) (tracking link|ट्रैकिंग लिंक)[^.]{0,80}24-48' +
  '|processing your refund|refund process kar rah|रिफंड प्रोसेस कर रह' +
  '|(sit down with|take up) your case|sabse pehle aapka case' +
  // Since 2026-10-10 (owner, Chikki review: every model down, a visitor gets ai-down.ts aiDownVisitorReply instead of
  // "took longer"): the same as AI_DOWN_REGEX there (unit.js compares them). Nobody has answered such a visitor yet.
  '|thanks for writing to [^!]{1,60}! (please share your order id|we have your order id)|ko message karne ke liye shukriya!';

export type WaitingLevel = 'fresh' | 'soon' | 'overdue';

export function waitingLevel(ms: number): WaitingLevel {
  return ms >= WAITING_OVERDUE_MS ? 'overdue' : ms >= 3_600_000 ? 'soon' : 'fresh';
}

// "12 min", "3h 20m", "13h", "3 d": short enough for a list row.
export function formatWaiting(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 10) return `${h}h ${min % 60}m`;
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)} d`;
}
