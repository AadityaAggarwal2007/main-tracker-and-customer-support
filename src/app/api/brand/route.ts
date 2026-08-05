import { NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';

export const dynamic = 'force-dynamic';

// Public endpoint — returns default business branding (no auth required)
export async function GET() {
  let data = await queryOne(
    `SELECT name, logo_url, support_email, support_phone
     FROM businesses
     WHERE is_default = true
     LIMIT 1`
  );

  if (!data) {
    // Fallback: grab the first business
    data = await queryOne(
      `SELECT name, logo_url, support_email, support_phone
       FROM businesses
       ORDER BY created_at ASC
       LIMIT 1`
    );
  }

  return NextResponse.json({ business: data || null });
}
