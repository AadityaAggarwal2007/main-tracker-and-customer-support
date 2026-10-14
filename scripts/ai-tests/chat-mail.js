// "Gmail too" for a chat reply + Chikki knowing the chat and the Gmail are one customer (owner 2026-10-13): the REAL
// chat-mail-rules.ts, chat-mail.ts, reply-mail.ts and customer-mail.ts against a fake database, a fake outbox and a
// fake SMTP. Nothing is sent anywhere.
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true }, fileName: filename }).outputText, filename);
const eq = assert.strictEqual, deq = assert.deepStrictEqual, ok = assert.ok;

const S = {};
function reset() {
  Object.assign(S, {
    conv: { c1: { source: 'chat', site_id: 's1', panel: 'P1', verified_order_id: '#3123' } },
    orders: { 'P1|#3123': 'Buyer@Gmail.com ', 'P2|#3123': 'other.panel@gmail.com' },
    verified: {},                 // 'P1|#3123' -> email (mail_verifications)
    boxes: [{ id: 'box1', email: 'support@vastrika.in', app_password: 'secret', site_name: 'VASTRIKA', panel: 'P1', site_id: 's1' }],
    outbox: true, enqueued: [], smtp: [], smtpFail: false, notes: [], sql: [], otherChannel: null, verTableMissing: false,
  });
}
reset();
const db = {
  query: async (sql, p = []) => {
    S.sql.push(sql.replace(/\s+/g, ' '));
    if (/UPDATE messages SET metadata/.test(sql)) { S.notes.push([p[0], JSON.parse(p[1])]); return { rows: [], rowCount: 1 }; }
    throw new Error('fake db: ' + sql.slice(0, 80));
  },
  queryOne: async (sql, p = []) => {
    S.sql.push(sql.replace(/\s+/g, ' '));
    if (/FROM conversations c JOIN sites s ON s.id = c.site_id WHERE c.id = \$1/.test(sql)) return S.conv[p[0]] || null;
    if (/customer_email\)\) AS email FROM orders/.test(sql)) { const e = S.orders[`${p[0]}|${p[1]}`]; return e ? { email: e.trim().toLowerCase() } : null; }
    if (/FROM mail_verifications/.test(sql)) {
      if (S.verTableMissing) throw Object.assign(new Error('relation "mail_verifications" does not exist'), { code: '42P01' });
      const e = S.verified[`${p[0]}|${p[1]}`]; return e ? { email: e.toLowerCase() } : null;
    }
    if (/FROM site_emails se JOIN sites s/.test(sql)) {
      const rows = S.boxes.filter((b) => b.panel === p[0]).sort((a, b) => (b.site_id === p[1]) - (a.site_id === p[1]));
      return rows[0] ? { id: rows[0].id, email: rows[0].email, app_password: rows[0].app_password, site_name: rows[0].site_name } : null;
    }
    if (/customer-mail/.test(sql)) return S.otherChannel;
    throw new Error('fake db one: ' + sql.slice(0, 80));
  },
};
const outbox = {
  outboxInstalled: async () => S.outbox,
  enqueueReply: async (r) => { S.enqueued.push(r); return 'ob-' + S.enqueued.length; },
  runOutbox: async () => 0,
};
const nodemailer = { createTransport: () => ({ sendMail: async (m) => { if (S.smtpFail) throw new Error('535 auth'); S.smtp.push(m); return {}; }, close() {} }) };
const fakes = { '@/lib/db': db, './mail-outbox': outbox, nodemailer };
const oR = Module._resolveFilename;
Module._resolveFilename = function (r, parent, ...x) { if (fakes[r]) return r; if (r.startsWith('@/')) return oR.call(this, path.join(SRC, r.slice(2)), parent, ...x); return oR.call(this, r, parent, ...x); };
const oL = Module._load; Module._load = function (r, ...x) { return fakes[r] || oL.call(this, r, ...x); };
const R = require(path.join(SRC, 'lib/chat/chat-mail-rules.ts'));
const M = require(path.join(SRC, 'lib/chat/chat-mail.ts'));
const RM = require(path.join(SRC, 'lib/chat/reply-mail.ts'));
const CM = require(path.join(SRC, 'lib/chat/customer-mail.ts'));

let pass = 0, fail = 0;
async function t(name, fn) {
  reset();
  const err = console.error, log = console.log; console.error = () => {}; console.log = () => {};
  try { await fn(); console.error = err; console.log = log; pass++; console.log('  ok  ' + name); }
  catch (e) { console.error = err; console.log = log; fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 5).join('\n       ')); }
}

