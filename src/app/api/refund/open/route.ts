import { NextRequest } from 'next/server';
import { OPEN_MAX, badToken, pjson, publicGuard, tokenFromBody } from '@/lib/refund/public';
import { openLink, publicFailure } from '@/lib/refund/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ── POST /api/refund/open {token} (owner, 2026-10-02) ─────────
// The customer's refund form page (/refund) asks what its link shows: the locked order block and the
// uploads so far (open), the status view (submitted, 90 days), or why it cannot be used (expired,
// replaced, cancelled, used). No login: the link's token (from the URL fragment, sent in this POST
// body, never in a URL) is the only key. A bad or unknown token is the same 404 {state:'invalid'}.
// Same origin only, no CORS (public.ts); never under /api/widget/*. Spec refund_form_spec.md 3.1.
export async function POST(request: NextRequest) {
  try {
    const g = await publicGuard(request, { kind: 'json', max: OPEN_MAX });
    if (g.res) return g.res;
    const hash = tokenFromBody(g.json);
    if (!hash) return badToken(g.ip);
    const r = await openLink(hash, g.ip, request.headers.get('user-agent'));
    return pjson(r.body, r.status);
  } catch (e) {
    const r = publicFailure('open', e);
    return pjson(r.body, r.status);
  }
}
