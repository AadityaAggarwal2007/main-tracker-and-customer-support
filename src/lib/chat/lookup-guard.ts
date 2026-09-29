// ── Making sure a typed order ID + last 4 gets looked up ───────
// On the evening of 2026-09-28 deepseek-v4-flash mostly stopped putting
// together an order ID and last 4 digits sent in separate messages: a bare
// "3335" right after "could you share the last 4 digits?" led to a lookup 72%
// of the time that day and 13% the next, and the rest of the time it just asked
// again. Nothing ever broke that loop, so those chats sat in ai_handling and
// staff never saw them. These helpers read the same rows getAIResponse loads,
// notice when the customer has already typed both, and let ai.ts force the
// lookup (with values the customer actually typed) or hand the chat to a
// person. lookupOrder's own order ID + last-4 rule is not touched.
// No imports: this file is small on purpose, so it can be tested on its own.

export interface GuardRow {
  sender: string;
  content: string | null;
  metadata?: {
    hidden?: unknown;
    withheld?: unknown;
    tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
    tool_call_id?: string;
  } | null;
}

export interface PendingLookup { identifier: string; last4: string }

/** What a lookup made during this request came back with. */
export interface LookupOutcome { found?: boolean; needs_verification?: boolean }

// Customers typing in Hindi send ३३३५ as often as 3335.
export function normaliseDigits(text: string): string {
  return text.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966));
}

// ── Did the reply ask for the order ID or the last 4? ──────────
const ASKS_LAST4 = [
  /\blast\s*(?:4|four)\b/,                                   // last 4 digits, last four digits
  /\blast\s+ke\s+(?:4|four|char|chaar)\b/,                   // last ke 4 digit
  /\ba{1,2}khi?ri\s*(?:4|four|char|chaar)\b/,                // aakhri 4, akhri 4
  /(?:आखिरी|आख़िरी|अंतिम|लास्ट)\s*(?:के\s*)?(?:4|चार)/,        // आखिरी 4 अंक
];
const ASKS_ORDER_ID = [
  /\border\s*(?:id|number|num|no)\b/,                        // Order ID, order number, order no
  /\btracking\s*id\b/,
  /(?:ऑर्डर|आर्डर|order)\s*(?:आईडी|आई\s*डी|नंबर|संख्या)/,       // ऑर्डर आईडी
];
// Mentioning an order ID is not asking for one ("Your order ID #1234 is…"),
// so there has to be a question or a request in the same message.
const REQUEST = /\?|\b(?:share|send|provide|give|tell|type|enter|confirm|check|need|please|pls|plz|could|can you|may i|mention|bata\w*|bhej\w*|dijiye|dijie|dein|de do|chahiye|kripya)\b|कृपया|बता|भेज|दीजिए|दें|चाहिए|साझा|शेयर/;

export function asksForOrderDetails(text: string | null | undefined): { orderId: boolean; last4: boolean } {
  const t = normaliseDigits(text || '').toLowerCase();
  if (!REQUEST.test(t)) return { orderId: false, last4: false };
  return {
    orderId: ASKS_ORDER_ID.some((re) => re.test(t)),
    last4: ASKS_LAST4.some((re) => re.test(t)),
  };
}

// ── Reading what the visitor typed ─────────────────────────────
interface Token {
  key: string;        // row:offset — two tokens are "different" when these differ
  row: number;
  value: string;      // as it should be looked up: STAB12CD34EF, #1598, 1598
  digits: string;     // the 4 digits it gives as a last-4 candidate, if any
  id: boolean;        // can be the order ID / tracking ID
  last4: boolean;     // can be the last 4 digits
  bare?: boolean;     // a plain number, read only from what the AI had asked
}

const isAlnum = (c: string | undefined) => !!c && /[A-Za-z0-9]/.test(c);

// A phone number as a customer types it: 9876543210, 09876543210,
// +91 98765 43210, 98765-43210, 987-654-3210. Returns the 10-digit number.
function tenDigits(raw: string): string | null {
  let d = raw.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d.length === 10 ? d : null;
}

const PHONE_SHAPES = [
  /\+?91[\s-]?\d{5}[\s-]?\d{5}/g,
  /\d{10,12}/g,
  /\d{5}[\s-]\d{5}/g,
  /\d{3}[\s-]\d{3}[\s-]\d{4}/g,
];

