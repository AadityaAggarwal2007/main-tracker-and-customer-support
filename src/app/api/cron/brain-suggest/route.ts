import { NextRequest, NextResponse } from 'next/server';
import { suggestLessons } from '@/lib/chat/brain-suggest';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Called daily by VPS cron (crontab is not in Git, see AGENTS.md):
//   40 3 * * * curl -s -m 290 "http://localhost:3000/api/cron/brain-suggest?secret=YOUR_SECRET" >> /var/log/brain-suggest.log 2>&1
// Drafts lessons from chats a team member answered (src/lib/chat/brain-learn.ts). It only ADDS
// pending suggestions; the AI reads nothing from them until an admin approves one.
export async function GET(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get('secret');
  if (secret !== (process.env.CRON_SECRET || 'shiptrack-cron')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    // ?max= (up to 60 chats) and ?days= (up to 60) for a one-off catch-up run.
    const num = (k: string) => { const v = parseInt(request.nextUrl.searchParams.get(k) || '', 10); return Number.isFinite(v) ? v : undefined; };
    const result = await suggestLessons({ max: num('max'), days: num('days') });
    if (result.reviewed) console.log(`[brain-suggest] reviewed ${result.reviewed} chats, ${result.suggested} lessons, ${result.examples} team examples, ${result.skipped} skipped`);
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error('[cron] brain-suggest error:', err);
    return NextResponse.json({ error: 'brain-suggest failed' }, { status: 500 });
  }
}
