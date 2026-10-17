// Payments > Brand Directory (owner 2026-10-17): the pure rules in src/lib/brand-directory-rules.ts and the REAL
// routes /api/brand-directory and /api/brand-directory/[id] on a fake database that plays brand-directory.sql
// (the unique name key ignoring capitals / outer spaces, a missing table, a broken connection).
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true }, fileName: filename }).outputText, filename);
const { NextRequest } = require('next/server');
const eq = assert.strictEqual, deq = assert.deepStrictEqual, ok = assert.ok;

const S = { user: null, rows: [], next: 1, missing: false, broken: false, raceDup: false, sql: [], logs: [] };
const key = (v) => String(v).trim().toLowerCase();
const COLS = ['founder_name', 'brand_name', 'bank_account_name', 'custom_field_1_label', 'custom_field_1_value', 'custom_field_2_label', 'custom_field_2_value'];
function guard(q) {
  S.sql.push(q.replace(/\s+/g, ' ').trim());
  if (S.broken) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432 password=secret'), { code: 'ECONNREFUSED' });
  if (S.missing) throw Object.assign(new Error('relation "brand_directory" does not exist'), { code: '42P01' });
}
const out = (r) => ({ ...r });
const db = {
  query: async (q, p = []) => {
    guard(q);
    const s = q.replace(/\s+/g, ' ').trim();
    if (/^SELECT .* FROM brand_directory ORDER BY/.test(s)) {
      return { rows: [...S.rows].sort((a, b) => key(a.brand_name).localeCompare(key(b.brand_name)) || a.id - b.id).map(out) };
    }
    if (/^DELETE FROM brand_directory WHERE id = \$1$/.test(s)) {
      const before = S.rows.length; S.rows = S.rows.filter((r) => String(r.id) !== String(p[0]));
      return { rows: [], rowCount: before - S.rows.length };
    }
    throw new Error('fake db: ' + s.slice(0, 90));
  },
  queryOne: async (q, p = []) => {
    guard(q);
    const s = q.replace(/\s+/g, ' ').trim();
    if (/^SELECT .* FROM brand_directory WHERE id = \$1$/.test(s)) { const r = S.rows.find((x) => String(x.id) === String(p[0])); return r ? out(r) : null; }
    if (/^SELECT id FROM brand_directory WHERE lower\(btrim\(brand_name\)\) = \$1 AND \(\$2::bigint IS NULL OR id <> \$2::bigint\) LIMIT 1$/.test(s)) {
      if (S.raceDup) return null;   // another tab saved the same name between the check and the insert
      const r = S.rows.find((x) => key(x.brand_name) === p[0] && (p[1] == null || String(x.id) !== String(p[1])));
      return r ? { id: String(r.id) } : null;
    }
    if (/^INSERT INTO brand_directory/.test(s)) {
      ok(/RETURNING/.test(s));
      if (S.rows.some((x) => key(x.brand_name) === key(p[1]))) throw Object.assign(new Error('duplicate key value violates unique constraint "brand_directory_name_key"'), { code: '23505' });
      const now = new Date().toISOString();
      const r = { id: S.next++, created_at: now, updated_at: now, created_by: p[7], updated_by: p[7] };
      COLS.forEach((c, i) => { r[c] = p[i]; });
      S.rows.push(r); return out(r);
    }
    if (/^UPDATE brand_directory SET/.test(s)) {
      const r = S.rows.find((x) => String(x.id) === String(p[0]));
      if (!r) return null;
      const name = p[2] ?? r.brand_name;
      if (S.rows.some((x) => x !== r && key(x.brand_name) === key(name))) throw Object.assign(new Error('dup'), { code: '23505' });
      COLS.forEach((c, i) => { if (p[i + 1] !== null && p[i + 1] !== undefined) r[c] = p[i + 1]; });
      r.updated_by = p[8]; r.updated_at = new Date(Date.now() + 1000).toISOString();
      return out(r);
    }
    throw new Error('fake db one: ' + s.slice(0, 90));
  },
};
const fakes = { '@/lib/db': db, '@/lib/auth': { getAuthFromRequest: () => S.user } };
const oR = Module._resolveFilename;
Module._resolveFilename = function (r, parent, ...x) { if (fakes[r]) return r; if (r.startsWith('@/')) return oR.call(this, path.join(SRC, r.slice(2)), parent, ...x); return oR.call(this, r, parent, ...x); };
const oL = Module._load; Module._load = function (r, ...x) { return fakes[r] || oL.call(this, r, ...x); };
const R = require(path.join(SRC, 'lib/brand-directory-rules.ts'));
const list = require(path.join(SRC, 'app/api/brand-directory/route.ts'));
const one = require(path.join(SRC, 'app/api/brand-directory/[id]/route.ts'));

