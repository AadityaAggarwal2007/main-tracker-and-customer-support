// ── Refund form: every customer text, in one file (owner, 2026-10-02) ──
// Pure (imports only ./rules). The chat messages are posted as "Vastora Support" (messages.sender =
// 'system'); refund-unit.js U4 pins every one byte for byte. The page (/refund) shows each label in
// English with a Devanagari Hindi line below it (owner answer Q8).
//
// Owner answers 2026-10-02 12:30 IST that shape these texts:
//   Q2  yes, but WITHOUT the destination number: the Refunded message says the amount, the date and
//       "aapke diye hue UPI ID / bank account me" plus the reference number (UTR) (master rule 17).
//   Q3  NO: a customer message never carries the masked UPI / account (no "xxxx4521", no "agar ye
//       aapka nahi hai"). There is no destination line in the "form received" message.
// No message promises a time: "7 din / 7 days" is the life of the link, not a refund time, so the
// texts are the same day and night.
// Owner change 2026-10-02 ~15:00: NO photo / video upload ("humein sirf bank details mil jaye bahut
// hai"), so no text asks for a photo, a video or a file.

import { DETAILS_MAX, CONSENT_VERSION, type Method, type Reason } from './rules';

export type Lang = 'en' | 'hinglish';
// One English line + one Devanagari line (the page shows both).
export interface Bi { en: string; hi: string }

// ── Chat messages (spec 4.1, with Q2 / Q3 applied) ─────────────
export type Step = 'form' | 'received' | 'approved' | 'rejected' | 'refunded' | 'return';
export const STEPS: Step[] = ['form', 'received', 'approved', 'rejected', 'refunded', 'return'];

// Q2 (master rule 17): amount, date and where it went. Q3: "where" never carries the UPI ID or the
// account, not even masked.
export const RULE17_LINE: Record<Lang, string> = {
  hinglish: 'Amount: {amount} · Date: {date} · Kahan bheja: {where}',
  en: 'Amount: {amount} · Date: {date} · Sent to: {where}',
};
export const WHERE: Record<Lang, Record<Method | 'any', string>> = {
  hinglish: { upi: 'aapke diye hue UPI ID me', bank: 'aapke diye hue bank account me', any: 'aapke diye hue UPI / bank account me' },
  en: { upi: 'the UPI ID you gave', bank: 'the bank account you gave', any: 'the UPI ID / bank account you gave' },
};

export const MESSAGES: Record<Step, Record<Lang, string>> = {
  form: {
    hinglish: 'Aapke order {order} ki refund request ke liye ye form bhariye: {link}\n'
      + 'Isme problem aur refund ke liye aapka UPI ID ya bank account bharna hai. Ye link sirf aapke is order ke liye hai, 7 din tak chalega aur ek hi baar submit hoga.\n'
      + 'Bank ya UPI details yahan na bhejein, sirf form me bharein. Hum kabhi OTP, UPI PIN ya password nahi maangte.',
    en: 'Please fill in this form for the refund request on your order {order}: {link}\n'
      + 'It asks what went wrong and your UPI ID or bank account for the refund. This link is only for this order, works for 7 days and can be submitted once.\n'
      + 'Please do not send bank or UPI details here; enter them only in the form. We never ask for an OTP, UPI PIN or password.',
  },
  // Owner's words; Q3 = no, so no destination line.
  received: {
    hinglish: 'Aapka refund form mil gaya hai. Team check karke isi chat me update degi.',
    en: 'We have received your refund form. Our team will check it and update you here in this chat.',
  },
  approved: {
    hinglish: 'Aapka refund approve ho gaya hai. Refund hote hi isi chat me reference number bhej denge.',
    en: 'Your refund has been approved. As soon as the refund is sent, we will share the reference number here in this chat.',
  },
  // Never carries the Super Admin's note.
  rejected: {
    hinglish: 'Aapki refund request abhi approve nahi ho payi. Team isi chat me aapse baat karegi.',
    en: 'Your refund request could not be approved right now. Our team will talk to you here in this chat.',
  },
  refunded: {
    hinglish: `Aapka refund bhej diya gaya hai. Reference number: {utr}\n${RULE17_LINE.hinglish}\nIs reference number se aap apne bank / UPI app me refund check kar sakte hain.`,
    en: `Your refund has been sent. Reference number: {utr}\n${RULE17_LINE.en}\nYou can use this reference number to check the refund in your bank / UPI app.`,
  },
  return: {
    hinglish: 'Is order ka return pickup hoga. Pickup ki details team isi chat me degi. Tab tak product ko uske packet aur tag ke saath sambhaal kar rakhiye.',
    en: 'This order needs a return pickup. Our team will share the pickup details here in this chat. Until then, please keep the product safe with its packet and tags.',
  },
};

