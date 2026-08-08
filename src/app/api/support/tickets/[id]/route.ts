import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';

// GET /api/support/tickets/[id] — full thread
// PATCH /api/support/tickets/[id] — update status / order_id

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const ticket = await queryOne<{
    id: string; source: string; status: string; subject: string;
    customer_email: string; customer_name: string; order_id: string;
    last_message_at: string; created_at: string; business_id: string; business_name: string;
  }>(
    `SELECT t.*, b.name as business_name
     FROM support_tickets t
     LEFT JOIN businesses b ON b.id = t.business_id
     WHERE t.id = $1`,
    [params.id]
  );

  if (!ticket) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const messages = await query<{
    id: string; direction: string; body: string;
    is_ai_generated: boolean; sent_by: string; created_at: string;
  }>(
    `SELECT id, direction, body, is_ai_generated, sent_by, created_at
     FROM ticket_messages
     WHERE ticket_id = $1
     ORDER BY created_at ASC`,
    [params.id]
  );

  // If order_id detected, fetch order info
  let order = null;
  if (ticket.order_id) {
    order = await queryOne(
      `SELECT order_id, customer_name, tracking_status, tracking_id, estimated_delivery, order_total
       FROM orders WHERE order_id = $1`,
      [ticket.order_id]
    );
  }

  return NextResponse.json({ ticket, messages: messages.rows, order });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { status, orderId, customerName } = body;

  const sets: string[] = ['updated_at = NOW()'];
  const values: unknown[] = [];
  let pi = 1;

  if (status) { sets.push(`status = $${pi++}`); values.push(status); }
  if (orderId !== undefined) { sets.push(`order_id = $${pi++}`); values.push(orderId || null); }
  if (customerName) { sets.push(`customer_name = $${pi++}`); values.push(customerName); }

  values.push(params.id);

  await query(
    `UPDATE support_tickets SET ${sets.join(', ')} WHERE id = $${pi}`,
    values
  );

  return NextResponse.json({ success: true });
}
