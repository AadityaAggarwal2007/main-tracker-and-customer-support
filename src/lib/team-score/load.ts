// ── Team score (owner, 2026-10-01, part 4): the loader. Server only. ──
// STAFF ONLY, Super Admin only. Reads one consistent snapshot (REPEATABLE READ READ ONLY, 8 s
// statement timeout) of the chats, messages, holder / status / case / health history, presence,
// AI verdicts and point settings that the pure engine (engine.ts) needs for some India days.
// Writes nothing. Customer keys and phones never leave SQL (only an md5 customer ref does), AI
// message text is never loaded, and customer / staff text is cut to 500 characters. Spec: phase 4,
// section 4.1.
//
// Time rules: messages.created_at is a naive TIMESTAMP(3) written in the database session's time
// zone, so it is read as col::timestamptz (epoch ms) and filtered by converting the PARAMETER
// ($1::timestamptz::timestamp), never with AT TIME ZONE on the column.
import { query, withTransaction } from '@/lib/db';
import { ownerUsernames } from '@/lib/auth';
import { resolvePermissions } from '@/lib/permissions';
import { AI_NOT_AN_ANSWER_REGEX, NO_REPLY_NEEDED_REGEX } from '@/lib/chat/waiting';
import type {
  InAction, InCase, InConv, InHealth, InHolder, InMsg, InPerson, InPresence, InStatus, ScoreInput, SettingsRow, Verdict, Weights,
} from './types';
import { DAY_MS, dayStartMs, istDay } from './clock';
import { DEFAULT_WEIGHTS, LOOKBACK_DAYS, MSG_LOOKBACK_DAYS, SOLVED_QUIET_MS, WEIGHT_KEYS } from './rules';

// ── Errors the routes turn into a plain answer ──
// 42P01: a team score table is missing (team-score.sql not applied yet).
export class TeamScoreNotInstalled extends Error {
  status = 503;
  constructor() { super('Team score is not installed yet (team-score.sql).'); this.name = 'TeamScoreNotInstalled'; }
}
// 57014: the 8-second statement timeout fired.
export class TeamScoreBusy extends Error {
  status = 503;
  constructor() { super('The report is busy, try again in a minute.'); this.name = 'TeamScoreBusy'; }
}
// A Postgres error with a code the routes answer in words; anything else is passed on unchanged.
export function mapDbError(err: unknown): unknown {
  const code = (err as { code?: string } | null)?.code;
  if (code === '42P01') return new TeamScoreNotInstalled();
  if (code === '57014') return new TeamScoreBusy();
  return err;
}

const iso = (ms: number) => new Date(ms).toISOString();
const num = (x: unknown): number => Number(x);
const numOrNull = (x: unknown): number | null => (x === null || x === undefined || !Number.isFinite(Number(x)) ? null : Number(x));
const str = (x: unknown): string | null => (x === null || x === undefined ? null : String(x));
const jsonOf = (x: unknown): unknown => {
  if (typeof x !== 'string') return x;
  try { return JSON.parse(x); } catch { return null; }
};

// ── People ──
export interface TeamRow { id: string; username: string; display_name: string | null; role: string; is_active: boolean; permissions: string[] | null }

export const TEAM_SQL = `SELECT id::text AS id, username, display_name, role, is_active, permissions FROM team_users`;

// Current members (tier from the Senior tick, canReply from chat.reply) plus the Super Admin.
export function buildPeople(rows: TeamRow[], owners: string[]): InPerson[] {
  const out: InPerson[] = [];
  for (const r of rows || []) {
    const perms = resolvePermissions(String(r.role || ''), Array.isArray(r.permissions) ? r.permissions : null);
    const login = String(r.username || '').toLowerCase();
    out.push({
      key: String(r.id),
      name: String(r.display_name || '').trim() || String(r.username || '') || 'Team member',
      tier: perms.includes('chat.senior') ? 'senior' : 'junior',
      active: r.is_active === true,
      canReply: perms.includes('chat.reply'),
      logins: login ? [login] : [],
    });
  }
  out.push({
    key: 'owner', name: 'Super Admin', tier: 'owner', active: true, canReply: true,
    logins: Array.from(new Set((owners || []).map((l) => String(l || '').toLowerCase()).filter(Boolean))),
  });
  return out;
}

