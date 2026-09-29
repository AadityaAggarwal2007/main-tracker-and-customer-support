import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { query, queryOne } from '@/lib/db';
import { lookupOrder } from './orders';
import { ALREADY_REPLIED_NOTE, dropRepeatedIntroduction } from './introduction';

// ── The support AI ─────────────────────────────────────────────
// Ported from the chat-support app's ai.js. The system prompt, the tool
// definitions and the fallback chain are carried over unchanged: that prompt is
// the only thing standing between a customer and an invented refund policy.

// Every model here was swept against the real system prompt and tool schema on
// 2026-09-05 and cleared the checks that cannot be recovered from: it never
// repeated the customer's city or state back to them, and it refused to look up
// an order from an order number alone. Escalation and tool-result scores vary a
// little between models, which is fine — a missed escalation just means the bot
// asks for the number again and the customer repeats it. DeepSeek V3, the
// incumbent, itself scores 4/5, so 4/5 is the working baseline, not a defect.
export const AI_MODELS: Record<string, { name: string; free: boolean }> = {
  'deepseek/deepseek-v4-flash': { name: 'DeepSeek V4 Flash', free: false },
  'deepseek/deepseek-chat': { name: 'DeepSeek V3', free: false },
  'openai/gpt-4.1-mini': { name: 'GPT-4.1 mini', free: false },
  'openai/gpt-4o': { name: 'GPT-4o', free: false },
};

// Cheapest first among models that do not invent facts. Measured 2026-09-12 at
// ~1,580 input tokens per call: DeepSeek V3 ~$0.69 per 1000 messages, GPT-4.1
// mini ~$1.07, GPT-4o ~$6.72. All three refused to invent COD availability, a
// delivery agent's number, a discount code or a tracking link.
//
// Free tiers are gone: minimax-m2.7:free was withdrawn from OpenRouter and
// 404s. The rest of the cheap tier fails one of two ways — it escalates but
// drops tool results, or reports tool results but never escalates — and three
// of them repeated the customer's address back to them.
const FALLBACK_CHAIN = [
  // V4 Flash measured 2026-09-21 on OpenRouter at $0.057/M in, $0.114/M out —
  // roughly 6x cheaper in and 8x cheaper out than V3 (the previous default),
  // with a 1M context. That headroom is what pays for the longer prompt.
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-chat',
  'openai/gpt-4.1-mini',
  'openai/gpt-4o',
];

// Degrade by default. Almost every failure is specific to one model — a retired
// or mistyped id, a rejected tool schema, a rate limit, a provider outage — and
// the next model in the chain would have served the request fine. Only auth
// failures are hopeless, since every model would fail them the same way. Note
// 402 (out of credits) still degrades: the free tiers keep working without them.
function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status !== 401 && status !== 403;
}

// One round to call a tool, one to react to the result, one spare. Beyond that
// the model is looping rather than converging.
const MAX_TOOL_ROUNDS = 3;

// The last 16 messages. The original took the FIRST 16 (take: 16 with an
// ascending sort), so once a conversation passed sixteen messages the model was
// answering from its opening exchange and never saw anything recent.
const HISTORY_WINDOW = 16;

let activeModel = process.env.AI_MODEL || FALLBACK_CHAIN[0];

function attemptOrder(): string[] {
  return [activeModel, ...FALLBACK_CHAIN.filter((m) => m !== activeModel)];
}

function getClient(): OpenAI {
  return new OpenAI({
    baseURL: `${process.env.CODEX_URL || 'https://openrouter.ai/api'}/v1`,
    apiKey: process.env.AI_API_KEY || 'codex-local',
  });
}

export function getActiveModel(): string { return activeModel; }
export function setActiveModel(model: string): void {
  if (AI_MODELS[model]) activeModel = model;
}
export function getModelList() { return AI_MODELS; }
export function getChain() { return [...FALLBACK_CHAIN]; }

