// The chargeback Gmail in the Mail tab (owner 2026-10-13: customers write to the chargeback Gmail too; VASTRIKA and
// kurtiya share one): the REAL mail-cb-box.ts and mail-inbox.ts (mailboxesFor / mailboxFor) against a fake database.
// Nothing reads Gmail.
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, jsx: 'react-jsx' }, fileName: filename }).outputText, filename);
const eq = assert.strictEqual, deq = assert.deepStrictEqual, ok = assert.ok;

const S = {};
function reset() {
  Object.assign(S, {
    // chargeback_mailboxes: two panels on ONE Gmail, a third on its own
    cb: [
      { id: 'r1', business_id: 'P1', email: 'Disputes@Brand.in', app_password: 'pw1', panel_name: 'VASTRIKA', site: { id: 's1', name: 'VASTRIKA' } },
      { id: 'r2', business_id: 'P2', email: 'disputes@brand.in', app_password: 'pw2', panel_name: 'kurtiya', site: null },
      { id: 'r3', business_id: 'P3', email: 'cb@vastora.in', app_password: 'pw3', panel_name: 'vastora', site: { id: 's3', name: 'vastora' } },
    ],
    support: [{ id: 'se1', email: 'help@brand.in', app_password: 'x', site_id: 's1', site_name: 'VASTRIKA', panel_id: 'P1', panel_name: 'VASTRIKA' }],
    orders: [ // panel, order, email
      ['P1', '#1500', 'asha@gmail.com'], ['P2', '#1918', 'ravi@gmail.com'], ['P1', '#2000', 'both@gmail.com'], ['P2', '#2001', 'both@gmail.com'],
      ['P1', '#3000', 'x1@gmail.com'], ['P2', '#3000', 'x2@gmail.com'],
    ],
    verified: [['P2', 'mona@yahoo.com']],
    cbMissing: false, failOrders: false, sql: [],
  });
}
reset();
const one = (s) => s.replace(/\s+/g, ' ');
const db = {
  query: async (sql, p = []) => {
    const q = one(sql); S.sql.push(q);
    if (/FROM chargeback_mailboxes m LEFT JOIN businesses b/.test(q)) {
      if (S.cbMissing) throw Object.assign(new Error('relation "chargeback_mailboxes" does not exist'), { code: '42P01' });
      const rows = S.cb.filter((r) => !/WHERE m.id::text = \$1/.test(q) || r.id === p[0]);
      return { rows: rows.map((r) => ({
        id: 'cb:' + r.id, email: r.email, app_password: r.app_password, site_id: r.site ? r.site.id : null,
        site_name: r.site ? r.site.name : r.panel_name, panel_id: r.business_id, panel_name: r.panel_name,
        shared_with: S.cb.filter((o) => o.id !== r.id && o.email.toLowerCase() === r.email.toLowerCase()).map((o) => o.panel_name),
      })) };
    }
    if (/FROM chargeback_mailboxes m JOIN chargeback_mailboxes o/.test(q)) {
      const me = S.cb.find((r) => r.id === p[0]);
      return { rows: me ? S.cb.filter((o) => o.email.toLowerCase() === me.email.toLowerCase()).map((o) => ({ business_id: o.business_id })) : [] };
    }
    if (/FROM site_emails se/.test(q)) return { rows: S.support.filter((b) => !/WHERE se.id = \$1/.test(q) || b.id === p[0]) };
    if (/lower\(btrim\(customer_email\)\) AS email, business_id::text AS panel FROM orders/.test(q)) {
      if (S.failOrders) throw new Error('db down');
      return { rows: S.orders.filter(([pn, , e]) => p[0].includes(pn) && p[1].includes(e)).map(([pn, , e]) => ({ email: e, panel: pn })) };
    }
    if (/AS panel FROM mail_verifications/.test(q)) return { rows: S.verified.filter(([pn, e]) => p[0].includes(pn) && p[1].includes(e)).map(([pn, e]) => ({ email: e, panel: pn })) };
    if (/SELECT DISTINCT order_id, business_id::text AS panel FROM orders/.test(q)) {
      return { rows: S.orders.filter(([pn, o]) => p[0].includes(pn) && p[1].includes(o)).map(([pn, o]) => ({ order_id: o, panel: pn })) };
    }
    if (/FROM mail_verifications v/.test(q)) return { rows: (S.mv || []).filter((v) => v.panel === p[0] && p[1].includes(v.email)).map((v) => ({ email: v.email, order_id: v.order, verified_by_name: 'auto', verified_at: new Date(), chat_id: null })) };
    if (/SELECT c.id, c.status, c.verified_order_id, c.case_kind FROM conversations c/.test(q)) {
      const rows = (S.chats || []).filter((c) => c.panel === p[0] && c.visitor === p[1] && c.source === 'email');
      rows.sort((a, b) => (b.verified_order_id === p[2]) - (a.verified_order_id === p[2]));
      return { rows: rows.slice(0, 1) };
    }
    if (/^ ?UPDATE conversations SET verified_order_id = \$2/.test(q)) {
      const c = S.chats.find((x) => x.id === p[0]);
      if (c.verified_order_id !== p[1]) c.verified_via = 'mail';
      c.verified_order_id = p[1]; if (c.status === 'resolved') c.status = 'agent_handling'; return { rows: [], rowCount: 1 };
    }
    if (/SELECT s.id FROM sites s WHERE s.tracker_business_id/.test(q)) return { rows: (S.sites || []).filter((x) => x.panel === p[0]).map((x) => ({ id: x.id })).slice(0, 1) };
    if (/INSERT INTO conversations/.test(q)) {
      const id = 'new' + ((S.chats || []).length + 1);
      S.chats.push({ id, panel: (S.sites.find((x) => x.id === p[0]) || {}).panel, site: p[0], visitor: p[1], source: 'email', status: 'agent_handling', verified_order_id: p[3], verified_via: 'mail', case_kind: null });
      return { rows: [{ id }] };
    }
    throw new Error('fake db: ' + q.slice(0, 90));
  },
  queryOne: async () => null,
};
const fakes = {
  '@/lib/db': db,
  './email': { buildEmailHtml: () => '', sendEmailReply: async () => ({}) },
  './imap-pool': { PoolTimeout: class extends Error {}, withPooledImap: async () => { throw new Error('no Gmail in tests'); } },
  mailparser: { simpleParser: async () => ({}) },
};
const oR = Module._resolveFilename;
Module._resolveFilename = function (r, parent, ...x) { if (fakes[r]) return r; if (r.startsWith('@/')) return oR.call(this, path.join(SRC, r.slice(2)), parent, ...x); return oR.call(this, r, parent, ...x); };
const oL = Module._load; Module._load = function (r, ...x) { return fakes[r] || oL.call(this, r, ...x); };
const C = require(path.join(SRC, 'lib/chat/mail-cb-box.ts'));
const CC = require(path.join(SRC, 'lib/chat/mail-case-chat.ts'));
const I = require(path.join(SRC, 'lib/chat/mail-inbox.ts'));

