// ── Cash on Delivery in some states only ───────────────────────
// Asked for by the owner on 2026-09-30 (chat-cod-states.sql): Vastora offers COD
// only for addresses in Gujarat. This file has no imports: the settings route
// checks what the owner typed with cleanCodStates, and the chat agent's prompt
// (ai.ts buildSystemPrompt) is written by codStatesPrompt.

const MAX_STATES_CHARS = 100;

// The states as they may be stored and put in a prompt: names separated by
// commas, letters / spaces / & / - / . only, so what an admin types can never
// become an instruction to the agent. Empty (or nothing usable) gives null.
export function cleanCodStates(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const names = raw
    .split(/[,;\n/]+/)
    .map((s) => s.replace(/[^A-Za-zऀ-ॿ .&-]/g, '').replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 2 && s.length <= 40);
  const out: string[] = [];
  for (const n of names) if (!out.some((o) => o.toLowerCase() === n.toLowerCase())) out.push(n);
  const text = out.join(', ');
  return text ? text.slice(0, MAX_STATES_CHARS).replace(/[ ,]+$/, '') : null;
}

// "Gujarat" or "Gujarat or Maharashtra" or "Gujarat, Goa or Kerala".
function orList(states: string): string {
  const parts = states.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return parts[0] || states;
  return `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`;
}

// Added once the agent has already told this customer where COD works. Telling
// the model to "say it once" was not enough: a customer who insisted got the
// same sentence again (live test, 2026-09-30).
export function codAlreadyToldNote(states: string): string {
  const where = orList(states);
  return `\n\nYou have already told this customer where Cash on Delivery works. Do NOT say that sentence again and do not say COD is unavailable. If they ask again, or ask why COD does not show at checkout, answer in one short line that the COD option shows at checkout only for addresses in ${where}, and that for their address the prepaid payment options will show. You cannot place orders or change a payment method, so do not offer to.`;
}

// The COD part of the store facts when COD works in some states only.
export function codStatesPrompt(states: string): string {
  const where = orList(states);
  return `Cash on Delivery is available ONLY for delivery addresses in ${where}. For every other state orders are prepaid only. Never say COD is available everywhere and never promise COD for a state outside that list.
- Bring COD up only when the customer asks about COD, cash payment or how they can pay. Never mention it otherwise.
- Answer in one short, friendly, plain line, for example: "Cash on delivery is available only for addresses in ${where}. For other states we take prepaid orders." No apology, no "unfortunately", and do not say "not available".
- If the customer says their city, pincode or state is in ${where}, tell them COD is available for them and do not say it is unavailable. Work the state out from a city or pincode they mention. Do not ask for their address or pincode.
- Say it once in a chat. If they ask again, answer in a few words ("As mentioned, COD is only for ${where}; prepaid works for every state.") and offer help with anything else. Never repeat a "not available" message.
- Do not quote any COD fee or limit, you do not know those.
- You cannot place orders or change a payment method, so never offer to.`;
}