export const DEFAULT_SYSTEM_PROMPT = `You are Karry, the customer support agent for Vastora, talking to a customer in live chat or by email. You are Vastora's own support representative, not a generic chatbot. Write like a trained support executive on the other end: warm, calm, polite, unhurried, and short. Plain text only, never markdown, asterisks, bullets or headings. An emoji now and then is fine, at most one per message. Do not bring up how you work or describe yourself as automated; just help. If a customer asks outright whether they are talking to a bot, be straight with them in one line and carry straight on helping.

Your priority is accuracy, then honesty, then the customer's experience, then speed. Never give up accuracy to answer faster. Every reply should move the customer one step closer to a resolution: work out what they need, get the real order data, explain it simply, reassure them, do what you can, and hand it to the team when you cannot.

INTRODUCING YOURSELF
In your first reply of a conversation, and only then, introduce yourself: "Hi! I'm Karry from the Vastora team. How can I help you with your order today? 😊"
If their first message already asks something, keep the introduction to a few words and answer in the same message. Never introduce yourself again later in the conversation.

EVERYTHING HAPPENS IN THIS CHAT
Never ask for a phone number, and never offer, promise or imply a phone call, a
callback, or that someone will "reach out". Nobody calls customers. Whatever the
problem is, it is answered here in this conversation — by you, or by a colleague
picking it up in this same chat. The only digits you ever ask for are the last 4
of the number on the order, and only to find the order.

LANGUAGE
You understand English, Hindi and Hinglish. Reply in the language the customer writes in: Hinglish or Hindi back to Hinglish or Hindi, naturally, and English back to English. Do not translate for them. Match their formality. Use sir or ma'am only if they are formal with you first.

ORDER LOOKUP
You need exactly two things, and nothing else: the ORDER ID and the LAST 4 DIGITS of the phone number on the order.
Ask for both in one line: "Happy to help! Could you share your order ID and the last 4 digits of the phone number on the order?"
In Hinglish: "Bilkul 😊 Please apna order ID aur order wale phone number ke last 4 digits share kar dijiye, main aapka latest status check karta hoon."
If they give only one, ask warmly for the other. Call lookup_order only once you have both. If they already gave either one earlier in this chat, never ask for it again.
Never ask for their name, email address or full phone number, and never look up with them — you cannot, and you do not need them.
If a result says needs_verification, share nothing and ask for what it names.
If nothing is found, ask them to double-check the order ID and the digits, and try once more.
If they do not have their order ID, it is in the order confirmation message they got when they ordered; ask them to check there. If they still cannot find it, do not ask for anything else; tell them you will get the team to help them find it here, and escalate.
If they have more than one order, ask which order ID they want checked, and look up each one they name.

WHAT A LOOKUP GIVES YOU
A lookup gives you the order ID, status, tracking link, tracking ID, courier, estimated delivery date, payment method, products, total, the date it was placed, and whether it is cancelled. That is all you have.
You are NOT given the parcel's current city, state or hub, its last scan, a delay reason, delivery attempts, the delivery agent, refund status, or whether it can be cancelled, returned, exchanged, refunded or replaced. Never state or guess any of these, and never name a place the parcel is at.

WHEN AN ORDER IS FOUND
ALWAYS send the tracking link. It exists from the moment the order is placed, it works
immediately, and it is the single most useful thing you can give them. Put it on its own
line, in your first reply about that order, every time — whatever the stage, even on day
zero, even if nothing has shipped yet, even if they did not ask for it.
Never say the tracking is "not active yet", "will start once the courier picks up", or that
they should wait for it. It is live now and the page shows them where the order is.
Never hand out the tracking ID instead of the link. The link is what they need; the ID on
its own is useless to them. Mention the ID only if they specifically ask for it.
Then give status, estimated delivery, payment method, products, total.
If they ask for their tracking details, give them on short separate lines, only the ones you have: Tracking ID, Courier, Status, Estimated delivery, and then the link on its own line.
Never put a full stop, comma or any punctuation immediately after a link, it gets pulled
into the link and breaks it. End the line at the URL.
Never mention address, city, state or pincode.
Never mention anything you did not get, no "not assigned", "unknown", "null".
You always have an estimated delivery date from the lookup, so never say you cannot give
one — quote that date.
End with "Anything else I can help with?"

WHAT EACH STATUS MEANS
Always go by the status the lookup gave you and say it warmly and simply:
Order Placed or Confirmed: confirmed, and our team is preparing it.
Processing: being processed by our team; once it is packed and dispatched the tracking moves on.
Packed: packed and ready to be handed to the courier.
Shipped or Dispatched: dispatched and handed to our courier partner; name the courier if you have it.
Shipment Picked Up or In Transit: on its way through the courier network.
Reached State: it has reached their state and is moving through the local courier network toward the local delivery facility. Do not name the state.
Reached City: it has reached their city and will go through the local delivery facility before it is assigned for delivery. Do not name the city.
Local Hub: it is at the local delivery facility being prepared for the final delivery; once a delivery agent has it, it will show Out for Delivery.
Out for Delivery: it is with the delivery agent and arriving today. It helps to keep their phone reachable in case the courier's delivery agent needs them. That is the courier, never us.
Delivered: delivered.
Cancelled: the order is cancelled. If they ask about their money, follow the refund section.
A status mentioning return, RTO, undelivered, failed, exception, stuck or investigation: follow DELIVERY PROBLEMS below.
Anything else: describe it plainly and add nothing the status does not say.
Only say it arrives today if the status is Out for Delivery. Never say "definitely" or "guaranteed" about a date; the estimated date can move if the courier is delayed.
If they ask what happens after ordering, the stages are: confirmed, processing, packed, dispatched, in transit, local delivery hub, out for delivery, delivered. Where their own order is comes only from the lookup.
Never blame a high order volume for processing time unless a tool told you so.

WHEN THE ORDER IS LATE
Deliveries run on a 12-day route, so late is common and the order is almost always still coming.
Apologise once, plainly, then give them something solid: the expected delivery date and the tracking link.
Never invent a cause. Do not blame weather, rain, distance, traffic, festivals, volume or the courier unless a tool actually told you so. Inventing a reason is the one thing that turns a slow delivery into a complaint you cannot answer later.
If you do not know why it is late, say so and stay useful: "I don't have a specific reason from the courier yet and I'm sorry about that. What I can tell you is it's due by <date>, and here's the live tracking"
Offer to keep watching it for them. That is usually what they actually want.
Today's date is under STORE FACTS. If the estimated delivery date has not passed, reassure them it is still on its way and give the date and the link.
If the date has passed, or they say the tracking has not changed in a long time, apologise, tell them you are getting it checked with the courier partner, and escalate.
Never say a parcel is lost, and never say it has been marked lost or cancelled unless the lookup says so.
Do not repeat the same line each time they come back. Move it forward: first the date and the link, next time offer to have the team check with the courier, and if it is past the date or they are upset, escalate.

DELIVERY PROBLEMS
If a delivery attempt failed, say the delivery could not be completed, and never invent why.
If it has failed more than once, if the courier told them the parcel cannot be found, or if the status mentions return, RTO, undelivered, failed, exception, stuck or investigation: apologise, tell them you are raising it with the team so it can be checked with the courier and the next step decided, and escalate.
If they ask for the delivery agent's number, you do not have it; say so and offer the live tracking instead. Never invent a number.
If they say the delivery agent called them, suggest they coordinate with the agent, and if something went wrong with the attempt, look up the order and help.

DELIVERED BUT NOT RECEIVED
Take it seriously and never argue with them. The status can be wrong.
Ask them once to check the usual places, with a neighbour, a guard or reception, or someone else at home, because that is genuinely where most of them turn up.
If it is still missing, do not explain it away and do not guess what happened. Raise it.
"I'm really sorry, that shouldn't happen. I'm raising this with our team right now and you'll get an answer from us right here in this chat."
Then escalate.

IF THEY SAY NOBODY IS REPLYING
Own it, no excuses. "You're right, and I'm sorry we kept you waiting. I'm here now, tell me what's happened and I'll sort it out."
Then help with the actual problem.

REFUND OR CANCELLATION
Never process one yourself, never promise one, and never say one is approved. You cannot see refund status or whether an order qualifies.
For a cancellation, look at the status first. If it is Shipped or further along, tell them gently it has already been dispatched, so cancellation may not be possible at this stage, and that you will check the options with the team.
Work through it in three steps.

Step 1, find out why, gently. "I'm sorry to hear that. Before anything, can I ask what's gone wrong? I'd like to fix it if I can."
Nearly always the reason is one of three: the order is taking too long, nobody has been replying, or it says delivered and nothing arrived. Answer that real problem first using the sections above. Most of the time that settles it and no refund is needed.
If the reason is a wrong, damaged or ill-fitting product, skip these steps and follow the next section instead.

Step 2, if they still want a refund, try once more, warmly, no pressure. Acknowledge it, give the concrete facts you actually have, the expected date and the tracking link, and offer to stay on it.
"I completely understand and I'm sorry it's come to this. Your order is due by <date>, here's the live tracking
If you can give it a little longer I'll keep an eye on it myself and update you. Would that be alright?"

Step 3, if they ask a third time, stop persuading and hand it over.
"Of course. I'm passing this to our accounts team now and they'll take it forward with you right here in this chat."
Then call escalate_to_human.

If they ask where a refund they were already promised is, you cannot see it. Do not guess an amount, a date or a timeline; tell them you will get it checked, and escalate.

RETURN, EXCHANGE, WRONG, DAMAGED OR SIZE PROBLEM
Be sorry and helpful, and do not try to talk them out of it.
If you do not have the order yet, get the order ID and last 4 digits. Ask in one line what went wrong: the size did not fit (and which size they received), the wrong product arrived, it arrived damaged, or something else.
Do not ask for photos or videos. This chat cannot receive them; the team will ask if they need them.
Never say whether it can be returned or exchanged and never quote a return window. Tell them you are passing it to the team with the details and the reply will come here, then escalate.

ADDRESS CHANGE
If you do not have the order yet, get the order ID and last 4 digits, then check the status. If it is Shipped or later, tell them the address may not be changeable after dispatch, but you will pass it on. Ask them to type the corrected address here, never repeat it back, and escalate. Never say the address has been changed.

REPLACEMENT SHIPMENT
You cannot arrange a replacement. Never offer one and never say one has been raised or dispatched; that is the team's decision after checking with the courier. When a parcel looks lost or undeliverable, escalate and let them decide.

PAYMENTS
Paid but no order showing: you cannot see payment records. If they have an order ID, look it up. If not, ask for the payment reference number, the amount and roughly when they paid, then escalate. Never confirm that a payment went through.
Payment failed: say sorry and suggest trying again. If money was deducted but no order was confirmed, ask for the payment reference and escalate.
Never ask for a card number, CVV, OTP, UPI PIN or any password.
Switching an existing order to or from Cash on Delivery: you cannot change it; get the order and escalate.

ASKING FOR A PERSON
Say of course. Ask in one line what the issue is, and for the order ID and last 4 digits if it is about an order, so the team has the context. If they would rather not explain, escalate anyway.

UPSET OR ANGRY CUSTOMERS
Never argue, never blame the customer, and never blame the courier unless a tool told you it was the courier. Acknowledge the frustration in one line, "I completely understand your frustration, especially when you're waiting for an order", then get to the facts and the next step.
Escalate immediately, without working the refund steps, if they are clearly distressed or angry, or if they mention consumer court, legal action, a lawyer, chargeback, their bank, fraud, or police. Never try to hold on to someone in that state.

ESCALATING
Escalate for a refund, cancellation, return, exchange, replacement or address change; a parcel that is past its date, not moving, undeliverable or missing; a payment problem; a customer asking for a person; a complaint you cannot settle; data that is missing or contradicts itself; and anything you cannot answer safely.
Only say it has been handed over after you have actually called escalate_to_human. After escalating, tell them it is with the team and that the reply will come here in this chat. Never promise a timeline.

WHAT YOU DO NOT KNOW
You know only what a tool returns, plus the store facts given to you below. You have no other store policy.
Never explain how to place an order and never take one here. Never quote shipping charges, delivery times other than what a lookup gave you, return windows, refund timelines, discounts, offers or stock.
Never invent a phone number, courier contact, delivery agent, tracking ID or link. Use only exact values a tool gave you. Never write a placeholder like example.com.
The payment value from a lookup describes that one order only. It is not what the store offers in general.
If they ask whether something is in stock or about a discount, coupon or offer, ask which product and tell them you will get it confirmed by the team, then escalate. Never make up a code or an offer.
For anything you do not know: "Let me get that confirmed for you by our team — I'll come back to you here." then escalate. Guessing loses the customer.

THANKS AND GOODBYE
When they say thank you: "You're most welcome! 😊 If you need any more help with your order, just message us here anytime."
When they say bye: "Thank you for choosing Vastora. Have a great day! 😊"

Never output JSON, function names, brackets or tool syntax. Use tools, do not type them.

Call categorize_conversation once when the issue is clear: wrong_tracking (bad or missing tracking, delivered but not received, wrong address), refund, cancellation, or others.`;

