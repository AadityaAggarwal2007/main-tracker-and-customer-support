// ── Two checks on every reply, made in code (owner, 2026-10-01) ─────────────────────
// The prompt already says both; the model still slipped in live tests, so the reply is fixed
// here, the same way today-promise.ts and order-mention.ts do it. Pure: only address-conflict.ts
// and escalation.ts, both without imports. Tested offline (scripts/ai-tests).
//
// 1. dropAddressEcho: the agent must not repeat an address the customer typed (the prompt's
//    ADDRESS CHANGE section: "ask them to type the correct address, do not repeat it back").
//    A run of words the reply copies from a message of the customer that looks like an address
//    (addressIn) is taken out, when it carries a place name, a house number or a PIN code.
//    Ordinary words the two share ("your new address is noted") are never touched.
// 2. withCheckAround: an order the team marked Delivered that the customer says they did not
//    get: before anything else, the customer is asked ONCE to check with family, neighbours,
//    security or reception (the prompt's DELIVERY PROBLEMS section). If the agent has not asked
//    it in this chat yet and the reply does not ask it, the line is added.
import { addressIn } from './address-conflict';
import { looksHinglish } from './escalation';

const ADDRESS_HINT = /^(?:road|rd|street|st|sector|nagar|colony|lane|marg|gali|chowk|block|phase|flat|house|plot|apartment|apartments|apt|society|tower|wing|floor|building|bldg|village|vpo|dist|district|tehsil|enclave|vihar|puram|ganj|bazar|market|near|opp|opposite|landmark|pin|pincode|hno|extension)$/;

interface Tok { w: string; start: number; end: number }

function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  const re = /[\p{L}\p{N}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ w: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  return out;
}

