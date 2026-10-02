// ── Team score (owner, 2026-10-01, part 4): shared types. No imports. ──
// STAFF ONLY: used by src/lib/team-score/*, /api/team/score/*, /api/cron/team-score and
// src/components/TeamScoreCard.tsx. Never by the widget, the AI, the learner or search.
// Owner answers 2026-10-02: the Super Admin sees everyone; a member who can reply sees only their
// own row (view 'self'). closed_waiting costs points; thanks / convinced only for verified chats.
export const ENGINE_VERSION = 'ts-1';
export type PersonKey = string;                       // team_users.id::text | 'owner'
export type Tier = 'owner' | 'senior' | 'junior';
export type PointKind = 'thanks' | 'solved' | 'fast_reply' | 'unanswered_2h' | 'angry' | 'closed_waiting' | 'convinced' | 'customer_answered';
export type ItemKind = 'chat' | 'thanks' | 'convinced' | 'frustrated' | 'unanswered_2h' | 'taken_no_reply'
  | 'picked' | 'sent' | 'received' | 'taken_from' | 'released' | 'fast_reply' | 'solved' | 'closed_waiting' | 'angry';
export type Metric = 'chats' | 'customers' | 'convinced' | 'thanks' | 'frustrated' | 'unanswered_2h' | 'sent'
  | 'picked' | 'taken_no_reply' | 'angry' | 'fast_reply' | 'solved' | 'points';
export type Weights = Record<PointKind, number>;

// ── Engine input (load.ts builds it from one REPEATABLE READ snapshot; all times epoch ms) ──
export interface InPerson { key: PersonKey; name: string; tier: Tier; active: boolean; canReply: boolean; logins: string[] }
export interface InConv {
  id: string; cu: string;                 // cu: hashed customer ref ('k…' widget customer, 'c…' one chat / email thread)
  // known = VERIFIED: order ID + phone proved, or an old phone match (the test of chatIsVerified in
  // src/lib/chat/verified.ts, also used for email threads). Thanks, convinced and angry need it.
  source: 'chat' | 'email'; known: boolean; status: string; mergedInto: string | null;
  assignedTo: string | null; assignedAt: number | null; caseNow: boolean;
}
export interface InMsg {
  id: string; conv: string; sender: 'visitor' | 'agent' | 'ai'; at: number;
  text: string;                           // visitor / agent: first 500 chars; ai: '' (never loaded)
  aiNotAnswer: boolean;                   // ai && AI_NOT_AN_ANSWER_REGEX (computed in SQL)
  noReply: boolean;                       // visitor && NO_REPLY_NEEDED_REGEX (computed in SQL)
  login: string | null;                   // agent: lower(metadata.agent)
  eventActor: string | null;              // agent: chat_events 'reply' actor for this message id
}
export interface InHolder { id: number; conv: string; at: number; from: string | null; to: string | null }
export interface InStatus { id: number; conv: string; at: number; from: string | null; to: string | null; reason: string | null; actor: string }
export interface InCase { conv: string; at: number; action: 'mark' | 'remove' }
export interface InAction {
  id: number; conv: string; at: number; kind: 'claim' | 'take' | 'transfer'; actor: string; actorName: string | null;
  from: string | null; to: string | null; reason: string | null; take: string | null; bulk: boolean; note: string | null;
}
export interface InHealth { conv: string; at: number; score: number }
export interface InPresence { actor: string; day: string; first: number; last: number }
export interface Verdict { thanks: boolean | null; convinced: boolean | null; source: 'ai' | 'ai_unclear' | 'ai_failed' }
export interface SettingsRow { id: number; weights: Weights; effectiveFrom: string; pointsFrom: string; createdAt: number }
export interface ScoreInput {
  days: string[];                         // India days to report, ascending, contiguous
  nowMs: number; loadStartMs: number; loadEndMs: number;
  eventsSinceMs: number | null;           // first chat_events row (part 3 live); null = none yet
  installedMs: number;                    // first team_score_settings row (holder/health/presence logs start)
  people: InPerson[];
  convs: InConv[]; msgs: InMsg[]; holders: InHolder[]; statuses: InStatus[]; cases: InCase[];
  actions: InAction[]; health: InHealth[]; presence: InPresence[];
  verdicts: Record<string, Verdict>;      // by customer message id
  settings: SettingsRow[];                // ascending id
}

