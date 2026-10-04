// ── Team score (owner, 2026-10-01, part 4): constants, weights and the waiting rule. Pure. ──
// STAFF ONLY. The numbers the owner asked for (Q11: 10-minute first reply, 2 hours unanswered,
// solved = 24 hours with no new complaint), the point weights, and an exact port of the inbox's
// "waiting for a reply" SQL so the score clock and the inbox agree.
import { HEALTH_PIN_MIN } from '@/lib/chat/health-rules';
import type { PointKind, SettingsRow, Weights } from './types';
import { isSignOff, acceptsClose } from './words';

export const FAST_REPLY_MIN = 10;              // owner Q11
export const UNANSWERED_MIN = 120;             // owner Q11
export const TAKEN_NO_REPLY_MIN = 30;          // info only
export const ANGRY_MIN = HEALTH_PIN_MIN;       // 65 (health-rules.ts; a unit test pins it)
export const ANGRY_HELD_MIN = 60;              // angry for >= 60 office minutes of the hold
export const THANKS_WINDOW_MS = 24 * 3_600_000;
export const SOLVED_QUIET_MS = 24 * 3_600_000; // owner Q11
export const SOLVED_REPLY_WITHIN_MS = 72 * 3_600_000;
export const OBJECTION_LOOKBACK_MS = 72 * 3_600_000;
export const SOLICIT_LOOKBACK_MS = 24 * 3_600_000;
export const LOOKBACK_DAYS = 3;                // load window starts 3 days before the first day
export const MSG_LOOKBACK_DAYS = 30;           // messages of candidate chats, for exact waiting state
export const SETTLE_AFTER_MS = 49 * 3_600_000; // from the day's 00:00 IST: D+2 01:00 IST
export const AI_GRACE_MS = 96 * 3_600_000;     // D+4 00:00: freeze even if AI checks are still pending
export const MAX_RANGE_DAYS = 31;
export const OWNER_RANKED = false;             // Q3
// The AI check's models come from sideAttemptOrder() in @/lib/chat/ai (judge.ts), like health.ts: the cheap model first.
export const JUDGE_MAX_PER_RUN = 40, JUDGE_MAX_PER_DAY = 300, JUDGE_FAIL_LIMIT = 3, JUDGE_WINDOW_DAYS = 4;
// Owner answers 2026-10-02 (A2): convinced +2 (was 0), closed while the customer waited -2 (was a red
// flag only). A settings row saved before a key existed takes that key from here.
export const DEFAULT_WEIGHTS: Weights = { thanks: 3, solved: 2, fast_reply: 1, unanswered_2h: -3, angry: -2, closed_waiting: -2, convinced: 2, customer_answered: 0 };
export const WEIGHT_KEYS: PointKind[] = ['thanks', 'solved', 'fast_reply', 'unanswered_2h', 'angry', 'closed_waiting', 'convinced', 'customer_answered'];
export const POINT_LABELS: Record<PointKind, string> = {
  thanks: 'Thank you', solved: 'Solved (no complaint 24 h)', fast_reply: 'Replied within 10 min of taking',
  unanswered_2h: 'Taken chat, no reply 2 h', angry: 'Customer stayed angry', closed_waiting: 'Closed while customer waiting',
  convinced: 'Convinced', customer_answered: 'Customer replied to',
};

// The "Points kaise bante hain" box (Hinglish, the owner's words). {key} is the current weight:
// fill it with rulesHinglish(weights), or replace "{key}" with the number.
export const RULES_HINGLISH: string[] = [
  '+{thanks} har customer ka Thank you (ek customer din me ek baar). "Thank you bol do" likhwa ke aaya thank you nahi ginta.',
  '+{solved} Solved: chat band hui aur 24 ghante customer ne koi nayi complaint nahi ki.',
  '+{fast_reply} Chat lene ke 10 minute (office time) me pehla asli reply, jab customer wait kar raha tha.',
  '{unanswered_2h} Li hui chat pe customer 2 office ghante bina reply. Agle din bhi wait kare to 2 aur office ghante baad phir se.',
  '{angry} Shaam 7:30 pe (ya band karte waqt) customer 1 ghante se zyada gusse me (65+) raha aur theek nahi hua.',
  '{closed_waiting} Customer jawab ka wait kar raha tha aur aapne chat band kar di.',
  '+{convinced} Convinced: customer ne pehle refund / cancel / gussa / "abhi tak nahi aaya" bola, phir maan gaya.',
  'Thank you aur Convinced sirf verified customer (order ID + phone) ke ginte hain. Unverified visitor ka nahi.',
  'Raat 7:30 se subah 10 baje tak ka time 10 minute / 2 ghante me nahi ginta. Raat ke thank you / solved ginte hain.',
  'Refund / Ship again wali chats 2 ghante aur gusse ke rule se bahar hain.',
];

