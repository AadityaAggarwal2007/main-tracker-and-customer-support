// ── Chargeback / court / police threats on a late order -> Refund: the pure part (owner, 2026-10-02) ──
// Owner, 18:45 IST, after a chat of that afternoon ("I have raised the complaint against u in consumer
// department ..."): "asi wali chat ko bhi seedha refund ma bhejdo ... ki mam we are processing your
// refund ... woh pakka chargeback karagi". His answers: only a threat of a chargeback, a consumer court /
// consumer complaint, the police / cyber cell, or a legal notice (NOT a social-media threat, NOT fraud
// words alone, NOT anger alone); only a VERIFIED customer (order ID + full phone); only when the order's
// estimated delivery date has PASSED. Then the chat goes to Refund by itself with the promise below (in
// the customer's language); when the customer writes again, ONE reminder that the refund proof comes in
// this chat and on their email. A Ship again chat with such a threat moves to Refund.
//
// This file holds what needs no database: the detector, the estimated date, the fixed texts and the two
// decisions. The server side (state reads, the mark, the reminder) is case-auto.ts; the widget route
// (src/app/api/widget/message/route.ts) and scripts/refund-threat-candidates.js call it. Pure: imports
// only journey.ts, escalation.ts and tracking-claim.ts, none of which touches the database.
//
// The texts never name the courier, never say today / tomorrow, never promise an amount or a time, and
// never carry a link: the refund form itself is still sent only by the Super Admin (rulebook 9.9).
// Tested in scripts/ai-tests/unit.js and team-routing.js R54-R65 (+ R58r).
import { AUTO_DELIVER_DAY } from '@/lib/journey';
import { isCourtesyOnly } from './escalation';
import type { ClaimLang, ClaimStage } from './tracking-claim';

// ── 1. The detector ───────────────────────────────────────────────────────────────────
export type RefundThreat = 'chargeback' | 'consumer' | 'legal' | 'police';

// A wrong hit here tells a customer "we are processing your refund", so every rule wants the threat
// itself, not a word that can mean something else (checked on 2026-10-02 against English, Hinglish and
// Hindi messages; scripts/ai-tests/unit.js holds them). In particular:
//  - "fir" is Hinglish for "then" (phir): owner 19:20 IST, a chat was listed because of it. FIR counts
//    only as F.I.R., as FIR in capitals among lower-case words, or in an FIR phrase ("FIR darj",
//    "lodge an FIR"); a message in capitals only ("FIR KAB AAYEGA") is not enough.
//  - "consumer care / support / number" is the store's customer care, not the consumer forum.
//  - a court or the police as an address or a job ("Opp. District Court", "Police Bazar", "papa police
//    me hai", "my husband is a police officer"), a lawyer as a person ("papa advocate hai", "gift for my
//    lawyer"), "cyber cafe / security", "nail polis".
//  - "please reverse the payment" asks the store for a refund (today's refund path); "my bank will
//    reverse it" / "reverse karwa dungi" is the chargeback threat.
// The F.I.R. token: dots taken out before the text is cut into clauses.
const FIR_TOKEN = 'f_i_r';
function normalise(text: string): string {
  let t = text.replace(/\bf\.\s?i\.\s?r\b\.?/gi, ` ${FIR_TOKEN} `);
  // FIR in capitals is the police report only among lower-case words: a message in capitals says FIR for "phir".
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  const lower = (t.match(/[a-z]/g) || []).length;
  if (lower * 2 >= latin) t = t.replace(/\bFIR\b/g, ` ${FIR_TOKEN} `);
  return t;
}