async function ownerLogins(): Promise<string[]> {
  try { return (await ownerUsernames()).map((l) => l.toLowerCase()); } catch { return []; }
}

// ── Settings ──
export const SETTINGS_SQL = `SELECT id, weights, effective_from::text, points_from::text, (extract(epoch FROM created_at)*1000)::float8 AS created
  FROM team_score_settings ORDER BY id`;

function cleanWeights(raw: unknown): Weights {
  const obj = (jsonOf(raw) || {}) as Record<string, unknown>;
  const w = { ...DEFAULT_WEIGHTS };
  for (const k of WEIGHT_KEYS) {
    const v = Number(obj?.[k]);
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && Number.isFinite(v)) w[k] = v;
  }
  return w;
}

export function settingsRows(rows: Record<string, unknown>[]): SettingsRow[] {
  return (rows || []).map((r) => ({
    id: num(r.id),
    weights: cleanWeights(r.weights),
    effectiveFrom: String(r.effective_from).slice(0, 10),
    pointsFrom: String(r.points_from).slice(0, 10),
    createdAt: num(r.created),
  })).sort((a, b) => a.id - b.id);
}

export const EVENTS_SINCE_SQL = `SELECT (extract(epoch FROM min(created_at))*1000)::float8 AS t FROM chat_events`;

// What the screen needs when every day in view is frozen (no message loader): who is who, the
// settings, when part 3 went live, when the logs started.
export interface ScoreMeta { people: InPerson[]; settings: SettingsRow[]; eventsSinceMs: number | null; installedMs: number }
export async function loadMeta(nowMs: number = Date.now()): Promise<ScoreMeta> {
  try {
    const owners = await ownerLogins();
    const team = await query<TeamRow>(TEAM_SQL);
    const st = await query<Record<string, unknown>>(SETTINGS_SQL);
    const ev = await query<{ t: number | null }>(EVENTS_SINCE_SQL);
    const settings = settingsRows(st.rows);
    return {
      people: buildPeople(team.rows, owners),
      settings,
      eventsSinceMs: numOrNull(ev.rows[0]?.t),
      installedMs: settings.length ? settings[0].createdAt : nowMs,
    };
  } catch (err) {
    throw mapDbError(err);
  }
}

