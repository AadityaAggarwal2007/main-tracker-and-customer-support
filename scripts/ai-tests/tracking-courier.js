// Customers never see the courier's name (owner, 2026-10-02: "valmo ... kisi bhi tracking me nahi
// dikhna chahiye"): not on the tracking pages, not in the public tracking JSON, not in the tracking
// emails. The Tracking ID stays. Staff screens keep the courier. Runs the REAL route
// (src/app/api/track/route.ts, with the real journey.ts) against a fake database and the REAL
// email template; no network, no email sent.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const ts = require('typescript');
const ROOT = path.resolve(__dirname, '../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracking-courier-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const transpile = (rel, out, fix = (s) => s) => {
  const src = fix(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  fs.writeFileSync(path.join(dir, out), ts.transpileModule(src, { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true } }).outputText);
  return require(path.join(dir, out));
};

// The fake database answers with ONLY the columns the SQL selects (o.* = every column), from rows
// that carry a courier, so a courier column added back to a SELECT shows up in the JSON.
const ORDER = {
  id: 7, order_id: '#9001', customer_name: 'Test Buyer', tracking_status: 'Shipped', tracking_id: 'STQAW7X2LQYT',
  courier_partner: 'valmo', status_updated_at: '2026-09-30T10:00:00.000Z', estimated_delivery: null,
  order_total: 356, payment_method: 'COD', is_cancelled: false, city: 'Surat', state: 'Gujarat', pincode: '395001',
  created_at: '2026-09-29T10:00:00.000Z', customer_mobile: '9876543210', business_id: 1, delivered_at: null,
  tracking_token: 'tok123',
};
const BIZ = { id: 1, name: 'Vastora', logo_url: '', support_email: 'help@example.test', support_phone: '', origin_city: 'Surat', default_courier: 'Valmo' };
fs.writeFileSync(path.join(dir, 'next-server.js'), `
class NextResponse { static json(body, init = {}) { const h = {}; return { status: init.status || 200, body, headers: { set: (k, v) => { h[k] = v; } } }; } }
module.exports = { NextResponse, NextRequest: class {} };`);
global.__tc = { ORDER, BIZ };
fs.writeFileSync(path.join(dir, 'db.js'), `
const { ORDER, BIZ } = global.__tc;
const flat = (sql) => sql.replace(/\\s+/g, ' ').trim();
const selectList = (q) => q.slice(q.indexOf('SELECT') + 6, q.search(/\\bFROM\\b/));
function pick(row, cols) { const out = {}; for (const c of cols) if (c in row) out[c] = row[c]; return out; }
async function queryOne(sql, params = []) {
  const q = flat(sql);
  if (/FROM orders o\\b/.test(q)) {
    const list = selectList(q);
    const hit = /WHERE o\\.tracking_token = \\$1/.test(q) ? params[0] === ORDER.tracking_token
      : /WHERE o\\.order_id = \\$1/.test(q) ? params[0] === ORDER.order_id : false;
    if (!hit) return null;
    const cols = /\\bo\\.\\*/.test(list) ? Object.keys(ORDER) : [...list.matchAll(/\\bo\\.([a-z_]+)/g)].map((m) => m[1]);
    const row = pick(ORDER, cols);
    for (const m of list.matchAll(/\\bb\\.([a-z_*]+)/g)) Object.assign(row, m[1] === '*' ? BIZ : pick(BIZ, [m[1]]));
    if (/\\bAS order_items\\b/.test(list)) row.order_items = [{ id: 1, product_name: 'Jhumka box', brand: 'vastora', quantity: 1, price: 128 }];
    return row;
  }
  if (/FROM businesses/.test(q)) {
    const list = selectList(q);
    return /^\\s*\\*\\s*$/.test(list) ? { ...BIZ } : pick(BIZ, list.split(',').map((c) => c.trim()));
  }
  throw new Error('fake db: unexpected SQL ' + q.slice(0, 80));
}
async function query(sql) {
  const q = flat(sql);
  if (/FROM tracking_history/.test(q)) return { rows: [{ status: 'Shipped', created_at: '2026-09-30T10:00:00.000Z', notes: 'Status updated to Shipped' }], rowCount: 1 };
  throw new Error('fake db: unexpected SQL ' + q.slice(0, 80));
}
module.exports = { query, queryOne };`);
transpile('src/lib/journey.ts', 'journey.js');
const routeFix = (s) => s.replace(/from '@\/lib\/db'/g, "from './db'").replace(/from '@\/lib\/journey'/g, "from './journey'")
  .replace(/from 'next\/server'/g, "from './next-server'");
