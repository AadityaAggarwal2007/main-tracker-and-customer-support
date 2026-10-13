import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { chatForCorrection } from '@/lib/chat/corrections';

export const dynamic = 'force-dynamic';

// POST /api/corrections/:id/chat: the verified chat to edit this correction's order from (corrections.ts
// chatForCorrection; owner 2026-10-13: a Mail correction showed "No chat to edit the order from"). chat.view +
// orders.update, inside the login's panels, a pending row. Answers {chatId}. Nothing is sent to the customer.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const r = await chatForCorrection(user, params.id);
    if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ chatId: r.value.chatId });
  } catch (e) {
    console.error('[correction] chat error:', (e as Error)?.message);
    return NextResponse.json({ error: 'Could not open a chat for this order right now' }, { status: 500 });
  }
}