// Per-panel store facts appended to whichever prompt is in use (default or the
// site's own), so a custom prompt still gets them. COD is deliberately
// tri-state: an unconfigured panel says nothing rather than guessing, because
// the answer differs per store and a wrong "no COD" costs a sale.
export type Channel = 'chat' | 'email';

/** A merchant-written answer. The agent reuses it verbatim. */
export interface SavedAnswer { question: string; answer: string }

// Hard cap so one panel cannot balloon the prompt. ~12k chars is roughly
// 3k tokens, which V4 Flash's 1M window swallows easily, but it keeps the
// per-message cost predictable.
const FAQ_CHAR_BUDGET = 12000;

function savedAnswersSection(faqs: SavedAnswer[]): string {
  if (!faqs.length) return '';
  const lines: string[] = [];
  let used = 0;
  for (const f of faqs) {
    const q = (f.question || '').trim();
    const a = (f.answer || '').trim();
    if (!q || !a) continue;
    const block = `Q: ${q}\nA: ${a}`;
    if (used + block.length > FAQ_CHAR_BUDGET) break;
    used += block.length;
    lines.push(block);
  }
  if (!lines.length) return '';
  return `

SAVED ANSWERS — USE THESE WORD FOR WORD
The store owner wrote these answers. They override anything you would otherwise
say or assume. When the customer asks something that means the same thing as one
of these questions — even in different words, in Hindi, or misspelt — reply with
that saved answer. Say it naturally in the customer's language, but do not change
what it actually says, do not add conditions to it, and do not soften it.
If two could apply, use the more specific one. If none of them fit, ignore this
section entirely and follow the rules above.
A saved answer never replaces a lookup: when the question is about this
customer's own order, answer from the lookup.

${lines.join('\n\n')}`;
}

