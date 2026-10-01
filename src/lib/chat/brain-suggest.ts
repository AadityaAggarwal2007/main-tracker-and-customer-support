import crypto from 'crypto';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import { query, queryOne } from '@/lib/db';
import { getActiveModel, getClient } from './ai';
import { BRAIN_TOPICS, BRAIN_TOPIC_KEYS, similarity } from './brain';
import { LEARN_INSTRUCTION, SUGGEST_MAX_PER_RUN, maskPersonal, parseDraft } from './brain-learn';
import { QUIET_OK, SITUATIONS, customerCalmedAfter, detectSituations, parseExample, sameReply } from './brain-examples';

// The learning job (brain-learn.ts, brain-examples.ts). For chats where the team answered (or
// edited an AI reply), it reads the masked chat plus what the team did in the order panel, and
// drafts at most one EXAMPLE (a team reply after which the customer calmed down, in a difficult
// situation) and one LESSON. Both are stored PENDING; the AI reads nothing until an admin
// approves (Panel Settings > Brain). Critical chats are read first.

interface Row { id: string; sender: string; content: string; created_at: string }
const REVIEW_VERSION = 2;
const CRITICAL_LABELS = ['Refund / Cancellation', 'Refund', 'Cancellation', 'Wrong tracking link', 'Delivery delay', 'Not received', 'Complaint', 'Payment issue', 'Damaged item', 'Wrong item', 'Missing item'];

// One run at a time: a second call while one runs (a slow run past the cron's timeout) would read
// the same chats and draft the same examples twice.
const g = globalThis as unknown as { __brainSuggestRunning?: boolean };

export async function suggestLessons(opts: { siteId?: string; max?: number; days?: number } = {}) {
  if (g.__brainSuggestRunning) return { reviewed: 0, suggested: 0, examples: 0, skipped: 0, busy: true };
  g.__brainSuggestRunning = true;
  try {
    return await runSuggest(opts);
  } finally {
    g.__brainSuggestRunning = false;
  }
}

