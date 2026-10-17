// Payments > Brand Directory (owner 2026-10-17): the two routes' shared checks and error answers.
import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { isSuperAdmin } from '@/lib/permissions';
import { DUPLICATE_ERROR, NEEDS_UPDATE_ERROR, NOT_INSTALLED_ERROR } from '@/lib/brand-directory-rules';
import { Duplicate, NeedsUpdate, NotInstalled } from '@/lib/brand-directory';

// The Super Admin only: 401 not logged in, 403 anyone else (a Manager or a team member too).
export function superAdminOnly(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return { res: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (!isSuperAdmin(user)) return { res: NextResponse.json({ error: 'Only the Super Admin can open Payments' }, { status: 403 }) };
  return { user };
}

// 503 before brand-directory.sql is run (or before its second run: the colour / fields / order columns), 409 the old
// unique name key, else 500 with no database detail (the log has it).
export function failed(e: unknown, what: string) {
  if (e instanceof NotInstalled) return NextResponse.json({ error: NOT_INSTALLED_ERROR, notInstalled: true }, { status: 503 });
  if (e instanceof NeedsUpdate) return NextResponse.json({ error: NEEDS_UPDATE_ERROR, notInstalled: true }, { status: 503 });
  if (e instanceof Duplicate) return NextResponse.json({ error: DUPLICATE_ERROR, fields: { brandName: DUPLICATE_ERROR } }, { status: 409 });
  console.error(`[brand-directory] ${what}:`, (e as Error)?.message);
  return NextResponse.json({ error: 'Could not reach the database right now. Please try again.' }, { status: 500 });
}