// Taken out before matching: a threat that is said NOT to happen ("I won't complain", "complaint nahi
// karungi", "no complaints"), and police / court / lawyer / consumer words that are an address, a job, a
// person or a thing ("near police line", "police verification", "food court", "COD charges back",
// "consumer care number"). A negation never reaches across "I" / "we" / "then" / "warna", so "if you don't
// deliver I will complain" stays a threat, nor across "never got my order" to a threat after it.
const NEG_STEP = String.raw`(?:(?!(?:i|we|i'?ll|then|otherwise|else|warna|or|if|unless|will|but|so|now|ab|got|received|recieved|reached|arrived|came|delivered)\b)[a-z']+\s+)`;
const NEG_TARGET = String.raw`(?:the\s+|a\s+|an\s+|any\s+)?(?:police|pulis|court|consumer\s+\w+|lawyer|advocate|legal\s+action|legal\s+notice|chargeback|charge\s?back|dispute|complaints?|complain\w*|case|fir|${FIR_TOKEN}|sue)\b`;
const LAWYER = String.raw`(?:lawyer|advocate|vakil|vakeel|wakil|wakeel|attorney)`;
const NOT_THREAT: RegExp[] = [
  new RegExp(String.raw`\b(?:won'?t|wont|will\s+not|would\s+not|wouldn'?t|not\s+going\s+to|never|no\s+need\s+to|(?:don'?t|dont|do\s+not)(?!\s+(?:make|force|let)\s+me))\s+(?:(?:want|like|wish|plan|need)\s+to\s+)?${NEG_STEP}{0,3}${NEG_TARGET}`, 'gi'),
  /\bno\s+(?:complaints?|legal\s+action|chargeback|dispute|case|police)\b/gi,
  // Review fix 2026-10-02: a Hinglish "not" in more words, inside one clause (before the shorter rule below,
  // which would leave "police me" behind) ("legal action nahi lena chahti",
  // "police me complaint nahi karungi", "mai police me nahi jaungi", "legal notice nahi bhejna chahti",
  // "legal karwai nahi karni"): the threat word, up to 3 small words, nahi / mat, then a verb.
  new RegExp(String.raw`\b(?:koi\s+)?(?:legal\s+(?:action|notice|karwai|karyawahi|case)|kanoo?ni\s+(?:karwai|karwahi|karyawahi|action|notice)|pol[iy]ce|pulis|court|adalat|consumer\s+\w+|cyber\s+\w+|chargeback|charge\s?back|dispute|complaint|complain|shikayat|case|${FIR_TOKEN})(?:[^\S\n]+(?:me|mein|main|ko|se|pe|par|tak|bhi|wagairah|vagera|koi|complaint|case|report|shikayat|${FIR_TOKEN})){0,3}[^\S\n]+(?:nahi|nhi|nahin|nai|mat)[^\S\n]+(?:\w+[^\S\n]+)?(?:lena|leni|lunga|lungi|lenge|jaunga|jaungi|jayenge|jaana|jana|karunga|karungi|karenge|karna|karni|karte|karti|krunga|krungi|bhejna|bhejni|bhejunga|bhejungi|bhejenge|dalna|dalni|daalna|daalni|chahta|chahti|chahte|chahiye)\b`, 'gi'),
  new RegExp(String.raw`\b(?:koi\s+)?(?:(?:police|consumer|court|legal|cyber|bank)\s+)?(?:complaint|complain|shikayat|case|chargeback|charge\s?back|police|court|fir|${FIR_TOKEN}|dispute)\s+(?:wagairah\s+|vagera\s+|bhi\s+)?(?:nahi|nhi|nahin|nai|na|mat)\s+(?:\w+\s+)?(?:karunga|karungi|karenge|karna|karni|karte|karti|karoonga|krunga|krungi|krna|jaunga|jaungi|jayenge|hai|h|hain|chahiye|chahta|chahti|karo|kariye|kijiye)\b`, 'gi'),
  /\b(?:nahi|nhi|nahin|mat)\s+(?:karunga|karungi|karenge|karna|krunga|krungi)\s+(?:koi\s+)?(?:complaint|complain|case|chargeback|shikayat)\b/gi,
  /(?:शिकायत|केस|चार्जबैक)\s*(?:नहीं|मत)\s*(?:करूँगा|करूंगा|करूँगी|करूंगी|करेंगे|करनी|करना|है)/g,
  // A place or a thing, not a threat.
  /\b(?:near|opp\.?|opposite|behind|beside|nr\.?|in\s+front\s+of|samne|saamne|piche|peeche)\s+(?:the\s+|of\s+)?(?:[a-z]+\s+){0,2}(?:pol[iy]ce|court)\b(?:\s+(?:station|line|lines|chowki|chauki|thana|colony|complex|campus|road|gate))?/gi,
  /\b(?:pol[iy]ce|court)\s+(?:station\s+|line\s+|lines\s+|chowki\s+|chauki\s+|thana\s+|colony\s+)?(?:ke\s+)?(?:paas|pass|samne|saamne|piche|peeche)\b/gi,
  /\bpol[iy]ce\s+(?:line|lines|colony|chowki|chauki|quarters?|headquarters?|hq|verification|uniform|costume|dress|ground|maidan|public\s+school|academy|station\s+road|road|bazaa?r|bajar|nagar|chowk|gate)\b/gi,
  /\bcourt\s+(?:road|colony|compound|campus|chowk|area|complex|style|shoes?|sneakers?|marriage)\b/gi,
  /\b(?:cod|delivery|shipping|extra|convenience|handling|platform)\s+charges?\s+back\b|\bcharges\s+back\b|\bcharge\s+back\s+(?:the\s+|my\s+)?(?:shipping|delivery|cod|extra|convenience|handling|platform)\b/gi,
  // The police as a job or a person, not a threat ("papa police me hai", "my husband is a police officer").
  /\bpol[iy]ce\s+(?:me|mein|main|department\s+(?:me|mein)|dept\s+(?:me|mein))\s+(?:hai|hain|h|hu|hoon|hun|the|thi|tha|job|naukri|kaam|service|duty|posted|tainaat)\b/gi,
  /\bpol[iy]ce\s*(?:man|men|wala|wale|wali|walo|officer|officers|constable|inspector|havaldar|daroga)\s+(?:hai|hain|h|hu|hoon|hun|the|thi|tha|by\s+profession)\b/gi,
  /\b(?:i\s+am|i'?m|he\s+is|she\s+is|he'?s|she'?s|(?:husband|wife|father|dad|papa|brother|bhai|sister|son|daughter|uncle)\s+is)\s+(?:a\s+|an\s+|in\s+the\s+)?pol[iy]ce(?:\s*(?:man|woman|officer|constable|inspector|force|department|service))?\b/gi,
  /\b(?:work|works|working|job|posted)\s+(?:in|for|with)\s+(?:the\s+)?pol[iy]ce\b/gi,
  /\btraffic\s+pol[iy]ce\b|\bpol[iy]ce\s+(?:checking|check|naka|barricade|patrolling|patrol)\b/gi,
  // A lawyer as a person ("I am a lawyer", "papa advocate hai", "gift for my lawyer").
  new RegExp(String.raw`\b(?:i\s+am|i'?m|is|was|he'?s|she'?s)\s+(?:a\s+|an\s+)?${LAWYER}\b|\b${LAWYER}s?\s+(?:friend|by\s+profession|hai|hain|h|hu|hoon|hun|the|thi|tha|ke\s+liye|ki\s+shaadi|ka\s+gown|gown|coat|uniform|dress|band)\b|\b(?:for|gift\s+(?:to|for))\s+(?:my|our|a|his|her)\s+(?:\w+\s+)?${LAWYER}s?\b`, 'gi'),
  // The store's customer care, not the consumer forum.
  /\bconsumer\s+(?:care|support|service|services|number|no\.?|id|electronics|goods|products?|brand|behaviou?r|reviews?|feedback|helpline\s+(?:number|no\.?|num))\b/gi,
  /(?:पुलिस\s*(?:लाइन|कॉलोनी|चौकी\s*के\s*पास|स्टेशन\s*के\s*पास|वेरिफिकेशन)|पुलिस\s*(?:में|मे)\s*(?:हैं|है|थे|नौकरी)|पुलिस\s*(?:वाले|वाला|अफसर|ऑफिसर)\s*(?:हैं|है|थे)|(?:फूड|फ़ूड|टेनिस|बैडमिंटन|बास्केटबॉल)\s*कोर्ट|कोर्ट\s*(?:रोड|कॉलोनी|के\s*पास|के\s*सामने|परिसर|मैरिज)|वकील\s*(?:हैं|है|हूँ|हूं|थे))/g,
];

// A complaint "against you" made on Instagram, Google or the like is a social-media threat (owner: not this
// rule). Only the plain "complaint against you" rules skip a clause that names one; the owner's own
// example also names the consumer department, which matches by itself.
const SOCIAL = /\b(?:insta\w*|ig|facebook|fb|twitter|tweet\w*|x\.com|youtube|yt|google|reviews?|social\s+media|whatsapp|linkedin|threads|reddit|quora|trustpilot|mouthshut)\b|इंस्टा|फेसबुक|यूट्यूब|गूगल/i;

// Review fix 2026-10-02: a complaint "against you" counts only with an OUTSIDE body in the same clause (a
// consumer forum / court / department / helpline, the police, the bank, the government). Without one it is
// a complaint to the store's own staff ("Can I raise a complaint against you here?", "I will complain
// against you to your manager"): today's threat path (escalation.ts), never Refund. A lower-case "fir" is
// "phir" (then), so only the F.I.R. token counts.
const OUTSIDE = new RegExp(String.raw`\b(?:consumer\s*(?:court|forum|commission|department|dept|cell|affairs|protection|helpline|portal|grievance|adalat)s?|national\s+consumer|NCH|e-?\s?daa?khil|grahak\s+(?:adalat|suraksha|nyayalaya|forum|court|ayog|aayog)|courts?|adalat|pol[iy]ce|pulis|${FIR_TOKEN}|cyber\s*(?:cell|crime|police)|cybercrime\w*|bank|rbi|npci|ombudsman|government|govt|sarkar|ministry|pmo|cpgrams|pg\s?portal)\b|उपभोक्ता|कंज्यूमर|अदालत|कोर्ट|न्यायालय|पुलिस|बैंक|सरकार`, 'i');
// Review fix 2026-10-02: a "case" with no court, police or legal word near it is a support case ("please
// register a case for my parcel", "file a case with the courier").
const LEGAL_NEAR = new RegExp(String.raw`\b(?:courts?|adalat|legal\w*|lawyer|advocate|vakil|vakeel|wakil|wakeel|attorney|kanoo?n\w*|pol[iy]ce|pulis|than[ae]|${FIR_TOKEN}|consumer\s*(?:court|forum|commission|department|dept|cell|helpline|adalat))\b`, 'i');
// Review fix 2026-10-02: the store asked to chase someone else, not threatened: the courier / delivery boy
// as the target ("can you raise a dispute with the courier?", "courier ke saath case file karo"), a
// question to the store at the start of the clause ("can you ..."), "please file / raise ...", or the
// imperative right after "case" / "dispute" ("case file kar do", "dispute raise karo").
const ASKS_STORE = /\b(?:courier|couriers|delivery\s*(?:boy|guy|man|partner|agent|person|wal[aei])|shipping\s*(?:partner|company)|logistics)\b|^\s*(?:can|could|would|will)\s+(?:you|u)\b|\b(?:please|pls|plz|kindly)\s+(?:\w+\s+){0,2}(?:file|raise|register|lodge|open|start|put)\b|\b(?:case|dispute)\s+(?:(?:raise|file|darj|daal|dal|open|lodge|register)\s+)?(?:kar\s+do|kar\s+dijiye|kar\s+dena|karo|kro|kariye|kijiye|karwa\s+do|karwado|do|dijiye)\b/i;

// The store as the target of a complaint: you / u / your company ..., never the delivery boy or the courier.
const AGAINST_YOU = String.raw`(?:against|agaisnt|agianst|aganist)\s+(?:you|u|yu|you\s+(?:guys|people|all)|(?:your|ur|this|the)\s+(?:company|store|site|website|shop|seller|brand|page|team|business)|vastora)\b`;
const HI_YOU = String.raw`(?:aap|aapke|aapki|aapka|apke|apki|apka|tum|tumhare|tumhari|tumhara|tere|teri|tera|is\s+company|iss\s+company|is\s+store|vastora)`;
const GO_TO_COURT = String.raw`(?:case|cases|notice|summons?|jaunga|jaungi|jaoonga|jaoongi|jaunge|jayenge|jaenge|jayengi|jaana|jana|jane|jaane|jakar|jaake|ja\s+ke|ja\s+kar|ja\s+rah\w*|ja\s+sakt\w*|le\s+ja\w*|ghasit\w*|ghaseet\w*|khinch\w*|kheench\w*|milenge|milte|action|proceedings?|bhej\w*|file\w*|dekh\s?l\w*)`;

// social: skipped in a clause that names a social-media site. needs: the clause must also match it.
// unless: the clause must not match it.
interface Rule { re: RegExp; social?: boolean; needs?: RegExp; unless?: RegExp }
const RULES: Record<RefundThreat, Rule[]> = {
  chargeback: [
    { re: /\bcharge[\s-]?bac?k|\bchargback/i },
    { re: /\b(?:raise|raising|raised|file|filing|filed|start|open|lodge|put|daal\w*|dal\w*)\s+(?:a\s+|an\s+|the\s+)?(?:payment\s+|card\s+|bank\s+|transaction\s+)?dispute\b|\bdispute\s+(?:raise|file|daal|dal|kar|open|lodge)\w*/i, unless: ASKS_STORE },
    { re: /\bdispute\b[^\n]{0,30}\b(?:bank|card|payment|transaction|charge|upi|gpay|phonepe|paytm)\b|\b(?:bank|card|upi|gpay|phonepe|paytm)\b[^\n]{0,30}\bdispute\b/i },
    // The bank / the customer reverses it; "please reverse the payment" is a refund request, not this.
    { re: /\b(?:ask|asked|tell|told|request|requested|get|got)\s+(?:my\s+|the\s+)?bank\s+(?:to\s+)?(?:\w+\s+){0,3}revers\w*|\bbank\s+(?:se|say|sy|ke\s+through|dwara|ke\s+zariye)\s+(?:\w+\s+){0,3}revers\w*|\brevers\w*\s+(?:karwa|karva|krwa|krva)(?:unga|ungi|enge|oonga|oongi|\s+(?:dunga|dungi|denge|lunga|lungi|lenge))\b|\bi\s*(?:will|'ll|shall|am\s+going\s+to|'m\s+going\s+to|m\s+going\s+to)\s+(?:get\s+|have\s+)?(?:(?:the|my|this|that|it|payment|transaction|amount|money|paisa|paise)\s+){0,2}revers(?:e|ed)\b/i },
    { re: /\b(?:bank|rbi|npci|banking\s+ombudsman|card\s+company|credit\s+card|debit\s+card)\s+(?:me|mein|main|ko|se|pe|par|to|with|in)?\s*(?:complain\w*|shikayat|dispute|report\s+kar\w*)\b|\b(?:complain\w*|shikayat|report\w*)\s+(?:to|with|in|at|me|mein|ko)\s+(?:my\s+|the\s+|apne\s+)?(?:bank|rbi|npci)\b/i },
    // Review fix 2026-10-02: only with the customer's own threat verb after it ("bank se paise wapas le lungi",
    // "... karwa lungi"); "bank se paise wapas kab aayenge?" is a refund question (today's refund path).
    { re: /\bbank\s+(?:se|say|sy)\s+(?:mere\s+|apne\s+)?(?:paise|paisa|pese|money|refund|amount)\s+(?:wapas|vapas|back)\s+(?:le\s*(?:lunga|lungi|lenge)|(?:karwa|karva|krwa|nikalwa|nikalva|mangwa|mangva)\s*(?:lunga|lungi|lenge|dunga|dungi|denge)|(?:karwa|karva|nikalwa|mangwa)(?:unga|ungi|oonga|oongi|enge|yenge))\b/i },
    { re: /चार्जबैक|चार्ज\s*बैक|बैंक\s*(?:में|को|से)?\s*(?:शिकायत|डिस्प्यूट)/ },
  ],
  consumer: [
    { re: /\bconsumer\s*(?:court|forum|commission|department|dept|cell|affairs|protection|case|portal|grievance|redressal|ministry|adalat)s?\b/i },
    { re: /\b(?:call|calling|contact|approach|complain\w*\s+(?:to|on|at)|report\w*\s+(?:to|on|at))\s+(?:the\s+)?(?:national\s+)?consumer\s+helpline\b/i },
    { re: /\bconsumer\b[^\n]{0,40}\b(?:complain\w*|case|shikayat|report\w*|notice)\b|\b(?:complain\w*|case|shikayat|report\w*)\b[^\n]{0,40}\bconsumer\b/i },
    { re: /\bnational\s+consumer\b|\be-?\s?daa?khil\b|\bgrahak\s+(?:adalat|suraksha|nyayalaya|forum|court|ayog|aayog)\b|\bingram\s+portal\b/i },
    { re: /\bNCH\b/ },
    { re: /\b(?:complain\w*|shikayat|report\w*)\b[^\n]{0,30}\b(?:pmo|cpgrams|pg\s?portal|ministry|government|govt|sarkar|authorit(?:y|ies))\b/i },
    { re: new RegExp(String.raw`\b(?:complain\w*|case|report\w*|shikayat|legal\s+action|action)\s+${AGAINST_YOU}`, 'i'), social: true, needs: OUTSIDE },
    { re: /\b(?:against|agaisnt|agianst|aganist)\s+(?:you|u|yu)\s+(?:\w+\s+){0,2}(?:complain\w*|case|shikayat|report\w*)\s+(?:karunga|karungi|karenge|kar\s+dunga|kar\s+dungi|kar\s+denge|krunga|krungi|karwa\w*|daal\w*|file\w*|darj)\b/i, social: true, needs: OUTSIDE },
    { re: new RegExp(String.raw`\b${HI_YOU}\s+(?:\w+\s+){0,2}(?:khilaf|khilaaf|against)\b[^\n]{0,30}\b(?:complain\w*|case|shikayat|report\w*|kesh)\b|\b(?:complain\w*|case|shikayat|report\w*)\b[^\n]{0,30}\b${HI_YOU}\s+(?:\w+\s+){0,1}(?:khilaf|khilaaf|against)\b`, 'i'), social: true, needs: OUTSIDE },
    { re: /(?:उपभोक्ता|कंज्यूमर)\s*(?:फोरम|फ़ोरम|अदालत|कोर्ट|आयोग|हेल्पलाइन|शिकायत|केस|विभाग|न्यायालय)|ग्राहक\s*(?:फोरम|फ़ोरम|अदालत|कोर्ट|आयोग|न्यायालय)|(?:शिकायत|केस)[^।.?!\n]{0,30}(?:उपभोक्ता|कंज्यूमर)/ },
    { re: /(?:आपके|आपकी|तुम्हारे|तुम्हारी|इस\s*कंपनी\s*के|कंपनी\s*के)\s*(?:खिलाफ|ख़िलाफ़)[^।.?!\n]{0,30}(?:शिकायत|केस|रिपोर्ट)|(?:शिकायत|केस)[^।.?!\n]{0,30}(?:आपके|आपकी|तुम्हारे|तुम्हारी)\s*(?:खिलाफ|ख़िलाफ़)/, social: true, needs: OUTSIDE },
  ],
  legal: [
    { re: /\blegal(?:ly)?\s+(?:action|notice|case|steps?|proceedings?|matter|route|recourse|karwai|karyawahi|kar\w*|jaunga|jaungi|jayenge|lunga|lungi|lenge|proceed|deal|aage)\b/i },
    { re: /\b(?:law\s?suit|lawsuits|suing)\b|\bsue\s+(?:you|u|your|ur|this|the\s+company|them|vastora)\b|\bi\s*(?:will|'ll|shall|am\s+going\s+to|m\s+going\s+to|would)\s+sue\b/i },
    { re: new RegExp(String.raw`\b${LAWYER}s?\b[^\n]{0,40}\b(?:notice|contact|sue|case|court|legal|bhej\w*|karwa\w*|hire|through|baat|talk|handle)\b|\b${LAWYER}s?\s+(?:se|ko|ke\s+through|ke\s+zariye|dwara|will|dekh\s?le\w*|dekhega|dekhenge|dekhegi)\b|\b(?:my|our|apne|mere|hamare|through|via|consult|hire|contact)\s+(?:a\s+)?${LAWYER}\b`, 'i') },
    // A court of law with a threat around it: "see you in court", "take you to court", "court me case",
    // "court tak jaungi". A court alone ("court shoes", "District Court" in an address) is not this rule.
    { re: /\b(?:to|in|into|at|before|till|until|tak)\s+(?:the\s+|a\s+)?(?:consumer\s+|district\s+|high\s+|civil\s+|supreme\s+|family\s+|sessions?\s+)?courts?\b(?!-)/i },
    { re: new RegExp(String.raw`\bcourts?\s+(?:(?:me|mein|main|tak|bhi|hi)\s+)*${GO_TO_COURT}\b`, 'i') },
    { re: /\b(?:go|going|gone|went|move|moving|approach|approaching|drag|dragging|take|taking)\s+(?:you\s+|u\s+|this\s+|the\s+matter\s+|it\s+)?(?:to\s+)?(?:the\s+)?courts?\b(?!-)/i },
    { re: /\b(?:court|legal|police|consumer)\s+case\b/i },
    // Review fix 2026-10-02: "case karunga / kar dunga" (the customer's own case) unless the store is asked to
    // chase the courier; "file / register / darj a case" only with a court, police or legal word near it.
    { re: /\bcase\s+(?:karunga|karungi|karenge|kar\s+dunga|kar\s+dungi|kar\s+denge|lagaunga|lagaungi|laga\s+(?:dunga|dungi|denge)|thok\w*|daal\s*(?:dunga|dungi|denge)|daalunga|daalungi|dalunga|dalungi)\b/i, unless: ASKS_STORE },
    { re: /\bcase\s+(?:darj|file)\w*|\b(?:file|lodge|register|darj)\w*\s+(?:a\s+)?case\b/i, needs: LEGAL_NEAR },
    { re: /\b(?:legal\s+)?notice\s+(?:bhejunga|bhejungi|bhejenge|bhej\s+dunga|bhej\s+dungi|bhej\s+denge|bhijwa\w*|send\s+kar\w*|serve)\b|\b(?:send|serve|issue)\s+(?:(?:you|u)\s+(?:a\s+|an\s+)?(?:legal\s+)?|(?:a\s+|an\s+)?legal\s+)notice\b/i },
    { re: /\bkanoo?ni\s+(?:karwai|karwahi|karyawahi|karyavahi|karvai|action|notice|kadam|madad)\b|\bkanoo?n\s+(?:ka\s+sahara|ki\s+madad)\b/i },
    { re: /कोर्ट|अदालत|न्यायालय|वकील\s*(?:से|के\s*ज़?रिए|द्वारा|नोटिस|भेज)|(?:मेरे|मेरा|अपने|हमारे)\s*वकील|कानूनी\s*(?:कार्रवाई|कार्यवाही|नोटिस)|लीगल\s*नोटिस|मुक़?दमा|केस\s*(?:करूँगा|करूंगा|करूँगी|करूंगी|करेंगे|दर्ज)/ },
  ],
  police: [
    { re: /\b(?:police|pulis)\b|\bpolis\s+(?:me|mein|ko|se|complaint|case|station|thana|report|jaunga|jaungi)\b/i },
    // FIR: the token (F.I.R., or FIR in capitals among lower-case words), or an FIR phrase. Never a bare
    // lower-case "fir" ("fir complaint karungi" = "then I will complain").
    { re: new RegExp(String.raw`\b${FIR_TOKEN}\b|\bfir\s+(?:darj|lodge|lodged|registered|filed)\b|\b(?:lodge|lodged|lodging)\s+(?:an?\s+|the\s+|my\s+)?fir\b|\b(?:file|filed|filing|register|registered|raise|raised)\s+an?\s+fir\b|\ban\s+fir\b`, 'i') },
    { re: /\bcyber\s*(?:cell|crime|police|complaint|dept|department|thana|cel)\b|\bcybercrime\w*|\bcyber\b[^\n]{0,20}\b(?:complain\w*|report\w*|shikayat)\b/i },
    { re: new RegExp(String.raw`\bthan[ae]\s+(?:me\s+|mein\s+|main\s+|pe\s+|par\s+)?(?:complaint|complain|report|shikayat|case|rapat|riport|${FIR_TOKEN})\w*`, 'i') },
    { re: /पुलिस|साइबर\s*(?:सेल|क्राइम|पुलिस|थाना|थाने|शिकायत)|एफ़?आईआर|थाने\s*में\s*(?:शिकायत|रिपोर्ट|केस|रपट|एफ़?आईआर|जा)/ },
  ],
};
const KINDS: RefundThreat[] = ['chargeback', 'consumer', 'legal', 'police'];

// One sentence or clause at a time: the words of one rule must be in the same clause.
const CLAUSE = /[.?!\n।;]+|\s+(?:and|aur|also|but|lekin|plus)\s+/i;

// The kind of threat in one customer message, or null. Only the four the owner named; a social-media
// threat, a fraud word or anger alone is null (they keep today's paths in escalation.ts).
export function refundThreatKind(text: string | null | undefined): RefundThreat | null {
  let t = normalise(String(text || '').slice(0, 2000));
  if (!t.trim()) return null;
  for (const re of NOT_THREAT) t = t.replace(re, ' ');
  const clauses = t.split(CLAUSE).filter((c) => c && c.trim());
  for (const k of KINDS) {
    for (const c of clauses) {
      const social = SOCIAL.test(c);
      if (RULES[k].some((r) => !(r.social && social) && (!r.needs || r.needs.test(c)) && !(r.unless && r.unless.test(c)) && r.re.test(c))) return k;
    }
  }
  return null;
}

// ── 2. The estimated date ─────────────────────────────────────────────────────────────
// The same date the app quotes (orders.ts toFoundOrder): the order's estimated_delivery, else the
// day-13 end of the delivery window from when it was placed. As epoch ms, or null when unknown.
const DAY_MS = 86_400_000;
const IST_MS = 330 * 60_000;
const ms = (v: string | Date | null | undefined): number => {
  if (v == null || v === '') return NaN;
  return v instanceof Date ? v.getTime() : Date.parse(String(v));
};
export function etaOf(o: { estimated_delivery?: string | Date | null; placed_on?: string | Date | null } | null | undefined): number | null {
  if (!o) return null;
  const e = ms(o.estimated_delivery);
  if (Number.isFinite(e)) return e;
  const p = ms(o.placed_on);
  return Number.isFinite(p) ? p + AUTO_DELIVER_DAY * DAY_MS : null;
}
// The India calendar day of an instant (no Date getters: the server's time zone never matters).
export const istDay = (t: number) => Math.floor((t + IST_MS) / DAY_MS);
// PASSED = the estimated day is over in India: an order due on 2 Oct has passed from 3 Oct 00:00 IST.
// A DATE column arrives as midnight (UTC or the server's zone), which is the same India day either way.
export function etaPassed(eta: number | null | undefined, now: number): boolean | null {
  if (eta == null || !Number.isFinite(eta)) return null;
  return istDay(eta) < istDay(now);
}

// ── 3. The fixed texts ────────────────────────────────────────────────────────────────
// The language: claimLang (tracking-claim.ts) over the threat message and the customer's last few.
export type RefundLang = ClaimLang;

// A. The promise (owner's words: "we're sorry, we are processing your refund, our team will send you a
// refund form in this chat to collect your UPI / bank details").
const PROMISE: Record<RefundLang, string> = {
  en: "We're sorry for the trouble. We are processing your refund, and our team will send you a refund form here in this chat to collect your UPI / bank details.",
  hinglish: 'Pareshani ke liye sorry. Hum aapka refund process kar rahe hain, hamari team isi chat me aapko refund form bhejegi jisme aap apni UPI / bank details de payenge.',
  hi: 'परेशानी के लिए माफ़ी चाहते हैं। हम आपका रिफंड प्रोसेस कर रहे हैं, हमारी टीम इसी चैट में आपको रिफंड फॉर्म भेजेगी जिसमें आप अपनी UPI / बैंक डिटेल्स दे पाएँगे।',
};
// B. The one reminder when the customer writes again (owner: "issi chat aur gmail pe dono pe de degi
// aapko refund ka proof"). No new promise, no time.
const REMINDER: Record<RefundLang, string> = {
  en: 'Our team is processing your refund, and they will share the refund proof with you both here in this chat and on your email.',
  hinglish: 'Hamari team aapka refund process kar rahi hai, refund ka proof aapko isi chat aur aapke Gmail / email dono pe de degi.',
  hi: 'हमारी टीम आपका रिफंड प्रोसेस कर रही है, रिफंड का प्रूफ आपको इसी चैट और आपके ईमेल दोनों पर दे देगी।',
};
export function refundPromiseReply(lang: RefundLang): string { return PROMISE[lang] ?? PROMISE.en; }
export function refundReminderReply(lang: RefundLang): string { return REMINDER[lang] ?? REMINDER.en; }
// The reminder's first words in each language: case-auto.ts looks for them in the AI messages since the
// mark, so "the one reminder was sent" holds whatever language it went out in.
export const REFUND_REMINDER_HEADS: readonly string[] = Object.values(REMINDER).map((t) => t.split(',')[0]);

// ── 4. The decisions ──────────────────────────────────────────────────────────────────
// What a threat message does in a chat. `order` undefined = not loaded yet (the caller loads it only
// when every other check passed: 'need_order'); null = could not be loaded.
export interface RefundThreatFacts {
  strictProof: boolean;          // verified_order_id set AND proved by order ID + full phone ('form' / 'chat_phone')
  caseKind: string | null;       // the chat's mark now
  otherOrder: boolean;           // the message may be about another order than the verified one
  refundRemoved: boolean;        // a Refund mark was taken out of this chat before (never again by itself)
  otherRefundChat: boolean;      // the same order is already in Refund in another chat
  // cod: a Cash on Delivery order (orders.ts payment 'Cash on Delivery (COD)'): nothing was paid yet.
  order?: { stage: ClaimStage; etaPassed: boolean | null; cod?: boolean } | null;
}
export type RefundThreatStep =
  | { act: 'mark' }              // not marked: Refund + the promise
  | { act: 'switch' }            // Ship again: switched to Refund + the promise
  | { act: 'in_refund' }         // already in Refund: the Refund chat's own follow-up decides
  | { act: 'need_order' }
  | { act: 'today'; why: string };   // not this rule: today's path (a threat: Needs you, the 1-hour line)
export function refundThreatStep(f: RefundThreatFacts): RefundThreatStep {
  const today = (why: string): RefundThreatStep => ({ act: 'today', why });
  if (!f.strictProof) return today('not verified by order ID + full phone');
  if (f.caseKind === 'refund') return { act: 'in_refund' };
  if (f.caseKind && f.caseKind !== 'reship') return today(`marked ${f.caseKind}`);
  if (f.otherOrder) return today('another order');
  if (f.refundRemoved) return today('Refund removed before');
  if (f.otherRefundChat) return today('order already in Refund in another chat');
  if (f.order === undefined) return { act: 'need_order' };
  if (f.order === null) return today('order not loaded');
  // Safe defaults (the owner did not decide these): Delivered, cancelled, returned (RTO) or failed
  // orders never go to Refund by themselves.
  if (f.order.stage === 'delivered') return today('delivered order');
  if (f.order.stage === 'other') return today('cancelled / returned / failed order');
  // Review fix 2026-10-02 (a safe default until the owner decides): a Cash on Delivery order that is not
  // delivered has had nothing paid, so "we are processing your refund ... your UPI / bank details" would be
  // false. Today's threat path (Needs you, the 1-hour line).
  if (f.order.cod) return today('COD order, nothing paid');
  if (f.order.etaPassed === null) return today('no estimated date');
  if (!f.order.etaPassed) return today('estimated date not passed');
  return { act: f.caseKind === 'reship' ? 'switch' : 'mark' };
}

// ── 5. Another order than the verified one, for this rule (review fix 2026-10-02) ──────
// mentionsOtherOrder (tracking-claim.ts) reads any 4-6 digit number as an order number. A customer who
// threatens a chargeback very often names what they paid, a date or a PIN code ("I paid 1499 and got
// nothing", "ordered on 25/09/2026"), and is exactly the customer this rule is for. Here a number counts
// only when it is written as an order ("#4716", "order 4716", "order no. 4716"), or is a bare 4-5 digit
// number that is not an amount (after Rs / ₹ / INR / paid / pay / price ..., or before rs / rupees / /-)
// and not part of a date. A bare 6-digit number is a PIN code. The tracking claim keeps mentionsOtherOrder.
const digitsOf = (s: unknown) => String(s ?? '').replace(/\D/g, '');
const ORDER_NO_RE = /(?:#\s*|\border\s*(?:id|no\.?|number|num)?\s*[:#-]?\s*#?\s*)(\d{4,6})\b/gi;
const MONTH = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?`;
const DATE_RES: RegExp[] = [
  /\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b|\b\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}\b/g,
  new RegExp(String.raw`\b(?:\d{1,2}(?:st|nd|rd|th)?\s+)?${MONTH},?\s+(?:\d{1,2}(?:st|nd|rd|th)?,?\s+)?(?:19|20)\d\d\b`, 'gi'),
];
const AMOUNT_RE = /(?:₹|\b(?:rs|inr|rupees?|paid|pay|payed|payment(?:\s+of)?|amount(?:\s+of)?|total|price|cost|mrp)\b)\.?\s*:?\s*(?:of\s+)?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s*(?:\/-|rs\b|rupees?\b|inr\b|₹)/gi;
export function threatNamesOtherOrder(said: string | null | undefined, verifiedOrderId: string | null | undefined): boolean {
  const mine = digitsOf(verifiedOrderId);
  let t = String(said || '').slice(0, 2000);
  for (const m of t.matchAll(ORDER_NO_RE)) if (m[1] !== mine) return true;
  t = t.replace(ORDER_NO_RE, ' ');
  for (const re of DATE_RES) t = t.replace(re, ' ');
  t = t.replace(AMOUNT_RE, ' ');
  return (t.match(/(?<![\d.,])\b\d{4,5}\b(?![.,]?\d)/g) || []).some((n) => n !== mine);
}

// The customer writes again in a Refund chat. auto: Chikki's own mark and nobody of the team (a reply or
// the Super Admin's refund form message) has written since. null: not Chikki's chat any more, today's
// path (a marked chat sends nothing, rule 9.2). 'reminder' at most once; 'silent' otherwise.
export function refundFollowUpAction(x: { auto: boolean; said: string; repeated: boolean }): 'reminder' | 'silent' | null {
  if (!x.auto) return null;
  if (isCourtesyOnly(String(x.said || ''))) return 'silent';
  return x.repeated ? 'silent' : 'reminder';
}
