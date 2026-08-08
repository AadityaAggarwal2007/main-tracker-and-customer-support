import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Called every 2 min by VPS cron:
// */2 * * * * curl -s "https://shiptrack.store/api/cron/support-ingest?secret=YOUR_SECRET" > /dev/null

export async function GET(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get('secret');
  if (secret !== (process.env.CRON_SECRET || 'shiptrack-cron')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Call the ingest endpoint
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
    const resp = await fetch(`${baseUrl}/api/support/ingest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.CRON_SECRET || 'shiptrack-cron'}`,
        'Content-Type': 'application/json',
      },
    });
    const data = await resp.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error('Support ingest cron error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
