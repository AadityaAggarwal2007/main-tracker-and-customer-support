import { query } from '@/lib/db';
import { orderCandidates, orderForms } from '@/lib/chargeback/parse';
import { looksLikeAddress, lowerEmail } from './mail-verify';

// ── Automatic verification of a Gmail sender (owner 2026-10-08) ───────────────────────────────
// Owner: "jis customer ne order id di hai aur uski email aayi hai to ... apne aap verified; email + order number
// de diya to wo bhi; baaki team verify kare". Three steps, the third is the Verify button (mail-verify.ts):
//   1. the sender's address is the email written on an order of THIS panel (orders.customer_email)
//      -> verified for that customer's latest order ('Email match');
//   2. the mail also NAMES an order number that belongs to that same email -> verified for that order
//      ('Email + order number');
//   3. anything else waits for a team member (Order ID + full phone).
// A forged From would otherwise be enough, so this only runs when Gmail itself wrote dmarc=pass in the mail's own
// headers (mail-view.ts gmailAuthPassed); without it the sender stays "Not verified" for the team step.
// This is the owner's exception for the mail channel to master rules 8.1 / 9 (the rules file itself is untouched).
// A sender the team has already Removed is never verified again (the removed row stays and blocks it).
// Rows are written as verified_by 'auto' with the basis as the name; the sender's email chats become verified
// with verified_via 'mail_auto' (not strict proof: no automatic Refund promise). No SQL change: mail-verify.sql.

export interface AutoCandidate { email: string; authPass: boolean; subject?: string; text?: string }

const missingTable = (e: unknown) => (e as { code?: string })?.code === '42P01';
export const AUTO_BY = 'auto';
export const BASIS_EMAIL = 'Email match';
export const BASIS_ORDER = 'Email + order number';

export interface AutoPlan { email: string; orders: string[]; basis: string }

// Pure: which orders each sender verifies, given the orders written with that email (newest first).
export function planAutoVerify(cands: AutoCandidate[], ordersByEmail: Record<string, string[]>): AutoPlan[] {
  const out: AutoPlan[] = [];
  const seen = new Set<string>();
  for (const c of cands) {
    const email = lowerEmail(c.email);
    if (!c.authPass || !looksLikeAddress(email) || seen.has(email)) continue;
    const mine = ordersByEmail[email] || [];
    if (mine.length === 0) continue;
    const named = orderForms(orderCandidates(c.subject || '', c.text || ''));
    const hit = mine.filter(o => named.includes(o)).slice(0, 3);
    seen.add(email);
    out.push(hit.length > 0 ? { email, orders: hit, basis: BASIS_ORDER } : { email, orders: [mine[0]], basis: BASIS_EMAIL });
  }
  return out;
}

// Writes the verifications that are new and moves the sender's email chats; returns the plans that added something.
export async function autoVerifySenders(businessId: string | null, cands: AutoCandidate[]): Promise<AutoPlan[]> {
  const eligible = Array.from(new Set(cands.filter(c => c.authPass).map(c => lowerEmail(c.email)).filter(looksLikeAddress)));
  if (!businessId || eligible.length === 0) return [];
  try {
    const r = await query<{ email: string; order_id: string }>(
      `SELECT lower(customer_email) AS email, order_id FROM orders
        WHERE business_id::text = $1::text AND lower(customer_email) = ANY($2::text[])
        ORDER BY created_at DESC`,
      [businessId, eligible]
    );
    // A sender the team has Removed once is never verified by itself again.
    const vetoed = new Set((await query<{ email: string }>(
      `SELECT DISTINCT email FROM mail_verifications WHERE business_id = $1 AND removed_at IS NOT NULL AND email = ANY($2::text[])`,
      [businessId, eligible]
    )).rows.map(x => x.email));
    const byEmail: Record<string, string[]> = {};
    for (const row of r.rows) {
      if (vetoed.has(row.email)) continue;
      const list = (byEmail[row.email] ??= []);
      if (!list.includes(row.order_id)) list.push(row.order_id);
    }
    const added: AutoPlan[] = [];
    for (const plan of planAutoVerify(cands, byEmail)) {
      const fresh: string[] = [];
      for (const orderId of plan.orders) {
        const ins = await query(
          `INSERT INTO mail_verifications (business_id, email, order_id, verified_by, verified_by_name)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (business_id, email, order_id) DO NOTHING`,
          [businessId, plan.email, orderId, AUTO_BY, plan.basis]
        );
        if ((ins.rowCount ?? 0) > 0) fresh.push(orderId);
      }
      if (fresh.length === 0) continue;
      await query(
        `UPDATE conversations c SET verified_order_id = $1, verified_at = now(), verified_via = 'mail_auto'
           FROM sites s
          WHERE s.id = c.site_id AND s.tracker_business_id::text = $2::text
            AND c.source = 'email' AND c.visitor_id = $3 AND c.merged_into IS NULL AND c.verified_order_id IS NULL`,
        [fresh[0], businessId, `email:${plan.email}`]
      );
      added.push({ ...plan, orders: fresh });
    }
    return added;
  } catch (e) {
    if (!missingTable(e)) console.error('[mail] auto verify:', (e as Error).message);
    return [];
  }
}