async function runSuggest(opts: { siteId?: string; max?: number; days?: number }) {
  const max = Math.max(1, Math.min(opts.max ?? SUGGEST_MAX_PER_RUN, 25));
  const days = Math.max(1, Math.min(opts.days ?? 14, 60));
  const sites = opts.siteId ? [{ id: opts.siteId }] : (await query<{ id: string }>(`SELECT id FROM sites`)).rows;
  const out = { reviewed: 0, suggested: 0, examples: 0, skipped: 0 };

  for (const site of sites) {
    if (out.reviewed >= max) break;
    const known = (await query<{ title: string; body: string }>(
      `SELECT title, body FROM brain_notes WHERE site_id = $1 OR site_id IS NULL
       UNION ALL SELECT title, body FROM brain_suggestions WHERE site_id = $1`,
      [site.id]
    )).rows;
    const existing = known.map((r) => r.title);
    let pendingLessons = (await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM brain_suggestions WHERE site_id = $1 AND status = 'pending'`, [site.id]))?.n ?? 0;
    const existingTexts = known.map((r) => `${r.title} ${r.body}`);
    const knownReplies = (await query<{ team_replied: string }>(
      `SELECT team_replied FROM brain_examples WHERE site_id = $1 AND status <> 'rejected'`, [site.id]
    ).catch(() => ({ rows: [] as { team_replied: string }[] }))).rows.map((r) => r.team_replied);

    const candidates = await query<{ id: string; order_id: string | null; status: string; customer_key: string | null }>(
      `SELECT c.id, COALESCE(c.verified_order_id, c.phone_match_order_id) AS order_id, c.status, c.customer_key
         FROM conversations c
        WHERE c.site_id = $1
          AND c.merged_into IS NULL
          AND (EXISTS (SELECT 1 FROM messages m
                        WHERE m.conversation_id = c.id AND m.sender = 'agent' AND m.deleted_at IS NULL
                          AND length(btrim(m.content)) >= 25 AND m.created_at > now() - make_interval(days => $3))
               OR EXISTS (SELECT 1 FROM message_revisions r JOIN messages am ON am.id = r.message_id
                           WHERE r.conversation_id = c.id AND r.action = 'edit' AND am.sender = 'ai'
                             AND r.created_at > now() - make_interval(days => $3)))
          AND NOT EXISTS (SELECT 1 FROM brain_reviewed r WHERE r.conversation_id = c.id AND r.v >= ${REVIEW_VERSION})
        ORDER BY (COALESCE(c.health_score, 0) >= 40 OR c.subject_label = ANY($4::text[])) DESC,
                 c.last_message_at DESC NULLS LAST
        LIMIT $2`,
      [site.id, max - out.reviewed, days, CRITICAL_LABELS]
    );

    for (const c of candidates.rows) {
      out.reviewed++;
      try {
        const msgs = (await query<Row>(
          `SELECT id, sender, content, created_at FROM (
             SELECT id, sender, content, created_at FROM messages
              WHERE conversation_id = $1 AND deleted_at IS NULL
                AND sender IN ('visitor', 'ai', 'agent')
                AND COALESCE(metadata->>'hidden', 'false') <> 'true'
                AND COALESCE(metadata->>'withheld', '') = ''
                AND btrim(content) <> ''
              ORDER BY created_at DESC, id DESC LIMIT 30) t
           ORDER BY created_at ASC, id ASC`,
          [c.id]
        )).rows;

        // A team reply in a difficult situation after which the customer calmed down: [CALMED].
        // When there is none, a team reply after which the customer never complained again (the
        // chat ended there, is closed or quiet for two days, and they wrote nowhere else since)
        // is used instead, and the owner is told so.
        const calmedIds = new Set<string>(), quietIds = new Set<string>();
        const calmedSits = new Set<string>(), quietSits = new Set<string>();
        const lastVisible = msgs[msgs.length - 1];
        for (let i = 0; i < msgs.length; i++) {
          const m = msgs[i];
          if (m.sender !== 'agent' || m.content.trim().length < 25) continue;
          const before = msgs.slice(0, i).filter((x) => x.sender === 'visitor').slice(-3).map((x) => x.content);
          const sits = detectSituations(before);
          if (!sits.length) continue;
          const nextTeam = msgs.findIndex((x, j) => j > i && x.sender === 'agent');
          const after = msgs.slice(i + 1, nextTeam === -1 ? undefined : nextTeam).filter((x) => x.sender === 'visitor').map((x) => x.content);
          if (customerCalmedAfter(after)) { calmedIds.add(m.id); sits.forEach((s) => calmedSits.add(s)); continue; }
          const endedHere = !after.length && !msgs.slice(i + 1).some((x) => x.sender === 'visitor')
            && (c.status === 'resolved' || Date.now() - new Date(lastVisible.created_at).getTime() > 2 * 86_400_000);
          if (endedHere) {
            const elsewhere = c.customer_key ? await queryOne<{ yes: boolean }>(
              `SELECT EXISTS (SELECT 1 FROM messages mm JOIN conversations cc ON cc.id = mm.conversation_id
                 WHERE cc.site_id = $1 AND cc.customer_key = $2 AND cc.id <> $3 AND mm.sender = 'visitor' AND mm.created_at > $4) AS yes`,
              [site.id, c.customer_key, c.id, m.created_at]
            ) : null;
            const critical = sits.filter((x) => QUIET_OK.includes(x));
            if (!elsewhere?.yes && critical.length) { quietIds.add(m.id); critical.forEach((x) => quietSits.add(x)); }
          }
        }
        const useQuiet = !calmedIds.size;
        const markIds = useQuiet ? quietIds : calmedIds;
        const situationsSeen = useQuiet ? quietSits : calmedSits;

        // What the team did in the order panel while this chat was going on.
        let actions: { status: string; changed_by: string; created_at: string }[] = [];
        if (c.order_id && msgs.length) {
          actions = (await query<{ status: string; changed_by: string; created_at: string }>(
            `SELECT status, changed_by, created_at FROM tracking_history
              WHERE order_id = $1
                AND changed_by NOT IN ('journey-engine', 'shopify-webhook', 'csv-upload', 'claude (owner request)')
                AND created_at BETWEEN $2::timestamptz - interval '1 hour' AND $3::timestamptz + interval '1 day'
              ORDER BY created_at LIMIT 5`,
            [c.order_id, msgs[0].created_at, msgs[msgs.length - 1].created_at]
          ).catch(() => ({ rows: [] }))).rows;
        }

        const lines: { at: number; text: string }[] = msgs.map((m) => ({
          at: new Date(m.created_at).getTime(),
          text: `${m.sender === 'visitor' ? 'Customer' : m.sender === 'ai' ? 'AI' : `Team${markIds.has(m.id) ? ' [CALMED]' : ''}`}: ${maskPersonal(m.content).slice(0, 600)}`,
        }));
        for (const a of actions) lines.push({ at: new Date(a.created_at).getTime(), text: `Team action (panel): set the order status to "${a.status}"` });
        lines.sort((a, b) => a.at - b.at);
        const transcript = lines.map((l) => l.text).join('\n');

        const fixes = await query<{ before: string; after: string }>(
          `SELECT r.previous_content AS before, r.new_content AS after
             FROM message_revisions r JOIN messages am ON am.id = r.message_id
            WHERE r.conversation_id = $1 AND r.action = 'edit' AND am.sender = 'ai' AND r.new_content IS NOT NULL
            ORDER BY r.created_at LIMIT 3`,
          [c.id]
        ).catch(() => ({ rows: [] as { before: string; after: string }[] }));
        const corrections = fixes.rows
          .map((f) => `The AI first wrote: ${maskPersonal(f.before).slice(0, 400)}\nA team member changed it to: ${maskPersonal(f.after).slice(0, 400)}`)
          .join('\n');

        let draft = null;
        let example = null;
        if (transcript.includes('Team') || corrections) {
          const allowed = Array.from(situationsSeen);
          const body = {
            model: getActiveModel(),
            messages: [
              { role: 'system', content: LEARN_INSTRUCTION },
              { role: 'user', content: `Situations: ${allowed.length ? allowed.join(', ') : '(none: return "example": null)'}\nAll situations: ${SITUATIONS.map((s) => s.key).join(', ')}\nTopics for a lesson: ${BRAIN_TOPICS.map((t) => t.key).join(', ')}\nExisting notes: ${existing.join(' | ') || '(none)'}\n\nChat:\n${transcript}${corrections ? `\n\nCorrections by the team (the strongest lesson):\n${corrections}` : ''}` },
            ],
            max_tokens: 900,
            temperature: 0,
            // An OpenRouter field the SDK does not type; thinking only eats the answer here.
            ...(getActiveModel().startsWith('deepseek/deepseek-v4') ? { reasoning: { enabled: false } } : {}),
          };
          const res = await getClient().chat.completions.create(body as unknown as ChatCompletionCreateParamsNonStreaming, { timeout: 60000, maxRetries: 1 });
          const raw = res.choices?.[0]?.message?.content;
          draft = parseDraft(raw, BRAIN_TOPIC_KEYS, existing, existingTexts);
          example = allowed.length ? parseExample(raw, allowed) : null;
          if (example && knownReplies.some((r) => sameReply(r, example!.team_replied) || similarity(r, example!.team_replied) >= 0.5)) example = null;
          // The owner reviews these by hand: past 25 waiting lessons, no new ones until some are decided.
          if (draft && pendingLessons >= 25) draft = null;
        }
        if (draft) {
          await query(
            `INSERT INTO brain_suggestions (id, site_id, conversation_id, kind, title, body, topics, why)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [crypto.randomUUID(), site.id, c.id, draft.kind, draft.title, draft.body, draft.topics, draft.why]
          );
          existing.push(draft.title);
          existingTexts.push(`${draft.title} ${draft.body}`);
          pendingLessons++;
          out.suggested++;
        }
        if (example) {
          await query(
            `INSERT INTO brain_examples (id, site_id, situation, customer_said, team_replied, why, source, conversation_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [crypto.randomUUID(), site.id, example.situation, example.customer_said, example.team_replied,
             useQuiet ? 'The customer did not complain again after this reply (no further message). Check that it really helped.' : 'The customer replied calmly after this.', corrections ? 'team_edit' : 'team_reply', c.id]
          );
          knownReplies.push(example.team_replied);
          out.examples++;
        }
        await query(
          `INSERT INTO brain_reviewed (conversation_id, site_id, had_lesson, v) VALUES ($1, $2, $3, ${REVIEW_VERSION})
           ON CONFLICT (conversation_id) DO UPDATE SET v = ${REVIEW_VERSION}, had_lesson = brain_reviewed.had_lesson OR EXCLUDED.had_lesson, reviewed_at = now()`,
          [c.id, site.id, !!(draft || example)]
        );
      } catch (err) {
        // Not marked reviewed: the next run tries it again.
        out.skipped++;
        console.error('[brain-suggest] chat skipped:', (err as Error)?.message);
      }
    }
  }
  return out;
}

export async function pendingSuggestionCount(siteId: string): Promise<number> {
  const r = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM brain_suggestions WHERE site_id = $1 AND status = 'pending'`, [siteId]);
  return r?.n ?? 0;
}
