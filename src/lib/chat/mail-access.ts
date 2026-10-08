import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest, type AuthUser } from '@/lib/auth';
import { can } from '@/lib/permissions';
import { mailboxFor, MailError, type MailBoxInfo } from './mail-inbox';

// ── Who may use the Mail tab (owner 2026-10-08) ───────────────────────────────────────────────
// The Super Admin always. A team member only with the Mail ticks (mail.view to read, mail.reply to send;
// no role has them by itself) and only for the panels they are limited to. Every /api/mail/* route goes
// through here, so the panel check cannot be skipped by a route.

export type MailNeed = 'view' | 'reply';

export function mailUser(request: NextRequest, need: MailNeed = 'view'): { user: AuthUser } | { error: NextResponse } {
  const user = getAuthFromRequest(request);
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const ok = need === 'reply' ? can(user, 'mail.view') && can(user, 'mail.reply') : can(user, 'mail.view');
  if (!ok) return { error: NextResponse.json({ error: 'You do not have access to Mail.' }, { status: 403 }) };
  return { user };
}

// The login plus ONE mailbox it may open; a mailbox of another panel looks exactly like a missing one.
export async function mailAccess(request: NextRequest, boxId: string | null, need: MailNeed = 'view') {
  const a = mailUser(request, need);
  if ('error' in a) return a;
  const box = await mailboxFor(a.user, boxId || '');
  if (!box) return { error: NextResponse.json({ error: 'Mailbox not found.' }, { status: 404 }) };
  return { user: a.user, box };
}

export function mailFail(err: unknown): NextResponse {
  if (err instanceof MailError) return NextResponse.json({ error: err.message }, { status: err.status });
  console.error('[mail] error:', (err as Error)?.message);
  return NextResponse.json({ error: 'Something went wrong with Mail. Try again.' }, { status: 500 });
}

export type { MailBoxInfo };
