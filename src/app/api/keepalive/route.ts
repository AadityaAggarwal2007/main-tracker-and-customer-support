import { NextResponse } from 'next/server';
import { queryCount } from '@/lib/db';

// Keep-alive / health-check endpoint
// No longer needed for Supabase pause prevention, but useful for monitoring
export async function GET() {
  try {
    const count = await queryCount('SELECT COUNT(*) FROM orders');

    return NextResponse.json({
      ok: true,
      orders: count,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({ error: 'Health check failed' }, { status: 500 });
  }
}
