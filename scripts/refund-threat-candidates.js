// ── One-off: which chats the "threat on a late order -> Refund" rule would take, and the approved move ──
// Owner 2026-10-02 18:45 (after a consumer-department threat that staff had closed): a VERIFIED customer (order ID + full phone) who
// threatens a chargeback, a consumer court / complaint, the police / cyber cell or a legal notice, and whose
// order's estimated date has passed, goes to Refund with "we are processing your refund, our team will send
// you a refund form in this chat". For the chats that already exist: "list first, move only after his OK".
//
//   1. LIST (read only: one BEGIN READ ONLY transaction, rolled back; writes nothing):
//        ssh shiptrack-vps 'cd /var/www/tracker && node scripts/refund-threat-candidates.js [--days 7]'
//   2. MOVE only the chat ids the owner approved from that list (never without ids):
//        ssh shiptrack-vps 'cd /var/www/tracker && node scripts/refund-threat-candidates.js --apply <id> [<id> ...] [--days 7]'
//      Each id is checked again by the live rule and moved by the app's OWN server functions
//      (src/lib/chat/case-auto.ts applyRefundThreatMove: the same Chikki (auto) Refund mark in one locked
//      transaction, a Ship again mark switched with a remove + mark pair, then the same promise message
//      posted as "Vastora Support"), loaded from the TS source with the real database module. A Closed chat
//      opens in the Refund section; a chat waiting in Needs you stays there. Run it AFTER the code is deployed.
//
// The list uses the same pure rules as the live code, not a copy: the detector (refundThreatKind), the
// other-order guard (threatNamesOtherOrder: an amount, a date or a PIN code is not an order), the decision
// (refundThreatStep: a Cash on Delivery order stays out), the estimated date (etaOf /
// etaPassed, the day-13 fallback of orders.ts) and the stage (claimStage over buildJourney, as orders.ts
// toFoundOrder), all transpiled in memory from src/. Chats: chat box only, not merged, verified by order ID
// + full phone, not in Refund (a Ship again chat is listed: it would be switched), open, or Closed with
// activity in the last N days (the chat that started this had been closed by staff). Customer messages of the last N
// days are read.
//
// /etc/tracker/.env is read into memory and never printed. Prints only chat ids, statuses, stages, threat
// kinds, counts, days, times, health scores and subject labels: no names, phones, order IDs or message text
// (AGENTS.md).

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const ROOT = path.resolve(__dirname, '..');
const appRequire = createRequire(path.join(ROOT, 'package.json'));
const ts = appRequire('typescript');

// Loads one of the app's TS files and the app files it imports ('@/lib/...', './...'); anything else
// (node's own modules, pg, next/server) comes from the app's node_modules.
const loaded = new Map();
function loadTs(file) {
  if (loaded.has(file)) return loaded.get(file).exports;
  const mod = { exports: {} };
  loaded.set(file, mod);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const req = (spec) => {
    if (spec.startsWith('@/')) return loadTs(path.join(ROOT, 'src', spec.slice(2) + '.ts'));
    if (spec.startsWith('./') || spec.startsWith('../')) return loadTs(path.resolve(path.dirname(file), spec + '.ts'));
    return appRequire(spec);
  };
  new Function('module', 'exports', 'require', js)(mod, mod.exports, req);
  return mod.exports;
}

// The pure rules (no database).
const R = loadTs(path.join(ROOT, 'src/lib/chat/refund-threat.ts'));
const C = loadTs(path.join(ROOT, 'src/lib/chat/tracking-claim.ts'));
const J = loadTs(path.join(ROOT, 'src/lib/journey.ts'));
for (const [name, fn] of [['refundThreatKind', R.refundThreatKind], ['refundThreatStep', R.refundThreatStep], ['etaOf', R.etaOf],
  ['etaPassed', R.etaPassed], ['istDay', R.istDay], ['threatNamesOtherOrder', R.threatNamesOtherOrder], ['claimStage', C.claimStage],
  ['buildJourney', J.buildJourney]]) {
  if (typeof fn !== 'function') throw new Error(`${name} is missing from the app code`);
}