const owner = { role: 'admin', businessIds: null };
const member = (ids) => ({ role: 'agent', username: 'rahul', businessIds: ids, permissions: ['mail.view', 'mail.reply'] });
const mail = (uid, fromAddress, subject = 'Hello', snippet = '') => ({ uid, fromAddress, subject, snippet });

let pass = 0, fail = 0;
async function t(name, fn) {
  reset();
  const err = console.error, log = console.log; console.error = () => {}; console.log = () => {};
  try { await fn(); console.error = err; console.log = log; pass++; console.log('  ok  ' + name); }
  catch (e) { console.error = err; console.log = log; fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 5).join('\n       ')); }
}

(async () => {
  console.log('mail-cb-box: the chargeback Gmail in the Mail tab, split by panel when two panels share it');

  await t('rules: a cb: id, and a mail is another panel\'s only when proven (the address wins, then the order; unknown = keep)', () => {
    eq(C.isCbBox('cb:r1'), true); eq(C.isCbBox('se1'), false); eq(C.isCbBox(null), false); eq(C.cbRowId('cb:r1'), 'r1');
    eq(C.belongsElsewhere('P1', ['P2'], []), true);
    eq(C.belongsElsewhere('P1', ['P1', 'P2'], []), false);
    eq(C.belongsElsewhere('P1', ['P1'], ['P2']), false, 'the address beats the order number');
    eq(C.belongsElsewhere('P1', [], ['P2']), true);
    eq(C.belongsElsewhere('P1', [], ['P1', 'P2']), false);
    eq(C.belongsElsewhere('P1', [], []), false);
  });

  await t('boxes: the chargeback Gmail is a box of its panel next to the support Gmail (kind, sharedWith); a member sees only their panels\' ones; no table = none', async () => {
    const all = await I.mailboxesFor(owner);
    deq(all.map((b) => [b.id, b.kind || 'support', b.panelId]), [['se1', 'support', 'P1'], ['cb:r1', 'chargeback', 'P1'], ['cb:r2', 'chargeback', 'P2'], ['cb:r3', 'chargeback', 'P3']]);
    deq(all.find((b) => b.id === 'cb:r1').sharedWith, ['kurtiya']);
    deq(all.find((b) => b.id === 'cb:r3').sharedWith, []);
    eq(all.find((b) => b.id === 'cb:r2').siteName, 'kurtiya', 'a panel without a chat site replies as its own name');
    ok(all.every((b) => !('appPassword' in b)), 'never the App Password in the list');
    deq((await I.mailboxesFor(member(['P2']))).map((b) => b.id), ['cb:r2']);
    const one = await I.mailboxFor(member(['P1']), 'cb:r1');
    eq(one.email, 'Disputes@Brand.in'); eq(one.appPassword, 'pw1'); eq(one.panelId, 'P1');
    eq(await I.mailboxFor(member(['P1']), 'cb:r2'), null, 'another panel\'s chargeback box looks missing');
    eq(await I.mailboxFor(member(['P1']), 'cb:nope'), null);
    eq((await I.mailboxFor(owner, 'se1')).id, 'se1', 'a support box still opens');
    S.cbMissing = true;
    deq((await I.mailboxesFor(owner)).map((b) => b.id), ['se1']);
    eq(await I.mailboxFor(owner, 'cb:r1'), null);
  });

  await t('split: in a shared Gmail, a mail proven to be the other panel\'s is left out; both / unknown / gateway mails stay in both', async () => {
    const mails = [
      mail(1, 'Asha@Gmail.com'),                                   // P1's customer
      mail(2, 'ravi@gmail.com'),                                   // P2's customer
      mail(3, 'both@gmail.com'),                                   // a customer of both
      mail(4, 'new@gmail.com', 'Needed update on order #1918'),    // unknown address, order only P2 has
      mail(5, 'new2@gmail.com', 'Where is order 3000?'),           // unknown address, order both have
      mail(6, 'noreply@payu.in', 'Chargeback raised'),            // a gateway
      mail(7, 'mona@yahoo.com'),                                   // verified in P2's Mail
      mail(8, 'asha@gmail.com', 'about #1918'),                    // P1's address, P2's order number: the address wins
    ];
    deq(Array.from(await C.hiddenForPanel('cb:r1', 'P1', mails)).sort(), [2, 4, 7]);
    deq(Array.from(await C.hiddenForPanel('cb:r2', 'P2', mails)).sort(), [1, 8]);
  });

  await t('split: a Gmail of one panel, a support box, no panel or a failed read hides nothing', async () => {
    const mails = [mail(2, 'ravi@gmail.com'), mail(4, 'new@gmail.com', 'order #1918')];
    eq((await C.hiddenForPanel('cb:r3', 'P3', mails)).size, 0, 'not shared');
    eq((await C.hiddenForPanel('se1', 'P1', mails)).size, 0, 'a support Gmail');
    eq((await C.hiddenForPanel('cb:r1', null, mails)).size, 0);
    S.failOrders = true;
    eq((await C.hiddenForPanel('cb:r1', 'P1', mails)).size, 0, 'nobody is hidden by a failed read');
  });

  await t('wiring: the list route hides in both paths, the sync and the outbox know the chargeback boxes, the screen shows them as buttons', () => {
    const route = fs.readFileSync(path.join(SRC, 'app/api/mail/messages/route.ts'), 'utf8');
    eq((route.match(/hiddenForPanel\(a\.box\.id, a\.box\.panelId/g) || []).length, 2);
    const sync = fs.readFileSync(path.join(SRC, 'lib/chat/mail-sync.ts'), 'utf8');
    ok(/const cb = \(await cbBoxRows\(\)\)/.test(sync));
    const outbox = fs.readFileSync(path.join(SRC, 'lib/chat/mail-outbox.ts'), 'utf8');
    ok(/if \(isCbBox\(boxId\)\)/.test(outbox), 'a reply from the chargeback box goes from that Gmail');
    const card = fs.readFileSync(path.join(SRC, 'components/MailCard.tsx'), 'utf8');
    ok(/Chargeback Gmail/.test(card) && /mail-boxtabs/.test(card) && /Shared with/.test(card));
    const poll = fs.readFileSync(path.join(SRC, 'lib/chargeback/poll.ts'), 'utf8');
    ok(/search\(\{ uid: `\$\{last \+ 1\}:\*` \}\)/.test(poll), 'the chargeback poller reads by uid, so the Mail tab marking read changes nothing for it');
  });


  await t('case chat (owner 13 Oct, Anurag): Refund / Ship again from Mail always gets the verified sender\'s email chat: an unverified one is verified, a Closed one reopened, none = made; never for an unverified order, never re-points a chat marked for another order', async () => {
    S.mv = [{ panel: 'P2', email: 'mohit@gmail.com', order: '#1948' }, { panel: 'P2', email: 'new@gmail.com', order: '#2001' }, { panel: 'P2', email: 'two@gmail.com', order: '#3000' }];
    S.sites = [{ id: 's2', panel: 'P2' }];
    S.chats = [
      { id: 'e1', panel: 'P2', visitor: 'email:mohit@gmail.com', source: 'email', status: 'resolved', verified_order_id: null, case_kind: null },
      { id: 'e2', panel: 'P2', visitor: 'email:two@gmail.com', source: 'email', status: 'agent_handling', verified_order_id: '#2999', case_kind: 'refund' },
    ];
    const box = { panelId: 'P2', siteId: 's2' };
    const a = await CC.ensureMailCaseChat(box, 'mohit@gmail.com', '1948');
    deq(a, { ok: true, chatId: 'e1', created: false });
    const e1 = S.chats.find((c) => c.id === 'e1');
    eq(e1.verified_order_id, '#1948'); eq(e1.verified_via, 'mail'); eq(e1.status, 'agent_handling');
    const b = await CC.ensureMailCaseChat(box, 'new@gmail.com', '#2001');
    eq(b.created, true); const nb = S.chats.find((c) => c.id === b.chatId);
    deq([nb.visitor, nb.source, nb.verified_order_id, nb.verified_via, nb.site], ['email:new@gmail.com', 'email', '#2001', 'mail', 's2']);
    const c = await CC.ensureMailCaseChat(box, 'two@gmail.com', '#3000');
    eq(c.created, true, 'a chat marked for another order is never re-pointed');
    eq(S.chats.find((x) => x.id === 'e2').verified_order_id, '#2999');
    const d = await CC.ensureMailCaseChat(box, 'mohit@gmail.com', '#9999');
    deq([d.ok, d.status], [false, 409]);
    const e = await CC.ensureMailCaseChat({ panelId: 'P1' }, 'mohit@gmail.com', '#1948');
    eq(e.ok, false, 'verified in another panel only');
    const card = fs.readFileSync(path.join(SRC, 'components/mail/CustomerCard.tsx'), 'utf8');
    ok(/\/api\/mail\/case-chat/.test(card) && !/o\.emailChat && !o\.emailChat\.caseKind && customer\?\.cases && o\.emailChat\.verified/.test(card), 'the buttons no longer need an existing verified email chat');
    const route = fs.readFileSync(path.join(SRC, 'app/api/mail/case-chat/route.ts'), 'utf8');
    ok(/can\(a\.user, 'chat\.cases'\)/.test(route) && /mailAccess\(request/.test(route));
  });

  console.log(`mail-cb-box: ${pass} passed, ${fail} failed`);
  console.log(fail ? 'MAIL-CB-BOX: FAILED' : `MAIL-CB-BOX: ${pass} groups passed`);
  process.exit(fail ? 1 : 0);
})();
