import crypto from 'crypto';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import { query, queryOne } from '@/lib/db';
import { getActiveModel, getClient } from './ai';
import { BRAIN_TOPICS, BRAIN_TOPIC_KEYS } from './brain';
import { LEARN_INSTRUCTION, SUGGEST_MAX_PER_RUN, maskPersonal, parseDraft } from './brain-learn';

// The daily job of the learning loop (brain-learn.ts): reads the newest chats where a team
// member answered, drafts at most one lesson per chat and stores it as a PENDING suggestion.
// Never touches brain_notes: only an admin's approval does (/api/panel-brain/suggestions).

interface Row { sender: string; content: string }

export async function suggestLessons(opts: { siteId?: string; max?: number } = {}) {
  const max = Math.min(opts.max ?? SUGGEST_MAX_PER_RUN, SUGGEST_MAX_PER_RUN);
  const sites = opts.siteId
    ? [{ id: opts.siteId }]
    : (await query<{ id: string }>(`SELECT id FROM sites`)).rows;
  const out = { reviewed: 0, suggested: 0, skipped: 0 };

  for (const site of sites) {
    if (out.reviewed >= max) break;
    const existing = (await query<{ title: string }>(
      `SELECT title FROM brain_notes WHERE site_id = $1 OR site_id IS NULL
       UNION SELECT title FROM brain_suggestions WHERE site_id = $1 AND status <> 'rejected'`,
      [site.id]
    )).rows.map((r) => r.title);

    const candidates = await query<{ id: string }>(
      `SELECT c.id
         FROM conversations c
        WHERE c.site_id = $1
          AND c.merged_into IS NULL
          AND (EXISTS (SELECT 1 FROM messages m
                        WHERE m.conversation_id = c.id AND m.sender = 'agent' AND m.deleted_at IS NULL
                          AND length(btrim(m.content)) >= 25 AND m.created_at > now() - interval '14 days')
               -- or a team member corrected something the AI wrote: the strongest signal there is
               OR EXISTS (SELECT 1 FROM message_revisions r JOIN messages am ON am.id = r.message_id
                           WHERE r.conversation_id = c.id AND r.action = 'edit' AND am.sender = 'ai'
                             AND r.created_at > now() - interval '14 days'))
          AND NOT EXISTS (SELECT 1 FROM brain_reviewed r WHERE r.conversation_id = c.id)
        ORDER BY c.last_message_at DESC NULLS LAST
        LIMIT $2`,
      [site.id, max - out.reviewed]
    );

    for (const c of candidates.rows) {
      out.reviewed++;
      try {
        const msgs = await query<Row>(
          `SELECT sender, content FROM (
             SELECT sender, content, created_at, id FROM messages
              WHERE conversation_id = $1 AND deleted_at IS NULL
                AND sender IN ('visitor', 'ai', 'agent')
                AND COALESCE(metadata->>'hidden', 'false') <> 'true'
                AND btrim(content) <> ''
              ORDER BY created_at DESC, id DESC LIMIT 14) t
           ORDER BY created_at ASC, id ASC`,
          [c.id]
        );
        const transcript = msgs.rows
          .map((m) => `${m.sender === 'visitor' ? 'Customer' : m.sender === 'ai' ? 'AI' : 'Team'}: ${maskPersonal(m.content).slice(0, 500)}`)
          .join('\n');
        // What the AI wrote first and what a team member changed it to.
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
        if (transcript.includes('Team:') || corrections) {
          const body = {
            model: getActiveModel(),
            messages: [
              { role: 'system', content: LEARN_INSTRUCTION },
              { role: 'user', content: `Topics: ${BRAIN_TOPICS.map((t) => t.key).join(', ')}\nExisting notes: ${existing.join(' | ') || '(none)'}\n\nChat:\n${transcript}${corrections ? `\n\nCorrections by the team (the strongest lesson):\n${corrections}` : ''}` },
            ],
            max_tokens: 500,
            temperature: 0,
            // An OpenRouter field the SDK does not type; thinking only eats the answer here.
            ...(getActiveModel().startsWith('deepseek/deepseek-v4') ? { reasoning: { enabled: false } } : {}),
          };
          const res = await getClient().chat.completions.create(body as unknown as ChatCompletionCreateParamsNonStreaming, { timeout: 45000, maxRetries: 1 });
          draft = parseDraft(res.choices?.[0]?.message?.content, BRAIN_TOPIC_KEYS, existing);
        }
        if (draft) {
          await query(
            `INSERT INTO brain_suggestions (id, site_id, conversation_id, kind, title, body, topics, why)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [crypto.randomUUID(), site.id, c.id, draft.kind, draft.title, draft.body, draft.topics, draft.why]
          );
          existing.push(draft.title);
          out.suggested++;
        }
        await query(
          `INSERT INTO brain_reviewed (conversation_id, site_id, had_lesson) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [c.id, site.id, !!draft]
        );
      } catch (err) {
        // Not marked reviewed: tomorrow's run tries it again.
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
