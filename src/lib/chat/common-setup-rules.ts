// ── One Chikki setup for every panel ("All panels", owner 2026-10-10, step 7: "ek jagah badlo to sab panels par lage;
// naya panel bane to sab apne aap") ──
// Pure. Chikki's prompt, saved answers and effort levels can live ONCE for every panel: the prompt in chat_settings
// `common_setup` (with {brand} wherever the store's name goes), the saved answers as site_faqs rows of the pseudo site
// '*' (COMMON_SITE: the column is plain text, so no schema change), the effort levels next to the prompt. A panel uses
// them while its mode is 'common' (chat_settings `setup_mode:<site id>`); its own prompt and answers stay stored,
// unused, and come back with 'own'. With no mode saved: a panel with its own prompt keeps it ('own', so nothing changes
// on deploy), a panel with none (a new panel) uses the common setup as soon as one exists. COD and the default courier
// stay per panel: they are facts of each store. The server part is common-setup.ts. No imports (the AI test harness
// compiles it next to ai.ts).

export const COMMON_SITE = '*';
export const BRAND = '{brand}';
export type SetupMode = 'common' | 'own';

export interface CommonSetup { prompt: string | null; effort: unknown | null; from: string | null; at: string | null; by: string | null }
export const NO_COMMON: CommonSetup = { prompt: null, effort: null, from: null, at: null, by: null };

// The store's name the customer reads, as the widget label already shows it (supportLabel): the site's name, first
// letter capital, without a trailing "Support". '' = unknown (the prompt keeps its own words then).
export function brandOf(siteName: string | null | undefined): string {
  const name = String(siteName || '').replace(/\s+/g, ' ').trim().replace(/\s+support$/i, '').slice(0, 60);
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : '';
}

// {brand} -> the panel's name (any capitals of the token).
export function fillBrand(text: string, brand: string): string {
  if (!text) return text;
  return text.replace(/\{brand\}/gi, brand || 'our store');
}

// The source panel's name -> {brand}, whole words only, any capitals ("Vastora", "VASTORA", "Vastora's").
export function toCommonText(text: string, sourceName: string): { text: string; hits: number } {
  const brand = brandOf(sourceName);
  if (!text || !brand) return { text: text || '', hits: 0 };
  // As panel-copy.ts replaceBrand: whole words, any capitals.
  let hits = 0;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu');
  const out = text.replace(re, () => { hits += 1; return BRAND; });
  return { text: out, hits };
}

export function parseCommon(raw: string | null | undefined): CommonSetup {
  if (!raw) return { ...NO_COMMON };
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
    return { prompt: str(o.prompt), effort: o.effort && typeof o.effort === 'object' ? o.effort : null, from: str(o.from), at: str(o.at), by: str(o.by) };
  } catch { return { ...NO_COMMON }; }
}

export const parseMode = (raw: string | null | undefined): SetupMode | null => (raw === 'common' || raw === 'own' ? raw : null);

// A common setup exists once it has a prompt (made from a panel, or typed).
export const commonReady = (c: CommonSetup) => !!c.prompt;

export function modeFor(saved: SetupMode | null, ownPrompt: string | null | undefined, ready: boolean): SetupMode {
  if (!ready) return 'own';
  if (saved) return saved;
  return ownPrompt && ownPrompt.trim() ? 'own' : 'common';
}

// What Chikki uses on a panel: the prompt (null = the built-in default), where its saved answers are read and the
// effort levels (null = the panel's own column).
export interface PanelSetup { mode: SetupMode; brand: string; prompt: string | null; faqSite: string; effort: unknown | null }
export function panelSetup(siteId: string, siteName: string | null, ownPrompt: string | null, common: CommonSetup, saved: SetupMode | null): PanelSetup {
  const brand = brandOf(siteName);
  const mode = modeFor(saved, ownPrompt, commonReady(common));
  if (mode === 'common') return { mode, brand, prompt: fillBrand(common.prompt || '', brand) || null, faqSite: COMMON_SITE, effort: common.effort };
  return { mode, brand, prompt: ownPrompt && ownPrompt.trim() ? ownPrompt : null, faqSite: siteId, effort: null };
}
