import { queryOne } from '@/lib/db';

// ── Visitor or customer? ───────────────────────────────────────
// Owner's rule (2026-09-30): only a VERIFIED customer (order ID + phone proved, or an
// old phone match) can be handed to the team (Needs you) by the system. A visitor
// who has not verified stays in Visitors: nothing moves them to Needs you, and the
// fixed "our team will reply" lines are not sent to them (nobody could be told which
// order or which customer it is). Same test as the inbox's Visitors / Customers
// split. On a database error it answers "verified", i.e. behaves as before, so a
// hiccup never stops a customer's chat reaching the team.
export async function chatIsVerified(conversationId: string): Promise<boolean> {
  try {
    const row = await queryOne<{ v: boolean }>(
      `SELECT (verified_order_id IS NOT NULL OR phone_match_order_id IS NOT NULL) AS v FROM conversations WHERE id = $1`,
      [conversationId]
    );
    return !!row?.v;
  } catch (err) {
    console.error('[chat] could not read the verified state:', (err as Error).message);
    return true;
  }
}