export interface MessageVars {
  order?: string;                       // form: verified_order_id as stored, e.g. #1234
  link?: string;                        // form: the raw link (or REFUND_LINK_MASK for a preview)
  utr?: string;                         // refunded
  amount?: number | string;             // refunded: rupees (formatAmount) or an already formatted '₹1,299'
  date?: string;                        // refunded: YYYY-MM-DD (formatDate)
  method?: Method | null;               // refunded: which words "where" uses; never the number (Q3)
}
const NEEDS: Record<Step, (keyof MessageVars)[]> = {
  form: ['order', 'link'], received: [], approved: [], rejected: [], refunded: ['utr', 'amount', 'date'], return: [],
};
// The exact text for one step. Throws when a needed value is missing, so no "{x}" ever reaches a
// customer. Values are put in one pass: a value is never scanned for placeholders again.
export function chatMessage(step: Step, lang: Lang, vars: MessageVars = {}): string {
  const tpl = MESSAGES[step]?.[lang === 'hinglish' ? 'hinglish' : 'en'];
  if (!tpl) throw new Error(`refund message: unknown step ${String(step)}`);
  for (const k of NEEDS[step]) {
    const v = vars[k];
    if (v === undefined || v === null || String(v).trim() === '') throw new Error(`refund message ${step}: missing ${k}`);
  }
  const L: Lang = lang === 'hinglish' ? 'hinglish' : 'en';
  const values: Record<string, string> = {
    order: String(vars.order ?? ''),
    link: String(vars.link ?? ''),
    utr: String(vars.utr ?? ''),
    amount: typeof vars.amount === 'number' ? formatAmount(vars.amount) : String(vars.amount ?? ''),
    date: vars.date && /^\d{4}-\d{2}-\d{2}$/.test(vars.date) ? formatDate(vars.date) : String(vars.date ?? ''),
    where: WHERE[L][vars.method === 'upi' || vars.method === 'bank' ? vars.method : 'any'],
  };
  return tpl.replace(/\{(order|link|utr|amount|date|where)\}/g, (_m, k: string) => values[k]);
}
// Hinglish when the chat's customer writes Hinglish (escalation.ts looksHinglish), else English.
export const messageLang = (hinglish: boolean): Lang => (hinglish ? 'hinglish' : 'en');

