// ── One-off, READ ONLY: which open chats the "fake / invalid tracking" move would take ──
// Owner 2026-10-02 (answer 5): open, verified chats whose customer already said the tracking ID / link is
// invalid, fake, shows another order, does not open or is stuck move to Ship again ONCE, with no message to
// anyone. This script only LISTS them for the lead's review; it writes nothing (one BEGIN READ ONLY
// transaction, rolled back). The move itself is chat-tracking-reship-move.sql, filled with the reviewed ids.
// Run on the server AFTER the tracking-claim code is deployed:
//   ssh shiptrack-vps 'cd /var/www/tracker && node scripts/tracking-reship-candidates.js'
//
// Same rules as the live code, not a copy: the detector (trackingClaimKind), the other-order guard
// (mentionsOtherOrder) and the stage (claimStage) are loaded from the app's own src/lib/chat/tracking-claim.ts,
// and the order's stage from src/lib/journey.ts (buildJourney + JOURNEY, as toFoundOrder in orders.ts does),
// all transpiled in memory. A message counts the way the live widget route would act on it:
//   - a tracking claim (trackingClaimKind) in a customer message,
//   - not a threat (urgentKind = 'threat': the threat wins, Needs you, spec 2.2 row 0),
//   - not a refund, cancel or payment request in the same message (routineHandOverKind: it wins, the
//     live route sends it to the team with no promise and no mark, case-auto.ts trackingClaimTurn),
//   - not about another order than the verified one (spec 1.6; no stored tool result is read here).
// A chat is a candidate when it has such a message, its verified order is dispatched and not delivered
// (stage in_transit: Shipped .. Out for Delivery) and the same order is not already in Ship again in another
// chat (live: spec 2.2 row 12, never a second mark). Pre-dispatch, delivered, other and not-loadable orders
// are only counted.
//
// /etc/tracker/.env is read into memory and never printed. Prints only chat ids, statuses, stages, claim
// kinds, counts, times and subject labels: no names, phones, order IDs or message text (AGENTS.md).

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ts = require(path.join(ROOT, 'node_modules/typescript'));

// Loads one of the app's pure TS files and the app files it imports ('@/lib/...', './...').
const loaded = new Map();
function loadTs(file) {
  if (loaded.has(file)) return loaded.get(file).exports;
  const mod = { exports: {} };
  loaded.set(file, mod);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const req = (spec) => {
    if (spec.startsWith('@/')) return loadTs(path.join(ROOT, 'src', spec.slice(2) + '.ts'));
    if (spec.startsWith('./') || spec.startsWith('../')) return loadTs(path.resolve(path.dirname(file), spec + '.ts'));
    throw new Error(`${path.relative(ROOT, file)} imports '${spec}': only the app's own pure files can be loaded here`);
  };
  new Function('module', 'exports', 'require', js)(mod, mod.exports, req);
  return mod.exports;
}

const C = loadTs(path.join(ROOT, 'src/lib/chat/tracking-claim.ts'));
const J = loadTs(path.join(ROOT, 'src/lib/journey.ts'));
const E = loadTs(path.join(ROOT, 'src/lib/chat/escalation.ts'));
for (const [name, fn] of [['trackingClaimKind', C.trackingClaimKind], ['claimStage', C.claimStage],
  ['mentionsOtherOrder', C.mentionsOtherOrder], ['buildJourney', J.buildJourney], ['urgentKind', E.urgentKind],
  ['routineHandOverKind', E.routineHandOverKind]]) {
  if (typeof fn !== 'function') throw new Error(`${name} is missing from the app code`);
}

