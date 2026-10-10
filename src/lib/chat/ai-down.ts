// ── When every AI model is down, what a visitor reads (owner 2026-10-10, Chikki review A18-A20) ──
// "Sorry, that took longer than expected on my end. Could you send that again?" went out 1,687 times in 30 days while
// OpenRouter refused every call (credits / the key's monthly limit), and new customers answered "you are fake", "is it
// scam??". A visitor (not verified: nobody may hand them to the team) now gets a plain, useful line in their language
// with the store's name: share the order ID and the phone number on the order. One who already typed both is not asked
// again: they are told to send "hi" again in a little while. Verified customers keep their path (the team takes it).
// Pure, no imports.

const HINGLISH = /\b(?:hai|hain|kya|kab|kaha|kahan|mera|meri|mere|nahi|nhi|kar|karo|kijiye|aap|bhai|ji|kyu|kyun|order\s+kab|aaya|aayega|milega|paisa|paise)\b/i;
const PHONE = /(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/;

// Did the visitor already type an order number AND a 10-digit phone (in their last few messages)?
export function typedBoth(visitorTexts: string[]): boolean {
  const t = visitorTexts.slice(-4).join(' \n ');
  if (!PHONE.test(t)) return false;
  const rest = t.replace(new RegExp(PHONE.source, 'g'), ' ');
  return /#\s?\d{3,8}\b|\b(?:order|id)\D{0,12}\d{3,8}\b|\b\d{3,8}\b/i.test(rest);
}

export function aiDownVisitorReply(brand: string, visitorTexts: string[]): string {
  const name = brand && brand.trim() ? brand.trim() : 'us';
  const latest = visitorTexts[visitorTexts.length - 1] || '';
  const hi = HINGLISH.test(latest) || /[ऀ-ॿ]/.test(latest);
  if (typedBoth(visitorTexts)) {
    return hi
      ? `${name} ko message karne ke liye shukriya! Aapka order ID aur phone number mil gaya hai. Thodi der baad ek baar "hi" bhejiye, main yahin aapke order ki details dikha dunga.`
      : `Thanks for writing to ${name}! We have your order ID and phone number. Please send "hi" again in a little while and I'll show you your order details right here.`;
  }
  return hi
    ? `${name} ko message karne ke liye shukriya! Apna order ID aur order par diya hua poora phone number bhejiye, hum yahin aapki madad karenge.`
    : `Thanks for writing to ${name}! Please share your order ID and the complete phone number on the order, and we'll help you right here.`;
}

// ── Owner 2026-10-11 ("AI band ho tab bhi order check: visitor order ID + phone de, to code khud check karke status bata
// de"): the order ID and the phone the visitor typed, for ai-down-check.ts. The newest message that has a phone wins; the
// order number is "#1234", "order ... 1234" or a bare 3-8 digit number that is not part of the phone. null = not both.
export function orderAndPhone(visitorTexts: string[]): { order: string; phone: string } | null {
  const recent = visitorTexts.slice(-4);
  const all = recent.join(' \n ');
  const pm = all.match(new RegExp(PHONE.source, 'g'));
  if (!pm || !pm.length) return null;
  const phone = pm[pm.length - 1].replace(/\D/g, '').slice(-10);
  const rest = all.replace(new RegExp(PHONE.source, 'g'), ' ');
  const m = rest.match(/#\s?(\d{3,8})\b/) || rest.match(/\b(?:order|id)\D{0,12}(\d{3,8})\b/i) || rest.match(/\b(\d{3,8})\b/);
  return m ? { order: m[1], phone } : null;
}

// The order matched: its stage line (closed-hours.ts statusLine, never "today") and that our team can see the chat now.
export function aiDownFoundReply(firstName: string | null, status: string | null, visitorTexts: string[]): string {
  const latest = visitorTexts[visitorTexts.length - 1] || '';
  const hi = HINGLISH.test(latest) || /[ऀ-ॿ]/.test(latest);
  const name = firstName ? ` ${firstName}` : '';
  if (hi) {
    return `Shukriya${name}, aapka order mil gaya. ${status || 'Aapka order verify ho gaya hai.'} Kuch aur poochna ho to yahin likhiye, hamari team bhi yeh chat dekh rahi hai.`;
  }
  return `Thank you${name}, I found your order. ${status || 'Your order is verified.'} If you need anything else, just write here: our team can see this chat too.`;
}

// No order of this store has that order ID with that phone (the same words whether the order exists or not).
export function aiDownNoMatchReply(brand: string, visitorTexts: string[]): string {
  const name = brand && brand.trim() ? brand.trim() : 'us';
  const latest = visitorTexts[visitorTexts.length - 1] || '';
  const hi = HINGLISH.test(latest) || /[ऀ-ॿ]/.test(latest);
  return hi
    ? `${name} ko message karne ke liye shukriya! Yeh order ID aur phone number hamare kisi order se match nahi hue. Order ID aur order par diya hua phone number ek baar check karke dobara bhejiye.`
    : `Thanks for writing to ${name}! That order ID and phone number do not match one of our orders. Please check the order ID and the phone number used on the order and send them again.`;
}

// For waiting.ts AI_NOT_AN_ANSWER_REGEX (Postgres, case-insensitive; no apostrophes): these lines answer nothing yet.
export const AI_DOWN_REGEX = 'thanks for writing to [^!]{1,60}! (please share your order id|we have your order id|that order id and phone number)|ko message karne ke liye shukriya!';

// The same lines in code: ai.ts leaves them out of the rows its guards count (like the busy apology), so asking for
// the order ID here never counts as Chikki asking again.
export const isAiDownLine = (text: string | null | undefined) => new RegExp(AI_DOWN_REGEX, 'i').test(String(text || ''));