// RULES_HINGLISH with the numbers filled in: "+3", "-3", "0".
export function rulesHinglish(w: Weights): string[] {
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  return RULES_HINGLISH.map((line) => line.replace(/\+?\{(\w+)\}/g, (all, k: string) =>
    (WEIGHT_KEYS as string[]).includes(k) ? sign(Number(w?.[k as PointKind] ?? DEFAULT_WEIGHTS[k as PointKind])) : all));
}

// Only the known keys (WEIGHT_KEYS); a missing key takes its default; each a number from -10 to 10 in steps of 0.5.
export function validateWeights(x: unknown): { ok: true; weights: Weights } | { ok: false; error: string } {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return { ok: false, error: 'Weights must be an object' };
  const obj = x as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!(WEIGHT_KEYS as string[]).includes(k)) return { ok: false, error: `Unknown weight: ${k.slice(0, 40)}` };
  }
  const out = { ...DEFAULT_WEIGHTS };
  for (const k of WEIGHT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const v = obj[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < -10 || v > 10 || !Number.isInteger(v * 2)) {
      return { ok: false, error: `${POINT_LABELS[k]}: use a number from -10 to 10, in steps of 0.5` };
    }
    out[k] = v;
  }
  return { ok: true, weights: out };
}

const NO_SETTINGS: SettingsRow = { id: 0, weights: DEFAULT_WEIGHTS, effectiveFrom: '2026-01-01', pointsFrom: '9999-12-31', createdAt: 0 };

// The row with the highest id whose effectiveFrom is on or before the day; else the first row.
export function settingsForDay(rows: SettingsRow[], day: string): SettingsRow {
  let best: SettingsRow | null = null;
  for (const r of rows || []) {
    if (r.effectiveFrom <= day && (!best || r.id > best.id)) best = r;
  }
  if (best) return best;
  if (!rows || !rows.length) return NO_SETTINGS;
  return rows.reduce((a, b) => (b.id < a.id ? b : a));
}

// The points start day of the latest (highest id) row. No rows: never.
export function pointsFrom(rows: SettingsRow[]): string {
  if (!rows || !rows.length) return NO_SETTINGS.pointsFrom;
  return rows.reduce((a, b) => (b.id > a.id ? b : a)).pointsFrom;
}

export function isHumanStatus(s: string | null): boolean {
  return s === 'human_needed' || s === 'agent_handling';
}

// lrAt: when the customer last wrote something that is not a sign-off (at or before t); null = never.
// Left out (undefined) it counts as null, the rule before 2026-10-02.
export interface WaitState { lvAt: number | null; lvNoReply: boolean; lvText: string; laAt: number | null; lastSender: 'visitor' | 'agent' | 'ai' | null; lastAiNotAnswer: boolean; lrAt?: number | null }

// Word for word WAITING_SINCE_SQL (src/lib/chat/waiting-sql.ts): since when the customer has waited.
export function waitingSince(s: WaitState, status: string | null): number | null {
  if (status === 'resolved' || s.lvAt === null) return null;
  if (s.laAt !== null && s.laAt > s.lvAt) return null;
  if (status === 'human_needed' && s.laAt === null) return s.lvAt;
  if (s.lvNoReply) return null;
  if (status === 'human_needed' || s.lastSender === 'visitor' || (s.lastSender === 'ai' && s.lastAiNotAnswer)) return s.lvAt;
  return null;
}

// waitingSince, but not waiting when a team member already answered in this chat and the customer's
// last word is a sign-off ("ok got it thanks" after Anurag's answer). Without a team answer (Needs
// you after the AI hand-over) the inbox rule stands: even "ok" waits. A bare courtesy nudge ("sir",
// "bhai", "ok sir") after a question nobody answered yet is the customer still waiting (as the inbox
// says): it is a sign-off only when the team answered after the customer's last real message. A real
// thank-you or acceptance ("got it thanks", "theek hai") still ends the wait (spec section 6 #41).
export function scoreWaiting(s: WaitState, status: string | null): number | null {
  const w = waitingSince(s, status);
  if (w === null) return null;
  if (s.laAt !== null && isSignOff(s.lvText) && (acceptsClose(s.lvText) || s.lrAt == null || s.laAt > s.lrAt)) return null;
  return w;
}