// ── Engine output ──
export interface ScoreItem {
  kind: ItemKind;
  actor: string;                          // PersonKey | 'ai' | 'unattributed' | 'pool'
  day: string; at: number; conv: string; cu: string;
  msgs: string[];                         // message ids behind it (staff reply first, then the customer's)
  counted: boolean;
  pending: boolean;                       // waiting for the AI check or the 24-hour check
  points: number;                         // 0 unless counted on a day with points
  why: string;                            // one plain-English sentence; never customer text
  by?: 'keyword' | 'ai' | null;           // thanks / convinced: how it was judged
  peer?: string | null;                   // the other person (sent to, taken by, got from); null = open pool
  note?: string | null;                   // transfer note (staff only; Super Admin sees it)
  n?: number; after?: number;             // 'chat': messages in that chat that day, of which outside 10:00-19:30
}
export interface Counts {
  replies: number; after_hours: number; chats: number; customers: number;
  thanks: number; thanks_pending: number; thanks_not_counted: number; asked_thanks: number;
  convinced: number; convinced_pending: number;
  frustrated: number | null;
  unanswered_2h: number | null; taken_no_reply: number | null;
  picked: number | null; picked_pool: number | null; picked_take: number | null;
  sent: number | null; sent_to: { key: string | null; name: string; n: number }[];
  received: number | null; taken_from: number | null; released: number | null;
  fast_reply: number | null; solved: number | null; solved_pending: number | null; closed_waiting: number | null;
  angry: number | null;
  holding_now: number | null; waiting_now: number | null;
  online: { first: string; last: string } | null; days_in: number;
}
export interface Part { n: number; each: number | null; points: number }   // each null: the weight changed inside a range (mergeDays)
export interface PersonDay { key: PersonKey; counts: Counts; points: number | null; parts: Partial<Record<PointKind, Part>>; cus: string[] }
export interface TeamDay {
  pool_waited_2h: number | null;          // customers who waited 2 office hours with nobody holding the chat
  absent_waits: number | null;            // customers waiting on a holder who was not in that day
  thanks_after_ai: number;                // thank-yous whose latest answer was the AI's
  unattributed: { login: string; replies: number }[];   // replies by a login that is no current member / owner
}
export interface DayResult {
  day: string; settingsId: number; pointsOn: boolean; eventsOn: boolean; healthOn: boolean;
  people: PersonDay[]; team: TeamDay; items: ScoreItem[]; aiPending: number;
}
export interface JudgeCandidate { messageId: string; conv: string; teamText: string; customerText: string }
export interface EngineResult { days: DayResult[]; candidates: JudgeCandidate[] }

// ── API: GET /api/team/score ──
export interface PersonRow {
  key: PersonKey; name: string; tier: Tier; active: boolean; ranked: boolean; rank: number | null;
  points: number | null; counts: Counts; parts: Partial<Record<PointKind, Part>>;
}
export interface DayState { day: string; state: 'live' | 'final' | 'recomputed'; final_at: string | null; saved_at: string | null; reason: string | null }
export interface TeamScoreResponse {
  // 'team': the Super Admin's full board. 'self': a member's own row only (people = [self] or [],
  // rank null, owner / leader null, team footer empty, judge.pending = their own, no recompute reason).
  view: 'team' | 'self';
  from: string; to: string; now: string; live: boolean;
  days: DayState[];
  events_since: string | null; health_from: string; points_from: string;
  weights: { id: number; values: Weights; effective_from: string };
  judge: { pending: number; model_ok: boolean | null };
  people: PersonRow[]; owner: PersonRow | null; team: TeamDay;
  leader: { key: PersonKey; name: string; thanks: number } | null;
  took_ms: number;
}
// ── API: GET /api/team/score/items ──
export interface ItemRow extends ScoreItem {
  at_ist: string;                         // '14:05' or '2 Oct 14:05' when not on the item's day
  chat: { id: string; name: string; status: string; known: boolean; source: string } | null;
  messages: { id: string; role: 'customer' | 'staff' | 'ai'; by: string | null; at_ist: string; text: string }[];
}
export interface ItemsResponse { person: string; metric: Metric; total: number; counted: number; items: ItemRow[] }