// Runs one pattern over the text, skipping matches that sit inside a longer
// word or number or overlap something already taken. accept() says whether
// the match counts; if it does, its characters are taken.
function scan(re: RegExp, text: string, used: boolean[], accept: (m: RegExpExecArray) => boolean) {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (!m[0]) { re.lastIndex++; continue; }
    if (isAlnum(text[start - 1]) && isAlnum(text[start])) continue;
    if (isAlnum(text[end]) && isAlnum(text[end - 1])) continue;
    let clash = false;
    for (let i = start; i < end; i++) if (used[i]) { clash = true; break; }
    if (clash || !accept(m)) continue;
    for (let i = start; i < end; i++) used[i] = true;
  }
}

function phonesIn(text: string, used: boolean[]): { at: number; phone: string }[] {
  const out: { at: number; phone: string }[] = [];
  for (const re of PHONE_SHAPES) {
    scan(re, text, used, (m) => {
      const phone = tenDigits(m[0]);
      if (!phone) return false;
      out.push({ at: m.index, phone });
      return true;
    });
  }
  return out;
}

// The widget takes messages of any length and this runs on every turn, so the
// text is capped and every run of spaces made one space: the patterns below
// then use " ?" instead of \s*, which backtracked for a minute on "order"
// followed by a few thousand spaces.
function prep(content: string): string {
  return normaliseDigits(content.slice(0, 2000)).replace(/\s+/g, ' ');
}

// Customers label the number themselves: "mobile no 3473", "Last four digit of
// my phone no. Is 8204", "5175 hain order number", "ID 4813". That beats
// reading it from what the AI last asked.
const LAST4_LABELLED = /\b(?:last ?(?:4|four|char)(?: ?digits?)?(?: (?:of|ke|ka) (?:my |mere |meri )?(?:phone|mobile|mob|number)\.?(?: ?(?:no|number)\.?)?)?|(?:phone|mobile|mob)(?: ?(?:no|number|num)\.?)?)(?: ?(?:is|are|hai|hain|:|-|=))? ?(\d{4})\b/gi;
const ID_BEFORE_LABEL = /\b(\d{4,5}) ?(?:hai|hain|is)? ?(?:my |mera )?order ?(?:id|no|number)\b/gi;
const ID_LABELLED = /\bid ?(?:is|hai|:|-|=)? ?(\d{4,5})\b/gi;
// Prices, pincodes and OTPs are numbers too, and not ones to look up.
const NOT_ORDER_DETAILS = /₹|\b(?:rs|inr|rupees?|rupaye|pin ?code|pin|otp|code)\b/i;

// A bare number only means something in a reply that is little more than the
// number ("3335", "1598 hai"). In a sentence or an email it is as likely a
// price, a pincode, a date or a signature.
function isShortReply(text: string): boolean {
  const words = text.match(/[A-Za-z\u0900-\u0965\u0970-\u097F]+/g) || [];
  return words.length <= 3 && !NOT_ORDER_DETAILS.test(text);
}

// Part of a date, a time or a link: 29/09/2026, 27.09.2026, 09:56, /2019/.
function partOfSomethingElse(text: string, start: number, end: number): boolean {
  const prev = text[start - 1] || '';
  const next = text[end] || '';
  if (prev === '/' || next === '/') return true;
  if (/[.:-]/.test(prev) && /\d/.test(text[start - 2] || '')) return true;
  return /[.:-]/.test(next) && /\d/.test(text[end + 1] || '');
}

