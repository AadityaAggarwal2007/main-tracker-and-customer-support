import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query } from '@/lib/db';
import { can, canAccessPanel } from '@/lib/permissions';
import { panelNameKey } from '@/lib/panel-name';
import { uploadWarnings } from '@/lib/upload-check';

export const dynamic = 'force-dynamic';

const MAX_IDS = 50000;
const MAX_BRANDS = 200;

// POST { panelId, orderIds: string[], brands: string[] } -> { warnings: [{ code, message }] }
// Asked by the upload screen before the first chunk is sent (owner 2026-10-08): is this file really
// for the panel the uploader chose? Reads only; it saves nothing. The screen asks "Upload anyway?".
export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || !can(user, 'orders.upload')) {
    return NextResponse.json({ error: 'You cannot upload orders' }, { status: 403 });
  }
  let body: { panelId?: unknown; orderIds?: unknown; brands?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const panelId = typeof body.panelId === 'string' ? body.panelId : '';
  if (!panelId || !canAccessPanel(user, panelId)) {
    return NextResponse.json({ error: 'You cannot upload into that panel' }, { status: 403 });
  }
  const orderIds = Array.isArray(body.orderIds) ? Array.from(new Set(body.orderIds.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 40))).slice(0, MAX_IDS) : [];
  const brands = Array.isArray(body.brands) ? body.brands.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, MAX_BRANDS) : [];

  try {
    const panels = await query<{ id: string; name: string }>(`SELECT id::text AS id, name FROM businesses`);
    const selected = panels.rows.find(p => p.id === panelId);
    if (!selected) return NextResponse.json({ error: 'Panel not found' }, { status: 404 });

    // Which panels already hold the file's order numbers.
    const perPanel = new Map<string, { count: number; sample: string[] }>();
    for (let i = 0; i < orderIds.length; i += 5000) {
      const batch = orderIds.slice(i, i + 5000);
      const r = await query<{ business_id: string; order_id: string }>(
        `SELECT business_id::text AS business_id, order_id FROM orders WHERE order_id = ANY($1::text[]) AND business_id IS NOT NULL`,
        [batch]
      );
      for (const row of r.rows) {
        const e = perPanel.get(row.business_id) ?? { count: 0, sample: [] };
        e.count++;
        if (e.sample.length < 3) e.sample.push(row.order_id);
        perPanel.set(row.business_id, e);
      }
    }

    // Does a panel's name match a brand written in the file (either contains the other)?
    const brandKeys = brands.map(panelNameKey).filter(Boolean);
    const matches = (name: string) => {
      const k = panelNameKey(name);
      return !!k && brandKeys.some(b => b === k || b.includes(k) || k.includes(b));
    };

    const warnings = uploadWarnings({
      panelName: selected.name,
      total: orderIds.length,
      inSelected: perPanel.get(panelId)?.count ?? 0,
      inOthers: panels.rows
        .filter(p => p.id !== panelId && perPanel.has(p.id))
        .map(p => ({ panel: p.name, count: perPanel.get(p.id)!.count, sample: perPanel.get(p.id)!.sample })),
      brandPanelsOther: panels.rows.filter(p => p.id !== panelId && matches(p.name)).map(p => p.name),
      brandMatchesSelected: matches(selected.name),
    });
    return NextResponse.json({ warnings });
  } catch (err) {
    console.error('[upload-check]', (err as Error)?.message);
    // A check that cannot run never blocks an upload.
    return NextResponse.json({ warnings: [] });
  }
}
