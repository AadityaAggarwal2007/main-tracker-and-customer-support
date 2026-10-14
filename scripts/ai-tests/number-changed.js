// "NC" (owner 2026-10-14: "number change ho gaya toh ussi number sa usko verified kardio, aga NC likh dio ki number
// change kara ha fir verify kia ha"). number-changed.ts on a fake order_address_changes table, and the wiring in the
// inbox list, the thread, the screens and the Mail customer card. Made-up panel ids: every panel the same.
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true }, fileName: filename }).outputText, filename);
const eq = assert.strictEqual, deq = assert.deepStrictEqual, ok = assert.ok;
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

const last10 = (x) => String(x || '').replace(/\D/g, '').slice(-10);
const S = { rows: [], sql: [], missing: false };
const fakes = {
  '@/lib/db': {
    query: async (sql, p) => {
      S.sql.push(sql);
      if (S.missing) throw Object.assign(new Error('relation "order_address_changes" does not exist'), { code: '42P01' });
      if (!/FROM order_address_changes h/.test(sql)) throw new Error('fake: ' + sql.slice(0, 60));
      // what the SQL asks: these panels and orders, an old phone, old and new differ; the newest per order
      const hits = S.rows.filter((r) => p[0].includes(r.panel) && p[1].includes(r.order_id) && r.old.phone && last10(r.old.phone) !== last10(r.new.phone))
        .sort((a, b) => b.at - a.at);
      const seen = new Set(), rows = [];
      for (const r of hits) { const k = r.panel + '|' + r.order_id; if (seen.has(k)) continue; seen.add(k); rows.push({ panel: r.panel, order_id: r.order_id, created_at: new Date(r.at), changed_by_name: r.by }); }
      return { rows };
    },
  },
};
const oR = Module._resolveFilename;
Module._resolveFilename = function (r, parent, ...x) { if (fakes[r]) return r; if (r.startsWith('@/')) return oR.call(this, path.join(SRC, r.slice(2)), parent, ...x); return oR.call(this, r, parent, ...x); };
const oL = Module._load; Module._load = function (r, ...x) { return fakes[r] || oL.call(this, r, ...x); };
const N = require(path.join(SRC, 'lib/chat/number-changed.ts'));

let pass = 0, fail = 0;
async function t(name, fn) {
  S.rows = []; S.sql = []; S.missing = false;
  const err = console.error; console.error = () => {};
  try { await fn(); console.error = err; pass++; console.log('  ok  ' + name); }
  catch (e) { console.error = err; fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 6).join('\n       ')); }
}

(async () => {
  console.log('number-changed: "NC" next to a verified customer whose order phone the team changed');

  await t('read: only a real phone change counts (an address-only edit or the same number written another way does not); the newest per order; per panel', async () => {
    const t0 = Date.parse('2026-10-14T06:00:00Z');
    S.rows = [
      { panel: 'pA1', order_id: '#11', old: { phone: '9876543210' }, new: { phone: '9988776655' }, by: 'Rahul', at: t0 },
      { panel: 'pA1', order_id: '#11', old: { phone: '9988776655' }, new: { phone: '9123456780' }, by: 'Anurag', at: t0 + 60000 },
      { panel: 'pA1', order_id: '#12', old: { phone: '9876543210' }, new: { phone: '+91 98765 43210' }, by: 'X', at: t0 },
      { panel: 'pA1', order_id: '#13', old: {}, new: { phone: '9876543210' }, by: 'X', at: t0 },
      { panel: 'pB2', order_id: '#11', old: { phone: '9000000000' }, new: { phone: '9000000001' }, by: 'Y', at: t0 },
    ];
    const m = await N.numberChanges([{ panel: 'pA1', order: '#11' }, { panel: 'pA1', order: '#12' }, { panel: 'pA1', order: '#13' }, { panel: null, order: '#14' }]);
    deq([...m.keys()], ['pA1|#11'], 'another panel\'s order with the same number is not this one');
    deq(m.get(N.ncKey('pA1', '#11')), { at: new Date(t0 + 60000).toISOString(), by: 'Anurag' });
    ok(/old_address->>'phone'/.test(S.sql[0]) && /<> RIGHT\(regexp_replace\(COALESCE\(h\.new_address->>'phone'/.test(S.sql[0]) && /DISTINCT ON \(h\.business_id, h\.order_id\)/.test(S.sql[0]));
  });

  await t('nothing asked = no query; the table missing = no tag, never an error', async () => {
    eq((await N.numberChanges([{ panel: null, order: null }])).size, 0); eq(S.sql.length, 0);
    S.missing = true;
    eq((await N.numberChanges([{ panel: 'pA1', order: '#11' }])).size, 0);
  });

  await t('wiring: the inbox list and the thread carry number_changed; the row, the header and the Mail card show NC; the light poll keeps it', async () => {
    const list = read('app/api/chat/conversations/route.ts');
    ok(/numberChanges\(/.test(list) && /r\.number_changed = /.test(list));
    const thread = read('app/api/chat/conversations/[id]/route.ts');
    ok(/conversation: \{ \.\.\.conversation, number_changed: numberChanged \}/.test(thread));
    ok(/number_changed: c\.number_changed \?\? null/.test(read('app/admin/chat/page.tsx')), 'the 3-second poll does not drop it');
    ok(/c\.verified_order_id && c\.number_changed && <span className="row-nc"/.test(read('app/admin/chat/_components/ConversationRow.tsx')));
    ok(/activeVerifiedOrder && activeConv\?\.number_changed && <NcChip/.test(read('app/admin/chat/_components/ThreadHeader.tsx')));
    ok(/o\.numberChanged && <span className="chip chip-warn"/.test(read('components/mail/CustomerCard.tsx')));
    ok(/o\.numberChanged = /.test(read('lib/chat/mail-customer.ts')));
  });

  console.log(`number-changed: ${pass} passed, ${fail} failed`);
  console.log(fail ? 'NUMBER-CHANGED: FAILED' : `NUMBER-CHANGED: ${pass} groups passed`);
  process.exit(fail ? 1 : 0);
})();