// Everything in one visitor message that could be the order ID or the last 4.
// askedId / askedLast4: whether the AI message just before it asked for them,
// which is the only thing that gives a bare number a meaning — order numbers
// are 4 digits too (#1002–#6821), so a lone "1598" could be either.
function tokensIn(content: string, row: number, askedId: boolean, askedLast4: boolean): Token[] {
  const text = prep(content);
  const used: boolean[] = new Array(text.length).fill(false);
  const found: { at: number; token: Token }[] = [];
  const add = (at: number, t: Omit<Token, 'key' | 'row'>) => found.push({ at, token: { key: `${row}:${at}`, row, ...t } });

  for (const p of phonesIn(text, used)) {
    add(p.at, { value: p.phone, digits: p.phone.slice(-4), id: false, last4: true });
  }
  // ST + 10 letters/digits is a tracking ID. Typed in lower case it could be an
  // English word ("strengthened"), so then it needs a digit in it.
  scan(/#? ?(ST[A-Z0-9]{10})\b/gi, text, used, (m) => {
    const v = m[1];
    if (!/\d/.test(v) && v !== v.toUpperCase()) return false;
    add(m.index, { value: v.toUpperCase(), digits: '', id: true, last4: false });
    return true;
  });
  scan(/# ?(D\d{2,7})\b/gi, text, used, (m) => {
    add(m.index, { value: '#' + m[1].toUpperCase(), digits: '', id: true, last4: false });
    return true;
  });
  scan(/# ?(\d{2,7})/g, text, used, (m) => {
    add(m.index, { value: '#' + m[1], digits: '', id: true, last4: false });
    return true;
  });
  scan(/\border ?(?:id|number|num|no)?\.? ?(?:is|hai|:|-|=)? ?(\d{3,7})/gi, text, used, (m) => {
    add(m.index, { value: m[1], digits: '', id: true, last4: false });
    return true;
  });
  scan(/(?:ऑर्डर|आर्डर) ?(?:आईडी|नंबर|संख्या)? ?(?:है|:|-)? ?(\d{3,7})/g, text, used, (m) => {
    add(m.index, { value: m[1], digits: '', id: true, last4: false });
    return true;
  });
  scan(LAST4_LABELLED, text, used, (m) => {
    add(m.index, { value: m[1], digits: m[1], id: false, last4: true });
    return true;
  });
  for (const re of [ID_BEFORE_LABEL, ID_LABELLED]) {
    scan(re, text, used, (m) => {
      add(m.index, { value: m[1], digits: '', id: true, last4: false });
      return true;
    });
  }
  // Whatever is left: a bare number means what the AI had just asked for.
  if (isShortReply(text)) {
    scan(/\d+/g, text, used, (m) => {
      const d = m[0];
      if (partOfSomethingElse(text, m.index, m.index + d.length)) return false;
      const id = askedId && (d.length === 4 || d.length === 5);
      const last4 = askedLast4 && d.length === 4;
      if (!id && !last4) return false;
      add(m.index, { value: d, digits: last4 ? d : '', id, last4, bare: true });
      return true;
    });
  }
  // In the order they were typed, so "most recent" means what it says.
  return found.sort((a, b) => a.at - b.at).map((f) => f.token);
}

// ── Reading the stored conversation ────────────────────────────
function isVisibleReply(r: GuardRow): boolean {
  if (r.sender !== 'ai' && r.sender !== 'agent') return false;
  if (!(r.content || '').trim()) return false;
  const h = r.metadata?.hidden;
  if (h === true || h === 'true') return false;
  // An email draft that was held back never reached the customer.
  return !r.metadata?.withheld;
}

function parseJson(s: string | null | undefined): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s || '');
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

function lastFoundIndex(rows: GuardRow[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].sender === 'tool_result' && parseJson(rows[i].content)?.found === true) return i;
  }
  return -1;
}

// Tokens from visitor messages after row `from`, each read against the AI
// message just before it.
function visitorTokens(rows: GuardRow[], from: number): Token[] {
  let asked = { orderId: false, last4: false };
  const out: Token[] = [];
  rows.forEach((r, i) => {
    if (isVisibleReply(r)) asked = asksForOrderDetails(r.content);
    else if (r.sender === 'visitor' && i > from) out.push(...tokensIn(r.content || '', i, asked.orderId, asked.last4));
  });
  return out;
}

