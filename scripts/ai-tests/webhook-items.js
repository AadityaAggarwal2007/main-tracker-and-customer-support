// The Shopify order webhook saves each line's full name ("Title - Silver / pack-of-3"), so two
// colours / sizes of one product are two different lines (owner, 2026-10-01). Runs the REAL route
// (src/app/api/shopify/webhook/route.ts) against a fake database; no network, no email sent.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), crypto = require('crypto');
const ts = require('typescript');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-items-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const seen = { items: [], ordersInserted: 0, existing: false };
global.__wh = seen;
fs.writeFileSync(path.join(dir, 'next-server.js'), `
class NextResponse { static json(body, init = {}) { return { status: init.status || 200, body }; } }
module.exports = { NextResponse, NextRequest: class {} };`);
fs.writeFileSync(path.join(dir, 'db.js'), `
const s = global.__wh;
async function query(sql, params = []) {
  const q = sql.replace(/\\s+/g, ' ').trim();
  if (/^INSERT INTO orders/.test(q)) { s.ordersInserted++; return { rows: [], rowCount: 1 }; }
  if (/^INSERT INTO order_items/.test(q)) {
    for (let i = 0; i < params.length; i += 5) s.items.push({ order_id: params[i], brand: params[i + 1], product_name: params[i + 2], quantity: params[i + 3], price: params[i + 4] });
    return { rows: [], rowCount: params.length / 5 };
  }
  if (/^DELETE FROM order_items/.test(q)) { s.items = []; return { rows: [], rowCount: 0 }; }
  if (/^(INSERT INTO tracking_history|UPDATE orders)/.test(q)) return { rows: [], rowCount: 1 };
  throw new Error('fake db: unexpected SQL ' + q.slice(0, 80));
}
async function queryOne(sql, params = []) {
  const q = sql.replace(/\\s+/g, ' ').trim();
  if (/SELECT shopify_webhook_secret FROM businesses/.test(q)) return { shopify_webhook_secret: 'test-secret' };
  if (/SELECT order_id FROM orders WHERE order_id = \\$1 AND source_store = \\$2/.test(q)) return s.existing ? { order_id: params[0] } : null;
  if (/SELECT id FROM email_logs/.test(q)) return { id: 1 };
  throw new Error('fake db: unexpected SQL ' + q.slice(0, 80));
}
module.exports = { query, queryOne };`);
fs.writeFileSync(path.join(dir, 'smtp.js'), `module.exports = { sendEmailDirect: async () => ({ sent: 0, errors: [] }) };`);
fs.writeFileSync(path.join(dir, 'email.js'), `module.exports = { generateTrackingEmail: () => null };`);
const src = fs.readFileSync(path.resolve(__dirname, '../../src/app/api/shopify/webhook/route.ts'), 'utf8')
  .replace(/from '@\/lib\/db'/g, "from './db'").replace(/from '@\/lib\/smtp-client'/g, "from './smtp'")
  .replace(/from '@\/lib\/email-templates'/g, "from './email'").replace(/from 'next\/server'/g, "from './next-server'");
fs.writeFileSync(path.join(dir, 'webhook.js'), ts.transpileModule(src, { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true } }).outputText);
const webhook = require(path.join(dir, 'webhook.js'));

const order = (lines) => ({
  id: 555, name: '#9001', order_number: 9001, email: '', total_price: '356.00', financial_status: 'pending', gateway: 'Cash on Delivery (COD)',
  shipping_address: { first_name: 'Test', last_name: 'Buyer', phone: '9876543210', address1: '1 Road', city: 'Surat', province: 'Gujarat', zip: '395001' },
  line_items: lines,
});
const post = (payload) => {
  const raw = JSON.stringify(payload);
  const hmac = crypto.createHmac('sha256', 'test-secret').update(raw, 'utf8').digest('base64');
  const headers = { 'x-shopify-hmac-sha256': hmac, 'x-shopify-shop-domain': 'test-shop.myshopify.com' };
  return webhook.POST({ text: async () => raw, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, url: 'http://x/api/shopify/webhook?b=P1' });
};
const LINES = [
  { title: 'Jhumka box', name: 'Jhumka box - Silver / pack-of-3', variant_title: 'Silver / pack-of-3', vendor: 'vastora', quantity: 1, price: '128.00' },
  { title: 'Jhumka box', name: 'Jhumka box - Gold / pack-of-3', variant_title: 'Gold / pack-of-3', vendor: 'vastora', quantity: 1, price: '128.00' },
  { title: 'Classic Bag', name: 'Classic Bag', variant_title: null, vendor: 'vastora', quantity: 2, price: '50.00' },
  { title: 'Old Line', vendor: 'vastora', quantity: 1, price: '50.00' },
];
let n = 0;
(async () => {
  const r = await post(order(LINES));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.action, 'created');
  assert.deepStrictEqual(seen.items.map((i) => i.product_name), ['Jhumka box - Silver / pack-of-3', 'Jhumka box - Gold / pack-of-3', 'Classic Bag', 'Old Line']);
  assert.deepStrictEqual(seen.items.map((i) => [i.quantity, i.price]), [[1, 128], [1, 128], [2, 50], [1, 50]]);
  n++;
  // The same order sent again (an update): items replaced, still with the full names, not doubled.
  seen.existing = true;
  const r2 = await post(order(LINES));
  assert.strictEqual(r2.body.action, 'updated');
  assert.strictEqual(seen.items.length, 4);
  assert.strictEqual(seen.items[1].product_name, 'Jhumka box - Gold / pack-of-3');
  n++;
  console.log(`WEBHOOK-ITEMS: ${n} groups passed`);
})().catch((e) => { console.error(e); process.exit(1); });
