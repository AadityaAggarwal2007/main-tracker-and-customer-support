import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { queryOne } from '@/lib/db';
import { ensureSiteForPanel, siteForPanel } from '@/lib/chat/site';
import { cleanCodStates } from '@/lib/chat/cod';
import { can, canAccessPanel, isSuperAdmin } from '@/lib/permissions';
import { COMMON_EDIT_ERROR, canEditCommon, loadCommon, saveCommon, setupForSite } from '@/lib/chat/common-setup';

export const dynamic = 'force-dynamic';

// ── Chat widget settings for a panel ───────────────────────────
// What used to be the chat-support dashboard's Sites page. A panel and a chat
// site are the same thing here, so this only exposes the few fields that are
// genuinely the site's: the widget key, whether the AI answers, and the prompt.

// ── GET /api/panel-chat?businessId= ────────────────────────────
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || !(can(user, 'settings.panel') || can(user, 'chikki.edit'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const businessId = new URL(request.url).searchParams.get('businessId');
  if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });
  if (!canAccessPanel(user, businessId)) return NextResponse.json({ error: 'Panel not found' }, { status: 404 });

  // Read-only: a panel that has never used chat has no site yet, and asking
  // about it should not create one.
  const site = await siteForPanel(businessId);
  if (!site) return NextResponse.json({ site: null });

  // Step 7: while the panel uses the All panels setup, the instructions box shows and saves the common prompt.
  const setup = await setupForSite(site.id).catch(() => null);
  const common = setup?.mode === 'common' ? await loadCommon(true) : null;
  const counts = await queryOne<{ conversations: string }>(
    `SELECT count(*) AS conversations FROM conversations WHERE site_id = $1`,
    [site.id]
  );

  return NextResponse.json({
    site: {
      id: site.id,
      widgetKey: site.widget_key,
      aiEnabled: site.ai_enabled,
      systemPrompt: common ? common.prompt : site.system_prompt,
      setupMode: setup?.mode ?? 'own',
      brand: setup?.brand ?? '',
      codAvailable: site.cod_available,
      codStates: site.cod_states,
      domain: site.domain,
      conversations: Number(counts?.conversations ?? 0),
    },
  });
}

// ── PATCH /api/panel-chat ──────────────────────────────────────
// Turning the AI on, or saving a prompt, is the point at which a panel
// genuinely starts using chat — so the site is created here if missing.
export async function PATCH(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || !can(user, 'settings.panel')) {
    return NextResponse.json({ error: 'You cannot change panel settings' }, { status: 403 });
  }

  try {
    const { businessId, aiEnabled, systemPrompt, codAvailable, codStates, regenerateKey } = await request.json();
    if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });
    if (!canAccessPanel(user, businessId)) return NextResponse.json({ error: 'Panel not found' }, { status: 404 });
    // A new widget key breaks the embed on the store: the super admin only.
    if (regenerateKey && !isSuperAdmin(user)) return NextResponse.json({ error: 'Only the super admin can make a new widget key' }, { status: 403 });

    const biz = await queryOne<{ id: string }>(`SELECT id FROM businesses WHERE id = $1`, [businessId]);
    if (!biz) return NextResponse.json({ error: 'Panel not found' }, { status: 404 });

    const site = await ensureSiteForPanel(businessId);

    const sets: string[] = [];
    const params: unknown[] = [];
    let pi = 1;

    if (aiEnabled !== undefined) { sets.push(`ai_enabled = $${pi++}`); params.push(Boolean(aiEnabled)); }
    // Tri-state: null means "not configured", so the agent stays silent on COD
    // rather than guessing. Only true/false are an actual answer.
    if (codAvailable !== undefined) {
      sets.push(`cod_available = $${pi++}`);
      params.push(codAvailable === null ? null : Boolean(codAvailable));
    }
    // COD only in some states (chat-cod-states.sql). What is typed is reduced to
    // state names, so it can never turn into an instruction for the agent; a
    // box with nothing usable in it clears the setting.
    if (codStates !== undefined) {
      const cleaned = cleanCodStates(codStates);
      if (typeof codStates === 'string' && codStates.trim() && !cleaned) {
        return NextResponse.json({ error: 'Type the state names, like Gujarat' }, { status: 400 });
      }
      sets.push(`cod_states = $${pi++}`);
      params.push(cleaned);
    }
    // The All panels setup (step 7): the box is the common prompt; an empty one would switch every panel back to its
    // own, so it is refused here (Settings > All panels setup switches a panel).
    let commonPrompt: string | null = null;
    if (systemPrompt !== undefined && (await setupForSite(site.id).catch(() => null))?.mode === 'common') {
      if (!canEditCommon(user, can(user, 'chikki.edit') || isSuperAdmin(user))) return NextResponse.json({ error: COMMON_EDIT_ERROR }, { status: 403 });
      const text = systemPrompt ? String(systemPrompt) : '';
      if (!text.trim()) return NextResponse.json({ error: 'The All panels prompt cannot be empty. To give this panel its own prompt, switch it to Own in Settings > All panels setup.' }, { status: 400 });
      commonPrompt = (await saveCommon({ prompt: text }, user.username)).prompt;
    } else if (systemPrompt !== undefined) {
      // An empty box means "use the default prompt", not "answer with nothing".
      sets.push(`system_prompt = $${pi++}`);
      params.push(systemPrompt && String(systemPrompt).trim() ? String(systemPrompt) : null);
    }
    // Regenerating invalidates every embed snippet already on a storefront, so
    // it only happens when explicitly asked for.
    if (regenerateKey === true) sets.push(`widget_key = gen_random_uuid()::text`);

    if (sets.length === 0) return NextResponse.json({ success: true, ...(commonPrompt !== null ? { site: { id: site.id, widgetKey: site.widget_key, aiEnabled: site.ai_enabled, systemPrompt: commonPrompt, setupMode: 'common', codAvailable: site.cod_available, codStates: site.cod_states } } : {}) });

    sets.push(`updated_at = now()`);
    params.push(site.id);

    const updated = await queryOne<{ widget_key: string; ai_enabled: boolean; system_prompt: string | null; cod_available: boolean | null; cod_states: string | null }>(
      `UPDATE sites SET ${sets.join(', ')} WHERE id = $${pi}
       RETURNING widget_key, ai_enabled, system_prompt, cod_available, cod_states`,
      params
    );

    return NextResponse.json({
      success: true,
      site: {
        id: site.id,
        widgetKey: updated!.widget_key,
        aiEnabled: updated!.ai_enabled,
        systemPrompt: commonPrompt ?? updated!.system_prompt,
        ...(commonPrompt !== null ? { setupMode: 'common' } : {}),
        codAvailable: updated!.cod_available,
        codStates: updated!.cod_states,
      },
    });
  } catch (err) {
    console.error('Panel chat settings error:', err);
    return NextResponse.json({ error: 'Could not save those settings' }, { status: 500 });
  }
}
