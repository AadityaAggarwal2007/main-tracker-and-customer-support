import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// GET: Fetch current progression settings
export async function GET() {
  const { data, error } = await getSupabaseAdmin()
    .from('progression_settings')
    .select('*')
    .order('step_order', { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ steps: data });
}

// PUT: Update progression settings
export async function PUT(request: NextRequest) {
  try {
    const { steps } = await request.json();

    if (!steps || !Array.isArray(steps)) {
      return NextResponse.json({ error: 'Invalid steps data' }, { status: 400 });
    }

    const results = [];

    // Update each step
    for (const step of steps) {
      const { data, error } = await getSupabaseAdmin()
        .from('progression_settings')
        .update({
          delay_minutes: step.delay_minutes,
          is_enabled: step.is_enabled,
          updated_at: new Date().toISOString(),
        })
        .eq('id', step.id)
        .select();

      results.push({
        id: step.id,
        delay_minutes: step.delay_minutes,
        updated: data?.length ?? 0,
        error: error?.message || null,
      });

      if (error) {
        console.error('Failed to update step:', error);
        return NextResponse.json({ error: error.message, debug: results }, { status: 500 });
      }
    }

    return NextResponse.json({ success: true, results });
  } catch (err) {
    console.error('Progression settings update error:', err);
    return NextResponse.json({ error: 'Update failed', detail: String(err) }, { status: 500 });
  }
}
