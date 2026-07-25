import { NextRequest, NextResponse } from 'next/server';
import { sendBatchEmails } from '@/lib/gmail-client';

export const dynamic = 'force-dynamic';

// Diagnostic endpoint to test the email sending chain
export async function GET(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key') || '';
  const secret = process.env.DRAFT_QUEUE_SECRET || '';
  if (!secret || key !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const scriptUrl = process.env.GMAIL_SCRIPT_URL || '';
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || '';

  // Test 1: Check if GMAIL_SCRIPT_URL is configured
  if (!scriptUrl) {
    return NextResponse.json({
      status: 'FAILED',
      issue: 'GMAIL_SCRIPT_URL is NOT set in Vercel environment variables',
      scriptUrl: '(empty)',
      baseUrl,
    });
  }

  // Test 2: Try to send a test email via the script
  try {
    const result = await sendBatchEmails([
      {
        to: 'test-diagnostic@example.com',
        subject: 'ShipTrack Diagnostic Test',
        html: '<p>This is a diagnostic test email. If you see this, email sending works!</p>',
      },
    ]);

    return NextResponse.json({
      status: result.sent > 0 ? 'OK' : 'FAILED',
      scriptUrl: scriptUrl.substring(0, 50) + '...',
      baseUrl,
      sendResult: result,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({
      status: 'ERROR',
      scriptUrl: scriptUrl.substring(0, 50) + '...',
      baseUrl,
      error: String(err),
      timestamp: new Date().toISOString(),
    });
  }
}
