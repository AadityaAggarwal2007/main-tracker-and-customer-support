import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '@/lib/db';
import { ensureSiteForPanel } from '@/lib/chat/site';
import { planCopy, type CopyParts, type CopyPlan, type FaqRow, type NoteRow, type Setup } from './panel-copy';

// ── Copy one panel's AI setup to another: the database part (panel-copy.ts has the rules) ──────────
// Super Admin only (the route checks). One transaction; nothing is deleted; the old values of anything REPLACED are saved in
// chat_settings under 'panel_copy:<time>:<target>' (with the ids that were added), so it can be undone by hand.

interface BizRow { id: string; name: string; default_courier: string | null }
interface SiteRow { id: string; system_prompt: string | null; cod_available: boolean | null; cod_states: string | null; chikki_effort: unknown | null }

export async function loadSetup(businessId: string): Promise<{ setup: Setup; siteId: string | null; biz: BizRow } | null> {
  const biz = await queryOne<BizRow>(`SELECT id::text AS id, name, default_courier FROM businesses WHERE id::text = $1::text`, [businessId]);
  if (!biz) return null;
  const site = await queryOne<SiteRow>(
    `SELECT id, system_prompt, cod_available, cod_states, chikki_effort FROM sites WHERE tracker_business_id::text = $1::text`, [businessId]);
  const faqs = site ? (await query<FaqRow>(`SELECT question, answer, sort_order, is_enabled FROM site_faqs WHERE site_id = $1 ORDER BY sort_order, created_at`, [site.id])).rows : [];
  const notes = site ? (await query<NoteRow>(`SELECT * FROM brain_notes WHERE site_id = $1 ORDER BY sort_order, created_at`, [site.id])).rows : [];
  return {
    biz, siteId: site?.id ?? null,
    setup: {
      name: biz.name, prompt: site?.system_prompt ?? null, codAvailable: site?.cod_available ?? null, codStates: site?.cod_states ?? null,
      effort: site?.chikki_effort ?? null, courier: biz.default_courier ?? null, faqs, notes,
    },
  };
}

export type CopyResult =
  | { ok: true; plan: CopyPlan; applied: boolean; added: { answers: number; notes: number } }
  | { ok: false; status: number; error: string };

export async function copyPanelSetup(sourceId: string, targetId: string, parts: CopyParts, overwrite: boolean, dryRun: boolean, actor: string): Promise<CopyResult> {
  if (!sourceId || !targetId) return { ok: false, status: 400, error: 'source and target are required' };
  if (sourceId === targetId) return { ok: false, status: 400, error: 'Choose another panel to copy from.' };
  const src = await loadSetup(sourceId), dst = await loadSetup(targetId);
  if (!src || !dst) return { ok: false, status: 404, error: 'Panel not found' };
  const plan = planCopy(src.setup, dst.setup, parts, overwrite);
  if (dryRun) return { ok: true, plan, applied: false, added: { answers: plan.answers.add.length, notes: plan.notes.add.length } };

  const siteId = dst.siteId ?? (await ensureSiteForPanel(targetId)).id;
  const before = dst.setup;
  await withTransaction(async (c: PoolClient) => {
    const sets = (a: string) => a === 'copy' || a === 'overwrite';
    if (sets(plan.prompt.action)) await c.query(`UPDATE sites SET system_prompt = $1, updated_at = now() WHERE id = $2`, [plan.prompt.value, siteId]);
    if (sets(plan.cod.action)) await c.query(`UPDATE sites SET cod_available = $1, cod_states = $2, updated_at = now() WHERE id = $3`, [plan.cod.codAvailable, plan.cod.codStates, siteId]);
    if (sets(plan.effort.action)) await c.query(`UPDATE sites SET chikki_effort = $1::jsonb, updated_at = now() WHERE id = $2`, [JSON.stringify(plan.effort.value), siteId]);
    if (sets(plan.courier.action)) await c.query(`UPDATE businesses SET default_courier = $1 WHERE id::text = $2::text`, [plan.courier.value, targetId]);
    const faqIds: string[] = [], noteIds: string[] = [];
    for (const f of plan.answers.add) {
      const id = randomUUID(); faqIds.push(id);
      await c.query(`INSERT INTO site_faqs (id, site_id, question, answer, sort_order, is_enabled) VALUES ($1, $2, $3, $4, $5, $6)`, [id, siteId, f.question, f.answer, f.sort_order, f.is_enabled]);
    }
    for (const n of plan.notes.add) {
      const id = randomUUID(); noteIds.push(id);
      const cols = ['id', 'site_id', 'kind', 'title', 'body', 'topics', 'always', 'is_enabled', 'source', 'sort_order', 'created_by'];
      const vals: unknown[] = [id, siteId, n.kind, n.title, n.body, n.topics ?? [], n.always, n.is_enabled, n.source, n.sort_order, `copy by ${actor}`];
      if (n.audience) { cols.push('audience'); vals.push(n.audience); }
      await c.query(`INSERT INTO brain_notes (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, vals);
    }
    // The way back: what was there before, and what was added.
    await c.query(
      `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())`,
      [`panel_copy:${new Date().toISOString()}:${targetId}`, JSON.stringify({
        by: actor, from: sourceId, to: targetId, overwrite,
        before: { prompt: before.prompt, codAvailable: before.codAvailable, codStates: before.codStates, effort: before.effort, courier: before.courier },
        addedFaqIds: faqIds, addedNoteIds: noteIds,
      })]);
  });
  return { ok: true, plan, applied: true, added: { answers: plan.answers.add.length, notes: plan.notes.add.length } };
}
