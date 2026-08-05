import { NextRequest, NextResponse } from 'next/server';
import { sendEmailDirect } from '@/lib/smtp-client';

export const dynamic = 'force-dynamic';

// Diagnostic endpoint to test the email sending chain
export async function GET(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key') || '';
  const secret = process.env.DRAFT_QUEUE_SECRET || '';
  if (!secret || key !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const gmailUser = process.env.GMAIL_USER || '';
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || '';

  // Test 1: Check if GMAIL_USER is configured
  if (!gmailUser) {
    return NextResponse.json({
      status: 'FAILED',
      issue: 'GMAIL_USER is NOT set in environment variables',
      gmailUser: '(empty)',
      baseUrl,
    });
  }

  // Test 2: Try to send a test email via SMTP
  try {
    const result = await sendEmailDirect([
      {
        to: 'test-diagnostic@example.com',
        subject: 'ShipTrack Diagnostic Test',
        html: '<p>This is a diagnostic test email. If you see this, email sending works!</p>',
      },
    ]);

    return NextResponse.json({
      status: result.sent > 0 ? 'OK' : 'FAILED',
      gmailUser,
      baseUrl,
      sendResult: result,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({
      status: 'ERROR',
      gmailUser,
      baseUrl,
      error: String(err),
      timestamp: new Date().toISOString(),
    });
  }
}
