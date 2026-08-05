import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

// ── GET: Fetch current progression settings ─────────────────────
export async function GET() {
  const result = await query(
    `SELECT * FROM progression_settings ORDER BY step_order ASC`
  );

  return NextResponse.json(
    { steps: result.rows },
    {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      },
    }
  );
}

// ── PUT: Update progression settings ───────────────────────────
export async function PUT(request: NextRequest) {
  try {
    const { steps } = await request.json();

    if (!steps || !Array.isArray(steps)) {
      return NextResponse.json({ error: 'Invalid steps data' }, { status: 400 });
    }

    // Update each step in parallel for speed
    await Promise.all(
      steps.map((step: { id: string; delay_minutes: number; is_enabled: boolean }) =>
        query(
          `UPDATE progression_settings
           SET delay_minutes = $1, is_enabled = $2, updated_at = NOW()
           WHERE id = $3`,
          [step.delay_minutes, step.is_enabled, step.id]
        )
      )
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Progression settings update error:', err);
    return NextResponse.json({ error: 'Update failed', detail: String(err) }, { status: 500 });
  }
}