const route = transpile('src/app/api/track/route.ts', 'track.js', routeFix);
const tpl = transpile('src/lib/email-templates.ts', 'email-templates.js');

const COURIER = /courier_partner|default_courier|valmo/i;
const get = (r, qs) => r.GET({ url: `http://x/api/track?${qs}` });
let n = 0;
(async () => {
  // 1. Token link (/track/<token>): the JSON has the Tracking ID and the journey, never the courier.
  const a = await get(route, 'token=tok123');
  assert.strictEqual(a.status, 200);
  assert.strictEqual(a.body.order.tracking_id, 'STQAW7X2LQYT');
  assert.ok(a.body.journey && a.body.journey.currentLabel, 'journey still built');
  assert.ok(!('courier_partner' in a.body.order), 'token JSON has courier_partner');
  assert.ok(!COURIER.test(JSON.stringify(a.body)), 'token JSON names the courier: ' + JSON.stringify(a.body).match(COURIER));
  n++;

  // 2. Order ID + phone (/track search): same, and the phone still stays out.
  const b = await get(route, `orderId=${encodeURIComponent('#9001')}&phone=3210`);
  assert.strictEqual(b.status, 200);
  assert.strictEqual(b.body.order.tracking_id, 'STQAW7X2LQYT');
  assert.ok(!('courier_partner' in b.body.order), 'search JSON has courier_partner');
  assert.ok(!('customer_mobile' in b.body.order), 'search JSON has the phone');
  assert.ok(!COURIER.test(JSON.stringify(b.body)), 'search JSON names the courier');
  assert.strictEqual((await get(route, `orderId=${encodeURIComponent('#9001')}&phone=0000`)).status, 403);
  n++;

  // 3. The fake is not blind: a route that selects the courier again is caught.
  const planted = transpile('src/app/api/track/route.ts', 'track-planted.js',
    (s) => routeFix(s).replace(/o\.status_updated_at,/g, 'o.courier_partner, o.status_updated_at,'));
  assert.ok(COURIER.test(JSON.stringify((await get(planted, 'token=tok123')).body)), 'planted courier column not seen');
  n++;

  // 4. Every tracking email (each status): no courier row, no courier name in the HTML or the
  //    subject; the Tracking ID is still there. The field stays in the data the callers pass.
  const statuses = Object.keys(tpl.getDefaultSubjects());
  assert.ok(statuses.length >= 7, 'statuses: ' + statuses.join(', '));
  for (const courierPartner of ['valmo', 'Delhivery']) {
    for (const status of statuses) {
      const e = tpl.generateTrackingEmail({
        customerName: 'Test Buyer', orderId: '#9001', productNames: ['Jhumka box'], trackingId: 'STQAW7X2LQYT',
        courierPartner, trackingUrl: 'https://shiptrack.store/track/tok123', businessName: 'Vastora',
        supportEmail: 'help@example.test', supportPhone: '', estimatedDelivery: '2026-10-08', orderTotal: 356, city: 'Surat',
      }, status);
      assert.ok(e, 'no email for ' + status);
      const name = new RegExp(courierPartner, 'i');
      assert.ok(!name.test(e.html) && !name.test(e.subject), `${status} email names ${courierPartner}`);
      assert.ok(!/>\s*Courier\s*</i.test(e.html), `${status} email has a Courier row`);
      assert.ok(e.html.includes('STQAW7X2LQYT') && e.html.includes('Tracking ID'), `${status} email lost the Tracking ID`);
    }
  }
  n++;

  // 5. Static: both tracking pages show the Tracking ID and no courier (no label, no field,
  //    no 'Courier Partner' placeholder).
  for (const rel of ['src/app/track/page.tsx', 'src/app/track/[token]/page.tsx']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(!/Courier Partner/i.test(src), rel + ' still says Courier Partner');
    assert.ok(!/courier_partner|courierPartner|default_courier/.test(src), rel + ' still reads the courier');
    assert.ok(src.includes('{order.tracking_id}') && src.includes('>Tracking ID<'), rel + ' lost the Tracking ID');
  }
  n++;
  console.log(`TRACKING-COURIER: ${n} groups passed`);
})().catch((e) => { console.error(e); process.exit(1); });
