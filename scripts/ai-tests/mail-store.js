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
  async messageFlagsAdd(uid, flags) { if (G.flagFail && Number(uid) === G.flagFail) throw new Error('flag refused'); G.flagCalls.push(['add', Number(uid), flags]); const m = this.f.msgs.find((x) => x.uid === Number(uid)); if (m) { if (flags.includes('\\Seen')) m.seen = true; if (flags.includes('\\Answered')) m.answered = true; } return true; }
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
  await t('sari mail (owner 14 Oct, "shiptrack sari mail nai pakad rha ... gmail pa pending dikh rhi, shiptrack ma koi pending nai"): up to 2,000 conversations of 60 days, unanswered first; an address we wrote to before is a customer', () => {
    const f = require(path.join(SRC, 'lib/chat/mail-filters.ts'));
    const v = require(path.join(SRC, 'lib/chat/mail-view.ts'));
    assert.strictEqual(v.STORE_MAX_CONVS, 2000); assert.strictEqual(v.STORE_LIST_DAYS, 60);
    const base = { uid: 1, from: 'Priya', subject: 'order', date: '2026-10-14T05:00:00Z', unread: false, hasAttachment: false, answered: false };
    assert.strictEqual(f.bucketOf({ ...base, fromAddress: 'priya@tcs.com' }, {}), 'other', 'a work address we never wrote to');
    assert.strictEqual(f.bucketOf({ ...base, fromAddress: 'priya@tcs.com', contact: true }, {}), 'todo', 'a work address we wrote to before = a customer');
    assert.strictEqual(f.bucketOf({ ...base, fromAddress: 'noreply@tcs.com', contact: true }, {}), 'other', 'a robot stays out');
    const rules = require(path.join(SRC, 'lib/chat/mail-store-rules.ts'));
    assert.strictEqual(rules.rowToListItem({ uid: 1, from_addr: 'a@b.com', sent_at: new Date(), contact: true }).contact, true);
    const store = fs.readFileSync(path.join(SRC, 'lib/chat/mail-store.ts'), 'utf8');
    assert.ok(/ORDER BY \(i\.answered OR ra\.replied_at IS NOT NULL\) ASC, i\.sent_at DESC LIMIT \$\{STORE_MAX_CONVS \+ 1\}/.test(store), 'unanswered first, then newest');
    assert.ok(/sinceDate\(now, STORE_LIST_DAYS\)/.test(store));
    const sync = fs.readFileSync(path.join(SRC, 'lib/chat/mail-sync.ts'), 'utf8');
    assert.ok(/const since = sinceDate\(now, STORE_LIST_DAYS\);\n    const present/.test(sync), 'the gone check covers the same 60 days');
    const card = fs.readFileSync(path.join(SRC, 'components/MailCard.tsx'), 'utf8');
    assert.ok(/Show more \(\{shown\.length - rowLimit\} left\)/.test(card) && /Gmail has not synced for/.test(card));
  });

  await t('cases per customer (owner 11 Oct afternoon, "active case aur close case"; 12:45, live: he replied and the customer stayed active, "Chat Support jaisa, apne aap"): a new mail = active; our reply after it = closed; wrote again = active; Close / Reopen by hand; not-customer mail is never a case; a closed customer leaves To reply', () => {
    const f = require(path.join(SRC, 'lib/chat/mail-filters.ts'));
    const it = (uid, a, date, o = {}) => ({ uid, from: 'X', fromAddress: a, subject: 's', date, unread: false, hasAttachment: false, answered: false, ...o });
    const P = 'piyush@gmail.com';
    const asked = it(1, P, '2026-10-10T10:00:00Z');
    // a new mail = active (no case row at all); our reply after it (repliedAt from the store) = closed, "replied <when>"
    eq(f.caseState(asked, {}), 'active'); eq(f.caseState(asked, undefined), 'active');
    deq(f.customerCase([asked], P, {}, undefined), { state: 'active', closedAt: null });
    const replied = it(1, P, '2026-10-10T10:00:00Z', { replied: true, repliedAt: '2026-10-10T11:00:00Z' });
    eq(f.caseState(replied, {}), 'closed');
    deq(f.customerCase([replied], P, {}, {}), { state: 'closed', closedAt: '2026-10-10T11:00:00Z', closedBy: 'reply' });
    // the customer wrote again after our reply = active by himself (his newest mail has no reply after it)
    const again = it(2, P, '2026-10-11T09:00:00Z');
    eq(f.caseState(again, {}), 'active');
    deq(f.customerCase([replied, again], P, {}, {}), { state: 'active', closedAt: null });
    // the old path (no repliedAt): the replied / answered flag = answered at the mail's own time = closed
    eq(f.caseState(it(1, P, '2026-10-10T10:00:00Z', { answered: true }), {}), 'closed');
    eq(f.caseState(it(1, P, '2026-10-10T10:00:00Z', { replied: true }), undefined), 'closed');
    deq(f.customerCase([it(1, P, '2026-10-10T10:00:00Z', { answered: true })], P, {}, undefined), { state: 'closed', closedAt: '2026-10-10T10:00:00Z', closedBy: 'reply' });
    // Close case by hand (a mail that needs no reply): closed, who and when; a newer mail from the customer = active by himself
    const closed = { [P]: { closedAt: '2026-10-10T12:00:00Z', by: 'owner', byName: 'Super Admin' } };
    eq(f.caseState(asked, closed), 'closed'); eq(f.caseState(again, closed), 'active');
    deq(f.customerCase([asked], P, {}, closed), { state: 'closed', closedAt: '2026-10-10T12:00:00Z', closedBy: 'hand', byName: 'Super Admin' });
    deq(f.customerCase([asked, again], P, {}, closed), { state: 'active', closedAt: null });
    eq(f.caseState(it(3, 'Piyush@Gmail.com', '2026-10-10T10:00:00Z'), closed), 'closed');            // the address is matched lower-case
    eq(f.caseClosedAt(asked, closed), '2026-10-10T12:00:00Z'); eq(f.caseClosedAt(again, closed), null);
    // the later of the two closed it: a close by hand after our reply is the one the team meant; a reply after a close says "replied"
    eq(f.customerCase([replied], P, {}, closed).closedBy, 'hand');                                       // replied 11:00, closed 12:00
    deq(f.customerCase([it(1, P, '2026-10-10T10:00:00Z', { replied: true, repliedAt: '2026-10-10T13:00:00Z' })], P, {}, closed), { state: 'closed', closedAt: '2026-10-10T13:00:00Z', closedBy: 'reply' });
    // Reopen case: active until a NEWER reply (or a close again); the reply from before the reopen does not close it
    const reopened = { [P]: { closedAt: null, reopenedAt: '2026-10-10T14:00:00Z', by: 'u2', byName: 'Rahul' } };
    eq(f.caseState(asked, reopened), 'active');
    eq(f.caseState(it(1, P, '2026-10-10T10:00:00Z', { replied: true, repliedAt: '2026-10-10T13:00:00Z' }), reopened), 'active');
    eq(f.caseState(it(1, P, '2026-10-10T10:00:00Z', { replied: true, repliedAt: '2026-10-10T15:00:00Z' }), reopened), 'closed');
    deq(f.customerCase([it(1, P, '2026-10-10T10:00:00Z', { replied: true, repliedAt: '2026-10-10T15:00:00Z' })], P, {}, reopened), { state: 'closed', closedAt: '2026-10-10T15:00:00Z', closedBy: 'reply' });
    eq(f.caseState(it(1, P, '2026-10-10T10:00:00Z', { answered: true }), reopened), 'active');          // old path: the flag counts at the mail's time, before the reopen
    eq(f.caseState(it(4, P, '2026-10-10T16:00:00Z', { answered: true }), reopened), 'closed');          // a mail after the reopen, answered: closed
    // one row per CUSTOMER (newest conversation, how many conversations), newest first; not-customer mail never a case
    const riya = [it(5, 'riya@yahoo.com', '2026-10-09T10:00:00Z'), it(6, 'riya@yahoo.com', '2026-10-11T11:00:00Z')];
    const items = [asked, ...riya, it(7, 'alerts@hdfcbank.net', '2026-10-11T12:00:00Z'), it(8, 'noreply@gmail.com', '2026-10-11T12:00:00Z')];
    deq(f.caseRows(items, {}, closed, 'active').map((r) => [r.uid, r.fromAddress, r.convCount]), [[6, 'riya@yahoo.com', 2]]);
    deq(f.caseRows(items, {}, closed, 'closed').map((r) => [r.uid, r.convCount]), [[1, 1]]);
    deq(f.caseRows([...items, again], {}, closed, 'active').map((r) => [r.uid, r.convCount]), [[6, 2], [2, 2]]);   // Piyush wrote again: active, newest conversation on top
    eq(f.caseRows(items, {}, closed, 'closed').length + f.caseRows(items, {}, closed, 'active').length, 2);            // the bank and the robot are nobody's case
    // Riya replied to (repliedAt on her newest conversation): a closed row with no case row at all; her older one does not count
    deq(f.caseRows([riya[0], { ...riya[1], replied: true, repliedAt: '2026-10-11T11:30:00Z' }], {}, undefined, 'closed').map((r) => [r.uid, r.convCount]), [[6, 2]]);
    deq(f.caseRows([{ ...riya[0], replied: true, repliedAt: '2026-10-09T11:00:00Z' }, riya[1]], {}, undefined, 'active').map((r) => r.uid), [6]);
    eq(f.customerCase(items, 'alerts@hdfcbank.net', {}, closed), null); eq(f.customerCase(items, 'nobody@gmail.com', {}, closed), null);
    eq(f.customerCase(items, 'shop@company.in', { 'shop@company.in': [{ orderId: '#1' }] }, closed), null);         // verified but not in the list
    // the boxes keep their own rule: a mail under a close by hand is Replied (leaves To reply) even without a reply; without the map nothing changes
    eq(f.bucketOf(asked, {}, closed), 'done'); eq(f.bucketOf(asked, {}), 'todo'); eq(f.bucketOf(again, {}, closed), 'todo');
    eq(f.bucketOf(it(7, 'alerts@hdfcbank.net', '2026-10-11T12:00:00Z'), {}, closed), 'other');
    const c = f.viewCounts([...items, again], {}, Date.parse('2026-10-11T13:00:00Z'), closed);
    deq([c.todo, c.done, c.other, c.active, c.closed], [3, 1, 2, 2, 0]);                                              // active / closed count customers
    const c2 = f.viewCounts(items, {}, Date.parse('2026-10-11T13:00:00Z'), closed);
    deq([c2.todo, c2.done, c2.active, c2.closed], [2, 1, 1, 1]);
    const c3 = f.viewCounts([replied, ...riya], {}, Date.parse('2026-10-11T13:00:00Z'), {});
    deq([c3.todo, c3.done, c3.active, c3.closed], [2, 1, 1, 1]);                                                        // a reply closes Piyush, Riya stays active
    deq([f.VIEW_LABELS.active, f.VIEW_LABELS.closed], ['Active cases', 'Closed cases']);
    eq(f.matchesView(asked, 'closed', {}, Date.now(), closed), true); eq(f.matchesView(again, 'active', {}, Date.now(), closed), true);
    eq(f.matchesView(replied, 'closed', {}, Date.now(), {}), true); eq(f.matchesView(replied, 'active', {}, Date.now(), reopened), true);
    // the screen: a sent reply stamps repliedAt on EVERY row of that customer (owner 11 Oct 13:02: his other threads too,
    // as storeList counts a reply to the customer) and opens the next active customer from Active cases
    const card = fs.readFileSync(path.join(SRC, 'components/MailCard.tsx'), 'utf8');
    assert.match(card, /const at = new Date\(\)\.toISOString\(\);/);
    assert.match(card, /x\.uid === uid \|\| \(addr && caseAddress\(x\.fromAddress\) === addr\) \? \{ \.\.\.x, answered: true, replied: true, repliedAt: at \}/);
    assert.match(card, /else if \(view === 'active'\) goNext\(uid, x => caseState\(x, cases\) === 'active'\)/);
    // the server side (mail-cases.ts): the chat_settings key, the masked address for the log, and no DELETE anywhere
    const src = fs.readFileSync(path.join(SRC, 'lib/chat/mail-cases.ts'), 'utf8');
    const code = src.replace(/\/\/[^\n]*/g, '');
    assert.ok(!/\bDELETE\b/.test(code) && /ON CONFLICT \(key\) DO UPDATE/.test(code) && /mail_case:/.test(code));
    assert.match(fs.readFileSync(path.join(SRC, 'app/api/mail/case/route.ts'), 'utf8'), /mailAccess\(request, body\.box \?\? null, 'reply'\)/);
    // the unread fix (owner 11 Oct afternoon): marking read through PATCH reads the whole conversation; mark unread stays one mail
    assert.match(fs.readFileSync(path.join(SRC, 'app/api/mail/message/route.ts'), 'utf8'), /if \(body\.seen\) await storeSeenThread\(row\);/);
    // the sync never undoes a click Gmail has not taken yet
    assert.match(fs.readFileSync(path.join(SRC, 'lib/chat/mail-sync.ts'), 'utf8'), /AND NOT EXISTS \(SELECT 1 FROM mail_actions a WHERE a\.box_id = \$1 AND a\.folder = \$2 AND a\.uidvalidity = \$3 AND a\.uid = \$4 AND a\.done_at IS NULL\)/);
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
    const routes = { messages: R('messages'), message: R('message'), thread: R('thread'), send: R('send'), mailCase: R('case') };
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
      // replied_at (owner 11 Oct 12:45, a reply closes the case): WHEN we last wrote after the mail (the Sent copy's time); none where we never did
      eq(l.mails[0].repliedAt, G.folders['[Gmail]/Sent Mail'].msgs[0].date.toISOString());
      deq(l.mails.slice(1).map((m) => 'repliedAt' in m), [false, false]);
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
    await t('Unread (owner 11 Oct afternoon, "Unread ka feature nahi chal raha"): marking read through PATCH (a mail the screen read ahead) reads the whole conversation; Mark unread stays one mail; the sync never undoes a click Gmail has not taken', async () => {
      const f = G.folders.INBOX;
      f.msgs.push({ uid: 18, thread: 'T1', seen: false, date: new Date(), from: { name: 'Alice', address: 'alice@example.com' }, to: [{ address: 'vastora@store.example' }], subject: 'Re: Where is my order?', mid: '<m18@x>', source: plain('<m18@x>', 'alice@example.com', 'vastora@store.example', 'Re: Where is my order?', 'Third mail') });
      await sync.syncMailbox(box);                                             // Gmail gets the earlier clicks (11, 17 read); 18 is copied unread
      store.forgetStoreReady();
      let r = await routes.message.PATCH(req('PATCH', '/api/mail/message', { box: BOX, uid: 11, seen: false }));   // Mark unread on the older mail
      eq(r.status, 200);
      let row = (await store.storeList(BOX)).mails.find((m) => m.fromAddress === 'alice@example.com');
      deq([row.uid, row.unread, row.threadCount], [18, true, 3]);
      // the screen opened uid 18 from its cache and only sent PATCH seen:true: before, 11 stayed unread and the row came back bold
      r = await routes.message.PATCH(req('PATCH', '/api/mail/message', { box: BOX, uid: 18, seen: true }));
      eq(r.status, 200);
      deq([(await store.storeRow(BOX, 'inbox', 18)).seen, (await store.storeRow(BOX, 'inbox', 11)).seen, (await store.storeRow(BOX, 'inbox', 17)).seen], [true, true, true]);
      row = (await store.storeList(BOX)).mails.find((m) => m.fromAddress === 'alice@example.com');
      eq(row.unread, false);
      // Mark unread: that one mail, as in Gmail; the row is bold again (any mail of the thread unread)
      r = await routes.message.PATCH(req('PATCH', '/api/mail/message', { box: BOX, uid: 18, seen: false }));
      eq(r.status, 200);
      deq([(await store.storeRow(BOX, 'inbox', 18)).seen, (await store.storeRow(BOX, 'inbox', 11)).seen], [false, true]);
      eq((await store.storeList(BOX)).mails.find((m) => m.fromAddress === 'alice@example.com').unread, true);
      // the next run writes the clicks to Gmail (unseen 11, seen 18, seen 11, unseen 18 in order) and reads the same back
      const res = await sync.syncMailbox(box);
      eq(res.actions, 4);
      deq([f.msgs.find((m) => m.uid === 18).seen, f.msgs.find((m) => m.uid === 11).seen], [false, true]);
      deq([(await store.storeRow(BOX, 'inbox', 18)).seen, (await store.storeRow(BOX, 'inbox', 11)).seen], [false, true]);
      // a click Gmail has not taken yet (its mail_actions row still open: Gmail refused the flag call) is never undone by
      // Gmail's older flag; once Gmail took it, Gmail's flags count again
      const kept = await store.storeRow(BOX, 'inbox', 18);
      await q(`UPDATE mail_store SET seen = true WHERE id = $1`, [kept.id]);
      await q(`INSERT INTO mail_actions (box_id, folder, uidvalidity, uid, action) VALUES ($1, 'inbox', $2, 18, 'seen')`, [BOX, kept.uidvalidity]);
      f.msgs.find((m) => m.uid === 18).modseq = 301n; f.modseq = 301n;   // Gmail still says "unseen" for 18 (changed since the last look)
      G.flagFail = 18;
      await sync.syncMailbox(box);
      G.flagFail = null;
      eq((await q(`SELECT count(*)::int AS n FROM mail_actions WHERE box_id = $1 AND done_at IS NULL`, [BOX])).rows[0].n, 1);
      eq((await store.storeRow(BOX, 'inbox', 18)).seen, true);
      await sync.syncMailbox(box);                                             // Gmail takes it now
      deq([f.msgs.find((m) => m.uid === 18).seen, (await store.storeRow(BOX, 'inbox', 18)).seen], [true, true]);
      f.msgs.find((m) => m.uid === 18).seen = false; f.msgs.find((m) => m.uid === 18).modseq = 302n; f.modseq = 302n;   // marked unread in Gmail itself
      await sync.syncMailbox(box);
      eq((await store.storeRow(BOX, 'inbox', 18)).seen, false);
    });
    await t('cases (owner 11 Oct afternoon): POST /api/mail/case close / reopen writes one chat_settings row (an UPDATE on reopen, never a DELETE), the list answers `cases`, a login without Reply gets 403', async () => {
      try { await q(`CREATE TABLE IF NOT EXISTS chat_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`); }
      catch (e) { try { await q(`SELECT 1 FROM chat_settings LIMIT 1`); } catch { throw new Error(`the scratch database needs chat_settings (run chat-settings.sql on it): ${e.message}`); } }
      const key = `mail_case:${BOX}:alice@example.com`;
      await q(`UPDATE chat_settings SET value = '{"closedAt":null}' WHERE key = $1`, [key]);
      const before = (await (await routes.messages.GET(req('GET', `/api/mail/messages?box=${BOX}`))).json()).cases;
      deq(before['alice@example.com'] && before['alice@example.com'].closedAt, before['alice@example.com'] ? null : undefined);
      let r = await routes.mailCase.POST(req('POST', '/api/mail/case', { box: BOX, address: 'Alice@Example.com', action: 'close' }));
      let j = await r.json();
      deq([r.status, j.ok, j.address, j.state, j.case.by, j.case.byName], [200, true, 'alice@example.com', 'closed', 'owner', 'owner']);   // byName = displayName, else the username
      assert.ok(!Number.isNaN(Date.parse(j.case.closedAt)));
      let rows = (await q(`SELECT key, value FROM chat_settings WHERE key = $1`, [key])).rows;
      eq(rows.length, 1); eq(JSON.parse(rows[0].value).closedAt, j.case.closedAt);
      const cases = (await (await routes.messages.GET(req('GET', `/api/mail/messages?box=${BOX}`))).json()).cases;
      deq(cases['alice@example.com'], { closedAt: j.case.closedAt, by: 'owner', byName: 'owner', reopenedAt: null });
      r = await routes.mailCase.POST(req('POST', '/api/mail/case', { box: BOX, address: 'alice@example.com', action: 'reopen' }));
      j = await r.json();
      deq([r.status, j.state, j.case.closedAt], [200, 'active', null]); assert.ok(!Number.isNaN(Date.parse(j.case.reopenedAt)));
      rows = (await q(`SELECT value FROM chat_settings WHERE key = $1`, [key])).rows;
      eq(rows.length, 1); eq(JSON.parse(rows[0].value).closedAt, null);                                  // updated, not deleted
      eq((await (await routes.messages.GET(req('GET', `/api/mail/messages?box=${BOX}`))).json()).cases['alice@example.com'].closedAt, null);
      eq((await routes.mailCase.POST(req('POST', '/api/mail/case', { box: BOX, address: 'not an address', action: 'close' }))).status, 400);
      eq((await routes.mailCase.POST(req('POST', '/api/mail/case', { box: BOX, address: 'alice@example.com', action: 'drop' }))).status, 400);
      const owner = authState.user;
      authState.user = { role: 'agent', username: 'reader', displayName: 'Reader', id: 'u1', permissions: ['mail.view'], businessIds: null };
      eq((await routes.mailCase.POST(req('POST', '/api/mail/case', { box: BOX, address: 'alice@example.com', action: 'close' }))).status, 403);
      authState.user = owner;
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
    await t('a reply to a mail whose body is not copied yet still goes through the outbox (no Gmail read, no quote)', async () => {
      const row = await store.storeRow(BOX, 'inbox', 13);
      await q(`UPDATE mail_store SET body_state = 'none' WHERE id = $1`, [row.id]);
      const orig = await store.storeOriginal(BOX, 13);
      assert.ok(orig && orig.hasBody === false && orig.text === '', 'headers without the body');
      const before = Number((await q(`SELECT count(*)::int AS n FROM mail_outbox`)).rows[0].n);
      const r = await routes.send.POST(req('POST', '/api/mail/send', { box: BOX, uid: 13, text: 'No body yet.' }));
      const d = await r.json();
      eq(d.queued, true);
      const after = Number((await q(`SELECT count(*)::int AS n FROM mail_outbox`)).rows[0].n);
      eq(after, before + 1);
      const last = (await q(`SELECT text_body FROM mail_outbox ORDER BY id DESC LIMIT 1`)).rows[0];
      assert.ok(last.text_body.startsWith('No body yet.') && !/wrote:/.test(last.text_body), 'no quote of an empty original');
      await q(`UPDATE mail_store SET body_state = 'done' WHERE id = $1`, [row.id]);
    });
    await t('cases close by themselves (owner 11 Oct 12:45): the list carries WHEN we last wrote after the mail; a customer writing again = none = active; a reply from here (the local Sent row, before Gmail\'s copy) = closed at once', async () => {
      const f = require(path.join(SRC, 'lib/chat/mail-filters.ts'));
      const inbox = G.folders.INBOX;
      let row = (await store.storeList(BOX)).mails.find((m) => m.fromAddress === 'cust@example.com');
      eq(row.replied, true); assert.ok(row.repliedAt && Date.parse(row.repliedAt) > Date.parse(row.date), 'the earlier replies to uid 13 are after it');
      const max = (await q(`SELECT max(sent_at) AS at FROM mail_store WHERE box_id = $1 AND folder = 'sent' AND NOT gone AND thread_id = 'T3'`, [BOX])).rows[0].at;
      eq(row.repliedAt, new Date(max).toISOString());                            // the newest Sent row of the thread (a reply from here counts)
      eq(f.caseState(row, {}), 'closed');
      // the customer writes again in the same conversation (a Gmail UID above every one kept): his newest mail has no reply after it = no replied_at = active
      inbox.msgs.push({ uid: 60, thread: 'T3', seen: false, date: new Date(), from: { name: 'Cust', address: 'cust@example.com' }, to: [{ address: 'vastora@store.example' }], subject: 'Re: Refund please', mid: '<m60@x>', source: plain('<m60@x>', 'Cust <cust@example.com>', 'vastora@store.example', 'Re: Refund please', 'Any update on the refund?') });
      await sync.syncMailbox(box);
      store.forgetStoreReady();
      row = (await store.storeList(BOX)).mails.find((m) => m.fromAddress === 'cust@example.com');
      deq([row.uid, row.replied, 'repliedAt' in row], [60, false, false]);
      eq(f.caseState(row, {}), 'active');
      for (const a of ['alice@example.com', 'new@example.com']) { const m = (await store.storeList(BOX)).mails.find((x) => x.fromAddress === a); eq(m.replied, false); eq('repliedAt' in m, false); }
      // a reply from here: the local Sent row carries the thread id, so the list closes the case before Gmail's copy is in
      const res = await routes.send.POST(req('POST', '/api/mail/send', { box: BOX, uid: 60, text: 'Your refund went out today.' }));
      eq(res.status, 200);
      await outbox.runOutbox();
      row = (await store.storeList(BOX)).mails.find((m) => m.fromAddress === 'cust@example.com');
      deq([row.uid, row.replied], [60, true]); assert.ok(Date.parse(row.repliedAt) > Date.parse(row.date));
      eq(f.caseState(row, {}), 'closed');
      deq(f.customerCase([row], 'cust@example.com', { 'cust@example.com': [{ orderId: '#1001' }] }, {}), { state: 'closed', closedAt: row.repliedAt, closedBy: 'reply' });   // verified = a customer (example.com is no personal mailbox)
      // the route answers it too
      const j = await (await routes.messages.GET(req('GET', `/api/mail/messages?box=${BOX}`))).json();
      eq(j.mails.find((m) => m.fromAddress === 'cust@example.com').repliedAt, row.repliedAt);
    });
    await t('answered per CUSTOMER, not per thread (owner 11 Oct 13:02, kurtiya: Bhanu\'s two mails, one answer in the first thread): a Sent row to the sender after the mail counts in any thread; to another address, or before the mail, does not', async () => {
      const f = require(path.join(SRC, 'lib/chat/mail-filters.ts'));
      const uv = String(G.folders.INBOX.uidValidity), suv = String(G.folders['[Gmail]/Sent Mail'].uidValidity);
      const B = 'bhanu@gmail.com';
      // two INBOX threads of one customer: A (uid 70, 3 h ago) and B (uid 71, 2 h ago, his newest mail)
      await q(`INSERT INTO mail_store (box_id, folder, uidvalidity, uid, thread_id, from_name, from_addr, subject, sent_at) VALUES
               ($1, 'inbox', $2, 70, 'TA', 'Bhanu', $3, 'Order not received', now() - interval '3 hours'),
               ($1, 'inbox', $2, 71, 'TB', 'Bhanu', $3, 'Please reply', now() - interval '2 hours')`, [BOX, uv, B]);
      // what must NOT count: our mail to him BEFORE his mail B, and a mail to somebody else after it
      await q(`INSERT INTO mail_store (box_id, folder, uidvalidity, uid, thread_id, from_addr, to_list, to_addrs, subject, sent_at, seen) VALUES
               ($1, 'sent', $2, 601, 'TA', 'vastora@store.example', $3, ARRAY[$3]::text[], 'Re: Order not received', now() - interval '150 minutes', true),
               ($1, 'sent', $2, 602, 'TX', 'vastora@store.example', 'other@gmail.com', ARRAY['other@gmail.com']::text[], 'Hello', now() - interval '30 minutes', true)`, [BOX, suv, B]);
      const list = async () => (await store.storeList(BOX)).mails.filter((m) => m.fromAddress === B).sort((a, b) => a.uid - b.uid);
      let rows = await list();
      deq(rows.map((m) => [m.uid, m.replied, 'repliedAt' in m]), [[70, true, true], [71, false, false]]);   // A answered (601 is after it), B not
      eq(f.caseState(rows[1], {}), 'active'); eq(f.bucketOf(rows[1], {}), 'todo');
      // the team answers INSIDE thread A, after B's mail, addressed to him: B is answered too
      const ins = await q(`INSERT INTO mail_store (box_id, folder, uidvalidity, uid, thread_id, from_addr, to_list, to_addrs, subject, sent_at, seen) VALUES
               ($1, 'sent', $2, 603, 'TA', 'vastora@store.example', $3, ARRAY[$3]::text[], 'Re: Order not received', now() - interval '1 hour', true) RETURNING sent_at`, [BOX, suv, B]);
      rows = await list();
      deq(rows.map((m) => [m.uid, m.replied]), [[70, true], [71, true]]);
      eq(rows[1].repliedAt, new Date(ins.rows[0].sent_at).toISOString());
      eq(f.caseState(rows[1], {}), 'closed'); eq(f.bucketOf(rows[1], {}), 'done');
      deq(f.customerCase(rows, B, {}, {}), { state: 'closed', closedAt: rows[1].repliedAt, closedBy: 'reply' });   // gmail.com = a customer
      // a mail Gmail gave no thread id still counts through the address
      await q(`INSERT INTO mail_store (box_id, folder, uidvalidity, uid, thread_id, from_addr, subject, sent_at) VALUES ($1, 'inbox', $2, 72, NULL, 'solo@gmail.com', 'No thread', now() - interval '2 hours')`, [BOX, uv]);
      await q(`INSERT INTO mail_store (box_id, folder, uidvalidity, uid, thread_id, from_addr, to_list, to_addrs, subject, sent_at, seen) VALUES ($1, 'sent', $2, 604, NULL, 'vastora@store.example', 'solo@gmail.com', ARRAY['solo@gmail.com']::text[], 'Re: No thread', now() - interval '1 hour', true)`, [BOX, suv]);
      const solo = (await store.storeList(BOX)).mails.find((m) => m.fromAddress === 'solo@gmail.com');
      deq([solo.uid, solo.replied, !!solo.repliedAt], [72, true, true]);
      const other = (await store.storeList(BOX)).mails.find((m) => m.fromAddress === 'other@gmail.com');
      eq(other, undefined);                                                       // the Sent row to somebody else made no row and counted for nobody
      await q(`UPDATE mail_store SET gone = true WHERE box_id = $1 AND uid IN (70, 71, 72, 601, 602, 603, 604)`, [BOX]);
    });
    pool.closeAllImap();
    outbox.closeOutboxTransports();
    await db.getPool().end();
  }
  console.log(`MAIL-STORE: ${pass} groups passed${fail ? `, ${fail} FAILED` : ''}`);
  process.exit(fail ? 1 : 0);
})();
