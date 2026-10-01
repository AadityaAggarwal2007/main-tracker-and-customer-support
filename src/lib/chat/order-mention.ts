// ── A wrong order number in a reply (owner, 2026-10-01) ─────────────────────────────
// In tests the model once wrote "#4711" for the customer's order #4715. A customer who reads a
// number that is not theirs thinks we mixed up their order. Every order number the reply mentions
// ("#4711", "order 4711", "order ID: 4711") must be an order found in this chat or a number the
// customer typed. Otherwise: with exactly one order in the chat it becomes that order's number;
// with none or several it is taken out ("your order"). Phone numbers (10 digits), amounts,
// dates, pin codes and tracking IDs are never touched. Pure, no imports, tested offline.

const digitsOf = (s: string) => String(s || '').replace(/\D/g, '');

export function fixOrderMentions(
  reply: string,
  knownOrderIds: string[],   // as stored, e.g. "#4715"
  customerText: string,      // what the customer wrote in this chat
): { text: string; changed: boolean } {
  if (!reply) return { text: reply, changed: false };
  const known = Array.from(new Set(knownOrderIds.map(digitsOf).filter((d) => d.length >= 3)));
  const typed = new Set((customerText.match(/\d{3,7}/g) || []));
  const ok = (d: string) => known.includes(d) || typed.has(d);
  const only = known.length === 1 ? known[0] : null;
  let changed = false;

  // "order 4711", "order ID: 4711", "order no. #4711", "order number 4711" (not an amount after it).
  let text = reply.replace(/\b(order(?:\s*(?:id|no\.?|number|num))?\s*[:\-]?\s*)(#\s?)?(\d{3,7})\b(?!\s*(?:rs\b|₹|rupees|%|\/-|pcs|pieces))/gi,
    (m, lead: string, hash: string | undefined, d: string, at: number, whole: string) => {
      if (ok(d)) return m;
      // "minimum order 299", "orders above 999", "order value 1500": an amount, not an order number.
      if (/\b(?:min(?:imum)?|above|over|upto|up to|below|worth|value|amount|of|se|tak|ke upar)\s*$/i.test(whole.slice(Math.max(0, at - 14), at))
        || /^order\s+(?:value|amount|worth|total)/i.test(lead)) return m;
      changed = true;
      return only ? `${lead}${hash ? '#' : ''}${only}` : lead.replace(/\s*(?:id|no\.?|number|num)?\s*[:\-]?\s*$/i, '');
    });
  // A bare "#4711" anywhere else.
  text = text.replace(/(^|[^\w#])#\s?(\d{3,7})\b/g, (m, pre: string, d: string) => {
    if (ok(d)) return m;
    changed = true;
    return only ? `${pre}#${only}` : `${pre}your order`;
  });
  if (changed) {
    text = text
      .replace(/\b(your|aapka|aapke)\s+order\s+your order\b/gi, '$1 order')
      .replace(/\border\s+your order\b/gi, 'order')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\s+([,.!?])/g, '$1');
  }
  return { text, changed };
}
