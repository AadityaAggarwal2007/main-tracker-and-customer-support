// ── Two different addresses from one customer ──────────────────
// SHIPTRACK_MASTER_RULES.md section 10: if a customer gives one address and later a
// different one, the system must not pick one; it goes to Needs you (for a verified
// customer only: owner's note, 2026-09-30). This file has no imports: the widget
// message route, the email poller and the tests share it.
//
// An address is written in a hundred ways, so this is a careful guess, not a parser:
//   - a message "looks like an address" when it has a PIN code next to an address
//     word, or at least two address words (road, sector, flat, nagar, near...) and a
//     few other words;
//   - two such messages conflict when their PIN codes differ, or, without PIN
//     codes, when they share almost no words (Delhi / MG Road against Mumbai / Park
//     Street). The same address with more detail, or a typo, does not conflict.
// A wrong alarm only sends the chat to a person to confirm; a missed one is a parcel
// sent to the wrong place, which is the thing this exists for.

const ADDRESS_WORDS = new Set([
  'address', 'pata', 'deliver', 'flat', 'house', 'plot', 'road', 'rd', 'street', 'st', 'sector', 'nagar', 'colony',
  'lane', 'apartment', 'apartments', 'apt', 'society', 'block', 'phase', 'marg', 'gali', 'chowk', 'near', 'opp',
  'opposite', 'village', 'vpo', 'dist', 'district', 'tehsil', 'pincode', 'pin', 'landmark', 'floor', 'tower', 'wing',
  'building', 'bldg', 'hno', 'sco', 'extension', 'enclave', 'vihar', 'puram', 'ganj', 'bazar', 'market',
]);

// Words that say nothing about the place, in English and Hinglish.
const STOP = new Set([
  'is', 'my', 'the', 'to', 'at', 'in', 'on', 'of', 'and', 'for', 'it', 'please', 'pls', 'send', 'ship', 'shift', 'change',
  'new', 'correct', 'correction', 'actually', 'instead', 'here', 'this', 'that', 'was', 'wrong', 'hai', 'ka', 'ke', 'ki',
  'mera', 'meri', 'mere', 'par', 'pe', 'me', 'mein', 'se', 'ko', 'kar', 'karo', 'do', 'dena', 'bhej', 'bhejo', 'naya',
  'sahi', 'galat', 'wala', 'wali', 'order', 'parcel', 'delivery', 'deliver', 'address', 'pata', 'i', 'a', 'an', 'you',
  'we', 'your', 'our', 'them', 'use', 'kindly', 'sir', 'madam', 'ok', 'okay',
]);

const toAscii = (t: string) => t.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966));

export interface AddressGuess {
  pin: string | null;
  words: Set<string>;
}

// The address a message seems to give, or null when it does not look like one.
export function addressIn(text: string | null | undefined): AddressGuess | null {
  const t = toAscii(String(text || '')).slice(0, 1000).toLowerCase();
  if (!t.trim()) return null;
  const tokens = t.replace(/[^a-z0-9ऀ-ॿ]+/g, ' ').trim().split(' ').filter(Boolean);
  if (tokens.length < 3) return null;
  const hits = new Set(tokens.filter((w) => ADDRESS_WORDS.has(w)));
  // A 6-digit PIN code (not a longer number, not a phone) and an address word near it.
  const pinMatch = t.match(/(?<![\d])([1-8]\d{5})(?![\d])/);
  const pin = pinMatch ? pinMatch[1] : null;
  // "send it to 4 hill road bandra mumbai": one address word is enough when the message
  // says where to send something, or calls itself an address.
  const intent = /\b(?:deliver|send|ship|shift|bhej|bhejo)\b[^.]{0,25}\bto\b|\b(?:address|pata)\b/.test(t) || t.includes('पता');
  const looksLikeAddress = (pin && hits.size >= 1) || (hits.size >= 2 && tokens.length >= 4) || (hits.size >= 1 && intent && tokens.length >= 4);
  if (!looksLikeAddress) return null;
  const words = new Set(tokens.filter((w) => !ADDRESS_WORDS.has(w) && !STOP.has(w) && w !== pin));
  if (words.size < 2) return null;
  return { pin, words };
}

// Does the newest message give an address that differs from one given before?
export function addressConflict(earlier: string[], latest: string): boolean {
  const b = addressIn(latest);
  if (!b) return false;
  return earlier.some((prev) => {
    const a = addressIn(prev);
    if (!a) return false;
    if (a.pin && b.pin) return a.pin !== b.pin;
    const small = Math.min(a.words.size, b.words.size);
    if (small < 2) return false;
    let same = 0;
    a.words.forEach((w) => { if (b.words.has(w)) same++; });
    return same / small < 0.34;
  });
}

// The whole reply: the AI does not choose between the two, and says so.
export function addressConflictReply(hinglish: boolean): string {
  return hinglish
    ? 'Aapne alag-alag address bataaye hain, isliye main khud se koi ek nahi chun sakta. Maine ise hamari team ko de diya hai, team sahi address confirm karke isi chat mein aapko jawab degi.'
    : "You've given two different addresses, so I can't pick one myself. I've passed this to our team, and they will confirm the right address and reply to you here in this chat.";
}
