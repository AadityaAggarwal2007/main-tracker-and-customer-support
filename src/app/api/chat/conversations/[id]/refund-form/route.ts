import { NextRequest, NextResponse } from 'next/server';
import { authReady, getAuthFromRequest, type AuthUser } from '@/lib/auth';
import { isSuperAdmin } from '@/lib/permissions';
import { actionError } from '@/lib/chat/team-routing';
import { ajson } from '@/lib/refund/public';
import { adminFailure, cancelRefundLink, refundFormState, retryFormEmail, sendRefundForm, type Res } from '@/lib/refund/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ── The Super Admin's "Send refund form" (owner, 2026-10-02) ────
// Only the Super Admin sends the refund form, and only from a chat in the Refund section
// (conversations.case_kind = 'refund', checked again on the LOCKED chat row). The link goes into the
// chat as "Vastora Support" (messages.sender = 'system'; an email chat also gets it as an email reply).
// Sending never claims the chat: holder, status and unread stay as they are.
//   GET     the Send dialog: blocks, warnings, the exact text with the link masked
//   POST    {lang, replace, expectLinkId}: send (pressing again while a link is open needs replace + its id)
//           {action: 'retry_email', linkId}: the open link's form email again, when it failed (email chats)
//   DELETE  Cancel link: the open link stops working; nothing is sent to the customer
// No other screen, route, AI tool or template can make a link. Spec refund_form_spec.md 3.2.

type Gate = { user: AuthUser; deny: null } | { user: null; deny: NextResponse };
async function gate(request: NextRequest): Promise<Gate> {
  // A Super Admin token is refused until the logins are read after a restart: wait for them.
  await authReady();
  const user = getAuthFromRequest(request);
  if (!user) return { user: null, deny: ajson({ error: 'Please log in again' }, 401) };
  if (!isSuperAdmin(user)) return { user: null, deny: ajson({ error: 'Only the Super Admin can send the refund form' }, 403) };
  return { user, deny: null };
}
const send = (r: Res) => ajson(r.body, r.status);
const convId = (params: { id?: string } | undefined) => String(params?.id || '');

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const g = await gate(request);
  if (g.deny) return g.deny;
  try {
    return send(await refundFormState(convId(params), g.user));
  } catch (e) {
    return send(adminFailure('form state', e));
  }
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const g = await gate(request);
  if (g.deny) return g.deny;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return ajson({ error: 'Send a JSON body' }, 400);
  }
  try {
    const retry = !!body && typeof body === 'object' && (body as { action?: unknown }).action === 'retry_email';
    return send(await (retry ? retryFormEmail(g.user, convId(params), body) : sendRefundForm(g.user, convId(params), body)));
  } catch (e) {
    // A busy chat lock (55P03 / deadlock) or a merged / changed chat: the team-routing answer.
    const a = actionError(e);
    if (a) {
      a.headers.set('Cache-Control', 'no-store');
      return a;
    }
    return send(adminFailure('form send', e));
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const g = await gate(request);
  if (g.deny) return g.deny;
  try {
    return send(await cancelRefundLink(convId(params), g.user));
  } catch (e) {
    return send(adminFailure('form cancel', e));
  }
}
