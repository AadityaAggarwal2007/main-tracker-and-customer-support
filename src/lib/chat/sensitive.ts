// ── Payment details a customer types into the chat ─────────────
// SHIPTRACK_MASTER_RULES.md section 20: a customer must never be asked for a
// card number, CVV, expiry, OTP, UPI PIN or a bank password, and when one is
// sent anyway it must be hidden from the customer-facing screen and the team,
// must not be stored in plain text, and the customer must be told not to send
// it. This file has no imports: the widget message route and the email poller
// run every customer message through maskSensitive BEFORE it is stored, so the
// database, the AI provider, the subject and health scorers and the inbox only
// ever see the masked text.
//
// A mask that eats the wrong digits would break the flow the owner cares about
// most (order ID + phone to verify), so each pattern needs its own evidence: a
// card number must pass the Luhn check, an OTP / CVV / PIN needs its keyword
// right next to the digits, and a bare digit run is never touched.

export type SensitiveKind = 'card' | 'expiry' | 'cvv' | 'otp' | 'pin' | 'password';

export interface MaskResult {
  text: string;
  kinds: SensitiveKind[];
}

const HIDDEN: Record<SensitiveKind, string> = {
  card: '[card number hidden]',
  expiry: '[expiry hidden]',
  cvv: '[CVV hidden]',
  otp: '[OTP hidden]',
  pin: '[PIN hidden]',
  password: '[password hidden]',
};

const CARD_WORDS = /\b(?:card|credit|debit|visa|master ?card|rupay|amex)\b|कार्ड/i;
// Words that mean the digits are an order, tracking or phone number.
const ID_WORD_BEFORE = /(?:order|awb|tracking|track|consignment|phone|mobile|contact|whatsapp|pin ?code|pincode|zip|postal)\W*(?:id|no|number|num|code)?\W*(?:is|hai|h)?\W*$/i;
// Between a keyword and its digits: a few plain characters, and never a word
// that says the digits are something else ("otp nahi aaya, order 12345678").
const GAP = '(?:(?!order|awb|track|phone|mobile|\\bid\\b)[^\\d\\n]){0,14}';

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

// The number ranges and lengths of the card networks used here (Visa,
// Mastercard, Amex, Diners, JCB, RuPay, UnionPay). Any other digit run, such as
// a timestamp-like reference that happens to pass Luhn, is not a card.
function plausibleIssuer(digits: string): boolean {
  const n = digits.length;
  if (/^4/.test(digits)) return n === 13 || n === 16 || n === 19;
  if (/^(?:5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d\d|27[01]\d|2720)/.test(digits)) return n === 16;
  if (/^3[47]/.test(digits)) return n === 15;
  if (/^(?:30[0-5]|36|38|39)/.test(digits)) return n >= 14 && n <= 16;
  if (/^35/.test(digits)) return n >= 16 && n <= 19;
  if (/^(?:60|62|64|65|81|82|508)/.test(digits)) return n >= 16 && n <= 19;
  return false;
}

// Replace the LAST capture of a match (the value is always at its end).
function hideTail(match: string, value: string, kind: SensitiveKind, found: Set<SensitiveKind>): string {
  found.add(kind);
  return match.slice(0, match.length - value.length) + HIDDEN[kind];
}

// Replace the FIRST capture of a match (the value is always at its start).
function hideHead(match: string, value: string, kind: SensitiveKind, found: Set<SensitiveKind>): string {
  found.add(kind);
  return HIDDEN[kind] + match.slice(value.length);
}

// Customers type ४१११ as often as 4111: read them as ASCII digits (one character
// each, so nothing moves). Only used when something is masked; a message with
// nothing to hide is stored exactly as typed.
const toAscii = (t: string) => t.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966));

