import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { pollAllMailboxes } from '@/lib/chat/email';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Called every minute by VPS cron:
//   * * * * * curl -s "http://localhost:3000/api/cron/chat-email-poll?secret=YOUR_SECRET" > /dev/null
//
// A sweep across several mailboxes can easily outlast a minute, and two
// overlapping sweeps would each see the same unread mail and answer it twice.
// A session-level advisory lock makes the second run a no-op instead. The lock
// dies with its connection, so a crashed run cannot wedge the poller forever.
const LOCK_KEY = 8_123_401; // arbitrary, must stay stable

export async function GET(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get('secret');
  if (secret !== (process.env.CRON_SECRET || 'shiptrack-cron')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const client = await getPool().connect();
  try {
    const lock = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock($1) AS locked`,
      [LOCK_KEY]
    );

    if (!lock.rows[0]?.locked) {
      return NextResponse.json({ skipped: 'previous sweep still running' });
    }

    try {
      const result = await pollAllMailboxes();
      return NextResponse.json({ success: true, ...result });
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY]);
    }
  } catch (err) {
    console.error('[cron] chat email poll error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    client.release();
  }
}
