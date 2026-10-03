// ── Ship again: the new parcel's AWB / tracking link (owner 2026-10-03) ──
// The team ships again through fship (app.fship.in) and pastes the new tracking link, or the bare
// AWB, into the chat. This reads that out of a text, so the chat can be marked "Reshipped" by the
// Mark reshipped button (parseReship: a link or a bare AWB of 8-30 letters / digits) and by the
// staff reply route on its own (reshipInReply: only a tracking link with an AWB, or a bare number
// of 12-18 digits, so a phone number, an order number or a price never counts). Pure, no imports.

export interface ReshipRef { awb: string; link: string | null }

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const AWB_PARAM_RE = /[?&](?:awbno|awb|waybill|wbn|tracking_?id|trackingid)=([A-Za-z0-9-]{6,40})/i;
const AWB_PATH_RE = /\/(?:tracking|track|shipment|awb)\/([A-Za-z0-9-]{8,40})(?:[/?#]|$)/i;
const BARE_DIGITS_RE = /(?<![\d+])(\d{12,18})(?!\d)/g;
const BARE_ANY_RE = /^[A-Za-z0-9-]{8,30}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The link without tracking junk (utm_*, fbclid) and without a trailing full stop or bracket.
function cleanLink(url: string): string {
  let u = url.replace(/[.,;:!?)\]]+$/, '');
  try {
    const parsed = new URL(u);
    for (const k of Array.from(parsed.searchParams.keys())) if (/^(utm_|fbclid|gclid)/i.test(k)) parsed.searchParams.delete(k);
    u = parsed.toString().replace(/\?$/, '');
  } catch { /* keep it as written */ }
  return u;
}

// The first link in the text that carries an AWB, as { awb, link }; else null.
export function reshipLinkIn(text: string): ReshipRef | null {
  for (const raw of (text || '').match(URL_RE) || []) {
    const link = cleanLink(raw);
    // ShipTrack's own tracking page (a UUID token, or a shiptrack host) is the OLD link, never a reship.
    if (/^https?:\/\/[^/]*shiptrack/i.test(link)) continue;
    const m = link.match(AWB_PARAM_RE) || link.match(AWB_PATH_RE);
    if (m && !UUID_RE.test(m[1])) return { awb: m[1], link };
  }
  return null;
}

// A bare AWB-like number: 12-18 digits that is not part of a longer number and not a +91 phone.
export function bareAwbIn(text: string): string | null {
  for (const m of (text || '').matchAll(BARE_DIGITS_RE)) {
    const n = m[1];
    if (n.length === 12 && n.startsWith('91')) continue;   // 91 + a 10-digit phone number
    return n;
  }
  return null;
}

// The staff reply route: a tracking link with an AWB, else a bare 12-18 digit number.
export function reshipInReply(text: string): ReshipRef | null {
  const link = reshipLinkIn(text);
  if (link) return link;
  const awb = bareAwbIn(text);
  return awb ? { awb, link: null } : null;
}

// The Mark reshipped dialog: a link, a bare number, or any 8-30 letter / digit AWB.
export function parseReship(input: unknown): ReshipRef | { error: string } {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text) return { error: 'Paste the new tracking link or the AWB number' };
  if (text.length > 400) return { error: 'That is too long for a link or an AWB' };
  const found = reshipInReply(text);
  if (found) return found;
  if (BARE_ANY_RE.test(text) && /\d/.test(text)) return { awb: text.toUpperCase(), link: null };
  if (/^https?:\/\//i.test(text)) return { error: 'That link has no AWB in it: paste the fship tracking link, or just the AWB number' };
  return { error: 'An AWB is 8-30 letters and digits (for example 143449611008922), or paste the fship tracking link' };
}