// ── The arguments ──────────────────────────────────────────────
// { mode: 'list' | 'apply', ids, days } or { error }. --apply needs at least one chat id.
function parseArgs(argv) {
  const out = { mode: 'list', ids: [], days: 7 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.mode = 'apply';
    else if (a === '--days') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 60) return { error: '--days wants a whole number from 1 to 60' };
      out.days = n;
    } else if (a.startsWith('--')) return { error: `unknown option ${a}` };
    else if (out.mode === 'apply') out.ids.push(...a.split(',').map((x) => x.trim()).filter(Boolean));
    else return { error: `a chat id (${a}) is only taken after --apply` };
  }
  if (out.mode === 'apply' && !out.ids.length) return { error: '--apply needs the chat ids the owner approved (from the list): nothing was moved' };
  if (out.ids.some((id) => !/^[A-Za-z0-9_-]{1,64}$/.test(id))) return { error: 'a chat id has odd characters: nothing was moved' };
  out.ids = [...new Set(out.ids)];
  return out;
}

// ── 1. The list (read only) ────────────────────────────────────
const CHATS_SQL = `
  SELECT c.id, c.site_id, c.status, c.case_kind, (c.assigned_to IS NOT NULL) AS held, c.verified_order_id, c.verified_via,
         c.subject_label, c.health_score, s.tracker_business_id,
         EXISTS (SELECT 1 FROM chat_case_events e
                  WHERE e.conversation_id = c.id AND e.kind = 'refund' AND e.action = 'remove') AS refund_removed,
         EXISTS (SELECT 1 FROM conversations o
                  WHERE o.site_id = c.site_id AND o.id <> c.id AND o.merged_into IS NULL
                    AND o.case_kind = 'refund' AND o.case_order_id = c.verified_order_id) AS order_in_refund
    FROM conversations c JOIN sites s ON s.id = c.site_id
   WHERE c.merged_into IS NULL AND c.source = 'chat'
     AND (c.case_kind IS NULL OR c.case_kind = 'reship')
     AND c.verified_order_id IS NOT NULL AND c.verified_via IN ('form', 'chat_phone')
     AND (c.status <> 'resolved' OR c.last_message_at > now() - make_interval(days => $1::int))
   ORDER BY c.id`;

// messages.created_at is a timestamp without time zone written in UTC: epoch ms read in SQL, so the Node
// process's time zone cannot shift it. The same window the live code would see for a new message.
const VISITOR_SQL = `
  SELECT conversation_id, content, (extract(epoch FROM created_at) * 1000)::float8 AS t
    FROM messages
   WHERE conversation_id = ANY($1::text[]) AND sender = 'visitor' AND deleted_at IS NULL
     AND COALESCE(metadata->>'hidden', 'false') <> 'true' AND content IS NOT NULL AND btrim(content) <> ''
     AND created_at > now() - make_interval(days => $2::int)
   ORDER BY conversation_id, created_at, id`;
const LAST_TEAM_SQL = `
  SELECT conversation_id, (extract(epoch FROM max(created_at)) * 1000)::float8 AS t
    FROM messages
   WHERE conversation_id = ANY($1::text[]) AND sender IN ('agent', 'system') AND deleted_at IS NULL
   GROUP BY conversation_id`;

// The verified order as the live code finds it (lookupVerifiedOrder in orders.ts: the site's panel, or any
// panel when the site has none; exactly one match, else not loadable), with the columns buildJourney reads.
const ORDER_SQL = `
  SELECT o.tracking_status, o.is_cancelled, o.created_at, o.status_updated_at, o.estimated_delivery,
         o.delivered_at, o.state, o.city, o.payment_method, b.origin_city
    FROM orders o
    LEFT JOIN businesses b ON b.id = o.business_id
   WHERE o.order_id = $1
     AND ($2::text IS NULL OR o.business_id::text = $2::text)
   LIMIT 2`;

const IST = (ms) => new Date(ms).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});