const USERS = {
  owner: { role: 'admin', username: 'owner', businessIds: null, permissions: [] },
  sunny: { role: 'manager', id: 'u-s', username: 'sunny', businessIds: null, permissions: null },
  rahul: { role: 'agent', id: 'u-r', username: 'rahul', businessIds: null, permissions: ['chat.view', 'chat.reply', 'orders.view'] },
  panelAdmin: { role: 'panel_admin', id: 'u-p', username: 'pa', businessIds: null, permissions: null },
};
const call = async (who, fn, url, method = 'GET', body, params) => {
  S.user = USERS[who] || null;
  const init = { method };
  if (body !== undefined) { init.body = typeof body === 'string' ? body : JSON.stringify(body); init.headers = { 'content-type': 'application/json' }; }
  const r = await fn(new NextRequest('http://x' + url, init), params ? { params } : undefined);
  return { status: r.status, body: await r.json() };
};
const getAll = (who = 'owner') => call(who, list.GET, '/api/brand-directory');
const add = (b, who = 'owner') => call(who, list.POST, '/api/brand-directory', 'POST', b);
const getOne = (id, who = 'owner') => call(who, one.GET, `/api/brand-directory/${id}`, 'GET', undefined, { id: String(id) });
const patch = (id, b, who = 'owner') => call(who, one.PATCH, `/api/brand-directory/${id}`, 'PATCH', b, { id: String(id) });
const del = (id, who = 'owner') => call(who, one.DELETE, `/api/brand-directory/${id}`, 'DELETE', undefined, { id: String(id) });
const reset = () => { S.rows = []; S.next = 1; S.missing = false; S.broken = false; S.raceDup = false; S.sql = []; S.logs = []; };
const FULL = { founderName: 'Sunny', brandName: 'Jiva', bankAccountName: 'Tradenest', customField1Label: 'GST Firm', customField1Value: 'Jiva Enterprises', customField2Label: 'Payment Gateway', customField2Value: 'PayU' };

const oErr = console.error, oLog = console.log;
console.error = (...a) => { S.logs.push(a.join(' ')); };
console.log = (...a) => { if (/^\[brand-directory\]/.test(String(a[0]))) S.logs.push(a.join(' ')); else oLog(...a); };

