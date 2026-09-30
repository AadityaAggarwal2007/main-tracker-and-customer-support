import { NextRequest, NextResponse } from 'next/server';
import { autoCloseIdleChats, AUTO_CLOSE_DAYS, AUTO_CLOSE_VISITOR_HOURS } from '@/lib/chat/auto-close';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Called hourly by VPS cron (crontab is not in Git, see AGENTS.md):
//   7 * * * * curl -s -m 120 "http://localhost:3000/api/cron/chat-auto-close?secret=YOUR_SECRET" >> /var/log/chat-auto-close.log 2>&1
// Closes chats that nobody has written in for AUTO_CLOSE_DAYS days (a visitor's chat:
// AUTO_CLOSE_VISITOR_HOURS hours) and whose
// customer is not waiting for an answer (src/lib/chat/auto-close.ts). Sends
// nothing to anyone. ?dry=<anything but 0/false/no> only counts and changes nothing:
// a mistyped flag must not close chats.
export async function GET(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get('secret');
  if (secret !== (process.env.CRON_SECRET || 'shiptrack-cron')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const dry = request.nextUrl.searchParams.get('dry');
  const dryRun = dry !== null && !['0', 'false', 'no'].includes(dry.toLowerCase());
  try {
    const result = await autoCloseIdleChats({ dryRun, days: AUTO_CLOSE_DAYS, visitorHours: AUTO_CLOSE_VISITOR_HOURS });
    if (!dryRun && result.closed > 0) console.log(`[auto-close] closed ${result.closed} quiet chats (${result.waiting} left open: customer waiting; ${result.protected} left open: refund / threat / payment / Needs you)`);
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error('[cron] chat auto-close error:', err);
    return NextResponse.json({ error: 'auto-close failed' }, { status: 500 });
  }
}
