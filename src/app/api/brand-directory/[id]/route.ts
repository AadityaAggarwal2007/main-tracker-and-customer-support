import { NextRequest, NextResponse } from 'next/server';
import { cleanBrand } from '@/lib/brand-directory-rules';
import { deleteBrand, getBrand, updateBrand, validId } from '@/lib/brand-directory';
import { failed, superAdminOnly } from '@/lib/brand-directory-http';

export const dynamic = 'force-dynamic';

// ── Payments > Brand Directory, one brand (owner 2026-10-17) ────────────────────────────────────────────────────
// GET    -> { brand }                       404 no such brand
// PATCH  {any of the seven fields} -> { brand }   only the fields sent change; 400 bad input, 409 name taken
// DELETE -> { ok: true }                    removes this ONE brand only
// The Super Admin only, like the list route.
const NOT_FOUND = () => NextResponse.json({ error: 'This brand is not saved any more' }, { status: 404 });

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const got = superAdminOnly(request);
  if ('res' in got) return got.res;
  if (!validId(params.id)) return NOT_FOUND();
  try {
    const brand = await getBrand(params.id);
    return brand ? NextResponse.json({ brand }) : NOT_FOUND();
  } catch (e) { return failed(e, 'get'); }
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const got = superAdminOnly(request);
  if ('res' in got) return got.res;
  if (!validId(params.id)) return NOT_FOUND();
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const { value, errors } = cleanBrand(body, true);
  if (Object.keys(errors).length) return NextResponse.json({ error: Object.values(errors)[0], fields: errors }, { status: 400 });
  if (!Object.keys(value).length) return NextResponse.json({ error: 'Nothing to change' }, { status: 400 });
  try {
    const brand = await updateBrand(params.id, value, 'owner');
    if (!brand) return NOT_FOUND();
    console.log(`[brand-directory] changed brand id=${brand.id}`);
    return NextResponse.json({ brand });
  } catch (e) { return failed(e, 'update'); }
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const got = superAdminOnly(request);
  if ('res' in got) return got.res;
  if (!validId(params.id)) return NOT_FOUND();
  try {
    if (!(await deleteBrand(params.id))) return NOT_FOUND();
    console.log(`[brand-directory] deleted brand id=${params.id}`);
    return NextResponse.json({ ok: true });
  } catch (e) { return failed(e, 'delete'); }
}
