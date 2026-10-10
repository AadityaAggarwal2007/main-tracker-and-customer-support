// ── Each brand's own words in a WhatsApp template (owner 2026-10-10: "har brand ka alag alag system hoga") ──
// One WhatsApp number serves the whole install (Meta shows one business name per number), but the brand name and
// the support email INSIDE a message are each panel's own: Vastora, VASTRIKA, kurtiya. They live in chat_settings
// (`wa_brand:<panel id>`, JSON {name, email}); a panel with nothing saved uses its panel name and its support Gmail
// address. The "order placed" template (ORDER_PLACED_PRESET) takes them as its variables.

import { query } from '@/lib/db';
import { BRAND_PREFIX, brandKey, parseBrand, type Brand } from './whatsapp-brand-rules';
export * from './whatsapp-brand-rules';

export async function loadBrands(): Promise<Brand[]> {
  const panels = await query<{ id: string; name: string }>(`SELECT b.id::text AS id, b.name FROM businesses b ORDER BY b.is_default DESC, b.created_at ASC`);
  const gmail = new Map<string, string>();
  try {
    const r = await query<{ id: string; email: string }>(
      `SELECT s.tracker_business_id::text AS id, se.email FROM site_emails se JOIN sites s ON s.id = se.site_id ORDER BY se.created_at ASC`
    );
    for (const row of r.rows) if (row.id && !gmail.has(row.id)) gmail.set(row.id, row.email);
  } catch (e) { console.error('[whatsapp] brand gmail read:', (e as Error).message); }
  const saved = new Map<string, { name: string | null; email: string | null }>();
  try {
    const r = await query<{ key: string; value: string }>(`SELECT key, value FROM chat_settings WHERE key LIKE 'wa_brand:%'`);
    for (const row of r.rows) saved.set(row.key.slice(BRAND_PREFIX.length), parseBrand(row.value));
  } catch (e) { console.error('[whatsapp] brand settings read:', (e as Error).message); }
  return panels.rows.map((p) => {
    const sv = saved.get(p.id) || { name: null, email: null };
    return { id: p.id, panel: p.name, name: sv.name || p.name, email: sv.email || gmail.get(p.id) || '', savedName: sv.name, savedEmail: sv.email, supportGmail: gmail.get(p.id) || null };
  });
}

export async function saveBrand(businessId: string, name: string, email: string): Promise<void> {
  await query(
    `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [brandKey(businessId), JSON.stringify({ name, email })]
  );
}
