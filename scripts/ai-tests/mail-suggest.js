// Suggestions + "Sudharo" in the Mail tab (owner 2026-10-13: "gmail pa grammer sudharna wala aur suggestion wala bhi
// dede"): the REAL mail-suggest.ts against a fake database (the mail store + Mail verification), and the wiring.
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, jsx: 'react-jsx' }, fileName: filename }).outputText, filename);
const eq = assert.strictEqual, deq = assert.deepStrictEqual, ok = assert.ok;

const S = {};
const NOW = Date.parse('2026-10-13T08:00:00Z');
function reset() {
  Object.assign(S, {
    store: [
      { box_id: 'b1', folder: 'inbox', uid: 10, uidvalidity: 1, gone: false, thread_id: 'T1', from_addr: 'ansh@gmail.com', to_addrs: [], subject: 'Address change', sent_at: '2026-10-12T05:00:00Z',
        body_text: 'Hi, please change my address to Rohini.\n\nOn Sun, 12 Oct 2026, VASTRIKA Support wrote:\n> old text' },
      { box_id: 'b1', folder: 'sent', uid: 4, uidvalidity: 1, gone: false, thread_id: 'T1', from_addr: 'help@brand.in', to_addrs: ['ansh@gmail.com'], subject: 'Re: Address change', sent_at: '2026-10-12T06:00:00Z',
        body_text: 'Hi Ansh, please share your order ID.\n> Hi, please change my address' },
      { box_id: 'b1', folder: 'inbox', uid: 11, uidvalidity: 1, gone: false, thread_id: 'T1', from_addr: 'ansh@gmail.com', to_addrs: [], subject: 'Re: Address change', sent_at: '2026-10-12T07:00:00Z', body_text: 'Order #1091, phone 9876543210' },
      { box_id: 'b1', folder: 'inbox', uid: 12, uidvalidity: 1, gone: false, thread_id: 'T9', from_addr: 'other@gmail.com', to_addrs: [], subject: 'x', sent_at: '2026-10-12T07:30:00Z', body_text: 'not this customer' },
      { box_id: 'b1', folder: 'inbox', uid: 13, uidvalidity: 1, gone: true, thread_id: 'T1', from_addr: 'ansh@gmail.com', to_addrs: [], subject: 'gone', sent_at: '2026-10-12T07:40:00Z', body_text: 'deleted in Gmail' },
    ],
    verified: { 'ansh@gmail.com': [{ order_id: '#1091' }] },
    sites: [{ id: 's7', panel: 'P1' }],
  });
}
reset();
const db = {
  queryOne: async (sql, p) => {
    const q = sql.replace(/\s+/g, ' ');
    if (/FROM mail_store WHERE box_id = \$1 AND folder = 'inbox' AND uid = \$2/.test(q)) { const r = S.store.find((x) => x.box_id === p[0] && x.folder === 'inbox' && x.uid === p[1]); return r ? { thread_id: r.thread_id, from_addr: r.from_addr } : null; }
    if (/SELECT id FROM sites WHERE tracker_business_id/.test(q)) { const s = S.sites.find((x) => x.panel === p[0]); return s ? { id: s.id } : null; }
    throw new Error('fake db one: ' + q.slice(0, 80));
  },
  query: async (sql, p) => {
    const q = sql.replace(/\s+/g, ' ');
    if (/FROM mail_store WHERE box_id = \$1 AND NOT gone AND sent_at >= \$2/.test(q)) {
      const rows = S.store.filter((x) => x.box_id === p[0] && !x.gone && Date.parse(x.sent_at) >= p[1].getTime?.() ? true : x.box_id === p[0] && !x.gone)
        .filter((x) => (p[2] && x.thread_id === p[2]) || (x.folder === 'inbox' && x.from_addr === p[3]) || (x.folder === 'sent' && x.to_addrs.includes(p[3])))
        .sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at)).slice(0, p[4]);
      return { rows };
    }
    if (/FROM mail_verifications v/.test(q)) return { rows: p[1].flatMap((e) => (S.verified[e] || []).map((v) => ({ email: e, order_id: v.order_id, verified_by_name: 'auto', verified_at: new Date(), chat_id: null }))) };
    throw new Error('fake db: ' + q.slice(0, 80));
  },
};
const fakes = { '@/lib/db': db };
const oR = Module._resolveFilename;
Module._resolveFilename = function (r, parent, ...x) { if (fakes[r]) return r; if (r.startsWith('@/')) return oR.call(this, path.join(SRC, r.slice(2)), parent, ...x); return oR.call(this, r, parent, ...x); };
const oL = Module._load; Module._load = function (r, ...x) { return fakes[r] || oL.call(this, r, ...x); };
const M = require(path.join(SRC, 'lib/chat/mail-suggest.ts'));

