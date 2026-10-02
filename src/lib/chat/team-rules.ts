// ── Who may do what on a chat (owner, 2026-10-01) ────────────────
// Super Admin > Senior (the chat.senior tick in Team) > Junior. A chat has at most one holder
// (conversations.assigned_to, chat-team.sql): the person who answers it. Everyone may read every
// chat of their panels; only the holder (or the Super Admin) replies, closes, hands it to the AI
// or transfers it, so two people never answer the same customer and the owner's report can say
// who left a customer waiting. The first reply or Take over on a chat nobody holds makes it yours.
//
// Pure rules, no imports: the server routes (team-routing.ts builds the inputs from the team
// cache and the locked row) and the unit tests share them, so a rule is decided in one place.
// The inbox never guesses: it draws what the server computed from these.

export const OWNER_KEY = 'owner';
// Owner answer Q1 (2026-10-01): a waiting customer is never stuck behind a member who is away.
// During office hours, when the member holding a chat has not been seen for 30 minutes and the
// customer is waiting, any member may take it. Never for the Super Admin's own chats.
export const AWAY_TAKE = true;
// Owner answer Q2 (2026-10-01, "YES, they claim"): the Super Admin's own first reply or Take over
// on a chat nobody holds makes it his, like a member's. The team can then only read it until he
// transfers it or gives all his open chats back to the team (POST /api/chat/team/release).
export const OWNER_ACTIONS_CLAIM = true;

// The same 30 minutes as AWAY_AFTER_MIN in src/lib/office-hours.ts (this file has no imports;
// the unit test checks they agree).
const HOLDER_AWAY_MIN = 30;

export interface Actor { key: string; name: string; superAdmin: boolean; senior: boolean; canReply: boolean; canCases: boolean }
// awayMin: minutes since last seen during office hours, null outside office hours (office-hours.ts).
export interface Holder { key: string; name: string; superAdmin: boolean; senior: boolean; awayMin: number | null }
// panelOk: the member may open the chat's panel (canAccessPanel).
export interface Member { key: string; name: string; active: boolean; canReply: boolean; senior: boolean; panelOk: boolean; awayMin: number | null }
// key null = "Nobody (open pool)", the Super Admin only.
export interface TransferTarget { key: string | null; name: string; senior: boolean; awayMin: number | null }

export type Tier = 'owner' | 'senior' | 'junior';
export type TakeKind = 'senior' | 'owner' | 'holder_away';

// Logged on every chat event (meta.tier), so the report can tell a senior's work from a junior's
// even after the ticks change.
export function actorTier(a: Actor): Tier {
  return a.superAdmin ? 'owner' : a.senior ? 'senior' : 'junior';
}

// Reply, Close, Hand to AI, Transfer and status changes: the holder, anyone on a chat nobody holds,
// and the Super Admin on any chat. A member who cannot reply (chat.reply) only reads.
export function canAct(a: Actor, h: Holder | null): boolean {
  return a.canReply && (a.superAdmin || h === null || h.key === a.key);
}

// Does this reply / Take over make the chat the actor's? Only on a chat nobody holds: acting on a
// member's chat (the Super Admin may) never moves it, "Take from X" does that on purpose.
export function claimsOnAct(a: Actor, h: Holder | null): boolean {
  return a.canReply && h === null && (!a.superAdmin || OWNER_ACTIONS_CLAIM);
}

// The "Take from X" button: may the actor take someone else's chat, and on what ground (logged as
// meta.take)? 'owner': the Super Admin takes any chat. 'senior': a senior takes a junior's chat.
// 'holder_away': the holder is a member not seen for 30 minutes during office hours and the
// customer is waiting (awayMin is null at night, so never at night). Juniors never take a senior's
// chat otherwise, and nobody but the Super Admin takes his.
export function takeKind(a: Actor, h: Holder | null, customerWaiting: boolean): TakeKind | null {
  if (!a.canReply || h === null || h.key === a.key) return null;
  if (a.superAdmin) return 'owner';
  if (a.senior && !h.superAdmin && !h.senior) return 'senior';
  if (AWAY_TAKE && !h.superAdmin && h.awayMin !== null && h.awayMin >= HOLDER_AWAY_MIN && customerWaiting) return 'holder_away';
  return null;
}

