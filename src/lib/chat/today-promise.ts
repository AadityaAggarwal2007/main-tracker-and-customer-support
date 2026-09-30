// ── "It arrives today" is never said (SHIPTRACK_MASTER_RULES.md: dates) ─────────
// Out for Delivery is a schedule stage that starts a day before the estimated date, not
// a courier scan, and a customer who was told "today" or "by tonight" and got nothing is
// the irritated customer this project exists to prevent. The prompt says so and the
// model still wrote it in 3 of 7 live-prompt tests on 2026-10-01 ("matlab aaj hi
// delivery hone wali hai", "if it hasn't arrived by tonight, message me"), so the reply is
// also checked here, without the model: a sentence that promises or hints at arrival
// today, tonight or tomorrow is dropped. No imports; pure.

const TIME_WORD = /\b(?:today|tonight|tomorrow|aaj|aaj\s+hi|aaj\s+raat|abhi\s+aaj)\b|आज|कल तक/i;
// Words that make the time word about the parcel arriving.
const ARRIVAL = /\b(?:deliver(?:y|ed|ing)?|arriv\w*|reach\w*|receive\w*|come|comes|came|coming|doorstep|aayega|aayegi|aa\s*jayega|aa\s*jaayega|ayega|milega|mil\s*jayega|mil\s*jaayega|pahunch\w*|pohonch\w*|hone\s+wali|hone\s+wala|hoga|ho\s*jayega|ho\s*jaayega|nahi\s+aaya|nhi\s+aaya|parcel|courier)\b|पहुँच|पहुंच|मिल/i;
// A greeting or an offer of help that happens to say "today" is not a promise.
const NOT_A_PROMISE = /\b(?:help|assist|madad|anything else|kuch aur|kuch\s+aur)\b/i;
// "placed today", "ordered today": about the order, not its arrival.
const ABOUT_ORDERING = /\b(?:placed|ordered|order\s+kiya|place\s+kiya|booked)\b[^.!?\n]{0,25}\b(?:today|aaj)\b/i;

function sentences(text: string): string[] {
  // Keep each sentence with its ending and any line breaks that follow it.
  return text.match(/[^.!?\n]+(?:[.!?]+|\n+|$)\s*/g) || [text];
}

export function promisesToday(text: string): boolean {
  return sentences(text).some((s) => isPromise(s));
}

function isPromise(sentence: string): boolean {
  if (!TIME_WORD.test(sentence)) return false;
  if (NOT_A_PROMISE.test(sentence) && !/\b(?:deliver|arriv|reach|aayega|milega)\w*\b/i.test(sentence)) return false;
  if (ABOUT_ORDERING.test(sentence) && !/\b(?:deliver(?:y|ed)?|arriv\w*|reach\w*)\b.*\b(?:today|tonight|aaj)\b/i.test(sentence)) return false;
  return ARRIVAL.test(sentence) || /\btonight\b|aaj\s+raat/i.test(sentence);
}

// The reply without those sentences. `fallback` is used when nothing is left.
export function dropTodayPromise(text: string, fallback: string): string {
  const kept = sentences(text).filter((s) => !isPromise(s)).join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return kept || fallback;
}