let pass = 0, fail = 0;
async function t(name, fn) { reset(); try { await fn(); pass++; oLog('  ok  ' + name); } catch (e) { fail++; oLog('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 3).join('\n       ')); } }

(async () => {
  await t('rules: cleaning, required fields, limits, defaults, unique founders, search over every field', () => {
    const c = R.cleanBrand({ founderName: '  Sunny  ', brandName: ' Ji  va ', bankAccountName: '<b>Trade</b>' });
    deq(c.errors, {});
    deq([c.value.founderName, c.value.brandName, c.value.bankAccountName, c.value.customField1Label], ['Sunny', 'Ji va', 'b Trade /b', '']);
    const e = R.cleanBrand({ founderName: ' ', brandName: '' });
    ok(e.errors.founderName && e.errors.brandName, 'both required');
    ok(R.cleanBrand({ founderName: 'A', brandName: 'B', customField1Value: 'x'.repeat(201) }).errors.customField1Value);
    ok(R.cleanBrand({ founderName: 'A', brandName: 'B', customField1Label: 'x'.repeat(41) }).errors.customField1Label);
    ok(R.cleanBrand({ founderName: 5, brandName: 'B' }).errors.founderName, 'not text');
    deq(Object.keys(R.cleanBrand({ bankAccountName: 'X' }, true).value), ['bankAccountName'], 'an edit checks only what it sends');
    eq(R.labelOf('', 1), 'Custom Field 1'); eq(R.labelOf('  ', 2), 'Custom Field 2'); eq(R.labelOf('GST Firm', 1), 'GST Firm');
    eq(R.uniqueFounders([{ founderName: 'Sunny' }, { founderName: ' sunny ' }, { founderName: 'SUNNY' }, { founderName: 'Rahul  Jain' }, { founderName: 'rahul jain' }]), 2);
    const row = { ...FULL };
    for (const q of ['sunny', 'JIVA', 'tradenest', 'gst firm', 'enterprises', 'payment gateway', 'payu', 'jiva payu']) ok(R.matchesSearch(row, q), q);
    ok(!R.matchesSearch(row, 'razorpay'));
    ok(R.matchesSearch({ ...R.EMPTY_BRAND, founderName: 'A', brandName: 'B' }, 'custom field 1'), 'the default label is searchable too');
    ok(R.matchesSearch(row, '   '), 'empty search shows everything');
  });

  await t('founder tiles: one group per founder (capitals / spaces ignored), A-Z, brands A-Z inside, the common spelling shown', () => {
    const g = R.founderGroups([
      { ...R.EMPTY_BRAND, founderName: 'sunny ', brandName: 'Kurtiya' },
      { ...R.EMPTY_BRAND, founderName: 'Sunny', brandName: 'Jiva' },
      { ...R.EMPTY_BRAND, founderName: 'Sunny', brandName: 'aura' },
      { ...R.EMPTY_BRAND, founderName: 'Aman  Jain', brandName: 'Noori' },
    ]);
    deq(g.map((x) => [x.key, x.name, x.brands.map((b) => b.brandName)]), [['aman jain', 'Aman Jain', ['Noori']], ['sunny', 'Sunny', ['aura', 'Jiva', 'Kurtiya']]]);
    deq(R.founderGroups([]), []);
  });

  await t('only the Super Admin: 401 not logged in, 403 for the Manager, a panel admin and a team member (every method)', async () => {
    eq((await getAll(null)).status, 401);
    for (const who of ['sunny', 'panelAdmin', 'rahul']) {
      eq((await getAll(who)).status, 403, who);
      eq((await add(FULL, who)).status, 403, who);
      eq((await getOne(1, who)).status, 403, who);
      eq((await patch(1, { brandName: 'X' }, who)).status, 403, who);
      eq((await del(1, who)).status, 403, who);
    }
    eq(S.sql.length, 0, 'nothing read or written for them');
  });

  await t('1 + 2: create with all fields, and with only founder + brand; counts follow', async () => {
    const a = await add(FULL);
    eq(a.status, 201); deq([a.body.brand.founderName, a.body.brand.brandName, a.body.brand.customField2Value], ['Sunny', 'Jiva', 'PayU']);
    ok(a.body.brand.id && a.body.brand.createdAt && a.body.brand.updatedAt);
    const b = await add({ founderName: 'sunny ', brandName: 'Kurtiya' });
    eq(b.status, 201); deq([b.body.brand.bankAccountName, b.body.brand.customField1Label, b.body.brand.customField1Value], ['', '', '']);
    const l = await getAll();
    deq(l.body.brands.map((x) => x.brandName), ['Jiva', 'Kurtiya']);
    eq(l.body.brands.length, 2, 'Total Brands');
    eq(R.uniqueFounders(l.body.brands), 1, 'Unique Founders: "Sunny" and "sunny " are one');
    eq(S.rows[0].created_by, 'owner');
  });

  await t('3-6: edit founder, brand name (same record, no copy), bank account name and both custom fields; the rest is kept', async () => {
    const id = (await add(FULL)).body.brand.id;
    const before = (await getOne(id)).body.brand;
    let r = await patch(id, { founderName: 'Rahul' });
    eq(r.status, 200); eq(r.body.brand.founderName, 'Rahul'); eq(r.body.brand.customField1Value, 'Jiva Enterprises', 'unchanged fields stay');
    r = await patch(id, { brandName: 'Jiva Store' });
    eq(r.body.brand.id, id); eq(S.rows.length, 1, 'no duplicate record');
    r = await patch(id, { bankAccountName: 'New Bank Pvt Ltd' });
    eq(r.body.brand.bankAccountName, 'New Bank Pvt Ltd');
    r = await patch(id, { customField1Label: 'Firm', customField1Value: 'Jiva LLP', customField2Label: 'Gateway', customField2Value: 'Razorpay' });
    deq([r.body.brand.customField1Label, r.body.brand.customField1Value, r.body.brand.customField2Label, r.body.brand.customField2Value], ['Firm', 'Jiva LLP', 'Gateway', 'Razorpay']);
    r = await patch(id, { bankAccountName: '' });
    eq(r.body.brand.bankAccountName, '', 'an optional field can be emptied');
    ok(r.body.brand.updatedAt > before.updatedAt, 'updated_at moves');
    eq(r.body.brand.createdAt, before.createdAt);
    eq((await patch(id, { brandName: ' ' })).status, 400, 'a required field cannot be emptied');
    eq((await patch(id, {})).status, 400, 'nothing to change');
    eq((await patch(id, 'not json')).status, 400);
  });

  await t('7 + 8: two brands keep their own custom labels; a fresh read (page refresh) returns what was saved', async () => {
    const a = (await add({ founderName: 'Sunny', brandName: 'A1', customField1Label: 'GST Firm', customField1Value: 'One' })).body.brand.id;
    const b = (await add({ founderName: 'Sunny', brandName: 'B1', customField1Label: 'Gateway', customField1Value: 'PayU', customField2Label: 'UPI', customField2Value: 'x@upi' })).body.brand.id;
    await patch(a, { customField2Label: 'Owner phone', customField2Value: 'later' });
    const l = (await getAll()).body.brands;
    const A = l.find((x) => x.id === a), B = l.find((x) => x.id === b);
    deq([A.customField1Label, A.customField2Label, A.customField2Value], ['GST Firm', 'Owner phone', 'later']);
    deq([B.customField1Label, B.customField2Label, B.customField2Value], ['Gateway', 'UPI', 'x@upi']);
  });

  await t('10 + 11: delete removes only that brand; the counts follow; a second delete / an unknown id is 404', async () => {
    const a = (await add({ founderName: 'Sunny', brandName: 'A1' })).body.brand.id;
    const b = (await add({ founderName: 'Sunny', brandName: 'B1' })).body.brand.id;
    const c = (await add({ founderName: 'Rahul', brandName: 'C1' })).body.brand.id;
    const d = await del(b);
    eq(d.status, 200); deq(d.body, { ok: true });
    const l = (await getAll()).body.brands;
    deq(l.map((x) => x.id), [a, c]); eq(R.uniqueFounders(l), 2);
    eq((await del(b)).status, 404);
    eq((await del('abc')).status, 404, 'a bad id never reaches the database');
    eq((await getOne(b)).status, 404);
    eq((await patch(b, { founderName: 'X' })).status, 404);
    ok(!S.sql.some((q) => /abc/.test(q)));
  });

  await t('12: duplicate brand names (capitals / spaces ignored) are refused on add and on rename; renaming to its own name is fine; the race is 409 too', async () => {
    const a = (await add(FULL)).body.brand.id;
    let r = await add({ founderName: 'Other', brandName: '  JIVA ' });
    eq(r.status, 409); ok(r.body.fields.brandName); eq(S.rows.length, 1);
    const b = (await add({ founderName: 'Other', brandName: 'Kurtiya' })).body.brand.id;
    r = await patch(b, { brandName: 'jiva' });
    eq(r.status, 409); eq(S.rows.find((x) => String(x.id) === b).brand_name, 'Kurtiya', 'nothing changed');
    r = await patch(a, { brandName: 'JIVA' });
    eq(r.status, 200, 'a brand may change its own capitals'); eq(r.body.brand.brandName, 'JIVA');
    S.raceDup = true;
    r = await add({ founderName: 'X', brandName: 'kurtiya' });
    eq(r.status, 409, 'the database key catches what the check missed');
  });

  await t('13: bad input and database trouble answer safely: 400 with field errors, 503 not installed, 500 without database detail', async () => {
    let r = await add({ founderName: '', brandName: 'X' });
    eq(r.status, 400); ok(r.body.fields.founderName); eq(S.sql.length, 0, 'never trusted to the database');
    r = await add('{bad json');
    eq(r.status, 400);
    S.missing = true;
    r = await getAll();
    eq(r.status, 503); eq(r.body.notInstalled, true); ok(/brand-directory\.sql/.test(r.body.error));
    eq((await add(FULL)).status, 503);
    S.missing = false; S.broken = true;
    r = await getAll();
    eq(r.status, 500); ok(!/ECONNREFUSED|5432|password/.test(JSON.stringify(r.body)), 'no database detail to the screen');
    eq((await del(1)).status, 500);
  });

  await t('logs never carry a name or a bank account name; every query is parameterised', async () => {
    const id = (await add(FULL)).body.brand.id;
    await patch(id, { bankAccountName: 'Secret Bank Name' });
    await del(id);
    ok(S.logs.length >= 3);
    ok(!S.logs.some((l) => /Sunny|Jiva|Tradenest|Secret Bank|PayU/.test(l)), S.logs.join(' | '));
    ok(!S.sql.some((q) => /Sunny|Jiva|Tradenest|Secret/.test(q)), 'values only as parameters');
  });

  await t('the SQL file: additive, the unique name key, the DELETE grant only on this table, nothing dropped', () => {
    const sql = fs.readFileSync(path.resolve(__dirname, '../../brand-directory.sql'), 'utf8');
    ok(/CREATE TABLE IF NOT EXISTS brand_directory/.test(sql));
    ok(/CREATE UNIQUE INDEX IF NOT EXISTS brand_directory_name_key ON brand_directory \(lower\(btrim\(brand_name\)\)\)/.test(sql));
    ok(/GRANT SELECT, INSERT, UPDATE, DELETE ON brand_directory TO tracker_user/.test(sql));
    ok(!/\bDROP\b|\bTRUNCATE\b|DELETE FROM/i.test(sql.replace(/--.*$/gm, '')));
  });

  await t('the screen: Payments tab for the Super Admin only; the card uses the real API and keeps nothing in the browser', () => {
    const page = fs.readFileSync(path.join(SRC, 'app/admin/page.tsx'), 'utf8');
    ok(/id: 'payments' as TabType, label: 'Payments', icon: Landmark, show: isSuperAdmin\(user\)/.test(page));
    ok(/activeTab === 'payments' && isSuperAdmin\(user\) && \(/.test(page));
    ok(/: activeTab === 'payments' \? isSuperAdmin\(user\)/.test(page), 'a remembered Payments tab falls back for anyone else');
    const card = fs.readFileSync(path.join(SRC, 'components/BrandDirectoryCard.tsx'), 'utf8');
    ok(/\/api\/brand-directory/.test(card));
    ok(!/localStorage|sessionStorage/.test(card), 'no brand data in the browser');
    for (const s of ['Brand Directory', 'Founder &amp; Bank Account Management', 'Total Brands', 'Unique Founders', 'Add Brand', 'Save Changes', 'Cancel', 'Delete', 'All founders', 'bd-founder']) ok(card.includes(s), s);
    ok(/founderGroups\(/.test(card), 'founders are shown apart, one tile each');
  });

  console.error = oErr; console.log = oLog;
  console.log(`\nbrand-directory: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
