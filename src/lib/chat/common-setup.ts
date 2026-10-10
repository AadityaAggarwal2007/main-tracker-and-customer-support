// ── The "All panels" setup on the server (owner 2026-10-10, step 7; rules in common-setup-rules.ts) ──
// Read on every AI reply (cached 30 s per process: a change made through the other PM2 process shows within 30 s),
// written from Settings > All panels setup and, while a panel is in 'common' mode, from Chikki's own screens (the
// prompt, the saved answers, the effort levels). Reads never throw: a failure means the panel's own setup, exactly as
// before this step.
import crypto from 'crypto';
import { query, queryOne, withTransaction } from '@/lib/db';
import {
  COMMON_SITE, NO_COMMON, commonReady, panelSetup, parseCommon, parseMode, toCommonText,
  type CommonSetup, type PanelSetup, type SetupMode,
} from './common-setup-rules';

const COMMON_KEY = 'common_setup';
const modeKey = (siteId: string) => `setup_mode:${siteId}`;
const TTL = 30_000;
const g = globalThis as unknown as { __commonCache?: { at: number; v: CommonSetup }; __modeCache?: Map<string, { at: number; v: SetupMode | null }> };

async function setting(key: string): Promise<string | null> {
  return (await queryOne<{ value: string }>(`SELECT value FROM chat_settings WHERE key = $1`, [key]))?.value ?? null;
}
async function saveSetting(key: string, value: string, client?: { query: (q: string, p: unknown[]) => Promise<unknown> }) {
  const sql = `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  if (client) await client.query(sql, [key, value]); else await query(sql, [key, value]);
}

export async function loadCommon(fresh = false): Promise<CommonSetup> {
  const c = g.__commonCache;
  if (!fresh && c && Date.now() - c.at < TTL) return c.v;
  try {
    const v = parseCommon(await setting(COMMON_KEY));
    g.__commonCache = { at: Date.now(), v };
    return v;
  } catch (e) {
    console.error('[common-setup] read:', (e as Error).message);
    return c?.v ?? { ...NO_COMMON };
  }
}

export async function savedMode(siteId: string, fresh = false): Promise<SetupMode | null> {
  const cache = (g.__modeCache ??= new Map());
  const c = cache.get(siteId);
  if (!fresh && c && Date.now() - c.at < TTL) return c.v;
  try {
    const v = parseMode(await setting(modeKey(siteId)));
    cache.set(siteId, { at: Date.now(), v });
    return v;
  } catch (e) {
    console.error('[common-setup] mode read:', (e as Error).message);
    return c?.v ?? null;
  }
}

// What Chikki uses on this panel now. Never throws: any failure = the panel's own setup.
export async function setupFor(siteId: string, ownPrompt: string | null): Promise<PanelSetup> {
  try {
    const site = await queryOne<{ name: string | null }>(`SELECT name FROM sites WHERE id = $1`, [siteId]);
    const [common, mode] = await Promise.all([loadCommon(), savedMode(siteId)]);
    return panelSetup(siteId, site?.name ?? null, ownPrompt, common, mode);
  } catch (e) {
    console.error('[common-setup] setup:', (e as Error).message);
    return panelSetup(siteId, null, ownPrompt, NO_COMMON, null);
  }
}

// The same for a screen (Chikki, Settings): the site's own prompt read here. Throws on a database error.
export async function setupForSite(siteId: string): Promise<PanelSetup & { ownPrompt: string | null }> {
  const site = await queryOne<{ name: string | null; system_prompt: string | null }>(`SELECT name, system_prompt FROM sites WHERE id = $1`, [siteId]);
  const [common, mode] = await Promise.all([loadCommon(true), savedMode(siteId, true)]);
  return { ...panelSetup(siteId, site?.name ?? null, site?.system_prompt ?? null, common, mode), ownPrompt: site?.system_prompt ?? null };
}

export async function setMode(siteId: string, mode: SetupMode): Promise<void> {
  await saveSetting(modeKey(siteId), mode);
  (g.__modeCache ??= new Map()).set(siteId, { at: Date.now(), v: mode });
}

export async function saveCommon(patch: Partial<CommonSetup>, by: string): Promise<CommonSetup> {
  const cur = await loadCommon(true);
  const next: CommonSetup = { ...cur, ...patch, at: new Date().toISOString(), by };
  await saveSetting(COMMON_KEY, JSON.stringify(next));
  g.__commonCache = { at: Date.now(), v: next };
  return next;
}

// ── Make the common setup from one panel (Settings > All panels setup: Preview, then Make common) ──
// The source's prompt (its name -> {brand}) becomes the common prompt; its enabled saved answers are ADDED to the
// common ones (a question already there is skipped; the name -> {brand} too); its effort levels become the common
// ones. The common setup before is kept in chat_settings `common_setup_backup:<time>`. Nothing of any panel changes:
// each panel switches to it with its own Common / Own button. One transaction.
export interface MakePlan {
  source: { siteId: string; name: string };
  prompt: { chars: number; hits: number; replaces: boolean };
  answers: { add: number; skip: number; hits: number };
  effort: boolean;
}
const qkey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export async function makeCommon(sourceSiteId: string, by: string, dryRun: boolean): Promise<MakePlan | { error: string }> {
  const site = await queryOne<{ id: string; name: string; system_prompt: string | null }>(
    `SELECT id, name, system_prompt FROM sites WHERE id = $1`, [sourceSiteId]);
  if (!site) return { error: 'Panel not found' };
  if (!site.system_prompt || !site.system_prompt.trim()) return { error: 'That panel has no Chikki prompt of its own to share' };
  let effort: unknown = null;
  try { effort = (await queryOne<{ chikki_effort: unknown }>(`SELECT chikki_effort FROM sites WHERE id = $1`, [site.id]))?.chikki_effort ?? null; } catch { /* column missing */ }
  const own = (await query<{ question: string; answer: string; sort_order: number }>(
    `SELECT question, answer, sort_order FROM site_faqs WHERE site_id = $1 AND is_enabled = true ORDER BY sort_order, created_at`, [site.id])).rows;
  const have = new Set((await query<{ question: string }>(`SELECT question FROM site_faqs WHERE site_id = $1`, [COMMON_SITE])).rows.map((r) => qkey(r.question)));
  const prompt = toCommonText(site.system_prompt, site.name);
  let hits = 0;
  const add: { question: string; answer: string }[] = [];
  let skip = 0;
  for (const f of own) {
    const q = toCommonText(f.question, site.name), a = toCommonText(f.answer, site.name);
    if (have.has(qkey(q.text))) { skip++; continue; }
    have.add(qkey(q.text));
    hits += q.hits + a.hits;
    add.push({ question: q.text, answer: a.text });
  }
  const cur = await loadCommon(true);
  const plan: MakePlan = {
    source: { siteId: site.id, name: site.name },
    prompt: { chars: prompt.text.length, hits: prompt.hits, replaces: commonReady(cur) },
    answers: { add: add.length, skip, hits },
    effort: !!effort,
  };
  if (dryRun) return plan;
  await withTransaction(async (client) => {
    if (commonReady(cur)) await saveSetting(`common_setup_backup:${new Date().toISOString()}`, JSON.stringify(cur), client);
    const next: CommonSetup = { prompt: prompt.text, effort: effort ?? cur.effort, from: site.name, at: new Date().toISOString(), by };
    await saveSetting(COMMON_KEY, JSON.stringify(next), client);
    const start = Number((await client.query(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM site_faqs WHERE site_id = $1`, [COMMON_SITE]) as { rows: { n: number }[] }).rows[0]?.n ?? 0);
    for (let i = 0; i < add.length; i++) {
      await client.query(`INSERT INTO site_faqs (id, site_id, question, answer, sort_order) VALUES ($1, $2, $3, $4, $5)`,
        [crypto.randomUUID(), COMMON_SITE, add[i].question, add[i].answer, start + i]);
    }
  });
  g.__commonCache = undefined;
  return plan;
}

