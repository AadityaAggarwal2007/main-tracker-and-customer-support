import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';

// GET /api/support/tickets — list tickets
// POST /api/support/tickets — create ticket manually

export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status') || '';
  const businessId = searchParams.get('businessId') || '';
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '50');
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: unknown[] = [];
  let pi = 1;

  if (status) { conditions.push(`t.status = $${pi++}`); params.push(status); }
  if (businessId) { conditions.push(`t.business_id = $${pi++}`); params.push(businessId); }

  // Restrict to accessible panels
  if (user.businessIds && user.businessIds.length > 0 && !businessId) {
    conditions.push(`t.business_id = ANY($${pi++}::uuid[])`);
    params.push(user.businessIds);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [ticketsResult, countResult] = await Promise.all([
    query<{
      id: string; source: string; status: string; subject: string;
      customer_email: string; customer_name: string; order_id: string;
      last_message_at: string; created_at: string; business_name: string;
      unread_count: number; last_message_preview: string;
    }>(
      `SELECT t.id, t.source, t.status, t.subject, t.customer_email, t.customer_name,
              t.order_id, t.last_message_at, t.created_at,
              b.name as business_name,
              (SELECT COUNT(*) FROM ticket_messages WHERE ticket_id = t.id AND direction = 'inbound') as unread_count,
              (SELECT LEFT(body, 120) FROM ticket_messages WHERE ticket_id = t.id ORDER BY created_at DESC LIMIT 1) as last_message_preview
       FROM support_tickets t
       LEFT JOIN businesses b ON b.id = t.business_id
       ${where}
       ORDER BY t.last_message_at DESC
       LIMIT $${pi} OFFSET $${pi + 1}`,
      [...params, limit, offset]
    ),
    query<{ count: string }>(`SELECT COUNT(*) FROM support_tickets t ${where}`, params),
  ]);

  return NextResponse.json({
    tickets: ticketsResult.rows,
    total: parseInt(countResult.rows[0]?.count || '0'),
  });
}

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { customerEmail, customerName, subject, message, businessId, orderId } = body;

  if (!customerEmail || !message) {
    return NextResponse.json({ error: 'customerEmail and message required' }, { status: 400 });
  }

  const ticket = await queryOne<{ id: string }>(
    `INSERT INTO support_tickets (business_id, source, subject, customer_email, customer_name, order_id)
     VALUES ($1, 'manual', $2, $3, $4, $5)
     RETURNING id`,
    [businessId || null, subject || 'Manual ticket', customerEmail, customerName || '', orderId || null]
  );

  if (!ticket) return NextResponse.json({ error: 'Failed to create ticket' }, { status: 500 });

  await query(
    `INSERT INTO ticket_messages (ticket_id, direction, body, sent_by)
     VALUES ($1, 'inbound', $2, 'manual')`,
    [ticket.id, message]
  );

  return NextResponse.json({ success: true, ticketId: ticket.id });
}