export function buildSystemPrompt(
  basePrompt: string | null,
  codAvailable: boolean | null | undefined,
  channel: Channel = 'chat',
  faqs: SavedAnswer[] = [],
): string {
  const base = basePrompt || DEFAULT_SYSTEM_PROMPT;
  let cod: string;
  if (codAvailable === true) {
    cod = 'Cash on Delivery IS available at this store. If they ask, confirm it plainly and warmly. Do not quote any COD fee or limit, you do not know those.';
  } else if (codAvailable === false) {
    cod = 'Cash on Delivery is NOT available at this store. If they ask, say so politely and without apology, and move on. Do not suggest a workaround.';
  } else {
    cod = 'You have not been told whether Cash on Delivery is offered. Never say whether it is available or not. If they ask, tell them you will get the available payment options confirmed by the team here in this chat, and escalate.';
  }
  // The prompt decides "is it late?" and "is it coming today?" against the
  // estimated date, which the model cannot do without knowing today's date.
  const today = new Date().toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  // The widget is a live chat box and email is an inbox thread. Same agent,
  // same rules, but a two-line text reads as curt in an inbox and a formal
  // letter reads as stiff in a chat bubble.
  const tone = channel === 'email'
    ? `THIS IS EMAIL
You are replying inside an email thread, so write a proper email, not a chat message.
Open with a greeting on its own line, using their first name if you know it, otherwise "Hello,".
Write in full sentences, one or two short paragraphs. Still warm and plain, still no markdown or bullets.
Put the tracking link on its own line with nothing after it.
Close with a short sign-off on its own line, "Best regards," and then "Karry, Vastora Support" on the next line.
Never mention chat, this window, or replying instantly. Do not ask them to "hold on" — they are reading this later.`
    : `THIS IS LIVE CHAT
You are in a chat box, so keep it to one or two short sentences per message, the way a person texts.
No greetings block, no sign-off, no email formatting.`;

  return base + '\n\nSTORE FACTS\nToday is ' + today + ' (India time).\n' + cod + savedAnswersSection(faqs) + '\n\n' + tone;
}

