// ── Introducing ourselves once ─────────────────────────────────
// Every prompt says to introduce ourselves in the first reply only, and the
// model still re-opened about 2% of later replies with "Hi! I'm Karry from the
// Vastora team 😊" (141 of 7,453 in the week to 2026-09-29), usually with its
// first greeting right there in the history. So once we have replied, the model
// gets a one-line reminder (ALREADY_REPLIED_NOTE), and any introduction that
// still comes back is taken off the front of the reply.
// No imports: this file is small on purpose, so it can be tested on its own.

export const ALREADY_REPLIED_NOTE =
  '\n\nYou have already replied in this conversation. Do not introduce yourself or say who you are again; answer their latest message directly.';

// "Hi! I'm Karry from the Vastora team 😊", "Hi Priya! 😊 I'm Karry from the
// Vastora team.", "I am Karry from Vastora.", "…from the Vastora team, and I'm
// here to help", "…team — I handle orders". It has to be I'm + a capitalised
// name + from + a capitalised store name (+ team), ending at punctuation, an
// emoji, a line break, ", and" or a dash — so "Hi! I'm sorry…", "I'm
// checking…" or "I'm writing from our office…" are never touched.
const INTRODUCTION = /^\s*(?:(?:[Hh]i|[Hh]ello|[Hh]ey|[Nn]amaste)\b[^!?.,\n]{0,40}[!.,]\s*)?(?:😊\s*)?I(?:['’]m|\s+am)\s+[A-Z][a-z]+\s+from\s+(?:the\s+)?[A-Z][\w'’&-]*(?:\s+[A-Z][\w'’&-]*){0,3}(?:\s+[Tt]eam)?(?=\s*(?:[.!]|😊|\n|$|[—–-]\s|,\s*and\s))\s*(?:[.!]|[—–-]|,\s*and\b)?\s*(?:😊\s*)?/u;

// The stock question that usually follows the introduction.
const OPENING_QUESTION = /^how (?:else )?can i help you(?: with your order)?(?: today)?\s*\?\s*(?:😊\s*)?/iu;

const HELLO_AGAIN = 'Hi again! 😊 How else can I help you with your order?';

export function dropRepeatedIntroduction(reply: string): string {
  const intro = reply.match(INTRODUCTION);
  if (!intro) return reply;
  let rest = reply.slice(intro[0].length);
  const question = rest.match(OPENING_QUESTION);
  if (question) rest = rest.slice(question[0].length);
  rest = rest.trim();
  // The introduction was the whole reply, e.g. to a second "hi".
  if (!rest) return HELLO_AGAIN;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}
