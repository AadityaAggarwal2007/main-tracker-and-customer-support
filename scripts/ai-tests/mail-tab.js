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
    authFail: false, connects: [], locks: [], searches: [], fetchQueries: [], logouts: 0, closes: 0, sent: [], flagCalls: [],
    boxes: [
      { id: 'boxV', email: 'vastora@store.example', app_password: 'SECRETSECRETSECR', site_name: 'Vastora', panel_id: 'bizV', panel_name: 'vastora' },
      { id: 'boxK', email: 'kurtiya@store.example', app_password: 'OTHERSECRETOTHER', site_name: 'Kurtiya', panel_id: 'bizK', panel_name: 'kurtiya' },
    ],
  }, over);
}
reset();

const db = {
  query: async (sql, params) => {
    if (/FROM site_emails se/.test(sql)) {
      const rows = /WHERE se\.id = \$1/.test(sql) ? S.boxes.filter((b) => b.id === params[0]) : S.boxes;
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  },
  queryOne: async () => null,
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
      constructor(o) { this.user = o.auth.user; S.connects.push(o.auth.user); }
      async connect() { if (S.authFail) { const e = new Error('Invalid credentials (Failure)'); e.authenticationFailed = true; throw e; } }
      async getMailboxLock(box, o) { S.locks.push({ box, readOnly: !!(o && o.readOnly) }); return { release() {} }; }
      async search(q) { S.searches.push(q); return S.msgs.map((_, i) => i + 1); }
      fetch(seqs, q) {
        S.fetchQueries.push(q);
        const list = seqs.map((s) => S.msgs[s - 1]);
        return (async function* () {
          for (const m of list) {
            yield {
              uid: m.uid, flags: new Set([...(m.seen ? ['\\Seen'] : []), ...(m.answered ? ['\\Answered'] : [])]),
              envelope: { from: [m.from], subject: m.subject, date: new Date(m.date) },
              bodyStructure: m.attachment ? { childNodes: [{ disposition: 'inline' }, { disposition: 'attachment' }] } : { type: 'text/plain' },
            };
          }
        })();
      }
      async fetchOne(uid, q, o) {
        assert.ok(o && o.uid, 'a single mail is fetched by UID');
        const m = S.msgs.find((x) => String(x.uid) === String(uid));
        return m ? { source: Buffer.from(m.source), flags: new Set([...(m.seen ? ['\\Seen'] : []), ...(m.answered ? ['\\Answered'] : [])]) } : false;
      }
      async messageFlagsAdd(uid, flags) { S.flagCalls.push(['add', Number(uid), flags]); const m = S.msgs.find((x) => x.uid === Number(uid)); if (flags.includes('\\Seen')) m.seen = true; if (flags.includes('\\Answered')) m.answered = true; return true; }
      async messageFlagsRemove(uid, flags) { S.flagCalls.push(['remove', Number(uid), flags]); const m = S.msgs.find((x) => x.uid === Number(uid)); if (flags.includes('\\Seen')) m.seen = false; return true; }
      async logout() { S.logouts++; }
      close() { S.closes++; }
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
const mstat = require(path.join(SRC, 'lib/chat/mailbox-status.ts'));
const perms = require(path.join(SRC, 'lib/permissions.ts'));

const req = (method, url, body) => new NextRequest(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const OWNER = { role: 'admin', username: 'owner', permissions: perms.resolvePermissions('admin'), businessIds: null };
const member = (extra = {}, role = 'agent') => ({ role, username: 'rahul', permissions: perms.resolvePermissions(role, extra.perms), businessIds: extra.panels ?? null });

let n = 0;
const t = async (name, fn) => { reset(); authState.user = OWNER; await fn(); n++; console.log('  ok  ' + name); };

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
    assert.strictEqual(S.logouts, 1); assert.ok(!/SECRET/.test(JSON.stringify(d)));
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
    assert.strictEqual(m.from, '"Support" <vastora@store.example>'); assert.strictEqual(m.to, 'bob.reply@example.com'); assert.strictEqual(m.subject, 'Re: Invoice and photo');
    assert.strictEqual(m.headers['In-Reply-To'], '<m12@mail.example>'); assert.ok(m.headers.References.includes('<m0@mail.example>') && m.headers.References.includes('<m12@mail.example>'));
    assert.ok(!/utm_source/.test(m.text) && /x=1/.test(m.text), 'copy-paste junk removed, the rest kept');
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

  console.log(`MAIL-TAB: ${n} groups passed`);
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