// ── The loader ──
export async function loadScoreInput(days: string[], nowMs: number): Promise<ScoreInput> {
  if (!Array.isArray(days) || !days.length) throw new Error('team-score: no days to load');
  const first = dayStartMs(days[0]), last = dayStartMs(days[days.length - 1]);
  if (first === null || last === null) throw new Error('team-score: bad day');
  const loadStartMs = first - LOOKBACK_DAYS * DAY_MS;
  const loadEndMs = Math.max(loadStartMs, Math.min(last + DAY_MS + SOLVED_QUIET_MS, nowMs));
  const msgFromMs = loadStartMs - MSG_LOOKBACK_DAYS * DAY_MS;
  const reportFrom = first, reportTo = last + DAY_MS;

  let input: ScoreInput;
  let teamRows: TeamRow[] = [];
  try {
    input = await withTransaction(async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query(`SET LOCAL statement_timeout = '8s'`);

      // Q1. Candidate chats and the customer's other chats. known = VERIFIED, the app's own test
      // (chatIsVerified in src/lib/chat/verified.ts, used for widget chats AND email threads): order ID
      // + phone proved, or an old phone match. Thanks and convinced count only there (owner A3).
      const q1 = await c.query(
        `WITH ids AS (
  SELECT DISTINCT m.conversation_id AS id FROM messages m
   WHERE m.created_at >= $1::timestamptz::timestamp AND m.created_at < $2::timestamptz::timestamp
     AND m.sender IN ('visitor','agent','ai')
  UNION SELECT h.conversation_id FROM chat_holder_log h WHERE h.at >= $1::timestamptz AND h.at < $2::timestamptz
  UNION SELECT e.conversation_id FROM chat_events e WHERE e.created_at >= $1::timestamptz AND e.created_at < $2::timestamptz
  UNION SELECT c.id FROM conversations c WHERE c.assigned_to IS NOT NULL AND c.status <> 'resolved'
)
SELECT c.id, c.source, c.status, c.merged_into, c.assigned_to,
       (extract(epoch FROM c.assigned_at) * 1000)::float8 AS assigned_ms,
       (c.verified_order_id IS NOT NULL OR c.phone_match_order_id IS NOT NULL) AS known,
       c.case_kind IS NOT NULL AS case_now,
       CASE WHEN c.source = 'chat' AND c.customer_key IS NOT NULL
            THEN 'k' || md5(c.site_id || ':' || c.customer_key) ELSE 'c' || md5(c.id) END AS cu
  FROM conversations c
 WHERE c.id IN (SELECT id FROM ids)
    OR (c.source = 'chat' AND c.customer_key IS NOT NULL
        AND (c.site_id, c.customer_key) IN (SELECT c2.site_id, c2.customer_key FROM conversations c2
                                              WHERE c2.id IN (SELECT id FROM ids) AND c2.source = 'chat'
                                                AND c2.customer_key IS NOT NULL))`,
        [iso(loadStartMs), iso(loadEndMs)],
      );
      const convs: InConv[] = q1.rows.map((r: Record<string, unknown>) => ({
        id: String(r.id),
        cu: String(r.cu),
        source: r.source === 'email' ? 'email' : 'chat',
        known: r.known === true,
        status: String(r.status ?? ''),
        mergedInto: str(r.merged_into),
        assignedTo: str(r.assigned_to),
        assignedAt: numOrNull(r.assigned_ms),
        caseNow: r.case_now === true,
      }));
      const ids = convs.map((x) => x.id);

      // Q2. Messages (the inbox's visibility rule, but a staff reply deleted by someone else stays).
      const q2 = ids.length ? await c.query(
        `SELECT m.id, m.conversation_id AS conv, m.sender,
       (extract(epoch FROM m.created_at::timestamptz) * 1000)::float8 AS at,
       CASE WHEN m.sender IN ('visitor','agent') THEN left(m.content, 500) ELSE '' END AS text,
       (m.sender = 'ai' AND m.content ~* $4) AS ai_not_answer,
       (m.sender = 'visitor' AND m.content ~* $5) AS no_reply,
       CASE WHEN m.sender = 'agent' THEN lower(m.metadata->>'agent') END AS login
  FROM messages m
 WHERE m.conversation_id = ANY($1::text[])
   AND m.created_at >= $2::timestamptz::timestamp AND m.created_at < $3::timestamptz::timestamp
   AND m.sender IN ('visitor','agent','ai')
   AND COALESCE(m.metadata->>'hidden','false') <> 'true'
   AND COALESCE(m.metadata->>'withheld','') = ''
   AND m.content IS NOT NULL AND btrim(m.content) <> ''
   AND (m.deleted_at IS NULL
        OR (m.sender = 'agent' AND m.deleted_by IS DISTINCT FROM m.metadata->>'agent'))
 ORDER BY m.created_at, m.id`,
        [ids, iso(msgFromMs), iso(loadEndMs), AI_NOT_AN_ANSWER_REGEX, NO_REPLY_NEEDED_REGEX],
      ) : { rows: [] };
      const msgs: InMsg[] = q2.rows.map((r: Record<string, unknown>) => {
        const sender = r.sender === 'agent' ? 'agent' : r.sender === 'ai' ? 'ai' : 'visitor';
        return {
          id: String(r.id), conv: String(r.conv), sender, at: num(r.at),
          text: sender === 'ai' ? '' : String(r.text ?? ''),
          aiNotAnswer: r.ai_not_answer === true,
          noReply: r.no_reply === true,
          login: sender === 'agent' ? str(r.login) : null,
          eventActor: null,
        } as InMsg;
      });

      // Q3. Who wrote each staff reply (part 3's reply events).
      const agentIds = msgs.filter((m) => m.sender === 'agent').map((m) => m.id);
      if (agentIds.length) {
        const q3 = await c.query(`SELECT message_id, actor FROM chat_events WHERE kind = 'reply' AND message_id = ANY($1::text[])`, [agentIds]);
        const byMsg = new Map<string, string>();
        for (const r of q3.rows as { message_id: string; actor: string }[]) if (r.actor) byMsg.set(String(r.message_id), String(r.actor));
        for (const m of msgs) if (m.sender === 'agent') m.eventActor = byMsg.get(m.id) ?? null;
      }

      // Q4-Q6 read every row of these chats, also those after loadEnd: the engine takes the state
      // before a chat's first row from that row ("from"), and only when there is no row at all from
      // the chat's CURRENT state. Cut at loadEnd, a chat closed / marked / given back after D+2 looked
      // closed / marked / unheld for all of day D, so a freeze or recompute of D lost its 2-hour items.
      // Q4. Holder rows.
      const q4 = ids.length ? await c.query(
        `SELECT id, conversation_id AS conv, (extract(epoch FROM at)*1000)::float8 AS at, from_owner, to_owner
  FROM chat_holder_log WHERE conversation_id = ANY($1::text[]) ORDER BY conversation_id, at, id`,
        [ids],
      ) : { rows: [] };
      const holders: InHolder[] = q4.rows.map((r: Record<string, unknown>) => ({
        id: num(r.id), conv: String(r.conv), at: num(r.at), from: str(r.from_owner), to: str(r.to_owner),
      }));

      // Q5. Status rows.
      const q5 = ids.length ? await c.query(
        `SELECT id, conversation_id AS conv, (extract(epoch FROM created_at)*1000)::float8 AS at, from_status, to_status, reason, actor
  FROM chat_events WHERE kind = 'status' AND conversation_id = ANY($1::text[]) ORDER BY conversation_id, id`,
        [ids],
      ) : { rows: [] };
      const statuses: InStatus[] = q5.rows.map((r: Record<string, unknown>) => ({
        id: num(r.id), conv: String(r.conv), at: num(r.at), from: str(r.from_status), to: str(r.to_status),
        reason: str(r.reason), actor: String(r.actor ?? ''),
      }));

      // Q6. Refund / Ship again marks.
      const q6 = ids.length ? await c.query(
        `SELECT conversation_id AS conv, (extract(epoch FROM created_at)*1000)::float8 AS at, action
  FROM chat_case_events WHERE conversation_id = ANY($1::text[]) ORDER BY conversation_id, created_at`,
        [ids],
      ) : { rows: [] };
      const cases: InCase[] = q6.rows
        .filter((r: Record<string, unknown>) => r.action === 'mark' || r.action === 'remove')
        .map((r: Record<string, unknown>) => ({ conv: String(r.conv), at: num(r.at), action: r.action as 'mark' | 'remove' }));

      // Q7. Pickups, takes, transfers.
      const q7 = await c.query(
        `SELECT id, conversation_id AS conv, (extract(epoch FROM created_at)*1000)::float8 AS at, kind, actor, actor_name,
       from_owner, to_owner, reason, meta->>'take' AS take, COALESCE((meta->>'bulk')::boolean, false) AS bulk, note
  FROM chat_events WHERE kind IN ('claim','take','transfer') AND created_at >= $1::timestamptz AND created_at < $2::timestamptz ORDER BY id`,
        [iso(loadStartMs), iso(loadEndMs)],
      );
      const actions: InAction[] = q7.rows
        .filter((r: Record<string, unknown>) => r.kind === 'claim' || r.kind === 'take' || r.kind === 'transfer')
        .map((r: Record<string, unknown>) => ({
          id: num(r.id), conv: String(r.conv), at: num(r.at), kind: r.kind as 'claim' | 'take' | 'transfer',
          actor: String(r.actor ?? ''), actorName: str(r.actor_name),
          from: str(r.from_owner), to: str(r.to_owner), reason: str(r.reason), take: str(r.take),
          bulk: r.bulk === true, note: str(r.note),
        }));

      // Q8. Health history.
      const q8 = ids.length ? await c.query(
        `SELECT conversation_id AS conv, (extract(epoch FROM at)*1000)::float8 AS at, score
  FROM chat_health_log WHERE conversation_id = ANY($1::text[]) AND at < $2::timestamptz ORDER BY conversation_id, at, id`,
        [ids, iso(loadEndMs)],
      ) : { rows: [] };
      const health: InHealth[] = q8.rows.map((r: Record<string, unknown>) => ({ conv: String(r.conv), at: num(r.at), score: num(r.score) }));

      // Q9. Who was in ShipTrack on which India day.
      const q9 = await c.query(
        `SELECT actor, day::text, (extract(epoch FROM first_seen)*1000)::float8 AS first, (extract(epoch FROM last_seen)*1000)::float8 AS last
  FROM staff_presence_days WHERE day BETWEEN $1::date AND $2::date`,
        [istDay(loadStartMs), istDay(loadEndMs)],
      );
      const presence: InPresence[] = q9.rows.map((r: Record<string, unknown>) => ({
        actor: String(r.actor), day: String(r.day).slice(0, 10), first: num(r.first), last: num(r.last),
      }));

      // Q10. AI verdicts of the customer messages on the report days (the only ones the engine asks about).
      const visIds = msgs.filter((m) => m.sender === 'visitor' && m.at >= reportFrom && m.at < reportTo).map((m) => m.id);
      const verdicts: Record<string, Verdict> = {};
      if (visIds.length) {
        const q10 = await c.query(`SELECT message_id, thanks, convinced, source FROM team_score_verdicts WHERE message_id = ANY($1::text[])`, [visIds]);
        for (const r of q10.rows as Record<string, unknown>[]) {
          const source = r.source === 'ai' || r.source === 'ai_unclear' || r.source === 'ai_failed' ? r.source : 'ai_failed';
          verdicts[String(r.message_id)] = {
            thanks: typeof r.thanks === 'boolean' ? r.thanks : null,
            convinced: typeof r.convinced === 'boolean' ? r.convinced : null,
            source,
          };
        }
      }

      // Q11. Point settings (the first row's time is the install time).
      const q11 = await c.query(SETTINGS_SQL);
      const settings = settingsRows(q11.rows);

      // Q12. When part 3's events start.
      const q12 = await c.query(EVENTS_SINCE_SQL);
      const eventsSinceMs = numOrNull(q12.rows[0]?.t);

      // Q13. The team.
      const q13 = await c.query(TEAM_SQL);
      teamRows = q13.rows as TeamRow[];

      return {
        days: [...days], nowMs, loadStartMs, loadEndMs,
        eventsSinceMs,
        installedMs: settings.length ? settings[0].createdAt : nowMs,
        people: [], convs, msgs, holders, statuses, cases, actions, health, presence, verdicts, settings,
      };
    });
  } catch (err) {
    throw mapDbError(err);
  }
  // The Super Admin's logins, read after the snapshot (auth.ts reads admin_login on the pool).
  input.people = buildPeople(teamRows, await ownerLogins());
  return input;
}