export function maskSensitive(input: string): MaskResult {
  const found = new Set<SensitiveKind>();
  if (typeof input !== 'string' || !input) return { text: input, kinds: [] };
  let text = toAscii(input);

  const cardContext = CARD_WORDS.test(text);

  // 1. Card numbers: 13-19 digits in one run, or grouped like a printed card
  //    (4-4-4-4, 4-6-5). Without a card word nearby the number must pass Luhn
  //    and start like a real card, and must not follow "order", "awb", "phone"...
  const cardRun = /(?<![\d#+])(?:\d{13,19}|\d{4}[ \t-]{1,3}\d{4}[ \t-]{1,3}\d{4}[ \t-]{1,3}\d{1,7}|\d{4}[ \t-]{1,3}\d{6}[ \t-]{1,3}\d{4,5})(?!\d)/g;
  text = text.replace(cardRun, (match, offset: number, whole: string) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) return match;
    const ok = cardContext
      ? true
      : luhn(digits) && plausibleIssuer(digits) && !ID_WORD_BEFORE.test(whole.slice(Math.max(0, offset - 25), offset));
    if (!ok) return match;
    found.add('card');
    return HIDDEN.card;
  });

  // 2. OTP, before "password" so "one time password is 123456" is an OTP. The
  //    digits may be spaced one by one ("1 2 3 4 5 6"). A digit run that is part
  //    of a longer spaced group ("98765 43210") or that follows an order, phone
  //    or pin-code word is never an OTP.
  const otpWord = '(?:otp|one[\\s-]?time[\\s-]?(?:password|pin|code)|verification code|ओटीपी)';
  const digits = (min: number, max: number) => `(?:\\d{${min},${max}}|\\d(?: \\d){${min - 1},${max - 1}})`;
  const notIdBefore = (whole: string, offset: number) => !ID_WORD_BEFORE.test(whole.slice(Math.max(0, offset - 25), offset));
  text = text.replace(new RegExp(`(?<![A-Za-z0-9_])${otpWord}${GAP}(${digits(4, 8)})(?![ -]?\\d)`, 'gi'), (m, v: string) => hideTail(m, v, 'otp', found));
  text = text.replace(new RegExp(`(?<![\\d#+])(?<!\\d[ -])(${digits(4, 8)})(?![ -]?\\d)${GAP}\\b${otpWord}`, 'gi'), (m, v: string, offset: number, whole: string) =>
    notIdBefore(whole, offset) ? hideHead(m, v, 'otp', found) : m);

  // 3. PIN: "UPI PIN", "ATM PIN", "mPIN" with 4-6 digits; a bare "pin" only with
  //    exactly 4 digits and never "pin code" (a 6-digit pin code is an address).
  text = text.replace(new RegExp(`\\b(?:upi\\s*pin|atm\\s*pin|debit\\s*card\\s*pin|m-?pin|pin\\s*number)${GAP}(${digits(4, 6)})(?![ -]?\\d)`, 'gi'), (m, v: string) => hideTail(m, v, 'pin', found));
  text = text.replace(new RegExp(`\\bpin\\b(?!\\s*-?code)${GAP}(\\d{4})(?![ -]?\\d)`, 'gi'), (m, v: string) => hideTail(m, v, 'pin', found));

  // 4. CVV / CVC / security code.
  const cvvWord = '(?:cvv2?|cvc2?|security code)';
  text = text.replace(new RegExp(`\\b${cvvWord}${GAP}(\\d{3,4})(?![ -]?\\d)`, 'gi'), (m, v: string) => hideTail(m, v, 'cvv', found));
  text = text.replace(new RegExp(`(?<![\\d#+])(?<!\\d[ -])(\\d{3,4})(?![ -]?\\d)${GAP}\\b${cvvWord}\\b`, 'gi'), (m, v: string, offset: number, whole: string) =>
    notIdBefore(whole, offset) ? hideHead(m, v, 'cvv', found) : m);

  // 5. Expiry: labelled ("exp 12/27", "valid thru 12/2027"), or written right
  //    after a masked card number, and a CVV written right after that expiry.
  //    A bare "exp 12/27" needs card context ("expected by 12/10" and "delivery
  //    expires 5/10" are dates); "valid thru" is a card phrase on its own.
  const expiryContext = cardContext || found.size > 0;
  text = text.replace(/\b(?:(?:expiry|expires?|exp\.?)(?![a-z])|valid\s*(?:thru|till|upto))(?:(?!order|awb|track|phone)[^\d\n]){0,12}(\d{1,2}\s*[\/.-]\s*\d{2,4})(?!\d)/gi, (m, v: string) =>
    expiryContext || /valid/i.test(m) ? hideTail(m, v, 'expiry', found) : m);
  text = text.replace(/(\[card number hidden\](?:(?!order|awb|track|phone)[^\d\n]){0,15})(\d{1,2}\s*[\/.-]\s*\d{2,4})(?!\d)/gi, (m, pre: string, v: string) => {
    found.add('expiry');
    return pre + HIDDEN.expiry;
  });
  text = text.replace(/(\[expiry hidden\](?:[^\d\n]){0,8})(\d{3,4})(?!\d)/g, (m, pre: string, v: string) => {
    found.add('cvv');
    return pre + HIDDEN.cvv;
  });

  // 6. A password or net-banking credential spoken outright: "password is x".
  //    A separator is required so "forgot my password for the site" is left alone.
  text = text.replace(/(?<![A-Za-z0-9_])(?:password|passcode|passwd|pwd|net ?banking (?:id|password)|पासवर्ड)\s*(?:is|hai|=|:|-)\s*(?!\[)(\S+)/gi, (m, v: string, offset: number, whole: string) => {
    // "forgot password: reset?" is a question, not a password.
    if (/[?]$/.test(v) || /(?:forgot|forget|reset|change|lost|recover|bhool\w*)\W*(?:my |the |your )?$/i.test(whole.slice(Math.max(0, offset - 20), offset))) return m;
    return hideTail(m, v, 'password', found);
  });

  if (!found.size) return { text: input, kinds: [] };
  return { text, kinds: Array.from(found) };
}

// Hindi in Devanagari, or Hinglish written in Latin letters.
function looksHinglish(text: string): boolean {
  if (/[ऀ-ॿ]/.test(text)) return true;
  return /\b(?:hai|hain|kya|nahi|nahin|nhi|mera|meri|mere|mujhe|mujhko|bhai|aap|apna|apni|apne|karo|karna|kardo|krdo|kar|karunga|karungi|karenge|karta|karti|hoon|hoga|hogi|ho|hua|hui|hue|gaya|gayi|gaye|gya|bhejo|dena|diya|liya|abhi|kab|kaise|kitna|kaha|kahan|kyun|kyu|paisa|paise|wapas|vapas|chahiye|chahie|chaiye|dijiye|kijiye|batao|jaldi|bilkul|theek|thik|ko|ka|ki|ke|toh|tum|log|lekin|aur|mein|milega|milegi|mila|aaya|aayi|aaye|jaunga|jaungi|dunga|dungi|denge|raha|rahi|rahe|lag)\b/i.test(text);
}

// The line that tells the customer not to send payment details.
export function sensitiveWarning(customerText: string): string {
  return looksHinglish(customerText)
    ? 'Please yahan card details, CVV, OTP ya PIN mat bhejiye. Payment details chat mein share na karein, maine aapki security ke liye ise hata diya hai.'
    : "Please don't share card details, CVV, OTP or PIN in this chat. I've hidden what you sent to keep your payment safe.";
}

// The reply with that line in front. The line is added by code, not left to the
// model, so it never depends on the model remembering.
export function withSensitiveWarning(reply: string, kinds: SensitiveKind[], customerText: string): string {
  if (!kinds.length) return reply;
  const warning = sensitiveWarning(customerText);
  return reply && reply.trim() ? `${warning}\n\n${reply}` : warning;
}
