import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { queryOne } from '@/lib/db';
import { GoogleGenerativeAI } from '@google/generative-ai';

// POST /api/support/tickets/[id]/ai-draft
// Returns an AI-generated draft reply based on conversation + order context

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // 1. Get ticket + messages
  const ticket = await queryOne<{
    id: string; subject: string; customer_email: string; customer_name: string;
    order_id: string; business_id: string;
  }>(
    `SELECT id, subject, customer_email, customer_name, order_id, business_id
     FROM support_tickets WHERE id = $1`,
    [params.id]
  );
  if (!ticket) return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });

  // 2. Get last few messages for context
  const { query: dbQuery } = await import('@/lib/db');
  const messages = await dbQuery<{ direction: string; body: string; created_at: string }>(
    `SELECT direction, body, created_at FROM ticket_messages
     WHERE ticket_id = $1 ORDER BY created_at DESC LIMIT 6`,
    [params.id]
  );
  const thread = [...messages.rows].reverse();

  // 3. Get order info if linked
  let orderContext = '';
  if (ticket.order_id) {
    const order = await queryOne<{
      tracking_status: string; tracking_id: string; estimated_delivery: string;
      order_total: number; city: string; courier_partner: string;
    }>(
      `SELECT tracking_status, tracking_id, estimated_delivery, order_total, city, courier_partner
       FROM orders WHERE order_id = $1`,
      [ticket.order_id]
    );
    if (order) {
      const deliveryStr = order.estimated_delivery
        ? new Date(order.estimated_delivery).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
        : 'Not available';
      orderContext = `
ORDER DETAILS:
- Order ID: ${ticket.order_id}
- Status: ${order.tracking_status}
- Tracking ID: ${order.tracking_id || 'Not assigned yet'}
- Courier: ${order.courier_partner || 'Not assigned'}
- Estimated Delivery: ${deliveryStr}
- Order Total: ₹${order.order_total}
- City: ${order.city}`;
    }
  }

  // 4. Get business name + AI settings
  const settings = await queryOne<{
    ai_provider: string; ai_api_key: string; ai_model: string; ai_base_url: string;
  }>(
    `SELECT ai_provider, ai_api_key, ai_model, ai_base_url
     FROM support_settings WHERE business_id = $1`,
    [ticket.business_id]
  );

  const biz = await queryOne<{ name: string }>(
    `SELECT name FROM businesses WHERE id = $1`,
    [ticket.business_id]
  );
  const brandName = biz?.name || 'our store';

  // 5. Build conversation string
  const conversationStr = thread
    .map(m => `${m.direction === 'inbound' ? `Customer (${ticket.customer_name})` : 'Support'}: ${m.body}`)
    .join('\n\n');

  const systemPrompt = `You are a helpful, friendly customer support agent for ${brandName}. 
Reply in a warm, professional tone. Keep replies concise (2-4 sentences). 
If you have order details, use them to give specific answers. 
Always end with an offer to help further. 
Write in the same language as the customer. Do NOT include greetings like "Dear" — start with "Hi [name]," naturally.`;

  const userPrompt = `${orderContext ? orderContext + '\n\n' : ''}CONVERSATION:\n${conversationStr}\n\nWrite a helpful reply to the customer's latest message.`;

  try {
    let draftText = '';

    const provider = settings?.ai_provider || 'gemini';
    const apiKey = settings?.ai_api_key || process.env.GEMINI_API_KEY || '';
    const model = settings?.ai_model || 'gemini-1.5-flash';

    if (provider === 'gemini' && apiKey) {
      // Google Gemini
      const genAI = new GoogleGenerativeAI(apiKey);
      const geminiModel = genAI.getGenerativeModel({ model });
      const result = await geminiModel.generateContent(`${systemPrompt}\n\n${userPrompt}`);
      draftText = result.response.text();
    } else if ((provider === 'openai' || provider === 'openrouter') && apiKey) {
      // OpenAI-compatible API (works for OpenAI, OpenRouter, etc.)
      const baseUrl = settings?.ai_base_url || (provider === 'openrouter'
        ? 'https://openrouter.ai/api/v1'
        : 'https://api.openai.com/v1');

      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...(provider === 'openrouter' ? { 'HTTP-Referer': 'https://shiptrack.store' } : {}),
        },
        body: JSON.stringify({
          model: model || (provider === 'openrouter' ? 'openai/gpt-4o-mini' : 'gpt-4o-mini'),
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 400,
          temperature: 0.7,
        }),
      });
      const data = await resp.json();
      draftText = data.choices?.[0]?.message?.content || '';
    } else {
      return NextResponse.json(
        { error: 'No AI API key configured. Go to Support Settings to add one.' },
        { status: 400 }
      );
    }

    return NextResponse.json({ draft: draftText.trim() });
  } catch (err) {
    console.error('AI draft error:', err);
    return NextResponse.json({ error: 'AI generation failed: ' + String(err) }, { status: 500 });
  }
}
