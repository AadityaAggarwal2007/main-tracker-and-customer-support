import { NextRequest, NextResponse } from 'next/server';
import { cleanBrand, cleanOrder, cleanText, LIMITS, type BrandInput } from '@/lib/brand-directory-rules';
import { addGateways, createBrand, listBrands, setOrder } from '@/lib/brand-directory';
import { failed, superAdminOnly } from '@/lib/brand-directory-http';

export const dynamic = 'force-dynamic';

// ── Payments > Brand Directory (owner 2026-10-17: "sirf super admin") ───────────────────────────────────────────
// GET  -> { brands: BrandRow[] }        every saved brand, by founder and the order the owner dragged them into
// POST {founderName, brandName, bankAccountName?, fields?: [{label, value}] (at most 10), color?, withGateways?}
//        -> 201 { brand, added: BrandRow[] }   withGateways = a new founder: also the 11 payment gateway cards
//                                               they do not have yet (owner: "founder add ho to sab apne aap aa jaye")
//      {action: 'founder', founderName}       -> 201 { added }   the gateway cards the founder still lacks
//      {action: 'order', ids: [...]}          -> { ok, changed }  the cards' new order after a drag
//      400 { error, fields } bad input
// The Super Admin only (401 not logged in, 403 anyone else). 503 until brand-directory.sql is run (again).
// Names and bank account names are never logged.
export async function GET(request: NextRequest) {
  const got = superAdminOnly(request);
  if ('res' in got) return got.res;
  try {
    return NextResponse.json({ brands: await listBrands() });
  } catch (e) { return failed(e, 'list'); }
}

export async function POST(request: NextRequest) {
  const got = superAdminOnly(request);
  if ('res' in got) return got.res;
  let body: Record<string, unknown>;
  try {
    const b = await request.json();
    body = b && typeof b === 'object' ? b : {};
  } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }

  if (body.action === 'order') {
    const ids = cleanOrder(body.ids);
    if (!ids) return NextResponse.json({ error: 'Bad card order' }, { status: 400 });
    try {
      const changed = await setOrder(ids);
      console.log(`[brand-directory] new card order for ${ids.length} cards`);
      return NextResponse.json({ ok: true, changed });
    } catch (e) { return failed(e, 'order'); }
  }

  if (body.action === 'founder') {
    const founder = cleanText(body.founderName);
    if (!founder) return NextResponse.json({ error: 'Founder / Owner name is required', fields: { founderName: 'Founder / Owner name is required' } }, { status: 400 });
    if (founder.length > LIMITS.founder) return NextResponse.json({ error: `Founder / Owner name can be at most ${LIMITS.founder} characters` }, { status: 400 });
    try {
      const added = await addGateways(founder, 'owner');
      console.log(`[brand-directory] gateway cards added: ${added.length}`);
      return NextResponse.json({ added }, { status: 201 });
    } catch (e) { return failed(e, 'founder'); }
  }
  if (body.action !== undefined) return NextResponse.json({ error: 'Bad request' }, { status: 400 });

  const { value, errors } = cleanBrand(body);
  if (Object.keys(errors).length) return NextResponse.json({ error: Object.values(errors)[0], fields: errors }, { status: 400 });
  try {
    const brand = await createBrand(value as BrandInput, 'owner');
    const added = body.withGateways === true ? await addGateways(brand.founderName, 'owner') : [];
    console.log(`[brand-directory] added brand id=${brand.id}${added.length ? ` + ${added.length} gateway cards` : ''}`);
    return NextResponse.json({ brand, added }, { status: 201 });
  } catch (e) { return failed(e, 'create'); }
}