// The stage, estimated date and payment the live code uses (orders.ts toFoundOrder, then claimStage / etaOf;
// COD = payment_method 'cod' or one that says cash on delivery, as toFoundOrder).
function orderFacts(row, now) {
  if (!row) return null;
  const journey = J.buildJourney(row);
  const status = journey.mode === 'normal' && journey.currentIndex >= 0 ? J.JOURNEY[journey.currentIndex].status : row.tracking_status;
  const eta = R.etaOf({ estimated_delivery: row.estimated_delivery, placed_on: row.created_at });
  const pay = String(row.payment_method || '').toLowerCase();
  return { stage: C.claimStage({ status, cancelled: row.is_cancelled }), name: status, eta, etaPassed: R.etaPassed(eta, now), cod: pay === 'cod' || pay.includes('cash on delivery') };
}

async function run(client, { days = 7, now = Date.now() } = {}) {
  const chats = (await client.query(CHATS_SQL, [days])).rows;
  const ids = chats.map((c) => c.id);
  const visitor = new Map();
  const lastTeam = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    for (const m of (await client.query(VISITOR_SQL, [part, days])).rows) {
      if (!visitor.has(m.conversation_id)) visitor.set(m.conversation_id, []);
      visitor.get(m.conversation_id).push(m);
    }
    for (const r of (await client.query(LAST_TEAM_SQL, [part])).rows) lastTeam.set(r.conversation_id, Number(r.t));
  }

  const why = {};
  let withThreat = 0, otherOrderOnly = 0;
  const rows = [];
  for (const c of chats) {
    const hits = [];
    let other = 0;
    for (const m of visitor.get(c.id) || []) {
      const kind = R.refundThreatKind(m.content);
      if (!kind) continue;
      if (R.threatNamesOtherOrder(m.content, c.verified_order_id)) { other++; continue; }
      hits.push({ kind, t: Number(m.t) });
    }
    if (!hits.length && !other) continue;
    withThreat++;
    if (!hits.length) { otherOrderOnly++; continue; }
    const facts = { strictProof: true, caseKind: c.case_kind, otherOrder: false, refundRemoved: !!c.refund_removed, otherRefundChat: !!c.order_in_refund };
    let step = R.refundThreatStep(facts);
    let order = null;
    if (step.act === 'need_order') {
      const orderRows = (await client.query(ORDER_SQL, [c.verified_order_id, c.tracker_business_id || null])).rows;
      order = orderFacts(orderRows.length === 1 ? orderRows[0] : null, now);
      step = R.refundThreatStep({ ...facts, order: order ? { stage: order.stage, etaPassed: order.etaPassed, cod: order.cod } : null });
    }
    if (step.act !== 'mark' && step.act !== 'switch') {
      const w = step.act === 'today' ? step.why : step.act;
      why[w] = (why[w] || 0) + 1;
      continue;
    }
    const last = hits[hits.length - 1];
    const team = lastTeam.get(c.id);
    rows.push({
      id: c.id, status: c.status, from: step.act === 'switch' ? 'Ship again' : '-', held: !!c.held, stage: order.name,
      days_late: R.istDay(now) - R.istDay(order.eta), threat: last.kind, hits: hits.length, last_hit: IST(last.t),
      team_replied_after_last_hit: team != null && team > last.t,
      health: c.health_score == null ? '-' : `${c.health_score}%`, subject: c.subject_label || '-',
    });
  }
  return { checked: chats.length, days, withThreat, otherOrderOnly, why, rows };
}

