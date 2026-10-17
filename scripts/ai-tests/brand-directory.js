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

const S = { user: null, rows: [], next: 1, missing: false, broken: false, oldKey: false, oldCols: false, sql: [], logs: [] };
const key = (v) => String(v).trim().toLowerCase();
const COLS = ['founder_name', 'brand_name', 'bank_account_name', 'fields', 'color'];
const fk = (v) => String(v).trim().toLowerCase();
const blank = () => ({ custom_field_1_label: '', custom_field_1_value: '', custom_field_2_label: '', custom_field_2_value: '', fields: [], color: '', sort_order: 0 });
function guard(q) {
  S.sql.push(q.replace(/\s+/g, ' ').trim());
  if (S.broken) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432 password=secret'), { code: 'ECONNREFUSED' });
  if (S.missing) throw Object.assign(new Error('relation "brand_directory" does not exist'), { code: '42P01' });
  if (S.oldCols && /fields|sort_order|color/.test(q)) throw Object.assign(new Error('column "fields" does not exist'), { code: '42703' });
}
const out = (r) => ({ ...r });
const db = {
  query: async (q, p = []) => {
    guard(q);
    const s = q.replace(/\s+/g, ' ').trim();
    if (/^SELECT .* FROM brand_directory ORDER BY lower\(btrim\(founder_name\)\), sort_order, lower\(btrim\(brand_name\)\), id$/.test(s)) {
      return { rows: [...S.rows].sort((a, b) => key(a.founder_name).localeCompare(key(b.founder_name)) || a.sort_order - b.sort_order || key(a.brand_name).localeCompare(key(b.brand_name)) || a.id - b.id).map(out) };
    }
    if (/^INSERT INTO brand_directory \(founder_name, brand_name, sort_order, created_by, updated_by\) SELECT \$1, g.name/.test(s)) {
      ok(/WITH ORDINALITY/.test(s) && /NOT EXISTS/.test(s) && /RETURNING/.test(s));
      const mine = S.rows.filter((r) => fk(r.founder_name) === fk(p[0]));
      const base = mine.length ? Math.max(...mine.map((r) => r.sort_order)) : -1;
      const rows = [];
      p[1].forEach((name, i) => {
        if (mine.some((r) => fk(r.brand_name) === fk(name))) return;
        const now = new Date().toISOString();
        const r = { ...blank(), id: S.next++, founder_name: p[0], brand_name: name, bank_account_name: '', sort_order: base + i + 1, created_at: now, updated_at: now, created_by: p[2], updated_by: p[2] };
        S.rows.push(r); rows.push(out(r));
      });
      return { rows, rowCount: rows.length };
    }
    if (/^UPDATE brand_directory b SET sort_order = o.ord - 1 FROM unnest\(\$1::bigint\[\]\) WITH ORDINALITY/.test(s)) {
      let n = 0;
      p[0].forEach((id, i) => { const r = S.rows.find((x) => String(x.id) === String(id)); if (r) { r.sort_order = i; n++; } });
      return { rows: [], rowCount: n };
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
    if (/^INSERT INTO brand_directory/.test(s)) {
      ok(/RETURNING/.test(s));
      if (S.oldKey && S.rows.some((x) => key(x.brand_name) === key(p[1]))) throw Object.assign(new Error('duplicate key value violates unique constraint "brand_directory_name_key"'), { code: '23505' });
      ok(/COALESCE\(\(SELECT max\(sort_order\) \+ 1 FROM brand_directory WHERE lower\(btrim\(founder_name\)\) = lower\(btrim\(\$1\)\)\), 0\)/.test(s), 'a new card goes last');
      const now = new Date().toISOString();
      const mine = S.rows.filter((x) => fk(x.founder_name) === fk(p[0]));
      const r = { ...blank(), id: S.next++, created_at: now, updated_at: now, created_by: p[5], updated_by: p[5], sort_order: mine.length ? Math.max(...mine.map((x) => x.sort_order)) + 1 : 0 };
      r.founder_name = p[0]; r.brand_name = p[1]; r.bank_account_name = p[2]; r.fields = JSON.parse(p[3]); r.color = p[4];
      S.rows.push(r); return out(r);
    }
    if (/^UPDATE brand_directory SET/.test(s)) {
      const r = S.rows.find((x) => String(x.id) === String(p[0]));
      if (!r) return null;
      const name = p[2] ?? r.brand_name;
      if (S.oldKey && S.rows.some((x) => x !== r && key(x.brand_name) === key(name))) throw Object.assign(new Error('dup'), { code: '23505' });
      COLS.forEach((c, i) => { if (p[i + 1] !== null && p[i + 1] !== undefined) r[c] = c === 'fields' ? JSON.parse(p[i + 1]) : p[i + 1]; });
      if (p[4] !== null) { r.custom_field_1_label = ''; r.custom_field_1_value = ''; r.custom_field_2_label = ''; r.custom_field_2_value = ''; }
      r.updated_by = p[6]; r.updated_at = new Date(Date.now() + 1000).toISOString();
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
const reset = () => { S.rows = []; S.next = 1; S.missing = false; S.broken = false; S.oldKey = false; S.oldCols = false; S.sql = []; S.logs = []; };
const FULL = { founderName: 'Sunny', brandName: 'Jiva', bankAccountName: 'Tradenest', fields: [{ label: 'GST Firm', value: 'Jiva Enterprises' }, { label: 'Payment Gateway', value: 'PayU' }] };
const post = (b, who = 'owner') => call(who, list.POST, '/api/brand-directory', 'POST', b);
const F = (n) => Array.from({ length: n }, (_, i) => ({ label: `L${i + 1}`, value: `V${i + 1}` }));

const oErr = console.error, oLog = console.log;
console.error = (...a) => { S.logs.push(a.join(' ')); };
console.log = (...a) => { if (/^\[brand-directory\]/.test(String(a[0]))) S.logs.push(a.join(' ')); else oLog(...a); };

let pass = 0, fail = 0;
async function t(name, fn) { reset(); try { await fn(); pass++; oLog('  ok  ' + name); } catch (e) { fail++; oLog('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 3).join('\n       ')); } }

(async () => {
  await t('rules: cleaning, required fields, limits, defaults, unique founders, search over every field', () => {
    const c = R.cleanBrand({ founderName: '  Sunny  ', brandName: ' Ji  va ', bankAccountName: '<b>Trade</b>' });
    deq(c.errors, {});
    deq([c.value.founderName, c.value.brandName, c.value.bankAccountName, c.value.fields, c.value.color], ['Sunny', 'Ji va', 'b Trade /b', [], '']);
    const e = R.cleanBrand({ founderName: ' ', brandName: '' });
    ok(e.errors.founderName && e.errors.brandName, 'both required');
    ok(R.cleanBrand({ founderName: 'A', brandName: 'B', fields: [{ label: 'a', value: 'x'.repeat(201) }] }).errors.fields);
    ok(R.cleanBrand({ founderName: 'A', brandName: 'B', fields: [{ label: 'x'.repeat(41), value: '' }] }).errors.fields);
    ok(R.cleanBrand({ founderName: 5, brandName: 'B' }).errors.founderName, 'not text');
    deq(Object.keys(R.cleanBrand({ bankAccountName: 'X' }, true).value), ['bankAccountName'], 'an edit checks only what it sends');
    eq(R.labelOf('', 1), 'Field 1'); eq(R.labelOf('  ', 7), 'Field 7'); eq(R.labelOf('GST Firm', 1), 'GST Firm');
    eq(R.uniqueFounders([{ founderName: 'Sunny' }, { founderName: ' sunny ' }, { founderName: 'SUNNY' }, { founderName: 'Rahul  Jain' }, { founderName: 'rahul jain' }]), 2);
    const row = { ...FULL };
    for (const q of ['sunny', 'JIVA', 'tradenest', 'gst firm', 'enterprises', 'payment gateway', 'payu', 'jiva payu']) ok(R.matchesSearch(row, q), q);
    ok(!R.matchesSearch(row, 'razorpay'));
    ok(R.matchesSearch({ ...R.EMPTY_BRAND, founderName: 'A', brandName: 'B', fields: [{ label: '', value: 'x' }] }, 'field 1'), 'the default label is searchable too');
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
    eq(a.status, 201); deq([a.body.brand.founderName, a.body.brand.brandName, a.body.brand.fields[1].value], ['Sunny', 'Jiva', 'PayU']);
    deq(a.body.added, [], 'no gateway cards unless asked');
    ok(a.body.brand.id && a.body.brand.createdAt && a.body.brand.updatedAt);
    const b = await add({ founderName: 'sunny ', brandName: 'Kurtiya' });
    eq(b.status, 201); deq([b.body.brand.bankAccountName, b.body.brand.fields, b.body.brand.color], ['', [], '']);
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
    eq(r.status, 200); eq(r.body.brand.founderName, 'Rahul'); eq(r.body.brand.fields[0].value, 'Jiva Enterprises', 'unchanged fields stay');
    r = await patch(id, { brandName: 'Jiva Store' });
    eq(r.body.brand.id, id); eq(S.rows.length, 1, 'no duplicate record');
    r = await patch(id, { bankAccountName: 'New Bank Pvt Ltd' });
    eq(r.body.brand.bankAccountName, 'New Bank Pvt Ltd');
    r = await patch(id, { fields: [{ label: 'Firm', value: 'Jiva LLP' }, { label: 'Gateway', value: 'Razorpay' }] });
    deq(r.body.brand.fields, [{ label: 'Firm', value: 'Jiva LLP' }, { label: 'Gateway', value: 'Razorpay' }]);
    r = await patch(id, { bankAccountName: '' });
    eq(r.body.brand.bankAccountName, '', 'an optional field can be emptied');
    ok(r.body.brand.updatedAt > before.updatedAt, 'updated_at moves');
    eq(r.body.brand.createdAt, before.createdAt);
    eq((await patch(id, { brandName: ' ' })).status, 400, 'a required field cannot be emptied');
    eq((await patch(id, {})).status, 400, 'nothing to change');
    eq((await patch(id, 'not json')).status, 400);
  });

  await t('7 + 8: two brands keep their own custom labels; a fresh read (page refresh) returns what was saved', async () => {
    const a = (await add({ founderName: 'Sunny', brandName: 'A1', fields: [{ label: 'GST Firm', value: 'One' }] })).body.brand.id;
    const b = (await add({ founderName: 'Sunny', brandName: 'B1', fields: [{ label: 'Gateway', value: 'PayU' }, { label: 'UPI', value: 'x@upi' }] })).body.brand.id;
    await patch(a, { fields: [{ label: 'GST Firm', value: 'One' }, { label: 'Owner phone', value: 'later' }] });
    const l = (await getAll()).body.brands;
    const A = l.find((x) => x.id === a), B = l.find((x) => x.id === b);
    deq(A.fields.map((f) => f.label + '=' + f.value), ['GST Firm=One', 'Owner phone=later']);
    deq(B.fields.map((f) => f.label + '=' + f.value), ['Gateway=PayU', 'UPI=x@upi']);
  });

  await t('10 + 11: delete removes only that brand; the counts follow; a second delete / an unknown id is 404', async () => {
    const a = (await add({ founderName: 'Sunny', brandName: 'A1' })).body.brand.id;
    const b = (await add({ founderName: 'Sunny', brandName: 'B1' })).body.brand.id;
    const c = (await add({ founderName: 'Rahul', brandName: 'C1' })).body.brand.id;
    const d = await del(b);
    eq(d.status, 200); deq(d.body, { ok: true });
    const l = (await getAll()).body.brands;
    deq(l.map((x) => x.id).sort(), [a, c].sort()); eq(R.uniqueFounders(l), 2);
    eq((await del(b)).status, 404);
    eq((await del('abc')).status, 404, 'a bad id never reaches the database');
    eq((await getOne(b)).status, 404);
    eq((await patch(b, { founderName: 'X' })).status, 404);
    ok(!S.sql.some((q) => /abc/.test(q)));
  });

  await t('12: the same brand name may be saved again (owner 17 Oct), on add and on rename; an install still holding the old unique key answers 409 with what to run', async () => {
    const a = (await add(FULL)).body.brand.id;
    let r = await add({ founderName: 'Robin', brandName: '  JIVA ' });
    eq(r.status, 201); eq(S.rows.length, 2, 'a second Jiva is saved');
    const b = (await add({ founderName: 'Robin', brandName: 'Kurtiya' })).body.brand.id;
    r = await patch(b, { brandName: 'jiva' });
    eq(r.status, 200); eq(r.body.brand.brandName, 'jiva');
    eq((await getAll()).body.brands.length, 3);
    ok(!S.sql.some((q) => /SELECT id FROM brand_directory WHERE lower/.test(q)), 'no name check any more');
    S.oldKey = true;
    r = await add({ founderName: 'X', brandName: 'kurtiya ' });
    eq((await add({ founderName: 'X', brandName: 'JIVA' })).status, 409, 'the old key still in the database');
    ok(/brand-directory\.sql/.test((await add({ founderName: 'X', brandName: 'JIVA' })).body.error));
    void a;
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

  await t('the SQL file: additive, no unique name, the DELETE grant only on this table, no table / row dropped', () => {
    const sql = fs.readFileSync(path.resolve(__dirname, '../../brand-directory.sql'), 'utf8');
    ok(/CREATE TABLE IF NOT EXISTS brand_directory/.test(sql));
    ok(!/CREATE UNIQUE INDEX/.test(sql), 'no unique brand name any more');
    ok(/DROP INDEX IF EXISTS brand_directory_name_key;/.test(sql), 'the old unique key goes (no row is removed)');
    ok(/CREATE INDEX IF NOT EXISTS brand_directory_name_idx ON brand_directory \(lower\(btrim\(brand_name\)\)\)/.test(sql));
    ok(/GRANT SELECT, INSERT, UPDATE, DELETE ON brand_directory TO tracker_user/.test(sql));
    ok(/ADD COLUMN IF NOT EXISTS fields jsonb NOT NULL DEFAULT '\[\]'::jsonb\s+CHECK \(jsonb_typeof\(fields\) = 'array' AND jsonb_array_length\(fields\) <= 10\)/.test(sql), 'up to 10 fields');
    ok(/ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT ''/.test(sql));
    ok(/ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0/.test(sql));
    ok(!/\bUPDATE brand_directory\b/i.test(sql.replace(/--.*$/gm, '')), 'no saved row is changed');
    ok(!/DROP TABLE|\bTRUNCATE\b|DELETE FROM|DROP COLUMN/i.test(sql.replace(/--.*$/gm, '')));
  });

  await t('the screen: Payments tab for the Super Admin only; the card uses the real API and keeps nothing in the browser', () => {
    const page = fs.readFileSync(path.join(SRC, 'app/admin/page.tsx'), 'utf8');
    ok(/id: 'payments' as TabType, label: 'Payments', icon: Landmark, show: isSuperAdmin\(user\)/.test(page));
    ok(/activeTab === 'payments' && isSuperAdmin\(user\) && \(/.test(page));
    ok(/: activeTab === 'payments' \? isSuperAdmin\(user\)/.test(page), 'a remembered Payments tab falls back for anyone else');
    const card = fs.readFileSync(path.join(SRC, 'components/BrandDirectoryCard.tsx'), 'utf8');
    ok(/\/api\/brand-directory/.test(card));
    ok(!/localStorage|sessionStorage/.test(card), 'no brand data in the browser');
    for (const s of ['Brand Directory', 'Founder &amp; Bank Account Management', 'Total Brands', 'Unique Founders', 'Add Brand', 'Add Founder', 'Save Changes', 'Cancel', 'Delete', 'All founders', 'bd-founder', 'draggable={canMove}', 'onDrop=', "action: 'order'", "action: 'founder'", 'withGateways', 'bd-palette', 'MAX_FIELDS']) ok(card.includes(s), s);
    const css = fs.readFileSync(path.join(SRC, 'app/globals.css'), 'utf8');
    for (const c of R.COLORS.filter((x) => x.key)) ok(css.includes(`.bd-c-${c.key} {`), 'colour ' + c.key);
    ok(/@media \(hover: none\) \{ \.bd-move \{ display: inline-flex; \}/.test(css), 'arrows on a touch screen');
    ok(/founderGroups\(/.test(card), 'founders are shown apart, one tile each');
  });


  await t('rules (owner 17 Oct evening): 10 fields at most, empty rows dropped, colours from the list, the old two fields read, order and drag', () => {
    deq(R.cleanFields([{ label: ' MID ', value: ' 123 ' }, { label: '', value: '' }, { label: '', value: 'x' }]).value, [{ label: 'MID', value: '123' }, { label: '', value: 'x' }]);
    eq(R.cleanFields(F(10)).value.length, 10);
    ok(/At most 10/.test(R.cleanFields(F(11)).error));
    ok(R.cleanFields('x').error); ok(R.cleanFields([{ label: 5 }]).error); ok(R.cleanFields([null]).error);
    ok(R.cleanBrand({ founderName: 'A', brandName: 'B', color: 'gold' }).errors.color, 'a colour not in the list');
    for (const c of R.COLORS) deq(R.cleanBrand({ founderName: 'A', brandName: 'B', color: c.key }).errors, {}, c.key);
    eq(R.COLORS.length, 10);
    deq(Object.keys(R.cleanBrand({ color: 'red' }, true).value), ['color'], 'a colour alone is an edit');
    deq(R.legacyFields('GST Firm', 'Jiva', '', ''), [{ label: 'GST Firm', value: 'Jiva' }]);
    deq(R.legacyFields('', 'PayU', '', ''), [{ label: 'Custom Field 1', value: 'PayU' }]);
    deq(R.legacyFields('', '', '', ''), []);
    deq(R.cleanOrder(['3', 1, '2']), ['3', '1', '2']);
    for (const bad of [[], ['1', '1'], ['0'], ['a'], 'x', Array.from({ length: 501 }, (_, i) => String(i + 1))]) eq(R.cleanOrder(bad), null, JSON.stringify(bad).slice(0, 20));
    const L = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
    deq(R.moveCard(L, 'a', 'c').map((x) => x.id), ['b', 'c', 'a', 'd']);
    deq(R.moveCard(L, 'd', 'a').map((x) => x.id), ['d', 'a', 'b', 'c']);
    eq(R.moveCard(L, 'a', 'a'), L); eq(R.moveCard(L, 'z', 'a'), L);
    eq(R.DEFAULT_GATEWAYS.length, 11);
    deq(R.missingGateways([{ brandName: 'cashfree ' }, { brandName: 'Phone  Pe' }, { brandName: 'Jiva' }]), ['AIRPAY', 'BILLDESK', 'DECENTRO', 'EASEBUZZ', 'PAYGLOCAL', 'PAYTM', 'PAYU', 'PINELABS', 'RAZORPAY']);
    const g = R.founderGroups([
      { ...R.EMPTY_BRAND, founderName: 'Rahul', brandName: 'B', sortOrder: 0 },
      { ...R.EMPTY_BRAND, founderName: 'Rahul', brandName: 'A', sortOrder: 1 },
      { ...R.EMPTY_BRAND, founderName: 'Rahul', brandName: 'C', sortOrder: 0 },
    ]);
    deq(g[0].brands.map((b) => b.brandName), ['B', 'C', 'A'], 'the dragged order first, then by name');
    ok(R.matchesSearch({ ...R.EMPTY_BRAND, founderName: 'A', brandName: 'B', fields: F(10) }, 'l10 v10'), 'the 10th field is searched too');
  });

  await t('a new founder gets the 11 gateway cards: Add Founder, and Add Brand with withGateways; never twice, after the founder\'s last card', async () => {
    let r = await post({ action: 'founder', founderName: '  Robin  ' });
    eq(r.status, 201); eq(r.body.added.length, 11);
    deq(r.body.added.map((b) => b.brandName), [...R.DEFAULT_GATEWAYS]);
    deq(r.body.added.map((b) => b.sortOrder), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    ok(r.body.added.every((b) => b.founderName === 'Robin' && b.bankAccountName === '' && b.fields.length === 0 && b.color === ''));
    r = await post({ action: 'founder', founderName: 'ROBIN' });
    eq(r.status, 201); eq(r.body.added.length, 0, 'a second click adds nothing');
    const id = S.rows.find((x) => x.brand_name === 'PAYU').id;
    await del(id);
    r = await post({ action: 'founder', founderName: 'robin' });
    deq(r.body.added.map((b) => b.brandName), ['PAYU'], 'only the missing one');
    ok(r.body.added[0].sortOrder > 10, 'after the last card');
    r = await add({ founderName: 'Aman', brandName: 'cashfree', fields: [{ label: 'MID', value: 'M1' }], color: 'green', withGateways: true });
    eq(r.status, 201); eq(r.body.brand.sortOrder, 0); eq(r.body.brand.color, 'green');
    eq(r.body.added.length, 10, 'the other 10 (CASHFREE is the brand itself)');
    ok(!r.body.added.some((b) => b.brandName === 'CASHFREE'));
    eq((await getAll()).body.brands.filter((b) => b.founderName === 'Aman').length, 11);
    eq((await post({ action: 'founder', founderName: ' ' })).status, 400);
    eq((await post({ action: 'founder', founderName: 'x'.repeat(81) })).status, 400);
    eq((await post({ action: 'nope' })).status, 400);
    eq((await post({ action: 'founder', founderName: 'Z' }, 'sunny')).status, 403, 'Super Admin only');
    ok(!S.logs.some((l) => /Robin|Aman|PAYU|CASHFREE/.test(l)), 'no names in the log');
  });

  await t('drag: the order is saved per card id, the list follows it; colour and fields saved on an edit; bad order 400', async () => {
    await post({ action: 'founder', founderName: 'Rahul' });
    const l1 = (await getAll()).body.brands;
    const ids = l1.map((b) => b.id);
    const moved = [ids[3], ...ids.filter((x) => x !== ids[3])];
    let r = await post({ action: 'order', ids: moved });
    eq(r.status, 200); eq(r.body.changed, 11);
    deq((await getAll()).body.brands.map((b) => b.id), moved, 'DECENTRO is first now');
    const stamp = S.rows.find((x) => String(x.id) === moved[0]).updated_at;
    eq(S.rows.find((x) => String(x.id) === moved[0]).updated_at, stamp, 'a move is not an edit');
    eq((await post({ action: 'order', ids: ['1', '1'] })).status, 400);
    eq((await post({ action: 'order', ids: 'x' })).status, 400);
    eq((await post({ action: 'order', ids: [moved[0]] }, 'rahul')).status, 403);
    r = await patch(moved[0], { color: 'red' });
    eq(r.status, 200); eq(r.body.brand.color, 'red'); deq(r.body.brand.fields, []);
    r = await patch(moved[0], { fields: F(10) });
    eq(r.body.brand.fields.length, 10); eq(r.body.brand.color, 'red', 'the colour stays');
    eq((await patch(moved[0], { fields: F(11) })).status, 400, 'an 11th field');
    eq((await patch(moved[0], { color: 'gold' })).status, 400);
    r = await patch(moved[0], { fields: [] });
    deq(r.body.brand.fields, [], 'all fields can be removed');
  });

  await t('rows of the first version: their two fields show as fields, and an edit of the fields empties the old columns for good', async () => {
    S.rows.push({ ...blank(), id: 50, founder_name: 'Old', brand_name: 'Jiva', bank_account_name: '', custom_field_1_label: 'GST Firm', custom_field_1_value: 'Jiva LLP', custom_field_2_label: '', custom_field_2_value: 'PayU', created_at: '2026-10-17T05:00:00Z', updated_at: '2026-10-17T05:00:00Z' });
    S.next = 51;
    let b = (await getOne(50)).body.brand;
    deq(b.fields, [{ label: 'GST Firm', value: 'Jiva LLP' }, { label: 'Custom Field 2', value: 'PayU' }]);
    b = (await patch(50, { color: 'blue' })).body.brand;
    eq(b.fields.length, 2, 'a colour change keeps the old fields');
    b = (await patch(50, { fields: [] })).body.brand;
    deq(b.fields, [], 'emptied, they do not come back');
    deq([S.rows[0].custom_field_1_label, S.rows[0].custom_field_2_value], ['', '']);
  });

  await t('before brand-directory.sql is run again: 503 with what to run, nothing broken', async () => {
    S.oldCols = true;
    const r = await getAll();
    eq(r.status, 503); eq(r.body.notInstalled, true); ok(/brand-directory\.sql once more/.test(r.body.error));
    eq((await post({ action: 'founder', founderName: 'X' })).status, 503);
    eq((await add(FULL)).status, 503);
  });

  console.error = oErr; console.log = oLog;
  console.log(`\nbrand-directory: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