// Open chats, verified by order ID + full phone (the two strict proofs), not marked, never taken out of
// Ship again before (live: spec 2.2 row 11, no auto mark again).
const CHATS_SQL = `
  SELECT c.id, c.site_id, c.status, (c.assigned_to IS NOT NULL) AS held, c.verified_order_id, c.subject_label,
         s.tracker_business_id,
         EXISTS (SELECT 1 FROM conversations o
                  WHERE o.site_id = c.site_id AND o.id <> c.id AND o.merged_into IS NULL
                    AND o.case_kind = 'reship' AND o.case_order_id = c.verified_order_id) AS order_in_ship_again
    FROM conversations c JOIN sites s ON s.id = c.site_id
   WHERE c.status <> 'resolved' AND c.merged_into IS NULL AND c.source = 'chat' AND c.case_kind IS NULL
     AND c.verified_order_id IS NOT NULL AND c.verified_via IN ('form', 'chat_phone')
     AND NOT EXISTS (SELECT 1 FROM chat_case_events e
                      WHERE e.conversation_id = c.id AND e.kind = 'reship' AND e.action = 'remove')
   ORDER BY c.id`;

// messages.created_at is a timestamp without time zone written in UTC: epoch ms read in SQL, so the
// Node process's time zone cannot shift it.
const VISITOR_SQL = `
  SELECT conversation_id, content, (extract(epoch FROM created_at) * 1000)::float8 AS t
    FROM messages
   WHERE conversation_id = ANY($1::text[]) AND sender = 'visitor' AND deleted_at IS NULL
     AND content IS NOT NULL AND btrim(content) <> ''
   ORDER BY conversation_id, created_at, id`;
const LAST_TEAM_SQL = `
  SELECT conversation_id, (extract(epoch FROM max(created_at)) * 1000)::float8 AS t
    FROM messages
   WHERE conversation_id = ANY($1::text[]) AND sender = 'agent' AND deleted_at IS NULL
   GROUP BY conversation_id`;

// The verified order as the live code finds it (lookupVerifiedOrder in orders.ts: the site's panel, or any
// panel when the site has none; exactly one match, else not loadable), with the columns buildJourney reads
// (the same ones order-facts.ts reads).
const ORDER_SQL = `
  SELECT o.tracking_status, o.is_cancelled, o.created_at, o.status_updated_at, o.estimated_delivery,
         o.delivered_at, o.state, o.city, b.origin_city
    FROM orders o
    LEFT JOIN businesses b ON b.id = o.business_id
   WHERE o.order_id = $1
     AND ($2::text IS NULL OR o.business_id::text = $2::text)
   LIMIT 2`;

const IST = (ms) => new Date(ms).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});

// The stage the live code uses: the tracking page's stage name for a normal order, the stored wording
// for cancelled / RTO / failed (toFoundOrder, orders.ts), then claimStage.
function stageOf(row) {
  if (!row) return { stage: 'not_loadable', name: null };
  const journey = J.buildJourney(row);
  const status = journey.mode === 'normal' && journey.currentIndex >= 0 ? J.JOURNEY[journey.currentIndex].status : row.tracking_status;
  return { stage: C.claimStage({ status, cancelled: row.is_cancelled }), name: status };
}