function report(r) {
  console.log(`Verified chats checked: ${r.checked} (chat box, verified by order ID + full phone, not in Refund; open, or Closed with activity in the last ${r.days} days)`);
  console.log(`Chats with a chargeback / consumer / legal / police threat from the customer in the last ${r.days} days: ${r.withThreat}`);
  console.log(`  only about another order than the verified one: ${r.otherOrderOnly}`);
  const left = Object.entries(r.why).sort((a, b) => b[1] - a[1]);
  console.log(`  left out by the rule: ${left.length ? left.map(([w, n]) => `${w}: ${n}`).join('; ') : 'none'}`);
  console.log('');
  console.log(`Candidates (late order, the rule would move them): ${r.rows.length}`);
  if (!r.rows.length) { console.log('Nothing to move.'); return; }
  console.log(['id', 'status', 'from', 'held', 'stage', 'days_late', 'threat', 'hits', 'last_hit_IST', 'team_replied_after_last_hit', 'health', 'subject_label'].join(' | '));
  for (const x of r.rows) {
    console.log([x.id, x.status, x.from, x.held ? 'held' : '-', x.stage, x.days_late, x.threat, x.hits, x.last_hit,
      x.team_replied_after_last_hit ? 'YES' : 'no', x.health, x.subject].join(' | '));
  }
  console.log('');
  console.log('Show this list to the owner first. A held chat or team_replied_after_last_hit = YES may already be handled by a person.');
  console.log('Move ONLY the ids he approves (each gets the refund promise in its chat):');
  console.log(`  node scripts/refund-threat-candidates.js --apply ${r.rows.map((x) => x.id).join(' ')}${r.days !== 7 ? ` --days ${r.days}` : ''}`);
}

// ── 2. The approved move ───────────────────────────────────────
// The app's own server function, per id, one after another. Prints only the id and the outcome.
async function applyIds(apply, ids, days) {
  const out = [];
  for (const id of ids) {
    let res;
    try {
      res = await apply(id, days);
    } catch (err) {
      res = { done: 'refused', why: `failed: ${(err && err.message) || 'error'}` };
    }
    out.push({ id, ...res });
    if (res.done === 'marked') {
      console.log(`${id} | moved to Refund${res.from ? ' (from Ship again)' : ''} | ${res.posted ? 'promise posted' : 'PROMISE NOT POSTED: post it by hand or tell the owner'}${res.keptInNeedsYou ? ' | kept in Needs you' : ''} | ${res.trigger}`);
    } else {
      console.log(`${id} | not moved: ${res.why}`);
    }
  }
  const moved = out.filter((x) => x.done === 'marked').length;
  console.log(`Moved ${moved} of ${ids.length}.`);
  return out;
}

// DATABASE_URL, and the refund form's kill switch REFUND_FORMS (not a secret): --apply runs the app's own
// check (link-mask.ts refundFormsOpen), which reads it from process.env. Values are never printed.
function serverEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync('/etc/tracker/.env', 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && (m[1] === 'DATABASE_URL' || m[1] === 'REFUND_FORMS')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* not on the server: the environment below */ }
  return out;
}
function databaseUrl(env = serverEnv()) {
  return env.DATABASE_URL || process.env.DATABASE_URL || null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { console.log(args.error); process.exit(2); }
  const env = serverEnv();
  const url = databaseUrl(env);
  if (!url) { console.log('DATABASE_URL missing (/etc/tracker/.env or the environment)'); process.exit(1); }
  if (env.REFUND_FORMS !== undefined && process.env.REFUND_FORMS === undefined) process.env.REFUND_FORMS = env.REFUND_FORMS;
  const formsOff = String(process.env.REFUND_FORMS || '').trim().toLowerCase() === 'off';
  if (formsOff) console.log('Refund forms are switched off (REFUND_FORMS=off): --apply refuses every chat (no refund form can be promised).');

  if (args.mode === 'apply') {
    // The real database module reads DATABASE_URL (never printed); the server functions use it.
    process.env.DATABASE_URL = url;
    const db = loadTs(path.join(ROOT, 'src/lib/db.ts'));
    const auto = loadTs(path.join(ROOT, 'src/lib/chat/case-auto.ts'));
    if (typeof auto.applyRefundThreatMove !== 'function') throw new Error('applyRefundThreatMove is missing from the app code');
    try {
      await applyIds(auto.applyRefundThreatMove, args.ids, args.days);
    } finally {
      await db.getPool().end().catch(() => {});
    }
    return;
  }

  const { Pool } = appRequire('pg');
  const pool = new Pool({ connectionString: url, max: 1, ssl: false });
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '60s'`);
    report(await run(client, { days: args.days }));
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => { console.error('refund-threat-candidates failed:', err && err.message); process.exit(1); });
} else {
  module.exports = { parseArgs, run, report, applyIds, orderFacts };
}