// The most recent order ID and the most recent last 4, never the same number.
function bestPair(tokens: Token[]): { id: Token; l4: Token } | null {
  // Once they have written an ID out (ST…, #1598, "order no 1598"), a later
  // bare number is them re-sending the last 4, not a new order number.
  const allIds = tokens.filter((t) => t.id);
  const written = allIds.filter((t) => !t.bare);
  const ids = written.length ? written : allIds;
  const l4s = tokens.filter((t) => t.last4);
  if (!ids.length || !l4s.length) return null;
  // Two different numbers. The same digits sent twice, or a bare number that is
  // also the end of their phone, is one answer: in the replay such pairs fired
  // on 17% of turns and were never an order.
  const fits = (i: Token, l: Token) => i.key !== l.key && normId(i.value) !== l.digits;
  const I = ids[ids.length - 1];
  const L = l4s[l4s.length - 1];
  if (I.key !== L.key) {
    const l = l4s.filter((t) => fits(I, t)).pop();
    return l ? { id: I, l4: l } : null;
  }
  const I2 = ids.filter((t) => fits(t, L)).pop();
  const L2 = l4s.filter((t) => fits(I, t)).pop();
  const order = (t: Token) => tokens.indexOf(t);
  // Both readings fit ("1598", then "3335"): customers give the order ID first.
  if (I2 && (!L2 || order(I2) >= order(L2))) return { id: I2, l4: L };
  if (L2) return { id: I, l4: L2 };
  return null;
}

