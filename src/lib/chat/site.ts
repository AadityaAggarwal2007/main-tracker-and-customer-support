import { queryOne } from '@/lib/db';

// ── The chat site behind a panel ───────────────────────────────
// Chat conversations, mailboxes and the widget key all hang off a row in
// `sites`, which belongs to the chat-support schema. A panel gets one created
// on demand: previously a site only appeared when a panel connected Shopify,
// which left panels that never sell through Shopify unable to use chat at all.

export interface PanelSite {
  id: string;
  name: string;
  domain: string;
  widget_key: string;
  ai_enabled: boolean;
  system_prompt: string | null;
  tracker_business_id: string | null;
  cod_available: boolean | null;
}

export async function siteForPanel(businessId: string): Promise<PanelSite | null> {
  return queryOne<PanelSite>(
    `SELECT id, name, domain, widget_key, ai_enabled, system_prompt, tracker_business_id, cod_available
       FROM sites WHERE tracker_business_id::text = $1::text`,
    [businessId]
  );
}

// `domainHint` is only used when the row has to be created and the panel has no
// Shopify store — an email address's domain reads better in a site list than a
// placeholder.
export async function ensureSiteForPanel(businessId: string, domainHint?: string): Promise<PanelSite> {
  const existing = await siteForPanel(businessId);
  if (existing) return existing;

  const biz = await queryOne<{ name: string; shopify_domain: string | null }>(
    `SELECT name, shopify_domain FROM businesses WHERE id = $1`,
    [businessId]
  );

  const domain =
    biz?.shopify_domain ||
    (domainHint && domainHint.includes('@') ? domainHint.split('@')[1] : domainHint) ||
    'email-only';

  // id and widget_key are generated here rather than leaning on the column
  // defaults Prisma happens to have created on the chat-support tables.
  const created = await queryOne<PanelSite>(
    `INSERT INTO sites (id, name, domain, widget_key, ai_enabled, tracker_business_id, created_at, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, gen_random_uuid()::text, true, $3::text, now(), now())
     ON CONFLICT (tracker_business_id) DO UPDATE SET updated_at = now()
     RETURNING id, name, domain, widget_key, ai_enabled, system_prompt, tracker_business_id`,
    [biz?.name || 'Panel', domain, businessId]
  );

  return created!;
}
