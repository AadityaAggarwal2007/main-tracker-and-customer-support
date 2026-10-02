import { NextRequest } from 'next/server';
import { SUBMIT_MAX, badToken, pjson, publicGuard, tokenFromBody } from '@/lib/refund/public';
import { publicFailure, submitRefund } from '@/lib/refund/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ── POST /api/refund/submit (owner, 2026-10-02) ─────────────────
// The customer sends the refund form once: reason, details, photos / video (already uploaded) and the
// UPI ID or bank account to refund to (owner answer Q1: every order, COD and prepaid). The order ID,
// name and phone are NEVER read from the body: they come from the link (master rule 30). The UPI /
// bank details are encrypted before any SQL and never logged. A retry with the same client_nonce
// gets the same answer. The "form received" message follows in its own transaction (server.ts). The
// error line carries codes only, never the body. Spec 3.1.
export async function POST(request: NextRequest) {
  try {
    const g = await publicGuard(request, { kind: 'json', max: SUBMIT_MAX });
    if (g.res) return g.res;
    const hash = tokenFromBody(g.json);
    if (!hash) return badToken(g.ip);
    const r = await submitRefund(hash, g.ip, request.headers.get('user-agent'), g.json || {});
    return pjson(r.body, r.status);
  } catch (e) {
    const r = publicFailure('submit', e);
    return pjson(r.body, r.status);
  }
}
