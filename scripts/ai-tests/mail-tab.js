// The Mail tab (owner 2026-10-08): the REAL /api/mail/* routes, mail-access.ts, mail-inbox.ts, mail-view.ts,
// mailbox-status.ts, permissions.ts and the real mailparser, against a fake Gmail (IMAP), a fake database and a
// fake SMTP. Nothing here touches a real mailbox or database.
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');

const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true }, fileName: filename }).outputText, filename);

// ── a small mailbox ────────────────────────────────────────────────────────────────────────────
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4 fake invoice bytes');
const plain = (id, from, subject, body, extra = '') => `From: ${from}\r\nTo: Vastora Support <vastora@store.example>\r\nSubject: ${subject}\r\nMessage-ID: <${id}@mail.example>\r\nDate: Wed, 07 Oct 2026 10:00:00 +0000\r\n${extra}Content-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
const html = [
  'From: Bob Buyer <bob@example.com>', 'Reply-To: Bob Buyer <bob.reply@example.com>', 'To: vastora@store.example', 'Subject: Invoice and photo',
  'Message-ID: <m12@mail.example>', 'References: <m0@mail.example>', 'Date: Tue, 06 Oct 2026 08:00:00 +0000', 'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="B1"', '', '--B1', 'Content-Type: multipart/related; boundary="B2"', '',
  '--B2', 'Content-Type: text/html; charset=utf-8', '',
  '<p onclick="steal()">Hello <b>team</b></p><script>alert(1)</script><iframe src="https://evil.example"></iframe><img src="cid:logo1"><img src="https://tracker.example/pixel.gif"><a href="https://shiptrack.store/x">link</a>',
  '--B2', 'Content-Type: image/png', 'Content-ID: <logo1>', 'Content-Disposition: inline; filename="logo.png"', 'Content-Transfer-Encoding: base64', '', PNG.toString('base64'),
  '--B2--', '--B1', 'Content-Type: application/pdf; name="invoice.pdf"', 'Content-Disposition: attachment; filename="invoice.pdf"', 'Content-Transfer-Encoding: base64', '', PDF.toString('base64'),
  '--B1--', ''].join('\r\n');

const S = {};
function reset(over = {}) {
  Object.assign(S, {
    msgs: [
      { uid: 11, seen: false, answered: false, date: '2026-10-07T10:00:00Z', from: { name: 'Alice', address: 'alice@example.com' }, subject: 'Where is my order?', source: plain('m11', 'Alice <alice@example.com>', 'Where is my order?', 'Hi, order #1001 has not come.') },
      { uid: 12, seen: true, answered: false, date: '2026-10-06T08:00:00Z', from: { name: 'Bob Buyer', address: 'bob@example.com' }, subject: 'Invoice and photo', source: html, attachment: true },
      { uid: 13, seen: false, answered: false, date: '2026-10-08T09:00:00Z', from: { name: '', address: 'cust@example.com' }, subject: 'Refund please', source: plain('m13', 'cust@example.com', 'Refund please', 'Please refund.') },
      { uid: 14, seen: false, answered: false, date: '2026-10-08T09:30:00Z', from: { name: 'Vastora', address: 'vastora@store.example' }, subject: 'Own copy', source: plain('m14', 'vastora@store.example', 'Own copy', 'x') },
    ],
    sentbox: [
      { uid: 501, from: { name: 'Vastora Support', address: 'vastora@store.example' }, to: { name: 'Cust', address: 'cust@example.com' }, subject: 'Re: Refund please', date: '2026-10-08T10:00:00Z', seen: true, source: plain('s501', 'Vastora Support <vastora@store.example>', 'Re: Refund please', 'We are checking your order.') },
      { uid: 502, from: { name: 'Vastora Support', address: 'vastora@store.example' }, to: { name: 'Other', address: 'other@example.com' }, subject: 'Hello other', date: '2026-10-07T10:00:00Z', seen: true, source: plain('s502', 'x@y.z', 'Hello other', 'x') },
    ], noSent: false,
    authFail: false, connects: [], locks: [], searches: [], fetchQueries: [], fetchOneOpts: [], logouts: 0, closes: 0, sent: [], flagCalls: [],
    boxes: [
      { id: 'boxV', email: 'vastora@store.example', app_password: 'SECRETSECRETSECR', site_id: 'siteV', site_name: 'Vastora', panel_id: 'bizV', panel_name: 'vastora' },
      { id: 'boxK', email: 'kurtiya@store.example', app_password: 'OTHERSECRETOTHER', site_id: 'siteK', site_name: 'Kurtiya', panel_id: 'bizK', panel_name: 'kurtiya' },
    ],
    orders: [{ order_id: '#1553', phone: '9876543210', panel: 'bizV', name: 'Priya' }, { order_id: '#7000', phone: '9111111111', panel: 'bizK', name: 'Other' }],
    ver: [], convUpdates: [], missingTable: false, chatFor: 'chat-1', orderEmails: [], pass: {},
    chat: { site_id: 'siteV', business_id: 'bizV', verified_order_id: '#1553', verified_via: 'form' },
    orderLookups: 0,
  }, over);
}
reset();

const gone = () => Object.assign(new Error('relation "mail_verifications" does not exist'), { code: '42P01' });
const db = {
  query: async (sql, params) => {
    if (/FROM site_emails se/.test(sql)) {
      const rows = /WHERE se\.id = \$1/.test(sql) ? S.boxes.filter((b) => b.id === params[0])
        : /WHERE s\.id = \$1/.test(sql) ? S.boxes.filter((b) => b.site_id === params[0]) : S.boxes;
      return { rows, rowCount: rows.length };
    }
    if (/mail_verifications/.test(sql) && S.missingTable) throw gone();
    if (/INSERT INTO mail_verifications/.test(sql)) {
      const row = { business_id: params[0], email: params[1], order_id: params[2], verified_by: params[3], verified_by_name: params[4], removed: false };
      const old = S.ver.find((v) => v.business_id === row.business_id && v.email === row.email && v.order_id === row.order_id);
      if (/DO NOTHING/.test(sql)) { if (old) return { rows: [], rowCount: 0 }; S.ver.push(row); return { rows: [], rowCount: 1 }; }
      if (old) Object.assign(old, row); else S.ver.push(row);
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT lower\(customer_email\) AS email, order_id FROM orders/.test(sql)) {
      const rows = S.orderEmails.filter((o) => (o.panel || 'bizV') === params[0] && params[1].includes(o.email));
      return { rows, rowCount: rows.length };
    }
    if (/removed_at IS NOT NULL AND email = ANY/.test(sql)) {
      const rows = S.ver.filter((v) => v.removed && v.business_id === params[0] && params[1].includes(v.email)).map((v) => ({ email: v.email }));
      return { rows, rowCount: rows.length };
    }
    if (/FROM mail_verifications v/.test(sql)) {
      const rows = S.ver.filter((v) => !v.removed && v.business_id === params[0] && params[1].includes(v.email))
        .map((v) => ({ email: v.email, order_id: v.order_id, verified_by_name: v.verified_by_name, verified_at: '2026-10-08T12:00:00Z', chat_id: S.chatFor }));
      return { rows, rowCount: rows.length };
    }
    if (/SELECT email FROM mail_verifications/.test(sql)) {
      const rows = S.ver.filter((v) => !v.removed && v.business_id === params[0] && v.order_id === params[1]).map((v) => ({ email: v.email }));
      return { rows, rowCount: rows.length };
    }
    if (/UPDATE mail_verifications SET removed_at/.test(sql)) {
      const v = S.ver.find((x) => !x.removed && x.business_id === params[0] && x.email === params[1] && x.order_id === params[2]);
      if (v) { v.removed = true; v.removed_by = params[3]; }
      return { rows: [], rowCount: v ? 1 : 0 };
    }
    if (/UPDATE conversations c SET verified_order_id = \$1/.test(sql)) { S.convUpdates.push({ kind: 'verify', params, sql }); return { rows: [], rowCount: 1 }; }
    if (/UPDATE conversations c SET verified_order_id = NULL/.test(sql)) { S.convUpdates.push({ kind: 'unverify', params }); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  },
  queryOne: async (sql, params) => {
    if (/FROM orders o/.test(sql) && /customer_mobile/.test(sql)) {
      S.orderLookups++;
      const id = String(params[0]).replace(/\\/g, '').replace(/[^0-9]/g, '');
      const o = S.orders.find((x) => x.order_id.replace(/\D/g, '') === id && x.phone === params[1] && x.panel === params[2]);
      return o ? { order_id: o.order_id, customer_name: o.name } : null;
    }
    if (/FROM conversations c JOIN sites s ON s\.id = c\.site_id WHERE c\.id = \$1/.test(sql)) return params[0] === 'chat-1' ? S.chat : (params[0] === 'chat-other' ? { ...S.chat, site_id: 'siteK', business_id: 'bizK' } : null);
    return null;
  },
  getPool: () => ({}),
};
const authState = { user: null };
const STUBS = {
  'lib/db.ts': db,
  'lib/auth.ts': { getAuthFromRequest: () => authState.user },
  'lib/chat/ai.ts': { getAIResponse: async () => ({}) },
  'lib/chat/brain-usage.ts': { recordBrainUsage: async () => {} },
  'lib/chat/chikki-runs.ts': { recordChikkiRun: async () => {} },
  'lib/chat/subject.ts': { updateConversationSubject: async () => {} },
  'lib/chat/health.ts': { updateConversationHealth: async () => {} },
  'lib/chat/verified.ts': { chatIsVerified: async () => false },
  'lib/chat/chat-history.ts': { recentVisitorMessages: async () => [] },
  'lib/chat/holidays.ts': { loadHolidays: async () => [] },
  'lib/chat/email-draft-mode.ts': { emailDraftOnly: async () => true },
};
const PKG_STUBS = {
  imapflow: {
    ImapFlow: class {
      constructor(o) { this.user = o.auth.user; this.usable = false; this.handlers = {}; }
      on(ev, fn) { this.handlers[ev] = fn; return this; }
      async connect() { S.connects.push(this.user); if (S.connectDelay) await new Promise((r) => setTimeout(r, S.connectDelay)); this.usable = true; if (S.authFail) { const e = new Error('Invalid credentials (Failure)'); e.authenticationFailed = true; throw e; } }
      async list() { return S.noSent ? [{ path: 'INBOX', specialUse: '\\Inbox' }] : [{ path: 'INBOX', specialUse: '\\Inbox' }, { path: '[Gmail]/Sent Mail', specialUse: '\\Sent' }]; }
      get box() { return this.path === '[Gmail]/Sent Mail' ? S.sentbox : S.msgs; }
      async getMailboxLock(box, o) { if (S.lockFailOnce && this.reusedOnce) { S.lockFailOnce = false; throw new Error('Connection not available'); } this.reusedOnce = true; this.path = box; S.locks.push({ box, readOnly: !!(o && o.readOnly) }); return { release() {} }; }
      async search(q) { S.searches.push(q); const l = this.box; return l.map((m, i) => i + 1).filter((i) => (!q.from || l[i - 1].from.address === q.from) && (!q.to || (l[i - 1].to && l[i - 1].to.address === q.to))); }
      fetch(seqs, q) {
        S.fetchQueries.push(q);
        const list = seqs.map((s) => this.box[s - 1]);
        return (async function* () {
          for (const m of list) {
            yield {
              uid: m.uid, flags: new Set([...(m.seen ? ['\\Seen'] : []), ...(m.answered ? ['\\Answered'] : [])]),
              envelope: { from: [m.from], to: m.to ? [m.to] : [], subject: m.subject, date: new Date(m.date) },
              bodyStructure: m.attachment ? { childNodes: [{ disposition: 'inline' }, { disposition: 'attachment' }] } : { type: 'text/plain' },
              headers: S.pass[m.uid] ? Buffer.from('Authentication-Results: mx.google.com;\r\n dkim=pass header.i=@example.com;\r\n dmarc=pass (p=NONE) header.from=example.com\r\n') : undefined,
            };
          }
        })();
      }
      async fetchOne(uid, q, o) {
        assert.ok(o && o.uid, 'a single mail is fetched by UID');
        const m = this.box.find((x) => String(x.uid) === String(uid));
        if (!m) return false;
        S.fetchOneOpts = (S.fetchOneOpts || []); S.fetchOneOpts.push(q.source);
        const full = Buffer.from(S.pass[m.uid] ? 'Authentication-Results: mx.google.com; dmarc=pass header.from=example.com\r\n' + m.source : m.source); const max = q.source && q.source.maxLength;
        return { source: max ? full.subarray(0, max) : full, flags: new Set([...(m.seen ? ['\\Seen'] : []), ...(m.answered ? ['\\Answered'] : [])]) };
      }
      async messageFlagsAdd(uid, flags) { S.flagCalls.push(['add', Number(uid), flags]); const m = S.msgs.find((x) => x.uid === Number(uid)); if (flags.includes('\\Seen')) m.seen = true; if (flags.includes('\\Answered')) m.answered = true; return true; }
      async messageFlagsRemove(uid, flags) { S.flagCalls.push(['remove', Number(uid), flags]); const m = S.msgs.find((x) => x.uid === Number(uid)); if (flags.includes('\\Seen')) m.seen = false; return true; }
      async logout() { S.logouts++; this.usable = false; }
      close() { S.closes++; this.usable = false; }
    },
  },
  nodemailer: { default: { createTransport: () => ({ sendMail: async (o) => { S.sent.push(o); } }) }, createTransport: () => ({ sendMail: async (o) => { S.sent.push(o); } }) },
  imap: class {},
};
const origLoad = Module._load, origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith('@/')) request = path.join(SRC, request.slice(2));
  return origResolve.call(this, request, parent, ...rest);
};
Module._load = function (request, parent, isMain) {
  if (PKG_STUBS[request]) return PKG_STUBS[request];
  let file = null;
  try { file = Module._resolveFilename(request, parent); } catch { /* a package */ }
  if (file && file.startsWith(SRC)) { const rel = path.relative(SRC, file); if (STUBS[rel]) return STUBS[rel]; }
  return origLoad.call(this, request, parent, isMain);
};

const { NextRequest } = require('next/server');
const R = (p) => require(path.join(SRC, 'app/api/mail', p, 'route.ts'));
const boxes = R('boxes'), messages = R('messages'), message = R('message'), attachment = R('attachment'), send = R('send');
const view = require(path.join(SRC, 'lib/chat/mail-view.ts'));
const verifyRoute = R('verify'), byChat = R('by-chat');
const mverify = require(path.join(SRC, 'lib/chat/mail-verify.ts'));
const mstat = require(path.join(SRC, 'lib/chat/mailbox-status.ts'));
const perms = require(path.join(SRC, 'lib/permissions.ts'));

const req = (method, url, body) => new NextRequest(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const OWNER = { role: 'admin', username: 'owner', permissions: perms.resolvePermissions('admin'), businessIds: null };
const member = (extra = {}, role = 'agent') => ({ role, username: 'rahul', permissions: perms.resolvePermissions(role, extra.perms), businessIds: extra.panels ?? null });

let n = 0;
const pool = require(path.join(SRC, 'lib/chat/imap-pool.ts'));
const inbox = require(path.join(SRC, 'lib/chat/mail-inbox.ts'));
process.env.MAIL_CACHE_DIR = 'off';   // the copy stays in memory in the tests, except the disk group below
const mcache = require(path.join(SRC, 'lib/chat/mail-cache.ts'));
const t = async (name, fn) => { pool.closeAllImap(); inbox.forgetSentPaths(); mcache.clearMailServerCache(); reset(); mverify.resetVerifyLimits(); authState.user = OWNER; await fn(); n++; console.log('  ok  ' + name); };

(async () => {
  // ── pure parts ──────────────────────────────────────────────────────────────────────────────
  await t('permissions: mail ticks exist, no role has them, the Super Admin has both', () => {
    assert.ok(perms.PERMISSIONS.includes('mail.view') && perms.PERMISSIONS.includes('mail.reply'));
    for (const r of Object.keys(perms.ROLE_INFO)) assert.ok(!perms.ROLE_INFO[r].perms.some((p) => p.startsWith('mail.')), r + ' has no Mail tick by itself');
    assert.ok(perms.can(OWNER, 'mail.view') && perms.can(OWNER, 'mail.reply'));
    assert.ok(!perms.can(member(), 'mail.view'));
    assert.ok(perms.can(member({ perms: ['orders.view', 'mail.view'] }), 'mail.view'));
    assert.ok(perms.PERMISSION_GROUPS.some((g) => g.items.some((i) => i.key === 'mail.view')) && perms.PERMISSION_GROUPS.some((g) => g.items.some((i) => i.key === 'mail.reply')), 'both ticks show in Team');
  });
  await t('mail filters (owner 2026-10-08): each view, the counts, search by sender / subject / order number, order, previous / next', () => {
    const f = require(path.join(SRC, 'lib/chat/mail-filters.ts'));
    const NOW = Date.parse('2026-10-08T12:00:00');
    const it = (uid, o = {}) => ({ uid, from: 'Name ' + uid, fromAddress: `u${uid}@x.com`, subject: 'Hello', date: '2026-10-08T09:00:00', unread: false, hasAttachment: false, answered: false, ...o });
    const items = [it(1, { unread: true }), it(2, { hasAttachment: true, subject: 'Order #1553 problem', date: '2026-10-05T09:00:00' }), it(3, { answered: true, date: '2026-09-20T09:00:00' }), it(4, { from: 'Priya Sharma', fromAddress: 'priya@x.com' })];
    const ver = { 'u1@x.com': [{ orderId: '#1001' }], 'priya@x.com': [{ orderId: '#1553' }] };
    const ids = (view) => items.filter((x) => f.matchesView(x, view, ver, NOW)).map((x) => x.uid);
    assert.deepStrictEqual(ids('all'), [1, 2, 3, 4]); assert.deepStrictEqual(ids('unread'), [1]);
    assert.deepStrictEqual(ids('verified'), [1, 4]); assert.deepStrictEqual(ids('unverified'), [2, 3]);
    assert.deepStrictEqual(ids('replied'), [3]); assert.deepStrictEqual(ids('notreplied'), [1, 2, 4]);
    assert.deepStrictEqual(ids('attach'), [2]); assert.deepStrictEqual(ids('today'), [1, 4]); assert.deepStrictEqual(ids('week'), [1, 2, 4]);
    const c = f.viewCounts(items, ver, NOW); assert.strictEqual(c.all, 4); assert.strictEqual(c.verified + c.unverified, 4);
    const s = (q) => items.filter((x) => f.searchMatch(x, q, ver)).map((x) => x.uid);
    assert.deepStrictEqual(s('priya'), [4]); assert.deepStrictEqual(s('PRIYA@X'), [4]); assert.deepStrictEqual(s('hello'), [1, 3, 4]);
    assert.deepStrictEqual(s('1553'), [2, 4], 'the order number in the subject AND the verified order'); assert.deepStrictEqual(s('#1553'), [2, 4]); assert.deepStrictEqual(s('  '), [1, 2, 3, 4]);
    assert.deepStrictEqual(f.sortItems(items, 'unreadfirst').map((x) => x.uid), [1, 4, 2, 3]);
    assert.deepStrictEqual(f.sortItems(items, 'newest').map((x) => x.uid), [1, 4, 2, 3]); assert.deepStrictEqual(f.sortItems(items, 'oldest').map((x) => x.uid), [3, 2, 1, 4]);
    assert.strictEqual(f.neighbour(items, 2, 1), 3); assert.strictEqual(f.neighbour(items, 2, -1), 1); assert.strictEqual(f.neighbour(items, 4, 1), null); assert.strictEqual(f.neighbour(items, 99, 1), null);
    assert.deepStrictEqual(f.orderNumbersIn('Re: Order #1553 and # 2210, #12'), ['#1553', '#2210']);
    assert.strictEqual(f.initials('Priya Sharma <p@x.com>'), 'PS'); assert.strictEqual(f.initials(''), '?');
  });
  await t('mail-view: unread first then newest; uid parsing; subject; frame policy', () => {
    const l = view.sortMails([{ unread: false, date: '2026-10-08' }, { unread: true, date: '2026-10-01' }, { unread: true, date: '2026-10-07' }]);
    assert.deepStrictEqual(l.map((x) => x.date), ['2026-10-07', '2026-10-01', '2026-10-08']);
    assert.strictEqual(view.parseUid('12'), 12); assert.strictEqual(view.parseUid('1;DROP'), null); assert.strictEqual(view.parseUid('0'), null); assert.strictEqual(view.parseUid(-3), null);
    assert.strictEqual(view.replySubject('Hello'), 'Re: Hello'); assert.strictEqual(view.replySubject('RE: Hello'), 'RE: Hello'); assert.strictEqual(view.replySubject(''), 'Re: Your enquiry');
    const f = view.frameHtml('<p onclick="x()">a</p><script>bad()</script><base href="https://e.example"><form action="x"><input></form>');
    assert.ok(!/<script|onclick|<base|<form/i.test(f.slice(f.indexOf('<body>'))), 'script, handlers, base and forms are cut from the mail');
    assert.ok(f.includes('<base target="_blank">'), 'our own base keeps links in a new tab');
    assert.ok(/Content-Security-Policy[^>]*default-src 'none'/.test(f) && /img-src data:;/.test(f) && !/https:/.test(f.match(/Content-Security-Policy[^>]*/)[0]), 'no remote image by default');
    assert.ok(/img-src data: https:/.test(view.frameHtml('<p>x</p>', true)));
    assert.strictEqual(view.cleanReply('   ').ok, false); assert.strictEqual(view.cleanReply('x'.repeat(8001)).ok, false); assert.strictEqual(view.cleanReply(' hi ').text, 'hi');
    assert.strictEqual(view.sinceDate(Date.UTC(2026, 9, 8)).toISOString().slice(0, 10), '2026-09-08');
  });
  await t('mailbox-status: a check is remembered, an error is put in plain words, no raw server text', () => {
    mstat.noteMailboxCheck('x1', { ok: true, now: 1000 });
    mstat.noteMailboxCheck('x1', { ok: true, handled: 2, now: 2000 });
    assert.deepStrictEqual(mstat.getMailboxStatus('x1'), { checkedAt: 2000, ok: true, error: null, lastMailAt: 2000, received: 2 });
    mstat.noteMailboxCheck('x1', { ok: false, error: mstat.friendlyMailError('AUTHENTICATIONFAILED Invalid credentials abc'), now: 3000 });
    const s = mstat.getMailboxStatus('x1');
    assert.strictEqual(s.ok, false); assert.ok(/App Password/.test(s.error)); assert.ok(!/abc|AUTHENTICATIONFAILED/.test(s.error)); assert.strictEqual(s.lastMailAt, 2000);
    assert.strictEqual(mstat.getMailboxStatus('nope'), null);
  });

  await t('mailbox-status: ImapFlow\'s "Command failed" is read through Gmail\'s own reason (responseText / code)', () => {
    const e = Object.assign(new Error('Command failed'), { responseText: 'Invalid credentials (Failure)', authenticationFailed: true, code: 'AUTHENTICATIONFAILED' });
    const text = mstat.mailErrorText(e);
    assert.ok(/Command failed/.test(text) && /Invalid credentials/.test(text));
    assert.ok(/App Password/.test(mstat.friendlyMailError(text)));
    assert.ok(/too many connections/.test(mstat.friendlyMailError(mstat.mailErrorText(Object.assign(new Error('Command failed'), { responseText: 'Too many simultaneous connections. (Failure)' })))));
    assert.ok(/sign-in or an App Password/.test(mstat.friendlyMailError('Command failed | Application-specific password required')));
    assert.ok(/Could not read this mailbox/.test(mstat.friendlyMailError(mstat.mailErrorText(new Error('Command failed')))), 'nothing known: the plain fallback');
    assert.strictEqual(mstat.mailErrorText(null), '');
  });

  // ── who may open what ───────────────────────────────────────────────────────────────────────
  await t('no login: every Mail route answers 401', async () => {
    authState.user = null;
    assert.strictEqual((await boxes.GET(req('GET', '/api/mail/boxes'))).status, 401);
    assert.strictEqual((await messages.GET(req('GET', '/api/mail/messages?box=boxV'))).status, 401);
    assert.strictEqual((await message.GET(req('GET', '/api/mail/message?box=boxV&uid=11'))).status, 401);
    assert.strictEqual((await send.POST(req('POST', '/api/mail/send', { box: 'boxV', uid: 11, text: 'hi' }))).status, 401);
    assert.strictEqual(S.connects.length, 0, 'Gmail was never touched');
  });
  await t('a team member WITHOUT the Mail tick is refused everywhere (even a panel admin), Gmail untouched', async () => {
    for (const role of ['agent', 'manager', 'panel_admin']) {
      authState.user = member({}, role);
      assert.strictEqual((await boxes.GET(req('GET', '/api/mail/boxes'))).status, 403, role);
      assert.strictEqual((await messages.GET(req('GET', '/api/mail/messages?box=boxV'))).status, 403, role);
      assert.strictEqual((await message.GET(req('GET', '/api/mail/message?box=boxV&uid=11'))).status, 403, role);
      assert.strictEqual((await attachment.GET(req('GET', '/api/mail/attachment?box=boxV&uid=12&index=0'))).status, 403, role);
      assert.strictEqual((await send.POST(req('POST', '/api/mail/send', { box: 'boxV', uid: 11, text: 'hi' }))).status, 403, role);
    }
    assert.strictEqual(S.connects.length, 0);
  });
  await t('the Super Admin sees every panel\'s Gmail; the App Password is never in an answer', async () => {
    const res = await boxes.GET(req('GET', '/api/mail/boxes')); const text = await res.text();
    assert.strictEqual(res.status, 200); const d = JSON.parse(text);
    assert.deepStrictEqual(d.boxes.map((b) => b.email), ['vastora@store.example', 'kurtiya@store.example']);
    assert.ok(d.canReply === true && !/SECRET|app_password|appPassword/i.test(text));
    mstat.noteMailboxCheck('boxV', { ok: true, now: 5 });
    assert.strictEqual(JSON.parse(await (await boxes.GET(req('GET', '/api/mail/boxes'))).text()).boxes[0].status.ok, true, 'the poller status rides along');
  });
  await t('a member with Open Mail for ONE panel sees only that panel\'s Gmail; the other panel\'s box looks missing (404) on every route', async () => {
    authState.user = member({ perms: ['orders.view', 'mail.view'], panels: ['bizV'] });
    const d = await (await boxes.GET(req('GET', '/api/mail/boxes'))).json();
    assert.deepStrictEqual(d.boxes.map((b) => b.id), ['boxV']); assert.strictEqual(d.canReply, false);
    assert.strictEqual((await messages.GET(req('GET', '/api/mail/messages?box=boxK'))).status, 404);
    assert.strictEqual((await message.GET(req('GET', '/api/mail/message?box=boxK&uid=11'))).status, 404);
    assert.strictEqual((await attachment.GET(req('GET', '/api/mail/attachment?box=boxK&uid=12&index=0'))).status, 404);
    assert.strictEqual((await message.PATCH(req('PATCH', '/api/mail/message', { box: 'boxK', uid: 11, seen: false }))).status, 404);
    assert.strictEqual((await messages.GET(req('GET', '/api/mail/messages?box=nope'))).status, 404);
    assert.strictEqual(S.connects.length, 0, 'Gmail of the other panel was never opened');
    assert.strictEqual((await messages.GET(req('GET', '/api/mail/messages?box=boxV'))).status, 200);
    assert.deepStrictEqual(S.connects, ['vastora@store.example']);
  });
  await t('a member limited to panels, with the tick, cannot read a box whose panel is unknown to them (no panel id = denied)', async () => {
    S.boxes.push({ id: 'boxX', email: 'x@store.example', app_password: 'XXXXXXXXXXXXXXXX', site_name: 'Loose', panel_id: null, panel_name: null });
    authState.user = member({ perms: ['mail.view'], panels: ['bizV'] });
    assert.strictEqual((await messages.GET(req('GET', '/api/mail/messages?box=boxX'))).status, 404);
    authState.user = member({ perms: ['mail.view'], panels: null });
    assert.strictEqual((await messages.GET(req('GET', '/api/mail/messages?box=boxX'))).status, 200, 'a member of every panel may');
  });

  // ── reading ─────────────────────────────────────────────────────────────────────────────────
  await t('list: last 30 days, unread first (newest first), read-only, headers only, nothing stored, session closed', async () => {
    const res = await messages.GET(req('GET', '/api/mail/messages?box=boxV')); const d = await res.json();
    assert.strictEqual(res.status, 200); assert.strictEqual(d.days, 30);
    assert.deepStrictEqual(d.mails.map((m) => m.uid), [14, 13, 11, 12], 'unread by newest, then the read one');
    assert.strictEqual(d.unread, 3); assert.strictEqual(d.mails[3].hasAttachment, true); assert.strictEqual(d.mails[1].from, 'cust@example.com');
    const since = S.searches[0].since; assert.ok(since instanceof Date); const days = (Date.now() - since.getTime()) / 864e5; assert.ok(days > 29.9 && days < 30.1, 'SINCE is 30 days back');
    assert.ok(S.locks.every((l) => l.readOnly), 'listing never changes a flag');
    assert.ok(S.fetchQueries.every((q) => !q.source), 'no body is downloaded for the list'); assert.strictEqual(S.flagCalls.length, 0);
    assert.strictEqual(S.connects.length, 1, 'one connection, kept open for the next call'); assert.ok(!/SECRET/.test(JSON.stringify(d)));
  });
  await t('open an unread mail: it is marked read in Gmail; peek=1 leaves it unread; a missing mail is 404', async () => {
    let res = await message.GET(req('GET', '/api/mail/message?box=boxV&uid=11')); let d = await res.json();
    assert.strictEqual(res.status, 200); assert.strictEqual(d.mail.subject, 'Where is my order?'); assert.ok(d.mail.frame.includes('order #1001'));
    assert.deepStrictEqual(S.flagCalls, [['add', 11, ['\\Seen']]]); assert.strictEqual(S.msgs[0].seen, true);
    S.flagCalls.length = 0;
    res = await message.GET(req('GET', '/api/mail/message?box=boxV&uid=13&peek=1')); assert.strictEqual(res.status, 200);
    assert.strictEqual(S.flagCalls.length, 0); assert.strictEqual(S.msgs[2].seen, false); assert.ok(S.locks.at(-1).readOnly);
    assert.strictEqual((await message.GET(req('GET', '/api/mail/message?box=boxV&uid=999'))).status, 404);
    assert.strictEqual((await message.GET(req('GET', '/api/mail/message?box=boxV&uid=abc'))).status, 400);
  });
  await t('an HTML mail is made safe: no script / handler / frame, its own picture inline, remote picture blocked until asked, attachment listed', async () => {
    let d = await (await message.GET(req('GET', '/api/mail/message?box=boxV&uid=12'))).json(); const m = d.mail;
    assert.ok(!/<script|alert\(1\)|onclick|<iframe|evil\.example/i.test(m.frame), 'nothing active survives');
    assert.ok(m.frame.includes('data:image/png;base64,'), 'the cid picture comes from the mail itself');
    assert.ok(!m.frame.includes('cid:logo1'));
    assert.ok(/default-src 'none'/.test(m.frame) && !/img-src[^;]*https/.test(m.frame), 'remote pictures blocked');
    assert.strictEqual(m.remoteImages, true); assert.strictEqual(m.imagesShown, false);
    assert.ok(m.frame.includes('<b>team</b>') && m.frame.includes('https://shiptrack.store/x'));
    assert.strictEqual(m.attachments.filter((a) => !a.inline).length, 1); assert.strictEqual(m.attachments.find((a) => !a.inline).filename, 'invoice.pdf');
    assert.strictEqual(m.fromAddress, 'bob@example.com'); assert.ok(m.replyTo.includes('bob.reply@example.com'));
    d = await (await message.GET(req('GET', '/api/mail/message?box=boxV&uid=12&images=1'))).json();
    assert.ok(/img-src data: https:/.test(d.mail.frame) && d.mail.imagesShown === true);
    assert.strictEqual(S.flagCalls.length, 0, 'it was already read');
  });
  await t('Mark unread / Mark read change Gmail\'s flag; a bad body is 400', async () => {
    S.msgs[1].seen = true;
    let res = await message.PATCH(req('PATCH', '/api/mail/message', { box: 'boxV', uid: 12, seen: false }));
    assert.strictEqual(res.status, 200); assert.deepStrictEqual(S.flagCalls, [['remove', 12, ['\\Seen']]]); assert.strictEqual(S.msgs[1].seen, false);
    res = await message.PATCH(req('PATCH', '/api/mail/message', { box: 'boxV', uid: 12, seen: true })); assert.strictEqual(S.msgs[1].seen, true);
    assert.strictEqual((await message.PATCH(req('PATCH', '/api/mail/message', { box: 'boxV', uid: 12, seen: 'no' }))).status, 400);
    assert.strictEqual((await message.PATCH(req('PATCH', '/api/mail/message', { box: 'boxV', seen: true }))).status, 400);
  });
  await t('an attachment comes back only as a download (octet-stream, attachment, nosniff) with the right bytes; a bad index is 404', async () => {
    const mailRes = await (await message.GET(req('GET', '/api/mail/message?box=boxV&uid=12'))).json();
    const a = mailRes.mail.attachments.find((x) => !x.inline);
    const res = await attachment.GET(req('GET', `/api/mail/attachment?box=boxV&uid=12&index=${a.index}`));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'application/octet-stream'); assert.ok(/^attachment;/.test(res.headers.get('content-disposition'))); assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(PDF));
    assert.strictEqual((await attachment.GET(req('GET', '/api/mail/attachment?box=boxV&uid=12&index=9'))).status, 404);
    assert.strictEqual((await attachment.GET(req('GET', '/api/mail/attachment?box=boxV&uid=12&index=-1'))).status, 400);
  });
  await t('Gmail rejecting the App Password: a plain 502, no password and no raw error in the answer, the session is closed', async () => {
    S.authFail = true;
    const res = await messages.GET(req('GET', '/api/mail/messages?box=boxV')); const text = await res.text();
    assert.strictEqual(res.status, 502); assert.ok(/App Password/.test(text)); assert.ok(!/SECRET|Failure/.test(text)); assert.ok(S.logouts + S.closes >= 1);
  });

  // ── replying ────────────────────────────────────────────────────────────────────────────────
  await t('reply needs the Reply tick: Open Mail alone is 403 and nothing is sent', async () => {
    authState.user = member({ perms: ['mail.view'], panels: ['bizV'] });
    assert.strictEqual((await send.POST(req('POST', '/api/mail/send', { box: 'boxV', uid: 12, text: 'hello' }))).status, 403);
    assert.strictEqual(S.sent.length, 0);
  });
  await t('reply: goes from the box\'s Gmail to the Reply-To, threaded, subject Re:, link junk cut, mail marked Answered', async () => {
    authState.user = member({ perms: ['mail.view', 'mail.reply'], panels: ['bizV'] });
    const res = await send.POST(req('POST', '/api/mail/send', { box: 'boxV', uid: 12, text: 'Hi Bob, track it: https://shiptrack.store/track/abc?utm_source=chatgpt.com&x=1' }));
    assert.strictEqual(res.status, 200); assert.strictEqual((await res.json()).to, 'bob.reply@example.com');
    assert.strictEqual(S.sent.length, 1); const m = S.sent[0];
    assert.strictEqual(m.from, '"Vastora Support" <vastora@store.example>'); assert.strictEqual(m.to, 'bob.reply@example.com'); assert.strictEqual(m.subject, 'Re: Invoice and photo');
    assert.strictEqual(m.headers['In-Reply-To'], '<m12@mail.example>'); assert.ok(m.headers.References.includes('<m0@mail.example>') && m.headers.References.includes('<m12@mail.example>'));
    assert.ok(!/utm_source/.test(m.text) && /x=1/.test(m.text), 'copy-paste junk removed, the rest kept');
    assert.ok(m.text.startsWith('Hi Bob, track it:'), 'the typed text first, then the quote');
    assert.ok(S.flagCalls.some((c) => c[0] === 'add' && c[1] === 12 && c[2].includes('\\Answered')));
  });
  await t('reply refused: a form link (403), empty / too long text (400), a mail from the box\'s own address (400), another panel (404); nothing is sent', async () => {
    assert.strictEqual((await send.POST(req('POST', '/api/mail/send', { box: 'boxV', uid: 12, text: 'Fill https://forms.gle/abc123' }))).status, 403);
    assert.strictEqual((await send.POST(req('POST', '/api/mail/send', { box: 'boxV', uid: 12, text: 'See https://docs.google.com/forms/d/e/xyz/viewform' }))).status, 403);
    assert.strictEqual((await send.POST(req('POST', '/api/mail/send', { box: 'boxV', uid: 12, text: '   ' }))).status, 400);
    assert.strictEqual((await send.POST(req('POST', '/api/mail/send', { box: 'boxV', uid: 12, text: 'x'.repeat(9000) }))).status, 400);
    assert.strictEqual((await send.POST(req('POST', '/api/mail/send', { box: 'boxV', uid: 14, text: 'hello' }))).status, 400);
    assert.strictEqual((await send.POST(req('POST', '/api/mail/send', { box: 'boxV', uid: 999, text: 'hello' }))).status, 404);
    authState.user = member({ perms: ['mail.view', 'mail.reply'], panels: ['bizV'] });
    assert.strictEqual((await send.POST(req('POST', '/api/mail/send', { box: 'boxK', uid: 12, text: 'hello' }))).status, 404);
    assert.strictEqual(S.sent.length, 0);
  });


  // ── verifying a sender (owner 2026-10-08) ──────────────────────────────────────────────────
  const post = (body) => verifyRoute.POST(req('POST', '/api/mail/verify', body));
  const V = (over = {}) => ({ box: 'boxV', email: 'Cust@Example.com', orderId: '1553', phone: '98765 43210', ...over });
  await t('verify: Order ID + FULL phone matching one order of the panel verifies the sender; any member with Open Mail may; the phone is never stored or answered', async () => {
    authState.user = member({ perms: ['mail.view'], panels: ['bizV'] });
    const res = await post(V()); const text = await res.text(); const d = JSON.parse(text);
    assert.strictEqual(res.status, 200); assert.strictEqual(d.orderId, '#1553'); assert.strictEqual(d.chats, 1);
    assert.ok(!/9876543210|98765/.test(text + JSON.stringify(S.ver) + JSON.stringify(S.convUpdates)), 'no phone anywhere');
    assert.deepStrictEqual(S.ver.map((v) => [v.business_id, v.email, v.order_id, v.verified_by]), [['bizV', 'cust@example.com', '#1553', 'rahul']]);
    const u = S.convUpdates[0]; assert.strictEqual(u.kind, 'verify'); assert.deepStrictEqual([u.params[0], u.params[1], u.params[2]], ['#1553', 'bizV', 'email:cust@example.com']);
    assert.ok(/verified_via = 'mail'/.test(fs.readFileSync(path.join(SRC, 'lib/chat/mail-verify.ts'), 'utf8')), 'a team check, not the strict proof');
  });
  await t('verify: the Super Admin is recorded as owner; verifying again for the same order does not duplicate', async () => {
    assert.strictEqual((await post(V())).status, 200); assert.strictEqual((await post(V())).status, 200);
    assert.strictEqual(S.ver.length, 1); assert.strictEqual(S.ver[0].verified_by, 'owner');
  });
  await t('verify refused: wrong phone / wrong order / an order of ANOTHER panel (422, nothing saved); a short phone and an empty order are 400 and never reach the orders table', async () => {
    assert.strictEqual((await post(V({ phone: '9876543211' }))).status, 422);
    assert.strictEqual((await post(V({ orderId: '9999' }))).status, 422);
    assert.strictEqual((await post(V({ orderId: '7000', phone: '9111111111' }))).status, 422, 'kurtiya\'s order cannot verify in vastora');
    assert.strictEqual(S.ver.length, 0); assert.strictEqual(S.convUpdates.length, 0);
    const before = S.orderLookups;
    assert.strictEqual((await post(V({ phone: '98765' }))).status, 400); assert.strictEqual((await post(V({ orderId: '  ' }))).status, 400);
    assert.strictEqual((await post(V({ email: 'not-an-address' }))).status, 400);
    assert.strictEqual(S.orderLookups, before);
  });
  await t('verify: 10 wrong tries in a row and the 11th is stopped (429), even with the right answer; another login is not affected', async () => {
    for (let i = 0; i < 10; i++) assert.strictEqual((await post(V({ phone: '9000000000' }))).status, 422);
    assert.strictEqual((await post(V())).status, 429); assert.strictEqual(S.ver.length, 0);
    authState.user = member({ perms: ['mail.view'] });
    assert.strictEqual((await post(V())).status, 200);
  });
  await t('verify: no login 401, no Mail tick 403, a mailbox of another panel 404, the table missing 503', async () => {
    authState.user = null; assert.strictEqual((await post(V())).status, 401);
    authState.user = member({}); assert.strictEqual((await post(V())).status, 403);
    authState.user = member({ perms: ['mail.view'], panels: ['bizV'] }); assert.strictEqual((await post(V({ box: 'boxK' }))).status, 404);
    authState.user = OWNER; S.missingTable = true; assert.strictEqual((await post(V())).status, 503);
  });
  await t('remove: a wrong click is taken back (the row stays, marked removed; the email chat goes back to unverified); a second remove is 404', async () => {
    await post(V()); S.convUpdates.length = 0;
    let res = await post({ box: 'boxV', email: 'cust@example.com', orderId: '#1553', remove: true });
    assert.strictEqual(res.status, 200); assert.strictEqual(S.ver[0].removed, true); assert.strictEqual(S.convUpdates[0].kind, 'unverify');
    assert.strictEqual((await post({ box: 'boxV', email: 'cust@example.com', orderId: '#1553', remove: true })).status, 404);
    const list = await (await messages.GET(req('GET', '/api/mail/messages?box=boxV'))).json();
    assert.deepStrictEqual(list.verified, {}, 'a removed verification does not count');
  });
  await t('the list says which senders are verified (with the chat to open); without Chat Support the chat link is left out', async () => {
    await post(V());
    let d = await (await messages.GET(req('GET', '/api/mail/messages?box=boxV'))).json();
    assert.deepStrictEqual(Object.keys(d.verified), ['cust@example.com']); assert.strictEqual(d.verified['cust@example.com'][0].orderId, '#1553'); assert.strictEqual(d.verified['cust@example.com'][0].chatId, 'chat-1');
    authState.user = member({ perms: ['mail.view'], panels: ['bizV'] });
    d = await (await messages.GET(req('GET', '/api/mail/messages?box=boxV'))).json();
    assert.strictEqual(d.verified['cust@example.com'][0].chatId, null);
    S.missingTable = true; assert.strictEqual((await messages.GET(req('GET', '/api/mail/messages?box=boxV'))).status, 200, 'before the SQL is applied the list still opens, every sender not verified');
  });
  await t('chat side: Emails of a verified chat = mails from the addresses verified for its order (searched by FROM); never for a login without Open Mail or Chat Support, or another panel\'s chat', async () => {
    await post(V());
    const get = (id) => byChat.GET(req('GET', `/api/mail/by-chat?conversationId=${id}`));
    let res = await get('chat-1'); let d = await res.json();
    assert.strictEqual(res.status, 200); assert.deepStrictEqual(d.emails, ['cust@example.com']); assert.strictEqual(d.orderId, '#1553');
    assert.ok(S.searches.some((q) => q.from === 'cust@example.com'), 'Gmail was asked only for that sender');
    assert.deepStrictEqual(S.connects, ['vastora@store.example'], 'only this panel\'s Gmail');
    assert.ok(d.mails.length > 0 && d.mails.every((m) => m.boxId === 'boxV'));
    S.chat = { ...S.chat, verified_order_id: null }; d = await (await get('chat-1')).json(); assert.deepStrictEqual(d.emails, []); assert.strictEqual(d.mails.length, 0);
    S.chat = { ...S.chat, verified_order_id: '#1553', verified_via: 'legacy' }; d = await (await get('chat-1')).json(); assert.strictEqual(d.orderId, null, 'an old check is not a verification');
    S.chat = { ...S.chat, verified_via: 'form' };
    authState.user = member({ perms: ['chat.view'] }); assert.strictEqual((await get('chat-1')).status, 403, 'no Open Mail');
    authState.user = member({ perms: ['mail.view'] }); assert.strictEqual((await get('chat-1')).status, 403, 'no Chat Support');
    authState.user = member({ perms: ['mail.view', 'chat.view'], panels: ['bizV'] });
    assert.strictEqual((await get('chat-other')).status, 404, 'another panel\'s chat');
    assert.strictEqual((await get('nope-nope')).status, 404);
    assert.strictEqual((await get('x')).status, 400);
    authState.user = null; assert.strictEqual((await get('chat-1')).status, 401);
  });

  // ── automatic verification (owner 2026-10-08: email on an order, then email + order number, then the team) ──
  const auto = require(path.join(SRC, 'lib/chat/mail-auto-verify.ts'));
  await t('auth: only Gmail\'s own FIRST Authentication-Results with dmarc=pass counts; a bare dkim/spf pass, a failure or a forged authserv-id does not', () => {
    const ok = 'mx.google.com; dkim=pass header.i=@x.com; spf=pass smtp.mailfrom=x.com; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=x.com';
    assert.strictEqual(view.gmailAuthPassed(ok), true); assert.strictEqual(view.gmailAuthPassed('Authentication-Results: ' + ok), true);
    assert.strictEqual(view.gmailAuthPassed('mx.google.com; dkim=pass; spf=pass'), false, 'dkim / spf alone can be the attacker\'s own domain');
    assert.strictEqual(view.gmailAuthPassed('mx.google.com; dmarc=fail header.from=x.com'), false);
    assert.strictEqual(view.gmailAuthPassed('mail.evil.example; dmarc=pass'), false, 'not Gmail\'s line');
    assert.strictEqual(view.gmailAuthPassed(null), false); assert.strictEqual(view.gmailAuthPassed(''), false);
    const raw = 'Authentication-Results: mx.google.com;\r\n dmarc=pass header.from=real.com\r\nAuthentication-Results: mx.google.com; dmarc=pass header.from=forged.com\r\n';
    assert.ok(/real\.com/.test(view.firstAuthResults(raw)) && !/forged/.test(view.firstAuthResults(raw)), 'the top line only, unfolded');
    assert.strictEqual(view.firstAuthResults('Subject: x'), null);
  });
  await t('plan: step 1 = the email\'s latest order; step 2 = the order number the mail names that belongs to that email; another customer\'s number is ignored; no pass / no orders = nothing', () => {
    const orders = { 'a@x.com': ['#1700', '#1553', '#1400'], 'b@x.com': ['#2000'] };
    let p = auto.planAutoVerify([{ email: 'A@x.com', authPass: true, subject: 'Where is my parcel' }], orders);
    assert.deepStrictEqual(p, [{ email: 'a@x.com', orders: ['#1700'], basis: 'Email match' }]);
    p = auto.planAutoVerify([{ email: 'a@x.com', authPass: true, subject: 'Re: Order #1553', text: 'also order no 1400' }], orders);
    assert.deepStrictEqual(p, [{ email: 'a@x.com', orders: ['#1553', '#1400'], basis: 'Email + order number' }]);
    p = auto.planAutoVerify([{ email: 'a@x.com', authPass: true, text: 'my friend\'s order #2000' }], orders);
    assert.deepStrictEqual(p, [{ email: 'a@x.com', orders: ['#1700'], basis: 'Email match' }], 'an order of another email never verifies this one');
    assert.deepStrictEqual(auto.planAutoVerify([{ email: 'a@x.com', authPass: false }], orders), []);
    assert.deepStrictEqual(auto.planAutoVerify([{ email: 'nobody@x.com', authPass: true }], orders), []);
    assert.strictEqual(auto.planAutoVerify([{ email: 'a@x.com', authPass: true }, { email: 'a@x.com', authPass: true }], orders).length, 1);
  });
  await t('list: a sender whose address is on an order of THIS panel and whose mail passed Gmail\'s dmarc is verified by itself (latest order), the email chat becomes mail_auto; no pass / another panel\'s order / no order = not verified', async () => {
    S.pass = { 13: true, 11: false }; S.orderEmails = [{ email: 'cust@example.com', order_id: '#1553' }, { email: 'cust@example.com', order_id: '#1400' }, { email: 'alice@example.com', order_id: '#1001' }, { email: 'bob@example.com', order_id: '#9000', panel: 'bizK' }];
    const d = await (await messages.GET(req('GET', '/api/mail/messages?box=boxVast'.replace('boxVast', 'boxV')))).json();
    assert.deepStrictEqual(Object.keys(d.verified), ['cust@example.com'], 'alice had no dmarc pass, bob\'s order is in another panel');
    assert.deepStrictEqual(d.verified['cust@example.com'].map((v) => [v.orderId, v.byName]), [['#1553', 'Email match']]);
    assert.strictEqual(S.ver[0].verified_by, 'auto');
    const u = S.convUpdates[0]; assert.ok(/'mail_auto'/.test(u.sql) && u.params[0] === '#1553' && u.params[2] === 'email:cust@example.com');
    const again = await (await messages.GET(req('GET', '/api/mail/messages?box=boxV'))).json(); assert.strictEqual(S.ver.length, 1, 'idempotent'); assert.strictEqual(S.convUpdates.length, 1);
    assert.ok(again.verified['cust@example.com']);
  });
  await t('open: the mail\'s own order number (email + order number) verifies that order, and the answer carries the sender\'s verifications', async () => {
    S.pass = { 11: true }; S.orderEmails = [{ email: 'alice@example.com', order_id: '#1400' }, { email: 'alice@example.com', order_id: '#1001' }];
    const d = await (await message.GET(req('GET', '/api/mail/message?box=boxV&uid=11'))).json();
    assert.deepStrictEqual(d.verified.map((v) => [v.orderId, v.byName]), [['#1001', 'Email + order number']], 'the mail said order #1001');
    assert.strictEqual(d.mail.authPass, true);
  });
  await t('team veto: a sender the team Removed is never verified again by itself; a team verification is never overwritten', async () => {
    S.pass = { 13: true }; S.orderEmails = [{ email: 'cust@example.com', order_id: '#1553' }];
    await messages.GET(req('GET', '/api/mail/messages?box=boxV'));
    assert.strictEqual((await post({ box: 'boxV', email: 'cust@example.com', orderId: '#1553', remove: true })).status, 200);
    const d = await (await messages.GET(req('GET', '/api/mail/messages?box=boxV'))).json();
    assert.deepStrictEqual(d.verified, {}, 'removed stays removed'); assert.strictEqual(S.ver.filter((v) => !v.removed).length, 0);
    reset(); S.pass = { 13: true }; S.orderEmails = [{ email: 'cust@example.com', order_id: '#1553' }];
    await post(V({ email: 'cust@example.com' }));
    const n = S.ver.length; S.ver[0].verified_by = 'rahul';
    await messages.GET(req('GET', '/api/mail/messages?box=boxV'));
    assert.strictEqual(S.ver.length, n); assert.strictEqual(S.ver[0].verified_by, 'rahul');
  });
  await t('automatic verification before the SQL is applied: the list still opens, nothing is written', async () => {
    S.pass = { 13: true }; S.orderEmails = [{ email: 'cust@example.com', order_id: '#1553' }]; S.missingTable = true;
    assert.strictEqual((await messages.GET(req('GET', '/api/mail/messages?box=boxV'))).status, 200);
  });

  // ── kept-open connections (owner 2026-10-08: "sloww hai, load hi nahi ho rahi") ──────────────────────────
  await t('speed: the list and opening a mail each keep ONE connection open per mailbox, so the second call does not sign in again; a list refresh never blocks opening a mail', async () => {
    await messages.GET(req('GET', '/api/mail/messages?box=boxV'));
    await message.GET(req('GET', '/api/mail/message?box=boxV&uid=11&peek=1'));
    assert.strictEqual(S.connects.length, 2, 'one for the list, one for the read-ahead (peek)');
    await message.GET(req('GET', '/api/mail/message?box=boxV&uid=11'));
    assert.strictEqual(S.connects.length, 3, 'a click has its own connection: never behind a slow read-ahead');
    await messages.GET(req('GET', '/api/mail/messages?box=boxV'));
    await message.GET(req('GET', '/api/mail/message?box=boxV&uid=13&peek=1'));
    await attachment.GET(req('GET', '/api/mail/attachment?box=boxV&uid=12&index=0'));
    assert.strictEqual(S.connects.length, 3, 'reused: no new sign-in'); assert.strictEqual(S.logouts, 0);
    // a refresh that is still signing in does not hold up an open
    pool.closeAllImap(); S.connects.length = 0; S.connectDelay = 60;
    const t0 = Date.now(); const slowList = messages.GET(req('GET', '/api/mail/messages?box=boxV')); const open = await message.GET(req('GET', '/api/mail/message?box=boxV&uid=11'));
    assert.strictEqual(open.status, 200); await slowList; assert.ok(Date.now() - t0 < 400);
    S.connectDelay = 0;
  });
  await t('speed: a connection Gmail closed while idle is replaced by a fresh one, once, and the call still works; a different App Password never reuses the old connection', async () => {
    await messages.GET(req('GET', '/api/mail/messages?box=boxV'));
    S.lockFailOnce = true;                                   // the reused connection fails on first use
    mcache.clearMailServerCache();                           // (the server's copy would answer without Gmail; this test is about the connection)
    const res = await messages.GET(req('GET', '/api/mail/messages?box=boxV'));
    assert.strictEqual(res.status, 200); assert.strictEqual(S.connects.length, 2, 'signed in again once');
    S.boxes[0].app_password = 'ANOTHERPASSWORD16'; mcache.clearMailServerCache(); await messages.GET(req('GET', '/api/mail/messages?box=boxV'));
    assert.strictEqual(S.connects.length, 3, 'a changed App Password signs in again');
  });
  await t('speed: a hung Gmail is cut (504) and its connection is thrown away, never reused', async () => {
    S.connectDelay = 0; await messages.GET(req('GET', '/api/mail/messages?box=boxV'));
    const real = Date.now; // nothing to wait for: the timeout path is exercised with a tiny limit
    const out = await pool.withPooledImap({ id: 'boxV', email: 'vastora@store.example', appPassword: 'SECRETSECRETSECR' }, 'list', () => new Promise(() => {}), 40).catch((e) => e);
    assert.ok(out instanceof pool.PoolTimeout); assert.ok(S.closes >= 1);
    mcache.clearMailServerCache(); await messages.GET(req('GET', '/api/mail/messages?box=boxV')); assert.strictEqual(S.connects.length, 2, 'a fresh connection after the hang'); void real;
  });

  // ── replying like Gmail: quote, plain mail, files; the conversation view (owner 2026-10-08) ─────────────────
  await t('quote helpers: Gmail\'s "On ... wrote:" header (India time), "> " on every line, an 8000-character cap, matching gmail_quote html, nothing branded', () => {
    const v = view;
    const h = v.quoteHeader('2026-10-08T07:26:00Z', 'Bob <b@x.com>'); assert.strictEqual(h, 'On Thu, 8 Oct 2026, 12:56, Bob <b@x.com> wrote:');
    const t = v.replyBodyText('Thanks', { dateIso: '2026-10-08T07:26:00Z', fromLabel: 'Bob <b@x.com>', original: 'line one\nline two' });
    assert.strictEqual(t, 'Thanks\n\nOn Thu, 8 Oct 2026, 12:56, Bob <b@x.com> wrote:\n> line one\n> line two');
    assert.strictEqual(v.replyBodyText('Thanks', null), 'Thanks');
    const html = v.replyBodyHtml('Thanks <b>', { dateIso: '2026-10-08T07:26:00Z', fromLabel: 'Bob <b@x.com>', original: 'see https://x.com/a\n<script>x</script>' });
    assert.ok(/class="gmail_quote"/.test(html) && /&lt;script&gt;/.test(html) && !/<script>/.test(html) && /Thanks &lt;b&gt;/.test(html), 'escaped, quoted');
    assert.ok(!/Customer support reply|This message was sent by/.test(html), 'a plain Gmail-style mail, not the branded box');
    assert.ok(v.replyBodyText('r', { dateIso: '2026-10-08T07:26:00Z', fromLabel: 'x', original: 'a'.repeat(20000) }).length < 8300);
  });
  await t('reply: the original is quoted after the typed text (built from the mail itself), sent as a plain mail from "<site> Support" in the same conversation', async () => {
    authState.user = member({ perms: ['mail.view', 'mail.reply'], panels: ['bizV'] });
    const res = await send.POST(req('POST', '/api/mail/send', { box: 'boxV', uid: 12, text: 'Hello Bob' }));
    assert.strictEqual(res.status, 200); const m = S.sent[0];
    assert.ok(/^Hello Bob\n\nOn .* wrote:\n> /.test(m.text), 'quote after the text'); assert.ok(/Hello team/.test(m.text), 'the original text is in the quote');
    assert.ok(/gmail_quote/.test(m.html) && !/Customer support reply/.test(m.html));
    assert.strictEqual(m.headers['In-Reply-To'], '<m12@mail.example>');
    assert.ok(!m.attachments, 'no files');
  });
  await t('reply: includeQuote false sends only the typed text; a quote can never be supplied by the browser', async () => {
    let res = await send.POST(req('POST', '/api/mail/send', { box: 'boxV', uid: 12, text: 'Short', includeQuote: false }));
    assert.strictEqual(res.status, 200); assert.strictEqual(S.sent[0].text, 'Short'); assert.ok(!/gmail_quote/.test(S.sent[0].html));
    S.sent.length = 0; res = await send.POST(req('POST', '/api/mail/send', { box: 'boxV', uid: 12, text: 'Hi', quote: 'FAKE QUOTE' }));
    assert.ok(!/FAKE QUOTE/.test(S.sent[0].text));
  });
  const formReq = (fields, files) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); for (const x of files) f.append('files', new Blob([x.bytes], { type: x.type || 'application/octet-stream' }), x.name); return new NextRequest('http://localhost/api/mail/send', { method: 'POST', body: f }); };
  const PNGB = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  await t('reply with files: a real PNG and a PDF go out as attachments (judged by their bytes, names cleaned); a renamed .exe, an empty file, more than 5 files and more than 10 MB are refused and NOTHING is sent', async () => {
    const ok = await send.POST(formReq({ box: 'boxV', uid: '12', text: 'See the files', includeQuote: '1' }, [{ name: 'photo.png', bytes: PNGB, type: 'image/png' }, { name: 'bill.pdf', bytes: Buffer.from('%PDF-1.4 x'), type: 'application/pdf' }]));
    assert.strictEqual(ok.status, 200); assert.strictEqual((await ok.json()).files, 2);
    assert.deepStrictEqual(S.sent[0].attachments.map((a) => [a.filename, a.contentType]), [['photo.png', 'image/png'], ['bill.pdf', 'application/pdf']]);
    S.sent.length = 0;
    const bad = [
      [{ name: 'run.png', bytes: Buffer.from('MZ\x90\x00 not an image'), type: 'image/png' }, 415],
      [{ name: 'empty.png', bytes: Buffer.alloc(0), type: 'image/png' }, 400],
    ];
    for (const [file, code] of bad) assert.strictEqual((await send.POST(formReq({ box: 'boxV', uid: '12', text: 'x' }, [file]))).status, code, file.name);
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `p${i}.png`, bytes: PNGB, type: 'image/png' }));
    assert.strictEqual((await send.POST(formReq({ box: 'boxV', uid: '12', text: 'x' }, six))).status, 400);
    const big = Buffer.concat([PNGB, Buffer.alloc(6 * 1024 * 1024)]);
    assert.strictEqual((await send.POST(formReq({ box: 'boxV', uid: '12', text: 'x' }, [{ name: 'a.png', bytes: big, type: 'image/png' }, { name: 'b.png', bytes: big, type: 'image/png' }]))).status, 413);
    assert.strictEqual(S.sent.length, 0);
  });
  await t('reply with files needs the Reply tick and the box\'s panel like any reply', async () => {
    authState.user = member({ perms: ['mail.view'], panels: ['bizV'] });
    assert.strictEqual((await send.POST(formReq({ box: 'boxV', uid: '12', text: 'x' }, [{ name: 'p.png', bytes: PNGB, type: 'image/png' }]))).status, 403);
    authState.user = member({ perms: ['mail.view', 'mail.reply'], panels: ['bizV'] });
    assert.strictEqual((await send.POST(formReq({ box: 'boxK', uid: '12', text: 'x' }, [{ name: 'p.png', bytes: PNGB, type: 'image/png' }]))).status, 404);
    assert.strictEqual(S.sent.length, 0);
  });
  const thread = require(path.join(SRC, 'app/api/mail/thread/route.ts'));
  await t('conversation view: what the address sent (INBOX, FROM) and what we sent it (Sent, TO), oldest first; only that address; our mails are opened read-only', async () => {
    const res = await thread.GET(req('GET', '/api/mail/thread?box=boxV&address=Cust@Example.com')); const d = await res.json();
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(d.items.map((x) => [x.folder, x.uid]).sort(), [['inbox', 13], ['sent', 501]], 'his mail and ours to him, nobody else\'s');
    assert.ok(d.items.some((x) => x.folder === 'sent' && x.uid === 501) && !d.items.some((x) => x.uid === 502));
    assert.ok(Date.parse(d.items[0].date) <= Date.parse(d.items[d.items.length - 1].date), 'oldest first');
    assert.ok(S.searches.some((q) => q.from === 'cust@example.com') && S.searches.some((q) => q.to === 'cust@example.com'));
    assert.ok(S.locks.every((l) => l.readOnly), 'reading the conversation changes no flag');
    const sentMail = await message.GET(req('GET', '/api/mail/message?box=boxV&uid=501&folder=sent')); const sm = await sentMail.json();
    assert.strictEqual(sentMail.status, 200); assert.ok(sm.mail.frame.includes('We are checking your order')); assert.deepStrictEqual(sm.verified, []);
    assert.strictEqual(S.flagCalls.length, 0, 'opening our own mail marks nothing');
  });
  await t('conversation view: no Sent folder = received mail only; bad address 400; no Mail tick 403; another panel\'s box 404', async () => {
    S.noSent = true;
    const d = await (await thread.GET(req('GET', '/api/mail/thread?box=boxV&address=cust@example.com'))).json(); assert.deepStrictEqual(d.items.map((x) => x.folder), ['inbox']);
    assert.strictEqual((await thread.GET(req('GET', '/api/mail/thread?box=boxV&address=nope'))).status, 400);
    authState.user = member({}); assert.strictEqual((await thread.GET(req('GET', '/api/mail/thread?box=boxV&address=cust@example.com'))).status, 403);
    authState.user = member({ perms: ['mail.view'], panels: ['bizV'] }); assert.strictEqual((await thread.GET(req('GET', '/api/mail/thread?box=boxK&address=cust@example.com'))).status, 404);
    authState.user = null; assert.strictEqual((await thread.GET(req('GET', '/api/mail/thread?box=boxV&address=cust@example.com'))).status, 401);
  });

  await t('conversation (owner 10 Oct, it kept spinning): its own Gmail connection, never behind the read-ahead; the server keeps a copy (instant the second time); fresh=1 reads Gmail again; an older message opened from it uses the same connection', async () => {
    let d = await (await thread.GET(req('GET', '/api/mail/thread?box=boxV&address=cust@example.com'))).json();
    assert.strictEqual(d.cached, false);
    const conns = S.connects.length, searches = S.searches.length;
    // The read-ahead (peek) signs in on its own connection: the conversation's connection is a different one.
    await message.GET(req('GET', '/api/mail/message?box=boxV&uid=13&peek=1'));
    assert.strictEqual(S.connects.length, conns + 1, 'the read-ahead has its own connection');
    d = await (await thread.GET(req('GET', '/api/mail/thread?box=boxV&address=Cust@Example.com'))).json();
    assert.deepStrictEqual([d.cached, S.searches.length], [true, searches], 'the copy answers, Gmail is not searched again');
    d = await (await thread.GET(req('GET', '/api/mail/thread?box=boxV&address=cust@example.com&fresh=1'))).json();
    assert.ok(d.cached === false && S.searches.length > searches, 'fresh=1 reads Gmail again');
    const before = S.connects.length;
    const sm = await message.GET(req('GET', '/api/mail/message?box=boxV&uid=501&folder=sent&peek=1&via=thread'));
    assert.strictEqual(sm.status, 200); assert.strictEqual(S.connects.length, before, 'an older message rides the conversation\'s connection');
    const src = fs.readFileSync(path.join(SRC, 'lib/chat/mail-inbox.ts'), 'utf8');
    assert.ok(/\}, 'thread'\);/.test(src), 'listThread runs on the thread slot');
  });
  await t('speed: phase=fast asks Gmail only for who / subject / date / flags (no structure, no headers) and writes nothing; the full list adds them and runs the automatic verification', async () => {
    S.pass = { 13: true }; S.orderEmails = [{ email: 'cust@example.com', order_id: '#1553' }];
    const fast = await (await messages.GET(req('GET', '/api/mail/messages?box=boxV&phase=fast'))).json();
    const q = S.fetchQueries.at(-1); assert.ok(q.envelope && q.flags && !q.bodyStructure && !q.headers, 'a light FETCH');
    assert.strictEqual(fast.phase, 'fast'); assert.ok(fast.mails.every((m) => m.hasAttachment === false && m.authPass === false));
    assert.strictEqual(S.ver.length, 0, 'the sender checks wait for the full list'); assert.strictEqual(fast.mails.length, 4);
    const full = await (await messages.GET(req('GET', '/api/mail/messages?box=boxV'))).json();
    const q2 = S.fetchQueries.at(-1); assert.ok(q2.bodyStructure && q2.headers);
    assert.strictEqual(full.phase, 'full'); assert.ok(full.mails.some((m) => m.hasAttachment) && full.mails.some((m) => m.authPass));
    assert.strictEqual(S.ver.length, 1, 'now the automatic verification ran');
  });

  await t('speed (every panel the same): a slow read-ahead on its own connection never holds up the mail the person clicked', async () => {
    const hold = pool.withPooledImap({ id: 'boxV', email: 'vastora@store.example', appPassword: 'SECRETSECRETSECR' }, 'bg', () => new Promise((r) => setTimeout(r, 400)));
    const t0 = Date.now(); const res = await message.GET(req('GET', '/api/mail/message?box=boxV&uid=11')); const took = Date.now() - t0;
    assert.strictEqual(res.status, 200); assert.ok(took < 300, `the click waited ${took} ms behind the read-ahead`);
    await hold;
  });
  await t('a very large mail: only its first 3 MB are read for the screen (marked cut); no body in those 3 MB = the whole mail is read; an ordinary mail is not cut', async () => {
    const pad = 'x'.repeat(70);
    const bigText = plain('big1', 'Big <big@example.com>', 'Big mail', 'Hello from a big mail\r\n' + (pad + '\r\n').repeat(60000));
    const attachFirst = ['From: Big <big@example.com>', 'Subject: Files first', 'Message-ID: <big2@mail.example>', 'Date: Wed, 07 Oct 2026 10:00:00 +0000', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="B"', '', '--B', 'Content-Type: application/pdf; name="a.pdf"', 'Content-Disposition: attachment; filename="a.pdf"', 'Content-Transfer-Encoding: base64', '', ('QUJD'.repeat(19) + '\r\n').repeat(50000), '--B', 'Content-Type: text/plain', '', 'The body comes last', '--B--', ''].join('\r\n');
    S.msgs.push({ uid: 21, seen: true, answered: false, date: '2026-10-08T09:00:00Z', from: { name: 'Big', address: 'big@example.com' }, subject: 'Big mail', source: bigText });
    S.msgs.push({ uid: 22, seen: true, answered: false, date: '2026-10-08T09:00:00Z', from: { name: 'Big', address: 'big@example.com' }, subject: 'Files first', source: attachFirst });
    assert.ok(bigText.length > 3 * 1024 * 1024 && attachFirst.length > 3 * 1024 * 1024);
    S.fetchOneOpts = [];
    let d = await (await message.GET(req('GET', '/api/mail/message?box=boxV&uid=21&peek=1'))).json();
    assert.strictEqual(d.mail.cut, true); assert.ok(d.mail.frame.includes('Hello from a big mail')); assert.deepStrictEqual(S.fetchOneOpts, [{ maxLength: 3 * 1024 * 1024 }]);
    S.fetchOneOpts = [];
    d = await (await message.GET(req('GET', '/api/mail/message?box=boxV&uid=22&peek=1'))).json();
    assert.ok(d.mail.frame.includes('The body comes last'), 'the body was found after reading the whole mail'); assert.notStrictEqual(d.mail.cut, true);
    assert.deepStrictEqual(S.fetchOneOpts.map((o) => (o && o.maxLength) || 'whole'), [3 * 1024 * 1024, 'whole']);
    d = await (await message.GET(req('GET', '/api/mail/message?box=boxV&uid=11&peek=1'))).json(); assert.ok(!d.mail.cut);
  });
  await t('the ask-for-verification texts ask for the Order ID and the FULL phone number, in English and Hinglish, with no link', () => {
    for (const x of [view.ASK_VERIFY_EN, view.ASK_VERIFY_HINGLISH]) { assert.ok(/order id/i.test(x) && /phone/i.test(x) && !/https?:\/\//.test(x)); }
    assert.ok(/full|poora/i.test(view.ASK_VERIFY_EN + view.ASK_VERIFY_HINGLISH));
  });


  // ── the server's copy (owner 2026-10-09: "Gmail kholna bahut slow hai, teeno panel par; history bana ke rakh") ──
  await t('cache: the second full list comes from the server\'s copy (no Gmail call), says so, and the sender checks ran once; a fresh list refreshes behind the screen only when old', async () => {
    let d = await (await messages.GET(req('GET', '/api/mail/messages?box=boxV'))).json();
    assert.strictEqual(d.cached, false); assert.strictEqual(S.searches.length, 1); assert.deepStrictEqual(d.mails.map((m) => m.uid), [14, 13, 11, 12]);
    d = await (await messages.GET(req('GET', '/api/mail/messages?box=boxV'))).json();
    assert.strictEqual(d.cached, true); assert.strictEqual(S.searches.length, 1, 'Gmail was not asked again'); assert.ok(d.at > 0);
    assert.deepStrictEqual(d.mails.map((m) => m.uid), [14, 13, 11, 12]); assert.strictEqual(d.unread, 3);
    assert.strictEqual(mcache.mailCacheStats().lists, 1);
    // the quick first list (a page load) is the copy too when there is one (it is better than a quick list: icons and sender checks included)
    d = await (await messages.GET(req('GET', '/api/mail/messages?box=boxV&phase=fast'))).json();
    assert.strictEqual(d.cached, true); assert.strictEqual(d.phase, 'full'); assert.strictEqual(S.searches.length, 1, 'no Gmail call');
    mcache.clearMailServerCache();
    d = await (await messages.GET(req('GET', '/api/mail/messages?box=boxV&phase=fast'))).json();
    assert.strictEqual(d.cached, false); assert.strictEqual(d.phase, 'fast'); assert.strictEqual(S.searches.length, 2, 'no copy yet: the quick list reads Gmail');
    await messages.GET(req('GET', '/api/mail/messages?box=boxV')); assert.strictEqual(S.searches.length, 3);
    // old copy: answered at once, read again behind the screen
    const box = await inbox.mailboxFor(OWNER, 'boxV');
    const stale = await mcache.listCached(box, Date.now() + mcache.LIST_FRESH_MS + 1);
    assert.strictEqual(stale.cached, true); await new Promise((r) => setTimeout(r, 30)); assert.strictEqual(S.searches.length, 4, 'one background read');
    mcache.clearMailServerCache(); assert.strictEqual(mcache.mailCacheStats().lists, 0);
  });
  await t('cache: a mail opened twice is downloaded once; the copy is marked read in Gmail with one flag call; Mark unread and a reply update the copy; a peek never marks read', async () => {
    await messages.GET(req('GET', '/api/mail/messages?box=boxV'));
    let d = await (await message.GET(req('GET', '/api/mail/message?box=boxV&uid=11'))).json();
    assert.strictEqual(d.mail.uid, 11); const downloads = S.fetchOneOpts.length; assert.strictEqual(downloads, 1);
    assert.deepStrictEqual(S.flagCalls, [['add', 11, ['\\Seen']]], 'marked read on the first open');
    let list = await (await messages.GET(req('GET', '/api/mail/messages?box=boxV'))).json();
    assert.strictEqual(list.mails.find((m) => m.uid === 11).unread, false, 'the copy of the list follows'); assert.strictEqual(list.unread, 2);
    d = await (await message.GET(req('GET', '/api/mail/message?box=boxV&uid=11'))).json();
    assert.strictEqual(d.mail.uid, 11); assert.strictEqual(S.fetchOneOpts.length, downloads, 'not downloaded again'); assert.strictEqual(S.flagCalls.length, 1, 'no second flag call');
    // Mark unread: Gmail and the copy; opening it again marks it read with one flag call and still no download
    assert.strictEqual((await message.PATCH(req('PATCH', '/api/mail/message', { box: 'boxV', uid: 11, seen: false }))).status, 200);
    list = await (await messages.GET(req('GET', '/api/mail/messages?box=boxV'))).json(); assert.strictEqual(list.mails.find((m) => m.uid === 11).unread, true);
    await message.GET(req('GET', '/api/mail/message?box=boxV&uid=11'));
    assert.strictEqual(S.fetchOneOpts.length, downloads); assert.deepStrictEqual(S.flagCalls.slice(-1), [['add', 11, ['\\Seen']]]);
    // a peek (the read-ahead) keeps the copy but marks nothing
    d = await (await message.GET(req('GET', '/api/mail/message?box=boxV&uid=13&peek=1'))).json();
    assert.strictEqual(d.mail.uid, 13); assert.strictEqual(S.fetchOneOpts.length, downloads + 1); assert.ok(!S.flagCalls.some((f) => f[1] === 13));
    list = await (await messages.GET(req('GET', '/api/mail/messages?box=boxV'))).json(); assert.strictEqual(list.mails.find((m) => m.uid === 13).unread, true);
    // a reply: the copy says answered
    mcache.noteAnswered('boxV', 13);
    list = await (await messages.GET(req('GET', '/api/mail/messages?box=boxV'))).json(); assert.strictEqual(list.mails.find((m) => m.uid === 13).answered, true);
    assert.strictEqual((await (await message.GET(req('GET', '/api/mail/message?box=boxV&uid=13'))).json()).mail.answered, true);
  });
  await t('cache: the poller\'s warm-up reads the list once and the newest mails ahead without marking them read; a second warm-up within minutes reads nothing', async () => {
    const box = await inbox.mailboxFor(OWNER, 'boxV');
    const w = await mcache.warmMailbox(box);
    assert.strictEqual(w.refreshed, true); assert.strictEqual(w.preread, 4, 'every mail of the small inbox');
    assert.strictEqual(S.searches.length, 1); assert.strictEqual(S.fetchOneOpts.length, 4); assert.strictEqual(S.flagCalls.length, 0, 'read ahead never marks read');
    const stats = mcache.mailCacheStats(); assert.strictEqual(stats.lists, 1); assert.strictEqual(stats.mails, 4); assert.ok(stats.bytes > 0);
    const again = await mcache.warmMailbox(box);
    assert.strictEqual(again.refreshed, false); assert.strictEqual(again.preread, 0); assert.strictEqual(S.searches.length, 1); assert.strictEqual(S.fetchOneOpts.length, 4);
    // the screen now opens from the copy: no Gmail call at all
    const d = await (await message.GET(req('GET', '/api/mail/message?box=boxV&uid=12'))).json();
    assert.strictEqual(d.mail.uid, 12); assert.strictEqual(S.fetchOneOpts.length, 4);
    assert.strictEqual((await (await messages.GET(req('GET', '/api/mail/messages?box=boxV'))).json()).cached, true); assert.strictEqual(S.searches.length, 1);
    // warmMailboxes never throws: a mailbox Gmail refuses is logged and the next one still warms
    S.authFail = true; await mcache.warmMailboxes([box]); S.authFail = false;
    // the old-copy warm reads again and forgets a mail that left the inbox
    S.msgs = S.msgs.filter((m) => m.uid !== 12);
    const later = await mcache.warmMailbox(box, Date.now() + mcache.LIST_WARM_MS + 1);
    assert.strictEqual(later.refreshed, true); assert.strictEqual(later.left, 0); assert.strictEqual(mcache.mailCacheStats().mails, 3, 'uid 12 forgotten');
    // a big inbox is read ahead a few per minute, newest first, until every mail is kept
    mcache.clearMailServerCache(); S.fetchOneOpts = [];
    S.msgs = Array.from({ length: 25 }, (_, i) => ({ uid: 200 + i, seen: true, answered: false, date: new Date(Date.parse('2026-10-01T00:00:00Z') + i * 3600e3).toISOString(), from: { name: 'N' + i, address: `n${i}@example.com` }, subject: 'S' + i, source: plain('n' + i, `n${i}@example.com`, 'S' + i, 'body ' + i) }));
    const w1 = await mcache.warmMailbox(box); assert.strictEqual(w1.preread, mcache.PREREAD); assert.strictEqual(w1.left, 25 - mcache.PREREAD);
    assert.ok(mcache.cachedMail('boxV', 224) && !mcache.cachedMail('boxV', 200), 'the newest first');
    const w2 = await mcache.warmMailbox(box); assert.strictEqual(w2.refreshed, false); assert.strictEqual(w2.preread, mcache.PREREAD);
    const w3 = await mcache.warmMailbox(box); assert.strictEqual(w3.preread, 5); assert.strictEqual(w3.left, 0); assert.strictEqual(mcache.mailCacheStats().mails, 25);
  });
  await t('cache: the copy is written to one file on disk (mode 0600, never the App Password) and read back after a restart, so the tab answers at once with no Gmail call', async () => {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mail-cache-'));
    process.env.MAIL_CACHE_DIR = dir;
    try {
      await messages.GET(req('GET', '/api/mail/messages?box=boxV'));
      await message.GET(req('GET', '/api/mail/message?box=boxV&uid=11'));
      await mcache.saveToDisk();
      const file = path.join(dir, 'mail-cache.json');
      assert.ok(fs.existsSync(file)); assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
      const text = fs.readFileSync(file, 'utf8'); assert.ok(!/SECRETSECRETSECR/.test(text), 'no App Password on disk'); assert.ok(/Where is my order/.test(text));
      const searches = S.searches.length, downloads = S.fetchOneOpts.length;
      // "restart": memory empty, the file is read at the first use
      mcache.clearMailServerCache(); mcache.forgetDiskLoad();
      const d = await (await messages.GET(req('GET', '/api/mail/messages?box=boxV&phase=fast'))).json();
      assert.strictEqual(d.cached, true); assert.deepStrictEqual(d.mails.map((m) => m.uid), [14, 13, 11, 12]); assert.strictEqual(d.mails.find((m) => m.uid === 11).unread, false);
      const m = await (await message.GET(req('GET', '/api/mail/message?box=boxV&uid=11'))).json();
      assert.strictEqual(m.mail.uid, 11); assert.strictEqual(S.searches.length, searches, 'no list read'); assert.strictEqual(S.fetchOneOpts.length, downloads, 'no download');
      // nothing changed: no second write; a change: written again
      const mtime = fs.statSync(file).mtimeMs; await mcache.saveToDisk(); assert.strictEqual(fs.statSync(file).mtimeMs, mtime);
      mcache.noteSeen('boxV', 13, true); await mcache.saveToDisk(); assert.ok(/"uid":13,[^}]*"unread":false/.test(fs.readFileSync(file, 'utf8')));
      // a missing or broken file is an empty copy, never an error
      fs.writeFileSync(file, '{broken'); mcache.clearMailServerCache(); mcache.forgetDiskLoad();
      assert.strictEqual(mcache.cachedList('boxV'), null);
    } finally { process.env.MAIL_CACHE_DIR = 'off'; mcache.clearMailServerCache(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  console.log(`MAIL-TAB: ${n} groups passed`);
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
