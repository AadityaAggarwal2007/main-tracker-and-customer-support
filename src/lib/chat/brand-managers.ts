// ── Brand managers, the database side (rules in brand-managers-rules.ts) ──
// chat_settings `brand_manager:<panel id>` = {"member": "<team member id>" | null, "by", "at"} (no SQL file; tracker_user
// may INSERT / UPDATE chat_settings, never DELETE: clearing writes member null). Cached 30 s per process.
import { query } from '@/lib/db';
import { BRAND_MANAGER_PREFIX, parseBrandManagers, type BrandManagers } from './brand-managers-rules';

let cache: { at: number; value: BrandManagers } | null = null;

export async function loadBrandManagers(fresh = false): Promise<BrandManagers> {
  if (!fresh && cache && Date.now() - cache.at < 30_000) return cache.value;
  try {
    const r = await query<{ key: string; value: string }>(`SELECT key, value FROM chat_settings WHERE key LIKE $1`, [`${BRAND_MANAGER_PREFIX.replace(/_/g, '\\_')}%`]);
    const value = parseBrandManagers(r.rows);
    cache = { at: Date.now(), value };
    return value;
  } catch (e) {
    console.error('[brand-managers] read:', (e as Error).message);
    return cache?.value || {};
  }
}

export async function setBrandManager(panelId: string, memberId: string | null, byName: string): Promise<void> {
  await query(
    `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [`${BRAND_MANAGER_PREFIX}${panelId}`, JSON.stringify({ member: memberId, by: byName, at: new Date().toISOString() })]);
  cache = null;
}