// Who the actor may transfer the chat to. Only someone who may act on it transfers it (the holder,
// anyone on an unheld chat, the Super Admin). Targets: members switched on, with chat.reply and the
// chat's panel, never yourself or the current holder; then the Super Admin (unless he holds it);
// then, for the Super Admin on a held chat, "Nobody" to put it back in the open pool.
// ownerAwayMin: the Super Admin's own away minutes, shown next to his name like a member's.
export function transferTargets(a: Actor, h: Holder | null, members: Member[], ownerAwayMin: number | null = null): TransferTarget[] {
  if (!canAct(a, h)) return [];
  const out: TransferTarget[] = members
    .filter((m) => m.active && m.canReply && m.panelOk && m.key !== a.key && m.key !== h?.key)
    .map((m) => ({ key: m.key, name: m.name, senior: m.senior, awayMin: m.awayMin }));
  // The Super Admin is above Senior; the dialog names him, so he is not labelled "Senior" too.
  if (h?.key !== OWNER_KEY) out.push({ key: OWNER_KEY, name: a.superAdmin ? 'Me (Super Admin)' : 'Super Admin', senior: false, awayMin: ownerAwayMin });
  if (a.superAdmin && h !== null) out.push({ key: null, name: 'Nobody (open pool)', senior: false, awayMin: null });
  return out;
}

// The status a chat gets when it is transferred. A known customer (verified or old phone match:
// the same test as chatIsVerified in verified.ts) goes to Needs you, so the AI stops, auto-close
// leaves it alone and it shows "For Rahul". A visitor never reaches Needs you (owner's verify rule),
// so it goes to agent_handling. A Refund / Ship again chat and a chat put back in the open pool keep
// their status. A Closed chat is not transferred (null): it goes to its holder when the customer
// writes again.
export function transferStatus(chat: { status: string; case_kind: string | null; known: boolean }, toNobody: boolean): string | null {
  if (chat.status === 'resolved') return null;
  if (toNobody || chat.case_kind) return chat.status;
  return chat.known ? 'human_needed' : 'agent_handling';
}

// May the actor mark Refund / Ship again (also switching between them)? Remove has no extra gate.
// seniorsAway: 'none' = no active member has the Senior tick (then today's rule: chat.cases is
// enough, day and night; covers deploy day before the owner ticks anyone); true = it is office
// hours and every senior has been away 30+ minutes (a junior may mark, logged as an override);
// false = a senior is around, or it is night.
export function caseMarkGate(a: Actor, seniorsAway: 'none' | boolean): { allowed: boolean; override: boolean } {
  if (!a.canCases) return { allowed: false, override: false };
  if (a.superAdmin || a.senior) return { allowed: true, override: false };
  if (seniorsAway === 'none') return { allowed: true, override: false };
  if (seniorsAway === true) return { allowed: true, override: true };
  return { allowed: false, override: false };
}

