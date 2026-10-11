// The mail store (owner 2026-10-11, "history ko load karke rakh"): the pure rules always; with MAIL_STORE_PG set (a
// scratch PostgreSQL that ran mail-store.sql, logging in as tracker_user, with one site_emails row
// 22222222-2222-2222-2222-222222222222 for site 'siteV') also the REAL sync (mail-sync.ts) against a fake Gmail and the
// REAL /api/mail routes reading the database. Nothing here touches a real mailbox.
//   MAIL_STORE_PG=postgres://tracker_user:x@127.0.0.1:5499/mailtest node scripts/ai-tests/mail-store.js
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true }, fileName: filename }).outputText, filename);

const PG = process.env.MAIL_STORE_PG || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.MAIL_CACHE_DIR = 'off';

// ── a fake Gmail ──
const plain = (id, from, to, subject, body) => `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: ${id}\r\nDate: Sat, 10 Oct 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
const G = {};
function resetGmail() {
  const now = Date.now();
  const d = (h) => new Date(now - h * 3600e3);
  Object.assign(G, {
    folders: {
      INBOX: { uidValidity: 7n, modseq: 100n, msgs: [
        { uid: 11, thread: 'T1', seen: false, date: d(5), from: { name: 'Alice', address: 'alice@example.com' }, to: [{ address: 'vastora@store.example' }], subject: 'Where is my order?', mid: '<m11@x>', source: plain('<m11@x>', 'Alice <alice@example.com>', 'vastora@store.example', 'Where is my order?', 'Hi, order #1001 has not come.') },
        { uid: 12, thread: 'T2', seen: true, date: d(4), from: { name: 'Bob', address: 'bob@example.com' }, to: [{ address: 'vastora@store.example' }], subject: 'Photo', mid: '<m12@x>', source: plain('<m12@x>', 'Bob <bob@example.com>', 'vastora@store.example', 'Photo', 'See photo.') },
        { uid: 13, thread: 'T3', seen: false, date: d(3), from: { name: 'Cust', address: 'cust@example.com' }, to: [{ address: 'vastora@store.example' }], subject: 'Refund please', mid: '<m13@x>', source: plain('<m13@x>', 'Cust <cust@example.com>', 'vastora@store.example', 'Refund please', 'Please refund my order.') },
      ] },
      '[Gmail]/Sent Mail': { uidValidity: 9n, modseq: 50n, msgs: [
        { uid: 501, thread: 'T3', seen: true, date: d(2), from: { name: 'Vastora Support', address: 'vastora@store.example' }, to: [{ name: 'Cust', address: 'cust@example.com' }], subject: 'Re: Refund please', mid: '<s501@x>', source: plain('<s501@x>', 'Vastora Support <vastora@store.example>', 'cust@example.com', 'Re: Refund please', 'We are checking your order.') },
      ] },
    },
    connects: 0, fetchOnes: 0, flagCalls: [], sent: [], smtpFail: null, smtpHold: null, transports: 0,
  });
}
resetGmail();
class FakeImap {
  constructor(o) { this.user = o.auth.user; this.usable = false; }
  on() { return this; }
  async connect() { G.connects++; this.usable = true; }
  async list() { return [{ path: 'INBOX', specialUse: '\\Inbox' }, { path: '[Gmail]/Sent Mail', specialUse: '\\Sent' }]; }
  async getMailboxLock(p) { this.path = p; return { release() {} }; }
  get f() { return G.folders[this.path]; }
  get mailbox() { const f = this.f; return { path: this.path, uidValidity: f.uidValidity, uidNext: f.msgs.reduce((m, x) => Math.max(m, x.uid), 0) + 1, highestModseq: f.modseq }; }
  async search(q, o) { assert.ok(o && o.uid, 'searches by UID'); return this.f.msgs.filter((m) => !q.since || m.date >= q.since).map((m) => m.uid); }
  fetch(range, q, o) {
    assert.ok(o && o.uid, 'fetches by UID');
    const all = this.f.msgs.slice().sort((a, b) => a.uid - b.uid);
    let list;
    const star = String(range).match(/^(\d+):\*$/);
    if (star) { list = all.filter((m) => m.uid >= Number(star[1])); if (!list.length && all.length) list = [all[all.length - 1]]; }
    else list = all.filter((m) => String(range).split(',').map(Number).includes(m.uid));
    if (o.changedSince !== undefined) list = list.filter((m) => (m.modseq || 0n) > o.changedSince);
    if (q.source) { G.batches = (G.batches || 0) + 1; if (G.batchFail) throw new Error('batch refused'); }
    return (async function* () {
      for (const m of list) yield {
        uid: m.uid, threadId: m.thread, size: m.source.length,
        flags: new Set([...(m.seen ? ['\\Seen'] : []), ...(m.answered ? ['\\Answered'] : [])]),
        envelope: { date: m.date, subject: m.subject, messageId: m.mid, from: [m.from], to: m.to, cc: [], replyTo: [] },
        bodyStructure: { type: 'text/plain' },
        headers: Buffer.from('Authentication-Results: mx.google.com; dmarc=pass header.from=example.com\r\n'),
        ...(q.source ? { source: Buffer.from(m.source) } : {}),
      };
    })();
  }
  async fetchOne(uid, q, o) { assert.ok(o && o.uid); G.fetchOnes++; const m = this.f.msgs.find((x) => String(x.uid) === String(uid)); return m ? { source: Buffer.from(m.source) } : false; }
  async messageFlagsAdd(uid, flags) { G.flagCalls.push(['add', Number(uid), flags]); const m = this.f.msgs.find((x) => x.uid === Number(uid)); if (m) { if (flags.includes('\\Seen')) m.seen = true; if (flags.includes('\\Answered')) m.answered = true; } return true; }
  async messageFlagsRemove(uid, flags) { G.flagCalls.push(['remove', Number(uid), flags]); const m = this.f.msgs.find((x) => x.uid === Number(uid)); if (m && flags.includes('\\Seen')) m.seen = false; return true; }
  async logout() { this.usable = false; }
  close() { this.usable = false; }
}
const authState = { user: null };
const realVerify = () => require(path.join(SRC, 'lib/chat/mail-verify.ts'));
const STUBS = {
  'lib/auth.ts': { getAuthFromRequest: () => authState.user },
  'lib/chat/mail-auto-verify.ts': { autoVerifySenders: async () => [] },
};
// The fake SMTP: records what the worker asks nodemailer for (pool, timeouts), can hold a send (smtpHold) or refuse it (smtpFail).
const fakeTransport = (opts) => { G.transports++; G.lastTransport = opts; return { sendMail: async (o) => { if (G.smtpFail) throw new Error(G.smtpFail); if (G.smtpHold) await G.smtpHold; G.sent.push(o); }, close() { G.closed = (G.closed || 0) + 1; } }; };
const PKG = {
  imapflow: { ImapFlow: FakeImap },
  nodemailer: { default: { createTransport: fakeTransport }, createTransport: fakeTransport },
};
const origLoad = Module._load, origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith('@/')) request = path.join(SRC, request.slice(2));
  return origResolve.call(this, request, parent, ...rest);
};
let verifyWrapped = null;
Module._load = function (request, parent, isMain) {
  if (PKG[request]) return PKG[request];
  let file = null;
  try { file = Module._resolveFilename(request, parent); } catch { /* a package */ }
  if (file && file.startsWith(SRC)) {
    const rel = path.relative(SRC, file);
    if (STUBS[rel]) return STUBS[rel];
    if (rel === 'lib/chat/mail-verify.ts') {
      if (!verifyWrapped) { const real = origLoad.call(this, request, parent, isMain); verifyWrapped = { ...real, verifiedSenders: async () => ({}) }; }
      return verifyWrapped;
    }
  }
  return origLoad.call(this, request, parent, isMain);
};

const rules = require(path.join(SRC, 'lib/chat/mail-store-rules.ts'));
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 10).join('\n       ')); }
}
const eq = assert.strictEqual, deq = assert.deepStrictEqual;

(async () => {
  console.log('mail store: the rules');
  await t('a row becomes the list item and the opened mail the screen knows; no body = null (the route reads Gmail once)', () => {
    const row = { id: '1', box_id: 'b', folder: 'inbox', uidvalidity: '7', uid: '13', thread_id: 'T3', message_id: '<m13@x>', from_name: 'Cust', from_addr: 'cust@example.com', to_list: 'vastora@store.example', to_addrs: [], cc_list: '', reply_to: '', subject: 'Refund', sent_at: '2026-10-10T10:00:00Z', seen: false, answered: true, has_attach: false, auth_pass: true, body_state: 'done', body_text: 'Hello <b>', body_html: null, attachments: [], cut: false };
    deq(rules.rowToListItem(row), { uid: 13, from: 'Cust', fromAddress: 'cust@example.com', subject: 'Refund', date: '2026-10-10T10:00:00.000Z', unread: true, hasAttachment: false, answered: true, authPass: true });
    const m = rules.rowToMailFull(row, false);
    deq([m.uid, m.from, m.text, m.unread, m.answered, m.authPass, m.remoteImages], [13, 'Cust <cust@example.com>', 'Hello <b>', true, true, true, false]);
    assert.match(m.frame, /Hello &lt;b&gt;/);                       // text is escaped inside the sandboxed frame
    eq(rules.rowToMailFull({ ...row, body_state: 'none' }, false), null);
  });
  await t('the conversation: oldest first, a ShipTrack reply shows until Gmail\'s own copy (same Message-ID) is in', () => {
    const R = (o) => ({ folder: 'inbox', uidvalidity: '7', from_name: 'X', from_addr: 'x@y', to_list: '', subject: 's', body_text: '', local: false, message_id: null, ...o });
    let items = rules.threadFromRows([R({ uid: '13', sent_at: '2026-10-10T10:00:00Z' }), R({ folder: 'sent', uid: '-5', uidvalidity: '0', local: true, message_id: '<r1@x>', sent_at: '2026-10-10T11:00:00Z', body_text: 'We will refund.' })]);
    deq(items.map((i) => [i.folder, i.uid, !!i.local, i.preview || '']), [['inbox', 13, false, ''], ['sent', -5, true, 'We will refund.']]);
    items = rules.threadFromRows([R({ uid: '13', sent_at: '2026-10-10T10:00:00Z' }), R({ folder: 'sent', uid: '-5', uidvalidity: '0', local: true, message_id: '<r1@x>', sent_at: '2026-10-10T11:00:00Z' }), R({ folder: 'sent', uid: '502', uidvalidity: '9', message_id: '<r1@x>', sent_at: '2026-10-10T11:00:05Z' })]);
    deq(items.map((i) => [i.folder, i.uid]), [['inbox', 13], ['sent', 502]]);
  });
  await t('a body: the mail\'s own small pictures are inlined, big ones are not, the attachment list keeps names and sizes only', () => {
    const small = Buffer.alloc(1000, 1), big = Buffer.alloc(rules.INLINE_IMAGE_MAX + 1, 2);
    const b = rules.bodyFromParsed({ html: '<img src="cid:a"><img src="cid:b">', attachments: [
      { cid: '<a>', content: small, contentType: 'image/png', filename: 'a.png' }, { cid: 'b', content: big, contentType: 'image/png', filename: 'b.png' },
      { content: Buffer.from('%PDF'), contentType: 'application/pdf', filename: 'invoice.pdf', contentDisposition: 'attachment' }] });
    assert.match(b.html, /data:image\/png;base64,/); assert.match(b.html, /cid:b/);
    deq(b.attachments.map((a) => [a.filename, a.inline, a.size]), [['a.png', true, 1000], ['b.png', true, big.length], ['invoice.pdf', false, 4]]);
    eq(rules.bodyFromParsed({ text: '', html: '<p>Hi&nbsp;there</p>' }).text.trim().length > 0, true);
  });
  await t('the three boxes (owner 11 Oct): a verified sender or a person on a personal mailbox is a customer; To reply until we wrote after it', () => {
    const f = require(path.join(SRC, 'lib/chat/mail-filters.ts'));
    const it = (a, o = {}) => ({ uid: 1, from: 'X', fromAddress: a, subject: 's', date: '2026-10-10T10:00:00Z', unread: true, hasAttachment: false, answered: false, ...o });
    const v = { 'shop@company.in': [{ orderId: '#1553' }] };
    deq(['piyush@gmail.com', 'riya.k@yahoo.co.in', 'a@outlook.com', 'me@icloud.com', 'x@rediffmail.com'].map((a) => f.bucketOf(it(a), {})), ['todo', 'todo', 'todo', 'todo', 'todo']);
    deq(['farhan.arshad@10681691.brevosend.com', 'alerts@hdfcbank.net', 'noreply@gmail.com', 'no-reply@accounts.google.com', 'notifications@github.com', 'info@gmail.com'].map((a) => f.bucketOf(it(a), {})), ['other', 'other', 'other', 'other', 'other', 'other']);
    eq(f.bucketOf(it('shop@company.in'), v), 'todo');                       // verified for an order: a customer whatever the address
    eq(f.bucketOf(it('piyush@gmail.com', { replied: true }), {}), 'done');
    eq(f.bucketOf(it('piyush@gmail.com', { answered: true }), {}), 'done');
    const items = [it('a@gmail.com', { uid: 1 }), it('b@gmail.com', { uid: 2, replied: true }), it('n@brevosend.com', { uid: 3 })];
    const c = f.viewCounts(items, {}, Date.parse('2026-10-11T00:00:00Z'));
    deq([c.todo, c.done, c.other, c.all], [1, 1, 1, 3]);
    eq(f.searchMatch(it('a@gmail.com', { snippet: 'my parcel is late' }), 'parcel', {}), true);
  });
  await t('a reply sent from here carries its outbox state in the conversation: sending / sent / failed with the reason and the id for Try again', () => {
    deq(rules.sendStateOf(null), null);
    deq(rules.sendStateOf({ id: '7', status: 'pending', error: null }), { sendState: 'sending', sendError: null, outboxId: '7' });
    deq(rules.sendStateOf({ id: '7', status: 'sending', error: 'old' }), { sendState: 'sending', sendError: null, outboxId: '7' });
    deq(rules.sendStateOf({ id: '7', status: 'sent', error: null }), { sendState: 'sent', sendError: null, outboxId: '7' });
    deq(rules.sendStateOf({ id: '7', status: 'failed', error: 'Gmail did not answer in time.' }), { sendState: 'failed', sendError: 'Gmail did not answer in time.', outboxId: '7' });
    const R = (o) => ({ folder: 'inbox', uidvalidity: '7', from_name: 'X', from_addr: 'x@y', to_list: '', subject: 's', body_text: '', local: false, message_id: null, ...o });
    const sends = new Map([['<r1@x>', { id: '9', status: 'failed', error: 'no' }]]);
    const items = rules.threadFromRows([R({ uid: '13', sent_at: '2026-10-10T10:00:00Z' }), R({ folder: 'sent', uid: '-5', uidvalidity: '0', local: true, message_id: '<r1@x>', sent_at: '2026-10-10T11:00:00Z' })], sends);
    deq(items.map((i) => [i.uid, i.sendState || null, i.sendError || null, i.outboxId || null]), [[13, null, null, null], [-5, 'failed', 'no', '9']]);
    // without the outbox (not installed) a local row has no state at all
    eq(rules.threadFromRows([R({ folder: 'sent', uid: '-5', uidvalidity: '0', local: true, message_id: '<r1@x>', sent_at: '2026-10-10T11:00:00Z' })])[0].sendState, undefined);
  });
  await t('the frame is as tall as the mail (owner 11 Oct, "neeche ka gap"): lines x 24 px + padding, 120 px to 70vh; a designed mail 65vh', () => {
    const v = require(path.join(SRC, 'lib/chat/mail-view.ts'));
    eq(v.frameLines('a\nb\nc'), 3); eq(v.frameLines('x'.repeat(230), 110), 3); eq(v.frameLines('', 110), 1); eq(v.frameLines('x'.repeat(100), 44), 3);
    eq(v.frameHeight({ text: 'Light wale h', frame: v.frameHtml(v.textToHtml('Light wale h')) }), 'clamp(120px, 80px, 70vh)');
    eq(v.frameHeight({ text: 'Hello team,\n\nMera order nahi aaya.\n\nThanks,\nPiyush', frame: '<p>x</p>' }), 'clamp(120px, 200px, 70vh)');
    eq(v.frameHeight({ text: 'short', frame: '<table><tr><td>designed</td></tr></table>' }), '65vh');
    eq(v.frameHeight({ text: 'short', frame: '<p><img src="data:x"></p>' }), '65vh');
    eq(v.frameHeight({ text: 'x'.repeat(2000), frame: '' }, 44), `clamp(120px, ${46 * 24 + 56}px, 70vh)`);   // a phone wraps sooner
  });
  await t('the outbox SQL file: additive, no DELETE for the app, the App Password is never stored there', () => {
    const sql = fs.readFileSync(path.resolve(__dirname, '../../mail-outbox.sql'), 'utf8');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS mail_outbox/); assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON mail_outbox TO tracker_user/);
    assert.match(sql, /CHECK \(status IN \('pending', 'sending', 'sent', 'failed'\)\)/);
    const code = sql.replace(/--[^\n]*/g, '');
    assert.ok(!/\bDELETE\b|DROP |TRUNCATE /i.test(code)); assert.ok(!/app_password/i.test(code));
    // the worker is kicked from the minute cron and the sync loop (retries), the loop takes it as a hook (no import cycle)
    const src = fs.readFileSync(path.join(SRC, 'lib/chat/email.ts'), 'utf8');
    assert.match(src, /void runOutbox\(\)/); assert.match(src, /startMailSync\(loadSyncBoxes, runOutbox\)/);
    assert.ok(!/from '\.\/mail-inbox'|from '\.\/email'|from '\.\/mail-sync'/.test(fs.readFileSync(path.join(SRC, 'lib/chat/mail-outbox.ts'), 'utf8')));
  });
  await t('the SQL file: additive, no DELETE for the app, the App Password is never stored here', () => {
    const sql = fs.readFileSync(path.resolve(__dirname, '../../mail-store.sql'), 'utf8');
    for (const tb of ['mail_store', 'mail_sync', 'mail_sync_lease', 'mail_actions']) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${tb}`));
    assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON mail_store, mail_sync, mail_sync_lease, mail_actions TO tracker_user/);
    const code = sql.replace(/--[^\n]*/g, '');
    assert.ok(!/\bDELETE\b|DROP |TRUNCATE /i.test(code)); assert.ok(!/app_password/i.test(code));
  });
  await t('the minute cron starts the sync loop and keeps the old warm-up only until the store is installed', () => {
    const src = fs.readFileSync(path.join(SRC, 'lib/chat/email.ts'), 'utf8');
    assert.match(src, /void startMailSync\(loadSyncBoxes, runOutbox\)\.then\(\(on\) => \{\s*if \(on\) return;\s*return warmMailboxes/);
  });

  if (!PG) {
    console.log('mail store: database part skipped (set MAIL_STORE_PG to a scratch PostgreSQL that ran mail-store.sql)');
  } else {
    const db = require(path.join(SRC, 'lib/db.ts'));
    const sync = require(path.join(SRC, 'lib/chat/mail-sync.ts'));
    const store = require(path.join(SRC, 'lib/chat/mail-store.ts'));
    const outbox = require(path.join(SRC, 'lib/chat/mail-outbox.ts'));
    const pool = require(path.join(SRC, 'lib/chat/imap-pool.ts'));
    const { NextRequest } = require('next/server');
    const R = (p) => require(path.join(SRC, 'app/api/mail', p, 'route.ts'));
    const routes = { messages: R('messages'), message: R('message'), thread: R('thread'), send: R('send') };
    const perms = require(path.join(SRC, 'lib/permissions.ts'));
    authState.user = { role: 'admin', username: 'owner', permissions: perms.resolvePermissions('admin'), businessIds: null };
    const BOX = '22222222-2222-2222-2222-222222222222';
    const box = { id: BOX, email: 'vastora@store.example', appPassword: 'SECRETSECRETSECR', panelId: '11111111-1111-1111-1111-111111111111' };
    const req = (method, url, body) => new NextRequest(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const q = (sql, p) => db.query(sql, p);
    // a clean store (the app may not delete: we mark everything of this box gone and forget the sync state by uidvalidity)
    const fresh = async () => {
      resetGmail(); pool.closeAllImap(); store.forgetStoreReady();
      const salt = BigInt(Date.now());
      G.folders.INBOX.uidValidity = salt; G.folders['[Gmail]/Sent Mail'].uidValidity = salt + 1n;
      await q(`UPDATE mail_store SET gone = true WHERE box_id = $1`, [BOX]);
      await q(`UPDATE mail_sync SET uidvalidity = 0, last_uid = 0, full_at = NULL, modseq = NULL WHERE box_id = $1`, [BOX]);
      await q(`UPDATE mail_actions SET done_at = now() WHERE box_id = $1 AND done_at IS NULL`, [BOX]);
      await q(`UPDATE mail_sync_lease SET lease_until = now() - interval '1 second' WHERE box_id = $1`, [BOX]);
      await q(`UPDATE mail_outbox SET status = 'sent' WHERE box_id = $1 AND status <> 'sent'`, [BOX]).catch(() => {});
      outbox.forgetOutboxInstalled(); outbox.closeOutboxTransports(); G.smtpFail = null; G.smtpHold = null;
    };
    const outboxRow = async (id) => (await q(`SELECT status, tries, error, claimed_at FROM mail_outbox WHERE id = $1`, [id])).rows[0];
    console.log('mail store: the sync and the routes on a real PostgreSQL');

    await t('the first run copies INBOX and Sent (headers AND bodies); the screen then reads only the database', async () => {
      await fresh();
      const r = await sync.syncMailbox(box);
      deq([r.error, r.skipped, r.fresh, r.bodies], [undefined, undefined, 4, 4]);
      eq((await store.storeReady(BOX)).ok, true);
      const l = await store.storeList(BOX);
      deq(l.mails.map((m) => [m.uid, m.unread]), [[13, true], [11, true], [12, false]]);
      // one row per conversation: the first words, whether we wrote after it in the same thread, the thread's size
      deq(l.mails.map((m) => [m.uid, m.snippet, m.replied, m.threadCount]), [[13, 'Please refund my order.', true, 2], [11, 'Hi, order #1001 has not come.', false, 1], [12, 'See photo.', false, 1]]);
      const before = { connects: G.connects, fetchOnes: G.fetchOnes };
      store.forgetStoreReady();
      const res = await routes.messages.GET(req('GET', `/api/mail/messages?box=${BOX}`));
      const j = await res.json();
      deq([res.status, j.mails.length, j.unread, j.store.mails, j.store.bodies], [200, 3, 2, 4, 4]);
      const m = await (await routes.message.GET(req('GET', `/api/mail/message?box=${BOX}&uid=13`))).json();
      eq(m.mail.text.trim(), 'Please refund my order.'); eq(m.mail.unread, false); eq(m.store, true);
      deq([G.connects, G.fetchOnes], [before.connects, before.fetchOnes]);       // not one Gmail call for the screen
    });
    await t('opening marks it read in the copy at once and in Gmail on the next run (mail_actions)', async () => {
      const row = await store.storeRow(BOX, 'inbox', 13);
      eq(row.seen, true);
      eq(G.folders.INBOX.msgs.find((m) => m.uid === 13).seen, false);
      const r = await sync.syncMailbox(box);
      eq(r.actions, 1); deq(G.flagCalls.slice(-1)[0], ['add', 13, ['\\Seen']]);
      eq(G.folders.INBOX.msgs.find((m) => m.uid === 13).seen, true);
      const left = await q(`SELECT count(*)::int AS n FROM mail_actions WHERE box_id = $1 AND done_at IS NULL`, [BOX]);
      eq(left.rows[0].n, 0);
    });
    await t('the conversation comes from the database: their mail and our Gmail reply in the same thread, oldest first', async () => {
      const j = await (await routes.thread.GET(req('GET', `/api/mail/thread?box=${BOX}&address=cust@example.com&uid=13`))).json();
      deq(j.items.map((i) => [i.folder, i.uid]), [['inbox', 13], ['sent', 501]]);
      eq(j.items[1].preview, 'We are checking your order.');
      const sent = await (await routes.message.GET(req('GET', `/api/mail/message?box=${BOX}&uid=501&folder=sent&via=thread`))).json();
      eq(sent.mail.text.trim(), 'We are checking your order.');
    });
    await t('a reply: no Gmail read before sending, it shows in the conversation at once, Answered reaches Gmail, Gmail\'s copy replaces ours', async () => {
      const before = G.fetchOnes;
      const res = await routes.send.POST(req('POST', '/api/mail/send', { box: BOX, uid: 13, text: 'Your refund is being checked.' }));
      eq(res.status, 200); eq(G.fetchOnes, before);
      await outbox.runOutbox();                                                // the outbox worker the route kicked (owner 11 Oct): wait for it here
      const mail = G.sent.slice(-1)[0];
      assert.match(mail.messageId, /^<[0-9a-f-]{36}@store\.example>$/); eq(mail.to, 'cust@example.com'); eq(mail.headers['In-Reply-To'], '<m13@x>');
      let items = (await (await routes.thread.GET(req('GET', `/api/mail/thread?box=${BOX}&address=cust@example.com&uid=13`))).json()).items;
      deq(items.map((i) => [i.folder, !!i.local]), [['inbox', false], ['sent', false], ['sent', true]]);
      eq((await store.storeRow(BOX, 'inbox', 13)).answered, true);
      G.folders['[Gmail]/Sent Mail'].msgs.push({ uid: 502, thread: 'T3', seen: true, date: new Date(), from: { name: 'Vastora Support', address: 'vastora@store.example' }, to: [{ address: 'cust@example.com' }], subject: 'Re: Refund please', mid: mail.messageId, source: plain(mail.messageId, 'vastora@store.example', 'cust@example.com', 'Re: Refund please', 'Your refund is being checked.') });
      const r = await sync.syncMailbox(box);
      eq(r.fresh, 1); eq(G.folders.INBOX.msgs.find((m) => m.uid === 13).answered, true);
      items = (await (await routes.thread.GET(req('GET', `/api/mail/thread?box=${BOX}&address=cust@example.com&uid=13`))).json()).items;
      deq(items.map((i) => [i.folder, i.uid, !!i.local]), [['inbox', 13, false], ['sent', 501, false], ['sent', 502, false]]);
    });
    await t('later runs: a new mail, a flag changed in Gmail (CONDSTORE: only what changed), an archived mail goes', async () => {
      const f = G.folders.INBOX;
      f.msgs.push({ uid: 15, thread: 'T5', seen: false, date: new Date(), from: { name: 'New', address: 'new@example.com' }, to: [{ address: 'vastora@store.example' }], subject: 'Hello', mid: '<m15@x>', source: plain('<m15@x>', 'new@example.com', 'vastora@store.example', 'Hello', 'Hi') });
      f.msgs.find((m) => m.uid === 11).seen = true; f.msgs.find((m) => m.uid === 11).modseq = 101n; f.modseq = 101n;
      let r = await sync.syncMailbox(box);
      deq([r.fresh, r.flags, r.bodies], [1, 1, 1]);
      eq((await store.storeRow(BOX, 'inbox', 11)).seen, true);
      f.msgs = f.msgs.filter((m) => m.uid !== 12);
      await q(`UPDATE mail_sync SET full_at = now() - interval '1 hour' WHERE box_id = $1`, [BOX]);
      r = await sync.syncMailbox(box);
      eq(r.gone, 1);
      deq((await store.storeList(BOX)).mails.map((m) => m.uid).sort(), [11, 13, 15]);
    });
    await t('one process at a time: a mailbox another process holds is skipped; Gmail changing the folder (uidvalidity) re-copies it', async () => {
      await q(`UPDATE mail_sync_lease SET lease_by = 'other:1', lease_until = now() + interval '1 minute' WHERE box_id = $1`, [BOX]);
      eq((await sync.syncMailbox(box)).skipped, 'another process');
      await q(`UPDATE mail_sync_lease SET lease_until = now() - interval '1 second' WHERE box_id = $1`, [BOX]);
      G.folders.INBOX.uidValidity += 100n;
      const r = await sync.syncMailbox(box);
      eq(r.fresh >= 3, true);
      deq((await store.storeList(BOX)).mails.map((m) => m.uid).sort(), [11, 13, 15]);   // the old copies are gone, no doubles
    });
    await t('one row per conversation: two mails of the same thread are one row (the newer), bold while any is unread; opening it reads them all', async () => {
      const f = G.folders.INBOX;
      f.msgs.push({ uid: 17, thread: 'T1', seen: false, date: new Date(), from: { name: 'Alice', address: 'alice@example.com' }, to: [{ address: 'vastora@store.example' }], subject: 'Re: Where is my order?', mid: '<m17@x>', source: plain('<m17@x>', 'alice@example.com', 'vastora@store.example', 'Re: Where is my order?', 'Still waiting!') });
      f.msgs.find((m) => m.uid === 11).seen = false; f.msgs.find((m) => m.uid === 11).modseq = 200n; f.modseq = 200n;
      await sync.syncMailbox(box);
      const rows = (await store.storeList(BOX)).mails.filter((m) => m.fromAddress === 'alice@example.com');
      deq(rows.map((m) => [m.uid, m.unread, m.threadCount, m.snippet]), [[17, true, 2, 'Still waiting!']]);
      store.forgetStoreReady();
      await routes.message.GET(req('GET', `/api/mail/message?box=${BOX}&uid=17`));
      deq([(await store.storeRow(BOX, 'inbox', 11)).seen, (await store.storeRow(BOX, 'inbox', 17)).seen], [true, true]);
    });
    await t('a mail whose body is not copied yet still opens (read from Gmail once, not marked there by the click)', async () => {
      const f = G.folders.INBOX;
      f.msgs.push({ uid: 16, thread: 'T6', seen: false, date: new Date(), from: { name: 'Late', address: 'late@example.com' }, to: [{ address: 'vastora@store.example' }], subject: 'Body later', mid: '<m16@x>', source: plain('<m16@x>', 'late@example.com', 'vastora@store.example', 'Body later', 'Text arrives later.') });
      await q(`INSERT INTO mail_store (box_id, folder, uidvalidity, uid, from_addr, subject, sent_at) VALUES ($1, 'inbox', $2, 16, 'late@example.com', 'Body later', now())`, [BOX, String(f.uidValidity)]);
      store.forgetStoreReady();
      const ones = G.fetchOnes;
      const m = await (await routes.message.GET(req('GET', `/api/mail/message?box=${BOX}&uid=16`))).json();
      eq(m.mail.text.trim(), 'Text arrives later.'); eq(f.msgs.find((x) => x.uid === 16).seen, false);
      eq((await store.storeRow(BOX, 'inbox', 16)).seen, true);
      eq(G.fetchOnes - ones, 1); eq(m.mail.raw, undefined);
      // the body read by the click is KEPT (owner 11 Oct): the next open does not touch Gmail
      const row = await store.storeRow(BOX, 'inbox', 16);
      deq([row.body_state, row.body_text.trim()], ['done', 'Text arrives later.']);
      const again = await (await routes.message.GET(req('GET', `/api/mail/message?box=${BOX}&uid=16`))).json();
      eq(again.mail.text.trim(), 'Text arrives later.'); eq(G.fetchOnes - ones, 1);
    });
    await t('bodies come ten to a Gmail call; a batch Gmail refuses falls back to one by one', async () => {
      const f = G.folders.INBOX;
      for (let u = 20; u < 32; u++) f.msgs.push({ uid: u, thread: 'B' + u, seen: false, date: new Date(), from: { name: 'B', address: `b${u}@example.com` }, to: [{ address: 'vastora@store.example' }], subject: 'Batch ' + u, mid: `<b${u}@x>`, source: plain(`<b${u}@x>`, `b${u}@example.com`, 'vastora@store.example', 'Batch ' + u, 'Body ' + u) });
      G.batches = 0; const ones = G.fetchOnes;
      let r = await sync.syncMailbox(box);
      deq([r.fresh, r.bodies, G.batches, G.fetchOnes - ones], [12, 12, 2, 0]);   // uid 16's body was kept by the click in the group before
      eq((await store.storeMail(BOX, 'inbox', 25, false)).mail.text.trim(), 'Body 25');
      f.msgs.push({ uid: 40, thread: 'B40', seen: false, date: new Date(), from: { name: 'B', address: 'b40@example.com' }, to: [{ address: 'vastora@store.example' }], subject: 'Fallback', mid: '<b40@x>', source: plain('<b40@x>', 'b40@example.com', 'vastora@store.example', 'Fallback', 'One by one') });
      G.batchFail = true;
      r = await sync.syncMailbox(box);
      G.batchFail = false;
      deq([r.fresh, r.bodies], [1, 1]);
      eq((await store.storeMail(BOX, 'inbox', 40, false)).mail.text.trim(), 'One by one');
    });
    await t('the run\'s order (owner 11 Oct): the just-arrived INBOX mail\'s body comes in the same run even with no budget left; the lease is released at the end', async () => {
      const f = G.folders.INBOX;
      f.msgs.push({ uid: 50, thread: 'N50', seen: false, date: new Date(), from: { name: 'Now', address: 'now@example.com' }, to: [{ address: 'vastora@store.example' }], subject: 'Just arrived', mid: '<n50@x>', source: plain('<n50@x>', 'now@example.com', 'vastora@store.example', 'Just arrived', 'Fresh body') });
      const r = await sync.syncMailbox(box, Date.now() - 2 * 60 * 60_000);   // "now" two hours ago: the INBOX gone-search window is skipped either way
      deq([r.fresh, r.bodies], [1, 1]);
      eq((await store.storeMail(BOX, 'inbox', 50, false)).mail.text.trim(), 'Fresh body');
      const lease = (await q(`SELECT lease_by, lease_until <= now() AS released FROM mail_sync_lease WHERE box_id = $1`, [BOX])).rows[0];
      eq(lease.released, true);                                              // another process can take the mailbox at once
      eq(rules.LEASE_MS, 75_000);
      // the log line of this run names the sign-in time: the budget starts after it
      assert.match(fs.readFileSync(path.join(SRC, 'lib/chat/mail-sync.ts'), 'utf8'), /connected = Date\.now\(\);\s*const deadline = connected \+ SYNC_BUDGET_MS/);
    });
    await t('the outbox: a reply is queued and answered at once; the worker sends it over a pooled SMTP with timeouts; the conversation says Sending… then Sent', async () => {
      let release; G.smtpHold = new Promise((res) => { release = res; });
      const before = G.sent.length;
      const res = await routes.send.POST(req('POST', '/api/mail/send', { box: BOX, uid: 13, text: 'Queued reply.' }));
      const j = await res.json();
      deq([res.status, j.ok, j.queued, j.to], [200, true, true, 'cust@example.com']);
      eq(G.sent.length, before);                                               // nothing went out inside the request
      let items = (await (await routes.thread.GET(req('GET', `/api/mail/thread?box=${BOX}&address=cust@example.com&uid=13`))).json()).items;
      const mine = items.filter((i) => i.local);
      eq(mine.length, 1); eq(mine[0].sendState, 'sending'); eq(mine[0].preview, 'Queued reply.');
      const rowId = (await q(`SELECT id FROM mail_outbox WHERE box_id = $1 ORDER BY id DESC LIMIT 1`, [BOX])).rows[0].id;
      assert.ok(['pending', 'sending'].includes((await outboxRow(rowId)).status));
      release();
      await outbox.runOutbox();                                                // joins the run the route kicked
      eq(G.sent.length, before + 1);
      const mail = G.sent.slice(-1)[0];
      eq(mail.to, 'cust@example.com'); eq(mail.headers['In-Reply-To'], '<m13@x>'); assert.match(mail.messageId, /^<[0-9a-f-]{36}@store\.example>$/); assert.match(mail.from, /^"Vastora Support" </);
      deq([G.lastTransport.pool, G.lastTransport.connectionTimeout, G.lastTransport.greetingTimeout, G.lastTransport.socketTimeout], [true, 20000, 20000, 60000]);
      deq([(await outboxRow(rowId)).status, (await outboxRow(rowId)).tries], ['sent', 1]);
      items = (await (await routes.thread.GET(req('GET', `/api/mail/thread?box=${BOX}&address=cust@example.com&uid=13`))).json()).items;
      eq(items.find((i) => i.local).sendState, 'sent');
      eq((await store.storeRow(BOX, 'inbox', 13)).answered, true);
    });
    await t('the outbox: a failing SMTP goes back to pending with the reason, is tried again, is failed for good after 5 tries; Try again queues it again', async () => {
      G.smtpFail = 'connect ETIMEDOUT 142.250.1.1:587';
      const res = await routes.send.POST(req('POST', '/api/mail/send', { box: BOX, uid: 13, text: 'Will fail.' }));
      eq(res.status, 200);
      await outbox.runOutbox();
      const rowId = (await q(`SELECT id FROM mail_outbox WHERE box_id = $1 ORDER BY id DESC LIMIT 1`, [BOX])).rows[0].id;
      let row = await outboxRow(rowId);
      deq([row.status, row.tries, row.error], ['pending', 1, 'Gmail did not answer in time.']);
      const closedBefore = G.closed || 0, transportsBefore = G.transports;
      eq(await outbox.runOutbox(), 0); eq((await outboxRow(rowId)).tries, 1);  // too soon: a failed send waits 30 s
      for (let i = 2; i <= 5; i++) {
        await q(`UPDATE mail_outbox SET claimed_at = now() - interval '1 minute' WHERE id = $1`, [rowId]);
        await outbox.runOutbox();
        row = await outboxRow(rowId);
        deq([row.status, row.tries], [i < 5 ? 'pending' : 'failed', i]);
      }
      // the pooled transport is dropped after every error and made again for the next try (a hung SMTP never sticks)
      eq(G.transports - transportsBefore, 4); eq((G.closed || 0) - closedBefore, 4);
      let items = (await (await routes.thread.GET(req('GET', `/api/mail/thread?box=${BOX}&address=cust@example.com&uid=13`))).json()).items;
      const failed = items.find((i) => i.local && i.preview === 'Will fail.');
      deq([failed.sendState, failed.sendError, failed.outboxId], ['failed', 'Gmail did not answer in time.', String(rowId)]);
      // Try again (the conversation's button): pending with fresh tries, then it goes out
      G.smtpFail = null;
      const retry = await routes.send.POST(req('POST', '/api/mail/send', { box: BOX, action: 'retry', id: String(rowId) }));
      eq(retry.status, 200);
      await outbox.runOutbox();
      deq([(await outboxRow(rowId)).status, (await outboxRow(rowId)).tries], ['sent', 1]);
      assert.match(G.sent.slice(-1)[0].text, /^Will fail\.\n\nOn .* wrote:\n> Please refund my order\./);   // the quote is in
      eq((await routes.send.POST(req('POST', '/api/mail/send', { box: BOX, action: 'retry', id: String(rowId) }))).status, 404);   // not failed any more
      eq((await routes.send.POST(req('POST', '/api/mail/send', { box: BOX, action: 'retry', id: 'x' }))).status, 400);
      eq(G.sent.filter((m) => m.text.startsWith('Will fail.')).length, 1);
    });
    await t('the outbox: two processes never send one reply twice (the claim); a row a dead process left in sending is taken after 3 minutes', async () => {
      G.smtpFail = null; G.smtpHold = null;
      await routes.send.POST(req('POST', '/api/mail/send', { box: BOX, uid: 13, text: 'Once only.' }));
      await outbox.runOutbox();
      eq(G.sent.filter((m) => m.text.startsWith('Once only.')).length, 1);
      const id = (await q(`INSERT INTO mail_outbox (box_id, to_addr, subject, text_body, html_body, message_id) VALUES ($1, 'cust@example.com', 'Re: x', 'Claim me', '<p>Claim me</p>', '<claim@x>') RETURNING id`, [BOX])).rows[0].id;
      const [a, b] = await Promise.all([outbox.claimOutbox(String(id)), outbox.claimOutbox(String(id))]);
      eq([a, b].filter(Boolean).length, 1);                                    // exactly one process gets it
      await q(`UPDATE mail_outbox SET status = 'sending', claimed_at = now() - interval '4 minutes' WHERE id = $1`, [id]);   // that process died mid-send
      await outbox.runOutbox();
      eq((await outboxRow(id)).status, 'sent'); eq(G.sent.filter((m) => m.text === 'Claim me').length, 1);
      await q(`UPDATE mail_outbox SET status = 'sending', claimed_at = now() - interval '1 minute' WHERE id = $1`, [id]);   // still being sent elsewhere: left alone
      await outbox.runOutbox();
      eq((await outboxRow(id)).status, 'sending'); eq(G.sent.filter((m) => m.text === 'Claim me').length, 1);
      await q(`UPDATE mail_outbox SET status = 'sent' WHERE id = $1`, [id]);
      // two concurrent runs in one process join into one
      await routes.send.POST(req('POST', '/api/mail/send', { box: BOX, uid: 13, text: 'Joined.' }));
      await Promise.all([outbox.runOutbox(), outbox.runOutbox(), outbox.runOutbox()]);
      eq(G.sent.filter((m) => m.text.startsWith('Joined.')).length, 1);
    });
    await t('a gone copy of a UID (an older Gmail numbering, body never copied) is never the one opened or replied to', async () => {
      const f = G.folders.INBOX;
      const uv = String(f.uidValidity);
      const row = await store.storeRow(BOX, 'inbox', 13);
      eq(row.uidvalidity, uv);
      await q(`INSERT INTO mail_store (box_id, folder, uidvalidity, uid, from_addr, subject, sent_at, gone) VALUES ($1, 'inbox', $2, 13, 'cust@example.com', 'old copy', now(), true) ON CONFLICT DO NOTHING`, [BOX, String(f.uidValidity + 999n)]);
      const again = await store.storeRow(BOX, 'inbox', 13);
      deq([again.uidvalidity, again.body_state], [uv, 'done']);
      const orig = await store.storeOriginal(BOX, 13);
      assert.ok(orig && orig.row.id === row.id, 'the reply uses the live copy');
    });
    pool.closeAllImap();
    outbox.closeOutboxTransports();
    await db.getPool().end();
  }
  console.log(`MAIL-STORE: ${pass} groups passed${fail ? `, ${fail} FAILED` : ''}`);
  process.exit(fail ? 1 : 0);
})();