export const normId = (s: unknown) => normaliseDigits(String(s ?? '')).toLowerCase().replace(/[#\s]/g, '');
const last4Of = (s: unknown) => normaliseDigits(String(s ?? '')).replace(/\D/g, '').slice(-4);

interface TriedLookup { order_id: string; last4: string; callId: string }

function lookupCalls(rows: GuardRow[]): TriedLookup[] {
  const out: TriedLookup[] = [];
  for (const r of rows) {
    if (r.sender !== 'ai') continue;
    for (const tc of r.metadata?.tool_calls || []) {
      if (tc?.function?.name !== 'lookup_order') continue;
      const a = parseJson(tc.function.arguments) || {};
      out.push({ order_id: normId(a.order_id), last4: last4Of(a.phone_last4), callId: tc.id || '' });
    }
  }
  return out;
}

// The same two values, either way round.
function samePair(t: TriedLookup, id: string, l4: string): boolean {
  const i = normId(id);
  return (t.order_id === i && t.last4 === l4) || (t.order_id === l4 && t.last4 === i);
}

/**
 * The order ID and last 4 the customer has typed and we have not yet looked
 * up, while our last message was still asking for them. Null otherwise.
 */
export function findPendingLookup(rows: GuardRow[]): PendingLookup | null {
  let lastReply: GuardRow | null = null;
  for (let i = rows.length - 1; i >= 0 && !lastReply; i--) if (isVisibleReply(rows[i])) lastReply = rows[i];
  const asked = asksForOrderDetails(lastReply?.content);
  if (!asked.orderId && !asked.last4) return null;

  const pair = bestPair(visitorTokens(rows, lastFoundIndex(rows)));
  if (!pair) return null;
  if (lookupCalls(rows).some((t) => samePair(t, pair.id.value, pair.l4.digits))) return null;
  return { identifier: pair.id.value, last4: pair.l4.digits };
}

/**
 * Whether a lookup_order call uses only values the customer typed (or an order
 * an earlier successful lookup returned). The model has been seen to fill in
 * digits nobody sent; a forced call must not be allowed to guess.
 */
export function typedByVisitor(args: { order_id?: unknown; phone_last4?: unknown }, rows: GuardRow[]): boolean {
  const id = normId(args.order_id);
  const l4raw = normaliseDigits(String(args.phone_last4 ?? '')).replace(/\D/g, '');
  if (!id || !l4raw) return false;

  const words = new Set<string>();
  const fours = new Set<string>();
  const phones: string[] = [];
  rows.forEach((r, row) => {
    if (r.sender === 'visitor') {
      const text = prep(r.content || '');
      const used: boolean[] = new Array(text.length).fill(false);
      for (const p of phonesIn(text, used)) {
        phones.push(p.phone);
        fours.add(p.phone.slice(-4));
        words.add(p.phone);
      }
      const rest = text.split('').map((c, i) => (used[i] ? ' ' : c)).join('').toLowerCase();
      for (const w of rest.match(/[a-z0-9]+/g) || []) {
        words.add(w);
        if (/^\d{4}$/.test(w)) fours.add(w);
      }
      // What findPendingLookup reads from the same text, so it never refuses
      // its own pair: "order no3973" is one word above but gives the ID 3973.
      for (const t of tokensIn(r.content || '', row, true, true)) {
        words.add(normId(t.value));
        if (t.digits) fours.add(t.digits);
      }
    } else if (r.sender === 'tool_result') {
      const res = parseJson(r.content);
      if (res?.found !== true || !Array.isArray(res.orders)) return;
      for (const o of res.orders as Record<string, unknown>[]) {
        if (o?.order_id) words.add(normId(o.order_id));
        if (o?.tracking_id) words.add(normId(o.tracking_id));
      }
    }
  });

  if (!words.has(id)) return false;
  let last4 = l4raw;
  if (l4raw.length !== 4) {
    const p = tenDigits(l4raw);
    if (!p || !phones.includes(p)) return false;
    last4 = p.slice(-4);
  }
  // One number used as both the order ID and the last 4 is a guess (see bestPair).
  return id !== last4 && fours.has(last4);
}

/**
 * The reply asks for the order ID or last 4 again although asking is no longer
 * getting anywhere: two full lookups have come back not found since the last
 * one that worked, or the customer has just sent again a pair that was already
 * looked up and not found.
 */
export function asksAgainAfterFailedLookups(reply: string, rows: GuardRow[], thisRequest: LookupOutcome[]): boolean {
  const ask = asksForOrderDetails(reply);
  if (!ask.orderId && !ask.last4) return false;
  if (thisRequest.some((o) => o.found === true)) return false;

  // Only failures since the last one that worked and since a person last
  // answered or we handed over: once staff hand the chat back, old misses
  // must not bounce it straight back to them.
  const from = Math.max(lastFoundIndex(rows), lastHandBackIndex(rows));
  const calls = lookupCalls(rows);
  const notFound = (o: Record<string, unknown> | LookupOutcome | null) => !!o && o.found === false && !o.needs_verification;

  let failures = thisRequest.filter(notFound).length;
  const failed: { call: TriedLookup; row: number }[] = [];
  rows.forEach((r, i) => {
    if (i <= from || r.sender !== 'tool_result' || !notFound(parseJson(r.content))) return;
    // Older calls looked up by name or phone and missed the same way; only a
    // full order ID + last 4 counts.
    const call = calls.find((c) => c.callId && c.callId === r.metadata?.tool_call_id);
    if (!call?.order_id || !call.last4) return;
    failures++;
    failed.push({ call, row: i });
  });
  if (failures >= 2) return true;

  const pair = bestPair(visitorTokens(rows, from));
  if (!pair) return false;
  return failed.some((f) => samePair(f.call, pair.id.value, pair.l4.digits)
    && (pair.id.row > f.row || pair.l4.row > f.row));
}

// ── Once the order is verified ─────────────────────────────────
// A chat that has proved which order it owns (the widget's verify form, or a
// lookup that came back found) must not be asked for the order ID or the
// phone digits again. The one fair reason to ask is the customer bringing up
// a different order, which is what this spots. When unsure it says "another
// order", so the reply that asks is let through rather than overridden.
// The words count only next to an order noun: "any new update?", "koi naya
// update" and "naya address" are about the same order.
const OTHER_WORD = String.raw`(?:another|other|second|2nd|new|first|1st|previous|old|older|earlier|dusra|doosra|dusri|doosri|dusre|doosre|naya|nayi|naye|pehla|pehle|pehli|pahla|pahle|purana|purane|purani|ek aur|aur ek)`;
const ORDER_NOUN = String.raw`(?:orders?|parcels?|packages?|items?|products?|shipments?|one)`;
const ANOTHER_ORDER = new RegExp(String.raw`\b${OTHER_WORD}\b(?: [^ ]+){0,2}? ${ORDER_NOUN}\b|\b(?:orders?|parcels?) (?:[^ ]+ )?(?:aur|bhi) ek\b`, 'i');
const ANOTHER_ORDER_HI = /(?:दूसरा|दूसरी|दूसरे|एक और|नया|नई|नए|पहला|पहले|पहली|पुराना|पुराने|पुरानी)(?: [^ ]+){0,2}? (?:ऑर्डर|आर्डर|पार्सल|order|parcel)/;

/**
 * Whether the customer's latest message talks about an order other than the
 * verified one: "another order" / "dusra order" / "दूसरा ऑर्डर", or an order ID
 * or tracking ID that is not one of knownIds (the verified order's ID and its
 * tracking ID). A 4-5 digit number in a short message with words ("1400 ka
 * status batao") counts as an ID too. A number on its own ("3335") does not:
 * it is as likely their last 4, and when our last reply asked for another
 * order's details ai.ts already lets the next ask through.
 */
export function mentionsAnotherOrder(text: string | null | undefined, knownIds: string | (string | null | undefined)[]): boolean {
  const content = text || '';
  const t = prep(content);
  if (ANOTHER_ORDER.test(t) || ANOTHER_ORDER_HI.test(t)) return true;
  const known = new Set((Array.isArray(knownIds) ? knownIds : [knownIds]).filter(Boolean).map(normId));
  const withWords = /[A-Za-z\u0900-\u0965\u0970-\u097F]/.test(t);
  return tokensIn(content, 0, withWords, false).some((tok) => tok.id && !known.has(normId(tok.value)));
}

/**
 * Stricter than asksForOrderDetails, for a chat whose order is already known:
 * the request and the "order ID" / "last 4" words must sit in the same
 * sentence, so the closing "Anything else I can help with?" does not turn an
 * answer into a question. A reply that quotes one of knownIds (the order ID
 * or tracking ID) is giving the order ID, not asking for it; it can still ask
 * for the last 4.
 */
export function reasksForOrderDetails(reply: string | null | undefined, knownIds: (string | null | undefined)[]): { orderId: boolean; last4: boolean } {
  const text = normaliseDigits(reply || '').toLowerCase().slice(0, 4000);
  const sentences = text.match(/[^.?!।\n]+[.?!।]*/g) || [];
  let orderId = false;
  let last4 = false;
  for (const sentence of sentences) {
    if (!REQUEST.test(sentence)) continue;
    if (ASKS_ORDER_ID.some((re) => re.test(sentence))) orderId = true;
    if (ASKS_LAST4.some((re) => re.test(sentence))) last4 = true;
  }
  if (orderId) {
    const flat = text.replace(/[#\s]/g, ' ');
    const quotes = knownIds.filter(Boolean).map(normId).some((id) => !!id
      && new RegExp(`(?:^|[^a-z0-9])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(flat));
    if (quotes) orderId = false;
  }
  return { orderId, last4 };
}

/**
 * Whether our last message the customer saw asked for order details in the
 * strict sense above: in a verified chat that ask was allowed (another
 * order), so the customer's next message is likely answering it.
 */
export function lastReplyReasked(rows: GuardRow[], knownIds: (string | null | undefined)[]): boolean {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!isVisibleReply(rows[i])) continue;
    const ask = reasksForOrderDetails(rows[i].content, knownIds);
    return ask.orderId || ask.last4;
  }
  return false;
}

// ── Handing over ───────────────────────────────────────────────
// Says nothing about any order and promises no call: the team answers here.
const HAND_OVER = {
  en: "Thanks for sharing those. I've passed this to our team and they'll reply to you right here in this chat.",
  hinglish: 'Thank you, details mil gayi. Maine aapki chat team ko de di hai, woh yahin is chat mein reply karenge.',
  hi: 'धन्यवाद, जानकारी मिल गई है। मैंने आपकी चैट हमारी टीम को दे दी है, वे यहीं इसी चैट में आपको जवाब देंगे।',
};

function lastHandBackIndex(rows: GuardRow[]): number {
  const ours = Object.values(HAND_OVER);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (isVisibleReply(r) && (r.sender === 'agent' || ours.includes(r.content || ''))) return i;
  }
  return -1;
}

const HINGLISH = /\b(?:hai|kya|mera|meri|nahi|nahin|kab|kar|aapka|bhai)\b|\border\s+kaha/i;
// Devanagari letters, not its digits (०-९), which say nothing about language.
const DEVANAGARI = /[ऀ-॥॰-ॿ]/;

export function handOverReply(rows: GuardRow[]): string {
  // The message that triggers a hand-over is usually just "3335", so the
  // language comes from the latest one with words in it.
  let latest = '';
  for (let i = rows.length - 1; i >= 0 && !latest; i--) {
    const c = rows[i].sender === 'visitor' ? rows[i].content || '' : '';
    if (/[A-Za-z]/.test(c) || DEVANAGARI.test(c)) latest = c;
  }
  if (DEVANAGARI.test(latest)) return HAND_OVER.hi;
  if (HINGLISH.test(latest)) return HAND_OVER.hinglish;
  return HAND_OVER.en;
}