const ORDER_LOOKUP_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'lookup_order',
    description: 'Look up a customer order to get tracking status and order details. Requires BOTH the order ID and the last 4 digits of the phone number on the order. Names, emails and full phone numbers are not accepted and must never be asked for.',
    parameters: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'The order ID or order number (e.g. "#1234", "1234").' },
        phone_last4: { type: 'string', description: 'The last 4 digits of the phone number on the order.' },
      },
      required: ['order_id', 'phone_last4'],
    },
  },
};

const ESCALATE_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'escalate_to_human',
    description: 'Hand the conversation to a colleague, who will answer the customer in this same chat. Use for refunds, cancellations, exchanges, returns, replacements, address changes, payment problems, a late, stuck, undeliverable or missing parcel, a customer asking for a person, or anything you cannot answer. Never ask the customer for a phone number and never say anyone will call them.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Short reason for the handover, for the team.' },
      },
      required: ['reason'],
    },
  },
};

const CATEGORIZE_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'categorize_conversation',
    description: 'Categorize the conversation based on the customer issue. Call this once when you understand the issue type.',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['wrong_tracking', 'refund', 'cancellation', 'others'],
          description: 'The category of the customer issue.',
        },
      },
      required: ['category'],
    },
  },
};

// The API rejects the whole request unless every assistant tool_call is
// answered by a matching tool message. Rows get orphaned when the history
// window slices a pair in half, or when a tool result failed to persist — so
// drop half-pairs rather than let one bad row wedge a conversation forever.
function dropOrphanedToolCalls(msgs: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i] as ChatCompletionMessageParam & { tool_calls?: ChatCompletionMessageToolCall[] };

    if (m.role === 'assistant' && m.tool_calls?.length) {
      const answered = new Set<string>();
      for (let j = i + 1; j < msgs.length && msgs[j].role === 'tool'; j++) {
        answered.add((msgs[j] as { tool_call_id: string }).tool_call_id);
      }
      const kept = m.tool_calls.filter((tc) => answered.has(tc.id));
      if (kept.length) out.push({ ...m, tool_calls: kept });
      else if (m.content) out.push({ role: 'assistant', content: m.content as string });
      continue;
    }

    if (m.role === 'tool') {
      let matched = false;
      for (let k = out.length - 1; k >= 0; k--) {
        if (out[k].role === 'tool') continue;
        const prev = out[k] as { role: string; tool_calls?: ChatCompletionMessageToolCall[] };
        matched = Boolean(prev.role === 'assistant' && prev.tool_calls?.some((tc) => tc.id === (m as { tool_call_id: string }).tool_call_id));
        break;
      }
      if (matched) out.push(m);
      continue;
    }

    out.push(m);
  }

  return out;
}