// Settings > All panels setup: the common setup and every panel the login may see, with its mode.
export async function overview(panelIds: string[] | null) {
  const common = await loadCommon(true);
  const answers = Number((await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM site_faqs WHERE site_id = $1`, [COMMON_SITE]))?.n ?? 0);
  const sites = (await query<{ site_id: string; business_id: string; name: string; system_prompt: string | null; answers: number }>(
    `SELECT s.id AS site_id, s.tracker_business_id::text AS business_id, COALESCE(b.name, s.name) AS name, s.system_prompt,
            (SELECT count(*)::int FROM site_faqs f WHERE f.site_id = s.id) AS answers
       FROM sites s JOIN businesses b ON b.id::text = s.tracker_business_id::text
      WHERE ($1::text[] IS NULL OR s.tracker_business_id::text = ANY($1::text[]))
      ORDER BY b.created_at NULLS LAST, b.name`, [panelIds])).rows;
  const panels = [];
  for (const s of sites) {
    const saved = await savedMode(s.site_id, true);
    const p = panelSetup(s.site_id, s.name, s.system_prompt, common, saved);
    panels.push({ businessId: s.business_id, siteId: s.site_id, name: s.name, brand: p.brand, mode: p.mode, saved, ownPromptChars: s.system_prompt?.length ?? 0, ownAnswers: s.answers });
  }
  return { common: { ready: commonReady(common), from: common.from, at: common.at, by: common.by, promptChars: common.prompt?.length ?? 0, effort: !!common.effort, answers }, panels };
}

// Who may change the common setup from a panel's screens: someone who may edit Chikki and is not limited to some
// panels (a change reaches every panel in 'common' mode).
export const canEditCommon = (u: { role: string; businessIds?: string[] | null; permissions?: unknown }, canChikki: boolean) =>
  canChikki && (!u.businessIds || u.businessIds.length === 0);
export const COMMON_EDIT_ERROR = 'This panel uses the All panels setup: only an admin of every panel can change it (or switch the panel to its own setup in Settings > All panels setup)';
