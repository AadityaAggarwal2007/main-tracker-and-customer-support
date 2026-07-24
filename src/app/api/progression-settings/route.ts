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

    for (const step of steps) {
      // Update
      const { data: updated, error } = await getSupabaseAdmin()
        .from('progression_settings')
        .update({
          delay_minutes: step.delay_minutes,
          is_enabled: step.is_enabled,
          updated_at: new Date().toISOString(),
        })
        .eq('id', step.id)
        .select();

      // Read back immediately
      const { data: readBack } = await getSupabaseAdmin()
        .from('progression_settings')
        .select('id, delay_minutes, updated_at')
        .eq('id', step.id)
        .single();

      // Also count total rows
      const { data: allRows } = await getSupabaseAdmin()
        .from('progression_settings')
        .select('id, step_from, step_to, delay_minutes, step_order')
        .eq('step_from', 'Order Placed');

      results.push({
        id: step.id,
        requested_delay: step.delay_minutes,
        update_returned: updated,
        read_back: readBack,
        all_matching_rows: allRows,
        error: error?.message || null,
      });
    }

    return NextResponse.json({ success: true, results });
  } catch (err) {
    console.error('Progression settings update error:', err);
    return NextResponse.json({ error: 'Update failed', detail: String(err) }, { status: 500 });
  }
}