// The one-line transfer note, as stored (chat_events.note: 3-200 characters, staff only). Control
// characters, line breaks and text-direction overrides become spaces (one line, and a note cannot
// make the team strip display something other than what was typed); runs of spaces become one.
// null when it says nothing: under 3 characters, or no letter in any script ("12!", "..."). Cut at
// 200 code points, so an emoji or a Hindi letter is never split; then checked again.
export function cleanTransferNote(x: unknown): string | null {
  if (typeof x !== 'string') return null;
  const flat = x.replace(/[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu, ' ').replace(/\s+/g, ' ').trim();
  const s = Array.from(flat).slice(0, 200).join('').trim();
  if (Array.from(s).length < 3 || !/\p{L}/u.test(s)) return null;
  return s;
}

// ── Hot chats: Close and Hand to AI are the Super Admin's (owner, 2026-10-02) ──
// A 77% Critical chat whose customer had threatened a consumer complaint was closed and handed to the
// AI by staff within seconds (2026-10-02). The owner's answer: on an angry / threat chat only the
// Super Admin may Close it or Hand it to the AI ("Close + Hand to AI band"); staff wording is not
// blocked ("Kuch nahi"). Take over, Take from X, Transfer, replies and the Refund / Ship again marks
// stay as they are, and the system (auto-close, merges, Chikki) is not a person: none of it is gated.
//
// HOT, for a KNOWN customer (a visitor is never in the inbox's problem tabs): the customer wrote a threat or
// a fraud claim that no team member has answered since (the `urgent` marker escalation.ts / refund-threat.ts
// put on the message itself, the inbox's 1-hour list), or the scorer's MODEL rates them HOT_SCORE_MIN+ (the
// "At risk" level). Or Chikki marked it Refund by itself (the customer was told their refund is being
// processed and a refund form will come).
// Review fix 2026-10-02: never health-rules.ts's word counts (health_signals threat / accuse): they match
// bare words ("fir" = phir, a court or police station in an address, "tracking id fake hai", "duplicate
// order", "loot sale"), and a recent count also floors health_score at 85, so the model's own number
// (health_signals.llm, health.ts) is read instead. A score saved before that key existed: health_score
// stands until the customer writes again; the model failed (llm null): no 'risk' from the counts.
// The same values as the rest of the app; this file has no imports, so hot-lock.js checks they agree.
export const HOT_SCORE_MIN = 65;                 // = HEALTH_PIN_MIN (health-rules.ts), the "At risk" tab
export const HOT_AUTO_MARKER = 'Chikki (auto)';  // = AUTO_MARK_NAME (tracking-claim.ts), Chikki's own marks

export type HotKind = 'auto_refund' | 'threat' | 'fraud' | 'risk';
export interface HotFacts {
  known: boolean;                                // verified, or an old phone match (isKnownCustomer)
  healthScore: number | null | undefined;        // conversations.health_score
  modelScore?: unknown;                          // conversations.health_signals->'llm' (undefined = no such key)
  urgent: unknown;                               // newest unanswered urgent marker: 'threat' | 'accusation' | null
  caseKind: string | null | undefined;
  caseMarkedBy: string | null | undefined;
}

// A count or score read from the database (a JSON number, a numeric string, or nothing): 0 unless finite.
const countOf = (x: unknown): number => {
  const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN;
  return Number.isFinite(n) ? n : 0;
};

// Why the chat is hot, the strongest reason first; null = not hot.
export function hotChat(f: HotFacts): HotKind | null {
  if (f.caseKind === 'refund' && f.caseMarkedBy === HOT_AUTO_MARKER) return 'auto_refund';
  if (!f.known) return null;
  if (f.urgent === 'threat') return 'threat';
  if (f.urgent === 'accusation') return 'fraud';
  const score = f.modelScore === undefined ? countOf(f.healthScore) : countOf(f.modelScore);
  if (score >= HOT_SCORE_MIN) return 'risk';
  return null;
}

// Close and Hand to AI on this chat: may this person press them? The Super Admin always; a member
// never on a hot chat. (Who holds the chat is canAct's question, asked separately.)
export function hotLocked(a: Pick<Actor, 'superAdmin'>, hot: HotKind | null): boolean {
  return !a.superAdmin && hot !== null;
}

// The reason in plain words (staff screens only, never the customer).
function hotWhy(kind: HotKind, score: number | null | undefined): string {
  if (kind === 'auto_refund') return 'Chikki told the customer their refund is being processed and a refund form will come in this chat.';
  if (kind === 'threat') return 'The customer made a threat (chargeback, court, police, legal action or bad reviews).';
  if (kind === 'fraud') return 'The customer called the store a fraud.';
  const s = countOf(score);
  return `The customer is at risk (${Math.round(s)}% frustrated).`;
}

// The small line under the buttons, after "Close / Hand to AI: " (thread answer staff.lock_reason).
export function hotLockNote(kind: HotKind, score?: number | null): string {
  return `Super Admin only. ${hotWhy(kind, score)}`;
}

// The 403 a member gets for Close / Hand to AI on a hot chat (PATCH /api/chat/conversations/[id]).
export function hotLockMessage(kind: HotKind, action: 'close' | 'hand_to_ai', score?: number | null): string {
  const what = action === 'close' ? 'close this chat' : 'hand this chat to the AI';
  return `Only the Super Admin can ${what}. ${hotWhy(kind, score)} You can still reply, take it over or transfer it.`;
}