let pass = 0, fail = 0;
async function t(name, fn) {
  reset();
  const err = console.error; console.error = () => {};
  try { await fn(); console.error = err; pass++; console.log('  ok  ' + name); }
  catch (e) { console.error = err; fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 5).join('\n       ')); }
}

(async () => {
  console.log('mail-suggest: Suggestions and Sudharo in the Mail tab');

  await t('ownWords: the mail\'s own words, without the quoted original (Gmail "On ... wrote:", "> " lines, Outlook\'s Original Message / From:)', () => {
    eq(M.ownWords('Hi, change my address.\n\nOn Sun, 12 Oct 2026 at 10:00, Store wrote:\n> old'), 'Hi, change my address.');
    eq(M.ownWords('Thanks\n> quoted\nok'), 'Thanks\nok');
    eq(M.ownWords('Reply here\n-----Original Message-----\nFrom: x'), 'Reply here');
    eq(M.ownWords('From: me first line stays\nbody'), 'From: me first line stays\nbody');
    eq(M.ownWords('Hello\nFrom: Store <s@x.in>\nSent: Monday'), 'Hello');
    eq(M.ownWords(null), '');
    eq(M.ownWords('x'.repeat(3000)).length, 1500);
  });

  await t('context: the open mail\'s Gmail thread and the customer\'s other mails / our replies, oldest first, cut; theirs = visitor, ours = agent; never another customer or a mail that left Gmail; the sender\'s verified order', async () => {
    const c = await M.mailSuggestContext({ id: 'b1', panelId: 'P1', siteId: '' }, 10, NOW);
    deq(c.src.rows.map((r) => [r.id, r.sender, r.content]), [
      ['inbox:10', 'visitor', 'Hi, please change my address to Rohini.'],
      ['sent:4', 'agent', 'Hi Ansh, please share your order ID.'],
      ['inbox:11', 'visitor', 'Order #1091, phone 9876543210'],
    ]);
    eq(c.src.orderId, '#1091');
    deq([c.conv.id, c.conv.site_id, c.conv.tracker_business_id, c.conv.source, c.conv.verified_order_id], ['mail:b1:T1', 's7', 'P1', 'email', '#1091']);
    eq(c.address, 'ansh@gmail.com');
  });

  await t('context: an unverified sender gets no order (drafts carry no order facts); a mail not in the store = null', async () => {
    S.verified = {};
    const c = await M.mailSuggestContext({ id: 'b1', panelId: 'P1', siteId: 'sX' }, 10, NOW);
    eq(c.src.orderId, null); eq(c.conv.verified_order_id, null); eq(c.conv.site_id, 'sX');
    eq(await M.mailSuggestContext({ id: 'b1', panelId: 'P1' }, 999, NOW), null);
  });

  await t('wiring: Mail reply access on both routes, the same drafting and guards as Chat Support, nothing sent; the reply box has Suggestions + Sudharo', () => {
    const sug = fs.readFileSync(path.join(SRC, 'app/api/mail/suggest/route.ts'), 'utf8');
    const pol = fs.readFileSync(path.join(SRC, 'app/api/mail/polish/route.ts'), 'utf8');
    ok(/mailAccess\(request, [^)]*'reply'\)/.test(sug) && /suggestReplies\(ctx\.conv,[^;]*ctx\.src\)/.test(sug));
    ok(/mailAccess\(request, [^)]*'reply'\)/.test(pol) && /polishDraft\(/.test(pol) && /hasFormLink\(text\)/.test(pol));
    const run = fs.readFileSync(path.join(SRC, 'lib/chat/suggest-run.ts'), 'utf8');
    ok(/guardOptions\(parseOptions\(res\.content\)/.test(run), 'the same guards');
    ok(/if \(!orderId && !src\) return \{ error: 'Suggestions are for verified customers only' \}/.test(run), 'Chat Support still drafts for verified customers only');
    const reader = fs.readFileSync(path.join(SRC, 'components/mail/MailReader.tsx'), 'utf8');
    ok(/\/api\/mail\/suggest/.test(reader) && /\/api\/mail\/polish/.test(reader) && /Sudharo/.test(reader) && /Suggest a reply/.test(reader));
    const ins = fs.readFileSync(path.join(SRC, 'lib/chat/suggest.ts'), 'utf8');
    ok(/ask for the order ID and the full phone number on the order/.test(ins), 'no order facts = ask for the order ID + full phone');
  });

  console.log(`mail-suggest: ${pass} passed, ${fail} failed`);
  console.log(fail ? 'MAIL-SUGGEST: FAILED' : `MAIL-SUGGEST: ${pass} groups passed`);
  process.exit(fail ? 1 : 0);
})();
