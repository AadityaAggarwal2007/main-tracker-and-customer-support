// ── One chargeback, one card (owner 2026-10-15: "chargeback na duplicate bhi ata h as in reminder toh alag alag box ...
// total count likhde pending ka") ──────────────────────────────────────────────────────────────────────────────────
// A gateway sends the same dispute again and again (the first notice, then "reminder", "2 days left", ...). Every mail is
// still kept as its own row; the list and the counts join the mails of ONE case into one card. Pure (no imports but
// parse.ts): the case is read from the words each time, so a better rule here regroups the old rows too.
//   0. a gateway's daily list ("URGENT- FIRST LEVEL PAYU CHARGEBACK NOTIFICATION - TOTAL CASES [ 4 ] [13-Oct-2026 9:25
//      PM]", owner 2026-10-15: four of them were four cards): every such list of the panel + gateway is ONE card, its
//      count and date taken out of the subject (it names many cases, so its first id never stands for the case);
//   1. the gateway's own case / dispute / payment id in the subject or the text (PayGlocal "cb_...", PayU "PayU ID 311...",
//      Easebuzz "E26092216UJOYK", Razorpay "disp_..." / "pay_...", any "Case ID: ...");
//   2. else the order the mail was tied to;
//   3. else a subject that carries a number (an amount: "INR 191.20 at risk") with the reminder words taken out;
//   4. else the mail is its own case (never two different disputes in one card by guess).
// Always inside one panel and one gateway.
import { gatewayKeyOf } from './parse';

const hasDigit = (s: string) => /\d/.test(s);
const ID_PATTERNS: RegExp[] = [
  /\b(cb_[A-Za-z0-9]{6,40})\b/,                                                    // PayGlocal case
  /\b(disp_[A-Za-z0-9]{8,30})\b/,                                                  // Razorpay dispute
  /\bPayU\s*(?:ID|Id|id|Payment\s*ID|Txn\s*ID)\s*[:#\-]?\s*(\d{6,20})\b/,           // PayU id
  /\b(E\d{8}[A-Z0-9]{4,12})\b/,                                                    // Easebuzz easepay id
  /\b(?:case|dispute|chargeback|cb)\s*(?:id\b|ref(?:erence)?\b|no\b\.?|number\b|#)\s*[:#\-]?\s*([A-Za-z0-9][A-Za-z0-9_\-]{5,39})/i,
  /\b(pay_[A-Za-z0-9]{8,30})\b/,                                                   // Razorpay payment
  /\b(?:transaction|txn|payment|arn|rrn|utr)\s*(?:id\b|ref(?:erence)?\b|no\b\.?|number\b)?\s*[:#]\s*([A-Za-z0-9][A-Za-z0-9_\-]{5,39})/i,
];

// The gateway's id for the dispute, lower-case, or null.
export function caseRef(subject: string, text: string): string | null {
  const hay = `${subject || ''}\n${(text || '').slice(0, 3000)}`;
  for (const re of ID_PATTERNS) {
    const m = hay.match(re);
    if (m && hasDigit(m[1])) return m[1].toLowerCase();
  }
  return null;
}

// "Reminder: 1 chargeback case needs your attention, INR 191.20 at risk" -> "1 chargeback case needs your attention, inr 191.20 at risk".
export function baseSubject(subject: string): string {
  let s = (subject || '').toLowerCase();
  for (let i = 0; i < 4; i++) {
    s = s.replace(/^\s*(re|fw|fwd)\s*:\s*/, '')
      .replace(/^\s*(\[[^\]]*\]\s*)/, '')
      .replace(/^\s*((final|gentle|second|2nd|3rd|first|last)\s+)?(reminder|follow[\s-]?up|urgent|action required|escalation)\s*[:\-–|]?\s*/, '');
  }
  return s.replace(/\s*[-–|(]\s*(reminder|follow[\s-]?up)\s*\d*\)?\s*$/, '').replace(/\s+/g, ' ').trim();
}

// A gateway's daily / summary list of open cases (it names several, with a count and a date in the subject).
const DIGEST = /total\s+(?:no\.?\s+of\s+)?cases?\s*[\[(:#\-]?\s*\d+|\bdaily\s+(?:chargeback\s+)?(?:report|summary|digest)\b|\bchargeback\s+summary\b/i;
export const isDigest = (subject: string): boolean => DIGEST.test(subject || '');
export function digestSubject(subject: string): string {
  return baseSubject(subject).replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\d+/g, '#')
    .replace(/(#[\s:./-]*)+/g, '# ').replace(/\s+/g, ' ').replace(/[\s#:,.\-–]+$/, '').trim();
}

export interface CaseMail { id: string; business_id: string; gateway: string; order_id: string | null; subject: string; snippet: string }

export function caseKey(a: CaseMail): string {
  const head = `${a.business_id}|${gatewayKeyOf(a.gateway)}`;
  if (isDigest(a.subject)) return `${head}|digest:${digestSubject(a.subject)}`;
  const ref = caseRef(a.subject, a.snippet);
  if (ref) return `${head}|id:${ref}`;
  if (a.order_id) return `${head}|order:${a.order_id.replace(/[^0-9]/g, '')}`;
  const subj = baseSubject(a.subject);
  if (subj && hasDigit(subj)) return `${head}|subj:${subj}`;
  return `${head}|mail:${a.id}`;
}

// The mails grouped by case, each group newest first; the groups in the order their first mail came in `rows`.
export function groupCases<T extends CaseMail & { received_at: string }>(rows: T[]): T[][] {
  const by = new Map<string, T[]>();
  for (const r of rows) {
    const k = caseKey(r);
    const g = by.get(k);
    if (g) g.push(r); else by.set(k, [r]);
  }
  return Array.from(by.values()).map(g => g.sort((x, y) => Date.parse(y.received_at) - Date.parse(x.received_at)));
}
