// ── The delay answer ladder ────────────────────────────────────
// Asked for by the owner on 2026-09-30: when a verified customer keeps asking about
// a late order, the reason given must not be the same sentence again and again, and it
// must not be made up by the model. The owner's own reasons, in the order they grow
// more serious: the festive season's courier volume, then heavy load on the courier
// network, then the delivery agent not being reachable yet. Which one is given is
// worked out here, in code, from how late the order is and how many times the customer
// has asked, so it is the same every time for the same situation. The model is only
// told which reason to use (delayNote) and puts it in the customer's language.
// This file has no imports: ai.ts and the tests share it.

// A customer message that asks about timing: "kab aayega", "still not received",
// "why late", "abhi tak nahi aaya", "how long".
const DELAY_ASK = /\b(late|delay|delayed|delaying|kab|kb|when will|when is|how long|abhi tak|still not|not received|nahi aaya|nahi mila|nhi aaya|kitna time|kitne din|wait|waiting|arrive|reach|pahunch|pahuch)\b|देर|कब|अभी तक|नहीं आया/i;

export function isDelayAsk(text: string | null | undefined): boolean {
  return DELAY_ASK.test(String(text || '').slice(0, 1500));
}

// How many of the customer's own messages ask about timing, the latest included.
export function delayAsksIn(rows: { sender: string; content: string | null }[]): number {
  return rows.filter((r) => r.sender === 'visitor' && isDelayAsk(r.content)).length;
}

export type DelayStage = 0 | 1 | 2 | 3;

// 0 = no reason needed yet (status, estimated date and tracking link only).
// How late the order is: daysToEta is the days until the estimated delivery date
// (negative once it has passed). How often they asked: the 2nd ask gives stage 1, the
// 3rd stage 2, the 4th stage 3. The later of the two wins. `pageStage` (owner 2026-10-04):
// once the tracking page shows the order as late it has already chosen a reason for that
// day (journey.ts "Late orders", same sentences as below); the chat then starts from that
// one, so the customer reads one story on the page and in the chat. Asking again still
// moves up the ladder.
export function delayStage(input: { daysToEta: number; asks: number; pageStage?: number | null }): DelayStage {
  const { daysToEta, asks } = input;
  const page = (input.pageStage || 0) as DelayStage;
  const byDate: DelayStage = page > 0 ? page : daysToEta > 2 ? 0 : daysToEta >= -1 ? 1 : daysToEta >= -4 ? 2 : 3;
  const byAsks: DelayStage = asks >= 4 ? 3 : asks === 3 ? 2 : asks === 2 ? 1 : 0;
  return Math.max(byDate, byAsks) as DelayStage;
}

// Identical to LATE_REASONS in src/lib/journey.ts (the tracking page's banner); unit.js
// compares them, so change both together.
export const DELAY_REASONS: Record<1 | 2 | 3, string> = {
  1: 'Because of the festive season, courier volume is very high right now, so some deliveries are taking a little longer than usual.',
  2: 'The courier network is under very heavy load right now, so parcels are waiting longer at the hubs before they move on.',
  3: 'We have not been able to connect with the delivery agent for your area yet. Our team is following it up, and the tracking link shows any movement.',
};

// The instruction added to the system prompt for this reply. '' when there is nothing to add.
export function delayNote(stage: DelayStage): string {
  if (stage === 0) return '';
  return `

DELAY ANSWER (the owner's ladder: this overrides any saved answer about delays)
The customer is asking about the timing of their order. Give the current stage, the estimated date (call it estimated) and the tracking link from the lookup, and explain the wait with exactly this reason, in the customer's language and in your own words, adding no other cause and promising no date:
"${DELAY_REASONS[stage]}"
Do not repeat a reason you gave earlier in this chat: if they ask again they will be given the next one. Do not say the order arrives today or tomorrow, and promise no action beyond what the reason itself says. Write the whole reply in the language the customer wrote in (Hinglish stays Hinglish).`;
}
