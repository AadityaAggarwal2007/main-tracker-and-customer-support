import { NextRequest, NextResponse } from 'next/server';
import { authReady, getAuthFromRequest } from '@/lib/auth';
import { can, isSuperAdmin } from '@/lib/permissions';
import { errorReply, getItems, isMetric, parseRange } from '@/lib/team-score/report';

export const dynamic = 'force-dynamic';

// ── Team score drill-down (owner, 2026-10-01, part 4) ───────────
// GET ?from&to&person&metric: the rows behind one number of the leaderboard, each with its
// plain-English reason and the masked message lines (src/lib/team-score/report.ts getItems).
// person = a team member's key, 'owner', or 'ai' (thank-yous after the AI's answers). The Super Admin
// may ask for anyone; a member who can reply (chat.reply) only for themselves (owner answer A1,
// 2026-10-02): any other person, 'owner' or 'ai' is 403.

// deny: the answer to send instead. self: null = the Super Admin (everyone); a member's own key
// (team_users.id) = only their own row.
interface Viewer { deny: NextResponse | null; self: string | null }
// A refusal's self is '' (nobody), never null, so a missed deny check can never show everything.
const refuse = (error: string, status: number): Viewer => ({ deny: NextResponse.json({ error }, { status }), self: '' });
async function viewer(request: NextRequest): Promise<Viewer> {
  await authReady();
  const user = getAuthFromRequest(request);
  if (!user) return refuse('Please log in again', 401);
  if (isSuperAdmin(user)) return { deny: null, self: null };
  if (can(user, 'team.lead')) return { deny: null, self: null };   // the Manager sees the whole team (owner 2026-10-10)
  if (!can(user, 'chat.reply')) return refuse('Only team members who reply to chats have a score', 403);
  if (!user.id) return refuse('Please log in again', 401);
  return { deny: null, self: String(user.id) };
}

const PERSON_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function GET(request: NextRequest) {
  const who = await viewer(request);
  if (who.deny) return who.deny;
  const sp = new URL(request.url).searchParams;
  const range = parseRange(sp.get('from'), sp.get('to'), Date.now());
  if ('error' in range) return NextResponse.json({ error: range.error }, { status: 400 });
  const metric = sp.get('metric');
  if (!isMetric(metric)) return NextResponse.json({ error: 'Unknown metric' }, { status: 400 });
  const person = (sp.get('person') || '').trim();
  if (!PERSON_RE.test(person)) return NextResponse.json({ error: 'Unknown person' }, { status: 400 });
  if (who.self !== null && person !== who.self) return NextResponse.json({ error: 'You can see only your own score' }, { status: 403 });
  try {
    const body = await getItems(range.from, range.to, person, metric);
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const e = errorReply(err, 'GET items');
    return NextResponse.json(e.body, { status: e.status });
  }
}
