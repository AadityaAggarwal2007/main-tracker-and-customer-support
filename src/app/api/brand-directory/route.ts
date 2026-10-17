import { NextRequest, NextResponse } from 'next/server';
import { cleanBrand, type BrandInput } from '@/lib/brand-directory-rules';
import { createBrand, listBrands } from '@/lib/brand-directory';
import { failed, superAdminOnly } from '@/lib/brand-directory-http';

export const dynamic = 'force-dynamic';

// ── Payments > Brand Directory (owner 2026-10-17: "sirf super admin") ───────────────────────────────────────────
// GET  -> { brands: BrandRow[] }        every saved brand, by name
// POST {founderName, brandName, bankAccountName?, customField1Label?, customField1Value?, customField2Label?,
//       customField2Value?} -> 201 { brand }   400 { error, fields } bad input, 409 the name is taken
// The Super Admin only (401 not logged in, 403 anyone else). 503 until brand-directory.sql is run.
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
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const { value, errors } = cleanBrand(body);
  if (Object.keys(errors).length) return NextResponse.json({ error: Object.values(errors)[0], fields: errors }, { status: 400 });
  try {
    const brand = await createBrand(value as BrandInput, 'owner');
    console.log(`[brand-directory] added brand id=${brand.id}`);
    return NextResponse.json({ brand }, { status: 201 });
  } catch (e) { return failed(e, 'create'); }
}
