import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { cleanParts, describePlan, planIsEmpty } from '@/lib/panel-copy';
import { copyPanelSetup } from '@/lib/panel-copy-server';

export const dynamic = 'force-dynamic';

// POST /api/panel-copy { source, target, parts?, overwrite?, dryRun? }: Super Admin only. Copies one panel's AI setup
// (Chikki's prompt, saved answers, Brain notes, COD answer, default courier, effort levels) to another, so every panel
// gets the same (panel-copy.ts). dryRun:true only reports what would happen. Nothing is ever deleted.
export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: { source?: unknown; target?: unknown; parts?: unknown; overwrite?: unknown; dryRun?: unknown } = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const source = typeof body.source === 'string' ? body.source : '', target = typeof body.target === 'string' ? body.target : '';
  try {
    const r = await copyPanelSetup(source, target, cleanParts(body.parts), body.overwrite === true, body.dryRun === true, user.displayName || user.username);
    if ('error' in r) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({
      applied: r.applied, lines: describePlan(r.plan), nothingToDo: planIsEmpty(r.plan), added: r.added,
      // short samples so the owner can see what is added (the question / the title, never a whole text)
      samples: { answers: r.plan.answers.add.slice(0, 5).map(f => f.question.slice(0, 80)), notes: r.plan.notes.add.slice(0, 5).map(n => n.title.slice(0, 80)) },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[panel-copy]', (e as Error).message);
    return NextResponse.json({ error: 'Could not copy the setup. Nothing was changed.' }, { status: 500 });
  }
}
