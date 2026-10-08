// ── A chargeback mail, understood (owner 2026-10-08) ──────────────────────────────────────────
// Pure. The mailbox is the one the owner gave the gateways as their chargeback address, so EVERY new mail in it
// is an alert; this only works out which gateway it looks like, which order number it names and a short text.
// A guess is only a hint for the team: the order is confirmed against the panel's orders (store.ts) and the
// gateway can be "Unknown".

export const GATEWAYS = [
  { key: 'razorpay', label: 'Razorpay', words: ['razorpay'] },
  { key: 'cashfree', label: 'Cashfree', words: ['cashfree'] },
  { key: 'payu', label: 'PayU', words: ['payu'] },
  { key: 'payglocal', label: 'PayGlocal', words: ['payglocal'] },
  { key: 'paytm', label: 'Paytm', words: ['paytm'] },
  { key: 'phonepe', label: 'PhonePe', words: ['phonepe'] },
  { key: 'stripe', label: 'Stripe', words: ['stripe'] },
  { key: 'instamojo', label: 'Instamojo', words: ['instamojo'] },
  { key: 'ccavenue', label: 'CCAvenue', words: ['ccavenue'] },
  { key: 'easebuzz', label: 'Easebuzz', words: ['easebuzz'] },
  { key: 'billdesk', label: 'BillDesk', words: ['billdesk'] },
  { key: 'juspay', label: 'Juspay', words: ['juspay'] },
  { key: 'paypal', label: 'PayPal', words: ['paypal'] },
  { key: 'shopify', label: 'Shopify Payments', words: ['shopify'] },
  { key: 'other', label: 'Other gateway', words: [] as string[] },
] as const;
export type GatewayKey = typeof GATEWAYS[number]['key'];
export const GATEWAY_KEYS: string[] = GATEWAYS.map(g => g.key);
// "PayU" -> 'payu' (the checklist and the routing use the key); 'Unknown' / an unlisted label -> 'other'.
export const gatewayKeyOf = (label: string): string => GATEWAYS.find(g => g.label === label)?.key ?? 'other';

// The sender's domain and name first (a real gateway mail comes from its own domain), then the subject and text.
export function gatewayOf(fromAddress: string, fromName: string, subject: string, text: string): string {
  const head = `${fromAddress} ${fromName}`.toLowerCase();
  const body = `${subject} ${text.slice(0, 1500)}`.toLowerCase();
  for (const g of GATEWAYS) if (g.words.some(w => head.includes(w))) return g.label;
  for (const g of GATEWAYS) if (g.words.some(w => body.includes(w))) return g.label;
  return 'Unknown';
}

// Order numbers the mail may name: "#1553", "Order ID: 1553", "order no 1553", "Order #1553". Digits only (the
// panel's orders are numbers like #1553): the DB then confirms which of them is a real order of THIS panel.
export function orderCandidates(subject: string, text: string): string[] {
  const hay = `${subject}\n${text.slice(0, 6000)}`;
  const found: string[] = [];
  const add = (d: string) => { if (/^\d{3,8}$/.test(d) && !found.includes(d)) found.push(d); };
  for (const m of hay.matchAll(/#\s?(\d{3,8})\b/g)) add(m[1]);
  for (const m of hay.matchAll(/order(?:\s*(?:id|no\.?|number|ref(?:erence)?))?\s*[:#\-]?\s*#?\s*(\d{3,8})\b/gi)) add(m[1]);
  return found.slice(0, 6);
}

// The forms an order number can be stored in: Shopify's "#1553" and the bare "1553".
export function orderForms(candidates: string[]): string[] {
  return Array.from(new Set(candidates.flatMap(c => [`#${c}`, c])));
}

// HTML mail to plain text (no scripts or styles), for the short text only.
export function htmlToText(html: string): string {
  return (html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

export function shortText(text: string, n = 700): string {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, n);
}

// The WhatsApp number as the Cloud API wants it: digits with the country code (a bare 10-digit Indian number gets 91).
export function whatsappNumber(raw: unknown): string | null {
  const digits = typeof raw === 'string' ? raw.replace(/[^\d]/g, '') : '';
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return null;
}