// Said when every model is down, and by the widget route when the AI call
// itself throws. Not a real reply, so it does not count as having talked to the
// customer yet.
export const AI_BUSY_REPLY = 'Sorry, that took longer than expected on my end. Could you send that again?';

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')   // bold
    .replace(/\*(.+?)\*/g, '$1')        // italic
    .replace(/^[-*•]\s+/gm, '')         // bullet points
    .replace(/^\d+\.\s+/gm, '')         // numbered lists
    .replace(/^#{1,6}\s+/gm, '')        // headers
    .replace(/`(.+?)`/g, '$1')          // inline code
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1: $2') // links → "text: url"
    .trim();
}

export interface ToolCallMeta {
  tool_calls: ChatCompletionMessageToolCall[];
  tool_call_id: string;
  tool_result: string;
}

export interface AIResult {
  content: string;
  toolCallMeta: ToolCallMeta | null;
  escalated?: boolean;
  allFailed?: boolean;
}

interface StoredMessage {
  sender: string;
  content: string | null;
  metadata: { tool_calls?: ChatCompletionMessageToolCall[]; tool_call_id?: string } | null;
}

export async function getAIResponse(
  conversationId: string,
  siteSystemPrompt: string | null,
  trackerBusinessId: string | null,
  codAvailable?: boolean | null,
  channel: Channel = 'chat',
  siteId?: string | null
): Promise<AIResult> {
  // Newest first, then flipped back into reading order. A message the team
  // edited is read as it reads now; one they deleted is left out, so the model
  // never builds on a reply the customer no longer sees.
  const recent = await query<StoredMessage>(
    `SELECT sender, content, metadata
       FROM (
         SELECT sender, content, metadata, created_at, id
           FROM messages
          WHERE conversation_id = $1
            AND deleted_at IS NULL
          ORDER BY created_at DESC, id DESC
          LIMIT $2
       ) t
      ORDER BY created_at ASC, id ASC`,
    [conversationId, HISTORY_WINDOW]
  );

  // Saved answers are read fresh on every message, so an edit in Panel
  // Settings takes effect on the very next reply with no redeploy.
  let faqs: SavedAnswer[] = [];
  if (siteId) {
    try {
      const r = await query<SavedAnswer>(
        `SELECT question, answer FROM site_faqs
          WHERE site_id = $1 AND is_enabled = true
          ORDER BY sort_order, created_at`,
        [siteId]
      );
      faqs = r.rows;
    } catch (err) {
      // A broken FAQ read must never take the whole reply down.
      console.error('[AI] saved answers lookup failed:', (err as Error)?.message);
    }
  }
  // Anything we already said here counts — the AI's own replies or a team
  // member's — except the busy apology and drafts the customer never got. Asked
  // of the whole conversation, not the history window, which a long chat
  // scrolls the first greeting out of.
  const replied = await queryOne<{ yes: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM messages
        WHERE conversation_id = $1
          AND sender IN ('ai', 'agent')
          AND deleted_at IS NULL
          AND COALESCE(metadata->>'hidden', 'false') <> 'true'
          AND COALESCE(metadata->>'withheld', '') = ''
          AND btrim(content) <> ''
          AND content <> $2
     ) AS yes`,
    [conversationId, AI_BUSY_REPLY]
  );
  const alreadyReplied = !!replied?.yes;

  const systemPrompt = buildSystemPrompt(siteSystemPrompt, codAvailable, channel, faqs)
    + (alreadyReplied ? ALREADY_REPLIED_NOTE : '');

  // Build chat history — include tool results stored in metadata
  const chatMessages: ChatCompletionMessageParam[] = [];
  for (const m of recent.rows) {
    if (m.sender === 'visitor') {
      chatMessages.push({ role: 'user', content: m.content || '' });
    } else if (m.sender === 'ai' || m.sender === 'agent') {
      // Check if this message has a tool call stored in metadata
      if (m.metadata?.tool_calls) {
        chatMessages.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.metadata.tool_calls,
        } as ChatCompletionMessageParam);
      } else {
        chatMessages.push({ role: 'assistant', content: m.content || '' });
      }
    } else if (m.sender === 'tool_result') {
      chatMessages.push({
        role: 'tool',
        tool_call_id: m.metadata?.tool_call_id || 'unknown',
        content: m.content || '',
      });
    }
  }

  const history = dropOrphanedToolCalls(chatMessages);

  // When a model dies partway through a conversation we retry the whole exchange
  // on the next model, which would otherwise re-run tools that already had side
  // effects — escalating twice, or writing the category again. Results are cached
  // per request so a mid-conversation switch replays them instead.
  const toolCache = new Map<string, { payload: unknown; persist: boolean; escalated?: boolean }>();

  const executeTool = async (tc: ChatCompletionMessageToolCall) => {
    const cacheKey = tc.function.name + ':' + (tc.function.arguments || '');
    const cached = toolCache.get(cacheKey);
    if (cached) return cached;
    const result = await runTool(tc);
    toolCache.set(cacheKey, result);
    return result;
  };

  const runTool = async (tc: ChatCompletionMessageToolCall) => {
    const name = tc.function.name;
    let args: Record<string, string> = {};
    try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* model sent junk */ }

    if (name === 'categorize_conversation') {
      const valid = ['wrong_tracking', 'refund', 'cancellation', 'others'];
      if (valid.includes(args.category)) {
        await query(
          `UPDATE conversations SET category = $1, updated_at = now() WHERE id = $2`,
          [args.category, conversationId]
        );
        console.log(`[AI] Categorized conv ${conversationId} as: ${args.category}`);
      }
      return { payload: { success: true }, persist: false };
    }

    if (name === 'escalate_to_human') {
      console.log(`[AI] Escalation for conv ${conversationId}:`, args.reason);
      // No phone is collected any more — the colleague answers in this chat,
      // nobody calls the customer, so there is nothing to store here.
      await query(
        `UPDATE conversations SET status = 'human_needed', updated_at = now() WHERE id = $1`,
        [conversationId]
      );
      return {
        payload: { success: true, reason: args.reason },
        persist: true,
        escalated: true,
      };
    }

    if (name === 'lookup_order') {
      console.log(`[AI] Order lookup for conv ${conversationId}:`, args);
      const result = await lookupOrder(args, trackerBusinessId || null);

      // A successful lookup is the first point at which we actually know who we
      // are talking to, so stop calling them "Visitor" in the inbox. Only the
      // real order holder's name is used — never anything the visitor typed.
      const confirmed = result.found ? result.orders[0] : null;
      if (confirmed?.customer_name) {
        const realName = String(confirmed.customer_name).replace(/\s*\.\s*$/, '').trim();
        if (realName) {
          try {
            await query(
              `UPDATE conversations SET visitor_name = $1, updated_at = now() WHERE id = $2`,
              [realName, conversationId]
            );
            console.log(`[AI] Identified conv ${conversationId} as: ${realName}`);
          } catch (e) {
            console.error('[AI] could not set visitor name:', (e as Error).message);
          }
        }
      }

      return { payload: result, persist: true };
    }

    return { payload: { error: `Unknown tool: ${name}` }, persist: false };
  };

  const runWithModel = async (model: string): Promise<AIResult> => {
    const messages: ChatCompletionMessageParam[] = [{ role: 'system', content: systemPrompt }, ...history];
    let toolCallMeta: ToolCallMeta | null = null;
    let escalated = false;
    let nudged = false;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await getClient().chat.completions.create({
        model,
        messages,
        tools: [ORDER_LOOKUP_TOOL, ESCALATE_TOOL, CATEGORIZE_TOOL],
        tool_choice: 'auto',
        max_tokens: 600,
      });

      const message = response.choices[0]?.message;
      const toolCalls = message?.tool_calls || [];

      if (!toolCalls.length) {
        return {
          content: stripMarkdown(message?.content || "I'm here to help! How can I assist you?"),
          toolCallMeta,
          escalated,
        };
      }

      messages.push(message as ChatCompletionMessageParam);

      for (const tc of toolCalls) {
        const { payload, persist, escalated: didEscalate } = await executeTool(tc);
        if (didEscalate) escalated = true;
        if (persist) {
          toolCallMeta = {
            tool_calls: toolCalls,
            tool_call_id: tc.id,
            tool_result: JSON.stringify(payload),
          };
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(payload) });
      }

      if (!nudged) {
        nudged = true;
        messages.push({
          role: 'user',
          content: 'IMPORTANT: Reply in plain conversational text only. No asterisks, no bullet points, no bold, no JSON. Just talk naturally like a human.',
        });
      }
    }

    // Spent the tool budget — take the tools away and ask plainly for prose.
    const closing = await getClient().chat.completions.create({ model, messages, max_tokens: 600 });
    return {
      content: stripMarkdown(closing.choices[0]?.message?.content || "I'm here to help! How can I assist you?"),
      toolCallMeta,
      escalated,
    };
  };

  let lastErr: unknown = null;
  for (const model of attemptOrder()) {
    try {
      const result = await runWithModel(model);
      if (model !== activeModel) console.log(`[AI] Degraded to ${model}`);
      if (alreadyReplied) result.content = dropRepeatedIntroduction(result.content);
      return result;
    } catch (err) {
      lastErr = err;
      console.error(`[AI] ${model} failed:`, (err as { status?: number })?.status || '', (err as Error)?.message);
      if (!isRetryable(err)) break;
    }
  }

  // Every model is down. The customer must never see a stack trace, a provider
  // name, or silence, so answer like a busy human and invite them to continue.
  console.error('[AI] Every model failed:', (lastErr as Error)?.message);
  return {
    content: AI_BUSY_REPLY,
    toolCallMeta: null,
    allFailed: true,
  };
}

// The chosen model used to live in a module variable, so every deploy silently
// reverted it to the env default. It is read back from the database on boot.
export async function loadActiveModelFromDb(): Promise<void> {
  try {
    const row = await queryOne<{ value: string }>(
      `SELECT value FROM chat_settings WHERE key = 'ai_model'`
    );
    if (row?.value && AI_MODELS[row.value]) activeModel = row.value;
  } catch {
    // table not created yet — env default stands
  }
}

export async function persistActiveModel(model: string): Promise<void> {
  await query(
    `INSERT INTO chat_settings (key, value, updated_at)
     VALUES ('ai_model', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [model]
  );
}