async function run(client) {
  const chats = (await client.query(CHATS_SQL)).rows;
  const ids = chats.map((c) => c.id);
  const visitor = new Map();
  const lastTeam = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    for (const m of (await client.query(VISITOR_SQL, [part])).rows) {
      if (!visitor.has(m.conversation_id)) visitor.set(m.conversation_id, []);
      visitor.get(m.conversation_id).push(m);
    }
    for (const r of (await client.query(LAST_TEAM_SQL, [part])).rows) lastTeam.set(r.conversation_id, Number(r.t));
  }

  const counts = { in_transit: 0, pre_dispatch: 0, delivered: 0, other: 0, not_loadable: 0 };
  let withClaim = 0, noUsable = 0, threatOnly = 0, routineOnly = 0, otherOrderOnly = 0, sameOrder = 0;
  const rows = [];
  for (const c of chats) {
    const hits = [];
    let threat = 0, routine = 0, otherOrder = 0;
    for (const m of visitor.get(c.id) || []) {
      const kind = C.trackingClaimKind(m.content);
      if (!kind) continue;
      if (E.urgentKind(m.content) === 'threat') { threat++; continue; }
      if (E.routineHandOverKind(m.content)) { routine++; continue; }
      if (C.mentionsOtherOrder(m.content, c.verified_order_id, null)) { otherOrder++; continue; }
      hits.push({ kind, t: Number(m.t) });
    }
    if (!hits.length && !threat && !routine && !otherOrder) continue;
    withClaim++;
    if (!hits.length) {
      noUsable++;
      const why = (threat ? 1 : 0) + (routine ? 1 : 0) + (otherOrder ? 1 : 0);
      if (why === 1 && threat) threatOnly++;
      else if (why === 1 && routine) routineOnly++;
      else if (why === 1) otherOrderOnly++;
      continue;
    }
    const orderRows = (await client.query(ORDER_SQL, [c.verified_order_id, c.tracker_business_id || null])).rows;
    const { stage, name } = stageOf(orderRows.length === 1 ? orderRows[0] : null);
    counts[stage] = (counts[stage] || 0) + 1;
    if (stage !== 'in_transit') continue;
    if (c.order_in_ship_again) { sameOrder++; continue; }
    const last = hits[hits.length - 1];
    const team = lastTeam.get(c.id);
    rows.push({
      id: c.id, status: c.status, held: !!c.held, stage: name, claim: last.kind, hits: hits.length,
      last_hit: IST(last.t), team_replied_after_last_hit: team != null && team > last.t,
      subject: c.subject_label || '-',
    });
  }
  return { checked: chats.length, withClaim, noUsable, threatOnly, routineOnly, otherOrderOnly, sameOrder, counts, rows };
}

function report(r) {
  console.log(`Open verified chats checked: ${r.checked} (not marked, verified by order ID + full phone, never removed from Ship again)`);
  console.log(`Chats with a tracking claim in a customer message: ${r.withClaim}`);
  console.log(`  no claim the live code would act on: ${r.noUsable} (only with a threat: ${r.threatOnly}; only with a refund / payment request with the claim: ${r.routineOnly}; only about another order: ${r.otherOrderOnly}; more than one of these: ${r.noUsable - r.threatOnly - r.routineOnly - r.otherOrderOnly})`);
  const k = r.counts;
  console.log(`  by order stage: in transit ${k.in_transit}, not dispatched ${k.pre_dispatch}, delivered ${k.delivered}, other (cancelled / RTO / failed) ${k.other}, order not loadable ${k.not_loadable}`);
  console.log(`  in transit but the same order is already in Ship again in another chat (left out): ${r.sameOrder}`);
  console.log('');
  console.log(`Candidates (in transit): ${r.rows.length}`);
  if (!r.rows.length) console.log('Nothing to move: do not apply chat-tracking-reship-move.sql.');
  if (r.rows.length) {
    console.log(['id', 'status', 'held', 'stage', 'claim', 'hits', 'last_hit_IST', 'team_replied_after_last_hit', 'subject_label'].join(' | '));
    for (const x of r.rows) {
      console.log([x.id, x.status, x.held ? 'held' : '-', x.stage, x.claim, x.hits, x.last_hit, x.team_replied_after_last_hit ? 'YES' : 'no', x.subject].join(' | '));
    }
    console.log('');
    console.log('Review first (spec 6.2): a held chat or team_replied_after_last_hit = YES may already be handled by a person.');
    console.log('Reviewed list for chat-tracking-reship-move.sql (and the undo file):');
    console.log(r.rows.map((x) => `('${x.id}')`).join(', '));
  }
}

async function main() {
  let url = null;
  try {
    for (const line of fs.readFileSync('/etc/tracker/.env', 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && m[1] === 'DATABASE_URL') url = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* not on the server: the environment below */ }
  url = url || process.env.DATABASE_URL || null;
  if (!url) { console.log('DATABASE_URL missing (/etc/tracker/.env or the environment)'); process.exit(1); }

  const { Pool } = require(path.join(ROOT, 'node_modules/pg'));
  const pool = new Pool({ connectionString: url, max: 1, ssl: false });
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '60s'`);
    report(await run(client));
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => { console.error('tracking-reship-candidates failed:', err && err.message); process.exit(1); });
} else {
  module.exports = { run, report, stageOf };
}