(async () => {
  console.log('chat-mail: a chat reply also by Gmail; Chikki knows the chat and the Gmail are one customer');

  await t('rules: the masked address, the subject, the bodies (sign-off with the brand, links clickable, HTML escaped)', () => {
    deq([R.maskEmail('Buyer@Gmail.com'), R.maskEmail('a@x.in'), R.maskEmail('nope')], ['bu***@gmail.com', 'a***@x.in', '']);
    deq([R.chatMailSubject('#3123'), R.chatMailSubject('3123'), R.chatMailSubject('')], ['Update on your order #3123', 'Update on your order #3123', 'An update from our support team']);
    const b = R.chatMailBodies('Hi <Ravi>,\nTrack: https://shiptrack.store/track/abc', 'VASTRIKA');
    eq(b.textBody, 'Hi <Ravi>,\nTrack: https://shiptrack.store/track/abc\n\nRegards,\nVASTRIKA Support');
    ok(b.htmlBody.includes('Hi &lt;Ravi&gt;,<br>Track: <a href="https://shiptrack.store/track/abc">') && b.htmlBody.includes('Regards,<br>VASTRIKA Support'), b.htmlBody);
    ok(!/<Ravi>/.test(b.htmlBody));
    eq(R.looksLikeEmail('a@b.co'), true); eq(R.looksLikeEmail('a@b'), false); eq(R.looksLikeEmail('a b@c.d'), false);
  });

  await t('sign-off once (owner 14 Oct: "Best Regards, Team Vastrika" then a second "Regards, VASTRIKA Support")', () => {
    for (const x of ['Dear Customer,\nYour order is on the way.\n\nBest Regards,\nTeam Vastrika', 'Hi,\nok\nThanks', 'Hi\nDone.\nRegards, Vastora Support', 'Hello\nok\n- Team Kurtiya', 'Hi\nok\nThank you\nCustomer Care'])
      eq(R.endsWithSignOff(x), true, x);
    for (const x of ['Thanks for waiting, your parcel left today.\nIt reaches in 3 days.\nThe link: https://x.in/t', 'Hi\nTeam members will call?', ''])
      eq(R.endsWithSignOff(x), false, x);
    const b = R.chatMailBodies('Dear Customer,\nTracking: https://x.in/t\n\nBest Regards,\nTeam Vastrika', 'VASTRIKA');
    ok(!/VASTRIKA Support/.test(b.textBody) && !/VASTRIKA Support/.test(b.htmlBody), b.textBody);
    ok(/Team Vastrika$/.test(b.textBody));
  });

  await t('reply-mail: a new mail keeps its subject (no "Re:"); a reply still gets "Re:"; fresh with an In-Reply-To is still a reply', () => {
    const base = { fromEmail: 's@x.in', toEmail: 'c@y.in', htmlBody: 'h', textBody: 't' };
    eq(RM.replyMailMessage({ ...base, subject: 'Update on your order #1', fresh: true }).subject, 'Update on your order #1');
    eq(RM.replyMailMessage({ ...base, subject: 'Order late' }).subject, 'Re: Order late');
    eq(RM.replyMailMessage({ ...base, subject: 'Order late', fresh: true, replyToMessageId: '<a@b>' }).subject, 'Re: Order late');
  });

  await t('target: a verified website chat -> the email ON its order (this panel only), the panel\'s support Gmail; else the address verified in Mail; never a visitor / email chat / a panel without Gmail', async () => {
    let f = await M.chatMailTarget('c1');
    deq([f.ok, f.target.to, f.target.toMasked, f.target.boxId, f.target.brand, f.target.orderId], [true, 'buyer@gmail.com', 'bu***@gmail.com', 'box1', 'VASTRIKA', '#3123']);
    ok(!S.sql.some((q) => /other\.panel/.test(q)));
    S.orders['P1|#3123'] = ''; S.verified['P1|#3123'] = 'Verified@Mail.com';
    f = await M.chatMailTarget('c1'); eq(f.target.to, 'verified@mail.com', 'no email on the order: the one verified for it in Mail');
    S.verified = {}; f = await M.chatMailTarget('c1'); deq(f, { ok: false, why: 'no_email' });
    S.verTableMissing = true; f = await M.chatMailTarget('c1'); deq(f, { ok: false, why: 'no_email' }, 'before mail-verify.sql: just no address');
    reset(); S.conv.c1.verified_order_id = null; deq(await M.chatMailTarget('c1'), { ok: false, why: 'not_verified' });
    reset(); S.conv.c1.source = 'email'; deq(await M.chatMailTarget('c1'), { ok: false, why: 'not_chat' });
    reset(); S.boxes = []; deq(await M.chatMailTarget('c1'), { ok: false, why: 'no_gmail' });
    reset(); S.boxes[0].panel = 'P2'; deq(await M.chatMailTarget('c1'), { ok: false, why: 'no_gmail' }, 'never another panel\'s Gmail');
    reset(); S.orders['P1|#3123'] = 'support@vastrika.in'; deq(await M.chatMailTarget('c1'), { ok: false, why: 'no_email' }, 'never to our own Gmail');
    deq(await M.chatMailTarget('nope'), { ok: false, why: 'not_chat' });
    reset(); deq(await M.chatMailOffer('c1'), { to: 'bu***@gmail.com' });
    S.boxes = []; deq(await M.chatMailOffer('c1'), { why: 'no_gmail' });
    reset(); S.conv.c1.source = 'whatsapp'; eq(await M.chatMailOffer('c1'), null, 'no line at all on a WhatsApp / email chat');
  });

  await t('send: through the outbox (a new mail: no uid, no In-Reply-To, our own Message-ID, the subject, the sign-off), answered at once; without the outbox straight to Gmail; a refusal is reported, never thrown; the note', async () => {
    let r = await M.sendChatAsMail('c1', 'Your parcel is on the way.', 'Sunny');
    deq(r, { ok: true, queued: true, to: 'bu***@gmail.com' });
    eq(S.enqueued.length, 1);
    const q = S.enqueued[0];
    deq([q.boxId, q.replyUid, q.uidvalidity, q.to, q.subject, q.inReplyTo, q.references, q.files, q.createdBy], ['box1', null, null, 'buyer@gmail.com', 'Update on your order #3123', null, null, [], 'Sunny']);
    ok(/^<[0-9a-f-]{36}@vastrika\.in>$/.test(q.messageId), q.messageId);
    ok(q.textBody.startsWith('Your parcel is on the way.') && /VASTRIKA Support$/.test(q.textBody));
    eq(S.smtp.length, 0, 'the outbox sends it, not the request');
    S.outbox = false;
    r = await M.sendChatAsMail('c1', 'Direct.', 'Sunny');
    deq(r, { ok: true, queued: false, to: 'bu***@gmail.com' });
    deq([S.smtp[0].to, S.smtp[0].subject, S.smtp[0].from], ['buyer@gmail.com', 'Update on your order #3123', '"VASTRIKA Support" <support@vastrika.in>']);
    S.smtpFail = true;
    r = await M.sendChatAsMail('c1', 'Fails.', 'Sunny');
    eq(r.ok, false); ok(/Gmail did not take the mail/.test(r.error)); eq(r.to, 'bu***@gmail.com');
    reset(); S.conv.c1.verified_order_id = null;
    r = await M.sendChatAsMail('c1', 'x', 'Sunny'); deq(r, { ok: false, error: 'The customer is not verified: no mail was sent' }); eq(S.enqueued.length, 0);
    await M.noteChatMail('m1', { ok: true, queued: true, to: 'bu***@gmail.com' });
    await M.noteChatMail('m2', { ok: false, error: 'No', to: 'bu***@gmail.com' });
    deq(S.notes, [['m1', { to: 'bu***@gmail.com', state: 'queued' }], ['m2', { to: 'bu***@gmail.com', state: 'failed', error: 'No' }]]);
  });

  await t('Chikki\'s line: a verified chat whose customer also emailed us -> one line (count + India date, never text); email the other way; none without a panel / order / messages; a failure = none', async () => {
    eq(CM.otherChannelNote('chat', 0, null), '');
    ok(/also written to our support email \(1 message, the last on 13 Oct\)/.test(CM.otherChannelNote('chat', 1, '2026-10-12T20:00:00Z')), 'India date (12 Oct 20:00 UTC = 13 Oct)');
    ok(/website chat \(4 messages\)/.test(CM.otherChannelNote('email', 4, null)));
    S.otherChannel = { n: 2, last: new Date('2026-10-12T06:00:00Z') };
    ok(/2 messages, the last on 12 Oct/.test(await CM.otherChannelLine('c1', '#3123', 'P1', 'chat')));
    eq(await CM.otherChannelLine('c1', null, 'P1', 'chat'), '');
    eq(await CM.otherChannelLine('c1', '#3123', null, 'chat'), '');
    const q = S.sql.filter((x) => /customer-mail/.test(x));
    eq(q.length, 1, 'no query without an order and a panel');
    ok(/s\.tracker_business_id::text = \$1::text/.test(q[0]) && /c\.source = 'email'/.test(q[0]) && /m\.sender = 'visitor'/.test(q[0]) && /o\.business_id::text = \$1::text/.test(q[0]), 'this panel\'s email chats, the customer\'s own messages, the order of this panel');
    ok(!/content/.test(q[0]), 'never the mails\' text');
    await CM.otherChannelLine('c1', '#3123', 'P1', 'email');
    ok(/c\.source = 'chat' AND c\.id <> \$3 AND c\.verified_order_id = \$2/.test(S.sql.filter((x) => /customer-mail/.test(x))[1]));
    S.otherChannel = { n: 0, last: null }; eq(await CM.otherChannelLine('c1', '#3123', 'P1', 'chat'), '');
    db.queryOne = ((orig) => async (sql, p) => { if (/customer-mail/.test(sql)) throw new Error('down'); return orig(sql, p); })(db.queryOne);
    eq(await CM.otherChannelLine('c1', '#3123', 'P1', 'chat'), '', 'a failure never stops a reply');
  });

  console.log(`CHAT-MAIL: ${pass} groups passed${fail ? `, ${fail} FAILED` : ''}`);
  if (fail) process.exit(1);
})();
