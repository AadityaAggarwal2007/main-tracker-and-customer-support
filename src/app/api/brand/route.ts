import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

// Public endpoint — returns default business branding (no auth required)
export async function GET() {
  const { data } = await getSupabaseAdmin()
    .from('businesses')
    .select('name, logo_url, support_email, support_phone')
    .eq('is_default', true)
    .single();

  if (!data) {
    // Fallback: grab the first business
    const { data: first } = await getSupabaseAdmin()
      .from('businesses')
      .select('name, logo_url, support_email, support_phone')
      .limit(1)
      .single();
    return NextResponse.json({ business: first || null });
  }

  return NextResponse.json({ business: data });
}
