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

    // Update each step
    for (const step of steps) {
      const { error } = await getSupabaseAdmin()
        .from('progression_settings')
        .update({
          delay_minutes: step.delay_minutes,
          is_enabled: step.is_enabled,
          updated_at: new Date().toISOString(),
        })
        .eq('id', step.id);

      if (error) {
        console.error('Failed to update step:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Progression settings update error:', err);
    return NextResponse.json({ error: 'Update failed' }, { status: 500 });
  }
}