// ── Numbers and dates (deterministic: no Intl, no time zone of the machine) ──
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const IST_OFFSET_MS = 330 * 60_000;
// ₹ with Indian grouping (1,23,456); decimals only when not .00: ₹1,299 / ₹1,299.50.
export function formatAmount(n: number): string {
  if (!Number.isFinite(n)) return '';
  const neg = n < 0;
  const p = Math.round(Math.abs(n) * 100);
  const whole = String(Math.floor(p / 100)), dec = p % 100;
  let grouped = whole;
  if (whole.length > 3) {
    const head = whole.slice(0, -3), tail = whole.slice(-3);
    grouped = head.replace(/\B(?=(\d{2})+$)/g, ',') + ',' + tail;
  }
  return `${neg ? '-' : ''}₹${grouped}${dec ? '.' + String(dec).padStart(2, '0') : ''}`;
}
// '2026-10-02' -> '2 Oct 2026'.
export function formatDate(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return '';
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] || ''} ${m[1]}`;
}
const istParts = (at: string | number | Date) => {
  const ms = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at);
  const d = new Date(ms + IST_OFFSET_MS);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), ok: !Number.isNaN(ms) };
};
// '9 Oct' (IST), for "Link valid till 9 Oct".
export function formatDayMonth(at: string | number | Date): string {
  const p = istParts(at);
  return p.ok ? `${p.d} ${MONTHS[p.mo]}` : '';
}
// '2 Oct, 11:42 AM' (IST), for "Submitted on ...".
export function formatDateTime(at: string | number | Date): string {
  const p = istParts(at);
  if (!p.ok) return '';
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  return `${p.d} ${MONTHS[p.mo]}, ${h12}:${String(p.mi).padStart(2, '0')} ${p.h < 12 ? 'AM' : 'PM'}`;
}
// '+91 •••••• 4321' (owner answer Q9: last 4 only).
export const maskedPhone = (last4: string | null | undefined) => (last4 ? `+91 •••••• ${last4}` : '');
// The status view's "Refund to" (the customer's own page, not a chat message; never in a message, Q3).
export const payoutLabel = (method: Method, mask: string) =>
  (method === 'upi' ? `UPI ID ${mask}` : `bank account ending ${(mask || '').slice(-4)}`);

// ── Banks and UPI handles (display and soft hints only; never a network call, never blocks) ──
export const BANK_NAMES: Record<string, string> = {
  SBIN: 'State Bank of India', HDFC: 'HDFC Bank', ICIC: 'ICICI Bank', UTIB: 'Axis Bank', PUNB: 'Punjab National Bank',
  BARB: 'Bank of Baroda', CNRB: 'Canara Bank', UBIN: 'Union Bank of India', KKBK: 'Kotak Mahindra Bank', IDIB: 'Indian Bank',
  BKID: 'Bank of India', IOBA: 'Indian Overseas Bank', MAHB: 'Bank of Maharashtra', YESB: 'Yes Bank', IDFB: 'IDFC FIRST Bank',
  INDB: 'IndusInd Bank', FDRL: 'Federal Bank', PYTM: 'Paytm Payments Bank', AIRP: 'Airtel Payments Bank', FINO: 'Fino Payments Bank',
  AUBL: 'AU Small Finance Bank', UCBA: 'UCO Bank', CBIN: 'Central Bank of India', PSIB: 'Punjab & Sind Bank', KARB: 'Karnataka Bank',
  KVBL: 'Karur Vysya Bank', SIBL: 'South Indian Bank', CIUB: 'City Union Bank', TMBL: 'Tamilnad Mercantile Bank', DCBL: 'DCB Bank',
  RATN: 'RBL Bank', JAKA: 'Jammu & Kashmir Bank', IBKL: 'IDBI Bank', BDBL: 'Bandhan Bank', ESFB: 'Equitas Small Finance Bank',
  IPOS: 'India Post Payments Bank',
};
export const UPI_HANDLES = ['ybl', 'ibl', 'axl', 'okaxis', 'okhdfcbank', 'okicici', 'oksbi', 'paytm', 'pthdfc', 'ptsbi', 'ptyes',
  'ptaxis', 'apl', 'yapl', 'rapl', 'upi', 'axisbank', 'icici', 'sbi', 'hdfcbank', 'kotak', 'waaxis', 'wahdfcbank', 'waicici',
  'wasbi', 'ikwik', 'jupiteraxis', 'naviaxis', 'superyes', 'fam', 'freecharge', 'airtel', 'idfcfirst', 'yesbank', 'indus', 'federal'];
// From an IFSC or a stored bank mask ('HDFC ••••4321'): the first 4 letters.
export const bankName = (ifscOrMask: string | null | undefined): string | null => BANK_NAMES[String(ifscOrMask || '').slice(0, 4).toUpperCase()] || null;
export function upiHandleKnown(upi: string): boolean {
  const at = (upi || '').lastIndexOf('@');
  return at >= 0 && UPI_HANDLES.includes(upi.slice(at + 1).toLowerCase());
}

// ── The page (spec 5.3 - 5.5; 5.6 uploads dropped by the owner) ──
export const REASON_TEXT: Record<Reason, Bi> = {
  damaged: { en: 'Damaged / broken', hi: 'सामान टूटा हुआ या खराब आया' },
  wrong_missing: { en: 'Wrong or missing item', hi: 'गलत सामान आया या कुछ कम आया' },
  not_received: { en: 'Order not received', hi: 'ऑर्डर नहीं मिला' },
  quality: { en: 'Quality / did not like it', hi: 'क्वालिटी ठीक नहीं या पसंद नहीं आया' },
};
export const SUB_REASON_TEXT: Record<string, Bi> = {
  wrong_product: { en: 'Wrong product', hi: 'दूसरा प्रोडक्ट आया' },
  wrong_size: { en: 'Wrong size', hi: 'गलत साइज़' },
  wrong_colour: { en: 'Wrong colour', hi: 'गलत रंग' },
  item_missing: { en: 'An item is missing', hi: 'कोई सामान कम आया' },
  shows_delivered: { en: 'Shows delivered, but I did not get it', hi: 'डिलीवर दिख रहा है, पर मुझे नहीं मिला' },
  never_came: { en: 'It never came', hi: 'ऑर्डर आया ही नहीं' },
  poor_quality: { en: 'Poor quality', hi: 'क्वालिटी खराब है' },
  not_as_shown: { en: 'Not as shown on the website', hi: 'जैसा दिखाया था वैसा नहीं है' },
  did_not_like: { en: 'Did not like it', hi: 'पसंद नहीं आया' },
};
export const DETAILS_PLACEHOLDER: Record<Reason, string> = {
  damaged: 'e.g. The kurta was torn near the sleeve when I opened the packet.',
  wrong_missing: 'e.g. I ordered size M but got L.',
  not_received: 'e.g. Tracking shows delivered on 28 Sep, but nobody at home got it.',
  quality: 'e.g. The colour looks very different from what the website showed.',
};

// Q10 option A: the customer's own name. The version is stored with the request (consent_version).
export const CONSENT_TEXT: Bi & { version: string } = {
  version: CONSENT_VERSION,
  en: 'This UPI ID / bank account is in my own name and the details I gave are correct. I understand that a refund sent to wrong details I typed may not come back.',
  hi: 'यह UPI आईडी / बैंक खाता मेरे अपने नाम पर है और दी गई जानकारी सही है। मुझे पता है कि मेरी लिखी गलत जानकारी पर भेजा गया रिफंड वापस नहीं आ सकता।',
};

export const PAGE = {
  advisory: { en: 'We never ask for your OTP, UPI PIN, card number or password.', hi: 'हम कभी OTP, UPI PIN, कार्ड नंबर या पासवर्ड नहीं माँगते।' },
  title: { en: 'Refund request', hi: 'रिफंड अनुरोध' },
  yourOrder: { en: 'Your order (filled for you)', hi: 'आपका ऑर्डर (पहले से भरा हुआ)' },
  orderId: { en: 'Order ID', hi: 'ऑर्डर आईडी' },
  name: { en: 'Name', hi: 'नाम' },
  phone: { en: 'Phone', hi: 'फ़ोन' },
  items: { en: 'Items', hi: 'सामान' },
  orderTotal: { en: 'Order total', hi: 'कुल राशि' },
  payment: { en: 'Payment', hi: 'भुगतान' },
  paymentCod: { en: 'Cash on delivery (COD)', hi: 'कैश ऑन डिलीवरी (COD)' },
  paymentPrepaid: { en: 'Prepaid (paid online)', hi: 'प्रीपेड (ऑनलाइन भुगतान)' },
  wholeOrder: { en: 'This request is for the whole order.', hi: 'यह अनुरोध पूरे ऑर्डर के लिए है।' },
  // {date} = formatDayMonth(expires_at)
  validTill: { en: 'Link valid till {date}', hi: 'यह लिंक {date} तक चलेगा।' },
  progress: {
    problem: { en: 'Problem', hi: 'समस्या' },
    refundTo: { en: 'Refund to', hi: 'रिफंड कहाँ' }, check: { en: 'Check', hi: 'जाँच' },
  },
  // Step 1
  step1: { en: 'What went wrong?', hi: 'क्या समस्या हुई?' },
  chooseOne: { en: 'Choose one', hi: 'एक चुनें' },
  checkedAround: {
    en: 'I have checked with my family, neighbours and the building security / reception.',
    hi: 'मैंने घर वालों, पड़ोसियों और सिक्योरिटी / रिसेप्शन से पूछ लिया है।',
  },
  tellUs: { en: 'Tell us what happened', hi: 'हमें बताइए क्या हुआ' },
  detailsCounter: { en: `{n} / ${DETAILS_MAX}`, hi: `{n} / ${DETAILS_MAX}` },
  // The details text is optional (owner change 2026-10-02).
  detailsHint: {
    en: 'You can skip this. Please do not write bank details here.',
    hi: 'चाहें तो छोड़ सकते हैं। यहाँ बैंक की जानकारी न लिखें।',
  },
  next: { en: 'Next', hi: 'आगे' },
  // Step 2 (the old photo / video step was dropped by the owner; the keys keep their names)
  step3: { en: 'Where should we send your refund?', hi: 'रिफंड कहाँ भेजें?' },
  methodUpi: { en: 'UPI ID', hi: 'यूपीआई आईडी' },
  methodBank: { en: 'Bank account', hi: 'बैंक खाता' },
  upiId: { en: 'UPI ID', hi: 'यूपीआई आईडी' },
  upiHint: {
    en: 'Like name@okaxis or 98xxxxxx10@ybl. You can find it in your GPay / PhonePe / Paytm profile.',
    hi: 'जैसे name@okaxis। यह GPay / PhonePe / Paytm की प्रोफ़ाइल में मिलेगी।',
  },
  upiUnknownHandle: { en: 'Please check once: this UPI handle is not common.', hi: 'एक बार जाँच लें: यह UPI हैंडल आम नहीं है।' },
  upiName: { en: 'Name shown in your UPI app', hi: 'UPI ऐप में दिखने वाला नाम' },
  upiNameHint: { en: 'Write it in English, as your UPI app shows it.', hi: 'अंग्रेज़ी में लिखें, जैसा UPI ऐप में दिखता है।' },
  holder: { en: 'Account holder name', hi: 'खाताधारक का नाम' },
  holderHint: { en: 'As in your bank passbook', hi: 'जैसा बैंक पासबुक में है' },
  account: { en: 'Account number', hi: 'खाता नंबर' },
  show: { en: 'Show', hi: 'दिखाएँ' },
  hide: { en: 'Hide', hi: 'छिपाएँ' },
  accountAgain: { en: 'Re-enter account number', hi: 'खाता नंबर दोबारा लिखें' },
  accountAgainHint: { en: 'Please type it again.', hi: 'कृपया दोबारा टाइप करें।' },
  ifsc: { en: 'IFSC code', hi: 'IFSC कोड' },
  ifscHint: {
    en: '11 characters, the 5th is zero (0). On your cheque book, passbook or bank app. Example: SBIN0001234',
    hi: '11 अक्षर, पाँचवाँ अक्षर शून्य (0) होता है। चेकबुक, पासबुक या बैंक ऐप में मिलेगा।',
  },
  ifscFixedO: { en: 'We changed the letter O to zero (0).', hi: 'हमने O अक्षर को शून्य (0) कर दिया है।' },
  refundGoesOnlyHere: { en: 'The refund goes only to the details you give here.', hi: 'रिफंड सिर्फ़ यहाँ दी गई जानकारी पर ही भेजा जाएगा।' },
  // Step 3 (check and submit)
  step4: { en: 'Check your details once', hi: 'एक बार अपनी जानकारी जाँच लें' },
  change: { en: 'Change', hi: 'बदलें' },
  notApprovedYet: {
    en: 'Sending this does not mean the refund is approved. Our team will check it and update you in your chat.',
    hi: 'भेजने का मतलब यह नहीं कि रिफंड मंज़ूर हो गया। टीम जाँच करके आपकी चैट में बताएगी।',
  },
  submit: { en: 'Submit refund request', hi: 'रिफंड अनुरोध भेजें' },
  // Success
  received: { en: 'Request received', hi: 'अनुरोध मिल गया' },
  requestNumber: { en: 'Request number: {ref}', hi: 'अनुरोध नंबर: {ref}' },
  willUpdate: { en: 'Our team will check it and update you in your chat.', hi: 'टीम जाँच करके आपकी चैट में बताएगी।' },
  canClose: { en: 'You can close this page.', hi: 'अब आप यह पेज बंद कर सकते हैं।' },
} as const;

// The submitted link's status view (Q4: 90 days).
export const STATUS_VIEW = {
  timeline: {
    received: { en: 'Received', hi: 'मिल गया' },
    approved: { en: 'Approved', hi: 'मंज़ूर' },
    refunded: { en: 'Refund sent', hi: 'रिफंड भेज दिया' },
  },
  notApproved: { en: 'Not approved right now. Our team will talk to you in the chat.', hi: 'अभी मंज़ूर नहीं हुआ। टीम चैट में आपसे बात करेगी।' },
  closed: { en: 'This request is closed. Our team will talk to you in the chat.', hi: 'यह अनुरोध बंद है। टीम चैट में आपसे बात करेगी।' },
  // {at} = formatDateTime(submitted_at), {payout} = the API's masked payout label
  submittedOn: { en: 'Submitted on {at} · Refund to: {payout}', hi: '{at} को भेजा गया · रिफंड: {payout}' },
  notYou: { en: 'If you did not submit this form, tell us in the chat right away.', hi: 'अगर यह फ़ॉर्म आपने नहीं भरा, तो तुरंत चैट में बताइए।' },
  amount: { en: 'Amount', hi: 'राशि' },
  date: { en: 'Date', hi: 'तारीख' },
  reference: { en: 'Reference number', hi: 'रेफ़रेंस नंबर' },
} as const;

// Screens without order data (5.4).
export type ScreenState = 'invalid' | 'expired' | 'replaced' | 'cancelled' | 'used' | 'closed' | 'slow_down';
export const SCREENS: Record<ScreenState, { title: Bi; body: Bi }> = {
  invalid: {
    title: { en: 'This link is not valid', hi: 'यह लिंक सही नहीं है' },
    body: { en: 'Please open the latest refund link in your chat.', hi: 'चैट में भेजा गया नया लिंक खोलें।' },
  },
  expired: {
    title: { en: 'This link has expired', hi: 'इस लिंक का समय खत्म हो गया' },
    body: { en: 'Links work for 7 days. Please ask for a new link in the same chat.', hi: 'लिंक 7 दिन चलता है। उसी चैट में नया लिंक माँगें।' },
  },
  replaced: {
    title: { en: 'A newer link was sent', hi: 'नया लिंक भेजा गया है' },
    body: { en: 'Please use the newest link in your chat.', hi: 'चैट में सबसे नया लिंक खोलें।' },
  },
  cancelled: {
    title: { en: 'This link was closed', hi: 'यह लिंक बंद कर दिया गया है' },
    body: { en: 'If needed, our team will send a new link in your chat.', hi: 'ज़रूरत होने पर टीम चैट में नया लिंक भेजेगी।' },
  },
  used: {
    title: { en: 'This form was already submitted', hi: 'यह फ़ॉर्म पहले ही भरा जा चुका है' },
    body: { en: 'If you did not submit it, tell us in the chat right away.', hi: 'अगर आपने नहीं भरा, तो तुरंत चैट में बताइए।' },
  },
  closed: {
    title: { en: 'The form is not available right now', hi: 'फ़ॉर्म अभी उपलब्ध नहीं है' },
    body: { en: 'Please message us in the chat.', hi: 'कृपया चैट में मैसेज करें।' },
  },
  slow_down: {
    title: { en: 'Too many tries', hi: 'बहुत ज़्यादा कोशिशें' },
    body: { en: 'Please wait a few minutes.', hi: 'कुछ मिनट रुककर कोशिश करें।' },
  },
};

// Validation messages (5.5), shown under the field.
export const ERRORS: Record<string, Bi> = {
  reason_required: { en: 'Please choose what went wrong.', hi: 'कृपया समस्या चुनें।' },
  sub_reason_required: { en: 'Please choose one option.', hi: 'कृपया एक विकल्प चुनें।' },
  checked_around_required: { en: 'Please check with family / neighbours first, then tick this.', hi: 'पहले घर वालों / पड़ोसियों से पूछें, फिर इसे टिक करें।' },
  details_long: { en: `Please keep it under ${DETAILS_MAX} letters.`, hi: `${DETAILS_MAX} अक्षर से कम लिखें।` },
  method_required: { en: 'Please choose UPI or bank account.', hi: 'UPI या बैंक खाता चुनें।' },
  upi_format: { en: 'This UPI ID does not look right. It looks like name@bank.', hi: 'यह UPI आईडी सही नहीं लग रही। यह name@bank जैसी होती है।' },
  holder_format: { en: 'Please write the name in English letters, as in your bank / UPI app.', hi: 'नाम अंग्रेज़ी अक्षरों में लिखें, जैसा बैंक / UPI ऐप में है।' },
  account_format: { en: 'Account number should be 9 to 18 digits.', hi: 'खाता नंबर 9 से 18 अंकों का होना चाहिए।' },
  account_mismatch: { en: 'Both account numbers must be the same.', hi: 'दोनों खाता नंबर एक जैसे होने चाहिए।' },
  ifsc_format: { en: 'IFSC has 11 characters, like SBIN0001234. The 5th is zero (0).', hi: 'IFSC 11 अक्षर का होता है, जैसे SBIN0001234। पाँचवाँ अक्षर शून्य (0) है।' },
  consent_required: { en: 'Please tick to confirm.', hi: 'पुष्टि के लिए टिक करें।' },
  network: { en: 'Could not send. Check your internet and try again.', hi: 'भेजा नहीं जा सका। इंटरनेट देखकर फिर कोशिश करें।' },
  // Not in the spec's table: a nonce problem the customer cannot fix by typing.
  bad_request: { en: 'Please reload this page and try again.', hi: 'कृपया पेज दोबारा खोलकर फिर कोशिश करें।' },
};
// Fill {n}, {date}, {ref}, {at}, {payout} in a page string.
export const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] === undefined ? m : String(vars[k])));