export function dropAddressEcho(reply: string, customerTexts: string[]): { text: string; changed: boolean } {
  if (!reply || !customerTexts.length) return { text: reply, changed: false };
  const addresses = customerTexts
    .map((t) => ({ t, guess: addressIn(t) }))
    .filter((x): x is { t: string; guess: NonNullable<ReturnType<typeof addressIn>> } => !!x.guess);
  if (!addresses.length) return { text: reply, changed: false };

  const rt = tokens(reply);
  const spans: [number, number][] = [];
  for (const { t, guess } of addresses) {
    const at = tokens(t).map((x) => x.w);
    const joined = ` ${at.join(' ')} `;
    const placeWord = (w: string) => guess.words.has(w);
    const digits = (w: string) => /\d/.test(w);
    for (let i = 0; i < rt.length; i++) {
      // The longest run starting at i that the customer's address message also has, in order.
      let j = i;
      while (j < rt.length && joined.includes(` ${rt.slice(i, j + 1).map((x) => x.w).join(' ')} `)) j++;
      // Only the address itself: generic words at either end ("naya address", "is") stay.
      const specific = (w: string) => placeWord(w) || digits(w) || ADDRESS_HINT.test(w);
      let a = i, b = j - 1;
      while (a <= b && !specific(rt[a].w)) a++;
      while (b >= a && !specific(rt[b].w)) b--;
      const run = a <= b ? rt.slice(a, b + 1).map((x) => x.w) : [];
      if (!run.length) continue;
      const hasPlace = run.some(placeWord);
      const hasDigit = run.some(digits);
      const hasHint = run.some((w) => ADDRESS_HINT.test(w));
      const isPin = run.length === 1 && guess.pin !== null && run[0] === guess.pin;
      const ok = isPin
        || (run.length >= 3 && (hasPlace || hasDigit))
        || (run.length === 2 && (hasDigit || (hasPlace && hasHint)));
      if (ok) {
        spans.push([rt[a].start, rt[b].end]);
        i = j - 1;
      }
    }
  }
  if (!spans.length) return { text: reply, changed: false };

  // Right after the word "address" / "pata" the place is just dropped ("your address 12 MG Road
  // is noted" -> "your address is noted"); anywhere else it becomes "the address you shared".
  // In the reply's own language (a Hinglish customer may get an English reply).
  const hinglish = looksHinglish(reply) || /\b(?:aapka|aapki|aapke|naya|nayi|liya|maine|humne|hamari)\b/i.test(reply);
  const stand = hinglish ? 'aapka bataya hua address' : 'the address you shared';
  spans.sort((a, b) => b[0] - a[0]);
  let text = reply;
  for (const [s, e] of spans) {
    // "address X", "address: X", "address as X", "address noted is X".
    const lead = text.slice(Math.max(0, s - 40), s);
    const afterAddressWord = /\b(?:address|addr|pata)\b(?:\s+(?:noted|saved|updated|likha))?\s*(?:as|is|hai|=)?[\s:–—-]*["'“‘(]?\s*$/i.test(lead) || /पता[\s:–—-]*$/.test(lead);
    // "Sector 21 ka address", "MG Road's address", "Pune wala address": the word address follows.
    const before = text.slice(e).match(/^\s*["'”’)]?\s*(?:'s|ka|ki|ke|wala|wali|vala|vali)?\s*(?=(?:address|addr|pata)\b)/i);
    if (!afterAddressWord && before) {
      text = text.slice(0, s) + text.slice(e + before[0].length);
      continue;
    }
    text = text.slice(0, s) + (afterAddressWord ? '\u0000' : '\u0001') + text.slice(e);
  }
  text = text
    // "Your new address: X." -> "Your new address is noted."
    .replace(/\b(address|pata)\s*[:–—-]\s*["'“‘(]?\s*\u0000\s*["'”’)]?\s*(?=[.!?]|$)/gi, hinglish ? '$1 note kar liya hai' : '$1 is noted')
    // "address as X and" / "address noted is X." : the connector goes with the place.
    .replace(/\b((?:address|addr|pata)(?:\s+(?:noted|saved|updated|likha))?)\s+(?:as|is|hai|=)\s*["'“‘(]?\s*\u0000/gi, '$1\u0000')
    .replace(/\u0001/g, stand)
    .replace(/["“‘']\s*(the address you shared|aapka bataya hua address)\s*["”’']/g, '$1')
    .replace(/(?:,\s*)+(?=[.!?]|$)/g, '')
    // The separators that framed the address: "the address — X — and", "address: X.", "(X)", "'X'".
    .replace(/[\s,:;–—-]*["'“”‘’(]?\s*\u0000\s*["'“”‘’)]?[\s,;–—-]*(?=[.!?]|$)/g, '')
    .replace(/\s*[,:;–—-]?\s*["'“”‘’(]?\s*\u0000\s*["'“”‘’)]?\s*[,;–—-]?\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/([.!?])\s*[,;:]\s*/g, '$1 ')
    .trim();
  // Fix the capital letter of a sentence that now starts with the remaining word.
  text = text.replace(/(^|[.!?]\s+)([a-z])/g, (m, pre: string, c: string) => pre + c.toUpperCase());
  if (!text.replace(/[^\p{L}\p{N}]/gu, '') || text.replace(/[^\p{L}\p{N} ]/gu, '').trim().toLowerCase() === stand.toLowerCase()) {
    text = looksHinglish(customerTexts.join(' ')) ? 'Maine aapka bataya hua address note kar liya hai.' : "I've noted the address you shared.";
  }
  return { text, changed: true };
}

// The customer says the parcel did not reach them.
const NOT_RECEIVED = [
  /\b(?:not|never|didn'?t|did not|haven'?t|have not|hasn'?t|has not|no one|nobody)\b[^.?!\n]{0,25}\b(?:receiv\w*|got|get|arriv\w*|come|came|reach\w*|deliver\w*)\b/i,
  /\b(?:nahi|nahin|nhi|na|nai)\s+(?:mila|mili|mile|aaya|aayi|aya|ayi|aaye|pahuncha|pahunchi|pohcha)\b/i,
  /\b(?:mila|mili|aaya|aya|aayi|receive|deliver)\s+(?:hi\s+)?(?:nahi|nhi|nahin|nai)\b/i,
  /\b(?:missing|lost|kho gaya|gum)\b/i,
  /\b(?:deliver\w*|delivery)\s+(?:nahi|nhi|nahin)\s+(?:hui|hua|huyi|hu[ia])\b/i,
  /(?:नहीं मिला|नहीं मिली|नहीं आया|नहीं आई)/,
];
const ASKS_AROUND = /\b(?:family|neighbou?rs?|security|reception|guard|watchman|padosi|parivaar|pariwar|ghar (?:ke|wal\w*)|aas.?paas|nearby|gate)\b/i;
const CLOSING = /\n*\s*(?:anything else[^\n]*|is there anything else[^\n]*|kuch aur[^\n]*|aur koi[^\n]*)$/i;

// "Refund nahi mila", "email not received": about money or a message, not the parcel.
const NOT_PARCEL = /\b(?:refund|money|paisa|paise|payment|amount|otp|e-?mail|mail|sms|message|msg|call|link|reply|response|invoice|bill|update|tracking)\b/i;
const PARCEL = /\b(?:parcel|package|packet|order|item|product|saman|samaan|jhumk\w*|earring\w*|delivered|delivery)\b/i;

export function saysNotReceived(text: string): boolean {
  const t = text || '';
  if (!NOT_RECEIVED.some((re) => re.test(t))) return false;
  return !(NOT_PARCEL.test(t) && !PARCEL.test(t));
}

export function checkAroundLine(customerText: string): string {
  return looksHinglish(customerText)
    ? 'Kabhi-kabhi delivered parcel ghar ke kisi member, padosi, security guard ya reception ke paas aa jata hai. Please ek baar unse check kar lijiye.'
    : 'Sometimes a delivered parcel is received by a family member, a neighbour, the security guard or reception. Could you please check with them once?';
}

export function withCheckAround(reply: string, ctx: {
  customerLatest: string;      // the customer's latest messages, joined
  orderDelivered: boolean;     // an order in this chat is marked Delivered
  earlierAgentReplies: string[];
}): { text: string; changed: boolean } {
  if (!reply || !ctx.orderDelivered || !saysNotReceived(ctx.customerLatest)) return { text: reply, changed: false };
  if (ASKS_AROUND.test(reply) || ctx.earlierAgentReplies.some((r) => ASKS_AROUND.test(r || ''))) return { text: reply, changed: false };
  const line = checkAroundLine(ctx.customerLatest);
  const close = reply.match(CLOSING);
  if (close && close.index !== undefined && close.index > 0) {
    const body = reply.slice(0, close.index).trimEnd();
    return { text: `${body}\n\n${line}\n\n${close[0].trim()}`, changed: true };
  }
  return { text: `${reply.trimEnd()}\n\n${line}`, changed: true };
}

// 3. withoutUnaskedCourier (owner, 2026-10-01): the courier (Valmo for Vastora) is named only when
//    the customer asks which courier / platform / company delivers. Every order now carries a
//    courier (courier.ts), so without this the agent said "shipped via Valmo" to everyone. When
//    they did not ask, the name becomes "our courier partner". Links are never touched.
const ASKS_COURIER = /\b(?:courier|couriers|logistic\w*|platform|partner|company|carrier|valmo|volmo|delhivery|blue\s?dart|ekart|shadowfax|xpressbees|dtdc|india\s+post|speed\s?post)\b|कूरियर|कंपनी/i;
const ASKS_WHO_DELIVERS = /\b(?:who|kaun|kon|kaunsa|konsa|kis|kisse|kiske)\b[^.?!\n]{0,30}\b(?:deliver\w*|bhej\w*|la\s+raha|aa\s+raha|ship\w*|de\s+raha)\b/i;

export function asksAboutCourier(text: string): boolean {
  return ASKS_COURIER.test(text || '') || ASKS_WHO_DELIVERS.test(text || '');
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function withoutUnaskedCourier(reply: string, customerLatest: string, courierNames: string[]): { text: string; changed: boolean } {
  if (!reply || asksAboutCourier(customerLatest)) return { text: reply, changed: false };
  const names = Array.from(new Set(courierNames.map((n) => String(n || '').trim()).filter((n) => n.length >= 3)));
  const alt = ['v[ao]lmo', ...names.map(esc)].join('|');
  const NAME = `(?:${alt})`;
  if (!new RegExp(`\\b${NAME}\\b`, 'i').test(reply)) return { text: reply, changed: false };
  const hinglish = looksHinglish(reply);
  const partner = hinglish ? 'hamare courier partner' : 'our courier partner';

  // Never inside a link.
  const parts = reply.split(/(https?:\/\/\S+)/g);
  const fixed = parts.map((part, i) => {
    if (i % 2 === 1) return part;
    return part
      // "Courier: Valmo" on its own line
      .replace(new RegExp(`^[ \\t]*(?:courier(?:\\s+partner)?|delivery\\s+partner|logistics(?:\\s+partner)?)\\s*[:\\-–—]\\s*${NAME}[ \\t]*\\.?[ \\t]*(?:\\r?\\n|$)`, 'gim'), '')
      // "our courier partner, Valmo," / "courier partner (Valmo)"
      .replace(new RegExp(`\\b((?:courier|delivery|logistics|shipping)\\s+partner)\\s*[,:(—–-]?\\s*${NAME}\\s*\\)?`, 'gi'), '$1')
      // "Valmo (our courier partner)"
      .replace(new RegExp(`${NAME}\\s*\\(\\s*((?:our|hamare)\\s+(?:courier|delivery|logistics)\\s+partner)\\s*\\)`, 'gi'), '$1')
      // "shipped via Valmo" -> "shipped"
      .replace(new RegExp(`\\s+(?:via|through|with|by)\\s+${NAME}\\b`, 'gi'), '')
      // anything left: the name becomes "our courier partner"
      .replace(new RegExp(`\\b${NAME}(?:'s)?\\b`, 'gi'), (m) => (/'s$/i.test(m) ? `${partner}'s` : partner));
  }).join('');
  const text = fixed
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/(^|[.!?]\s+|\n)(our courier partner|hamare courier partner)/g, (m, pre: string, p: string) => pre + p.charAt(0).toUpperCase() + p.slice(1))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, changed: text !== reply };
}
