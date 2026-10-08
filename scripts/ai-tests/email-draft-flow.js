// Runs the REAL email poller (src/lib/chat/email.ts `pollEmailAccount`) and the REAL panel-email route against a
// fake Gmail (IMAP), a fake database, a scripted AI and a fake SMTP, to check "Chikki writes a draft, the team
// sends" (owner 2026-10-08, email-draft.ts). Nothing here touches a real mailbox or database.
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');

const SRC = path.resolve(__dirname, '../../src');
// Every .ts file is compiled on demand, so the poller's real imports (escalation, sensitive, address-conflict,
// office-hours, email-draft...) are the real ones; only the I/O edges below are replaced.
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true }, fileName: filename }).outputText, filename);

// ── what the current scenario set up ──────────────────────────────────────────────────────────
const S = {};
function reset(over = {}) {
  Object.assign(S, {
    draftRow: undefined,        // chat_settings value for email_draft_only:<site>; undefined = no row
    settingsThrows: false,      // reading the switch fails
    verified: true,             // chatIsVerified
    mail: { from: 'cust@example.com', subject: 'Where is my order', text: 'Hi, where is my order #1001? My phone is 9876543210.' },
    ai: { content: 'Hello, your order is Shipped.', escalated: false, allFailed: false },
    sent: [],                   // what SMTP was asked to send
    sql: [],                    // every statement the poller ran
    aiMsgMeta: [],              // metadata stored with the AI message
    unverifiedCalls: 0,
  }, over);
}

const SQL = (re) => S.sql.filter((x) => re.test(x.sql));

const db = {
  query: async (sql, params) => {
    S.sql.push({ sql, params });
    if (/INSERT INTO messages/.test(sql) && /'ai'/.test(sql) && /RETURNING/.test(sql)) return { rows: [{ id: 'aimsg1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  },
  queryOne: async (sql, params) => {
    S.sql.push({ sql, params });
    if (/FROM chat_settings/.test(sql)) {
      if (S.settingsThrows) throw new Error('connection reset');
      return S.draftRow === undefined ? null : { value: S.draftRow };
    }
    if (/FROM messages m\s+JOIN conversations c/.test(sql)) return null;                       // a new thread
    if (/INSERT INTO conversations/.test(sql)) return { id: 'conv1', status: params[3], email_thread_id: params[4] };
    if (/INSERT INTO messages \(id, conversation_id, sender, content, metadata, created_at\)\s+VALUES \(gen_random_uuid\(\)::text, \$1, 'ai', \$2, \$3::jsonb/.test(sql)) {
      S.aiMsgMeta.push(JSON.parse(params[2]));
      return { id: 'aimsg1' };
    }
    return null;
  },
  getPool: () => ({}),
};

const STUBS = {
  'lib/db.ts': db,
  'lib/chat/ai.ts': { getAIResponse: async () => ({ ...S.ai }) },
  'lib/chat/brain-usage.ts': { recordBrainUsage: async () => {} },
  'lib/chat/chikki-runs.ts': { recordChikkiRun: async () => {} },
  'lib/chat/subject.ts': { updateConversationSubject: async () => {} },
  'lib/chat/health.ts': { updateConversationHealth: async () => {} },
  'lib/chat/verified.ts': { chatIsVerified: async () => { S.unverifiedCalls++; return S.verified; } },
  'lib/chat/chat-history.ts': { recentVisitorMessages: async () => [] },
  'lib/chat/holidays.ts': { loadHolidays: async () => [] },
  'lib/chat/site.ts': {
    siteForPanel: async () => ({ id: 'site1' }),
    ensureSiteForPanel: async () => ({ id: 'site1' }),
  },
};
const PKG_STUBS = {
  imapflow: {
    ImapFlow: class {
      async connect() {}
      async getMailboxLock() { return { release() {} }; }
      async search() { return [101]; }
      fetch() { return (async function* () { yield { uid: 101, source: Buffer.from('raw') }; })(); }
      async logout() {}
    },
  },
  mailparser: {
    simpleParser: async () => ({
      from: { value: [{ address: S.mail.from, name: 'Customer' }] }, subject: S.mail.subject, messageId: '<m1@example.com>',
      inReplyTo: '', references: [], text: S.mail.text, headerLines: S.mail.headerLines,
    }),
  },
  nodemailer: { default: { createTransport: () => ({ sendMail: async (o) => { S.sent.push(o); } }) }, createTransport: () => ({ sendMail: async (o) => { S.sent.push(o); } }) },
  imap: class { /* the connect-time check is not under test */ },
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
  if (file && file.startsWith(SRC)) {
    const rel = path.relative(SRC, file);
    if (STUBS[rel]) return STUBS[rel];
  }
  return origLoad.call(this, request, parent, isMain);
};

const { pollEmailAccount } = require(path.join(SRC, 'lib/chat/email.ts'));
const account = { id: 'acc1', email: 'support@store.example', app_password: 'abcdabcdabcdabcd', last_uid: 100, site_id: 'site1', site_name: 'Vastora', ai_enabled: true, system_prompt: null, tracker_business_id: 'biz1', cod_available: null };

let n = 0;
const t = async (name, fn) => { reset(); await fn(); n++; console.log('  ok  ' + name); };
const toNeedsYou = () => SQL(/UPDATE conversations SET status = 'human_needed'/).length > 0;

(async () => {
  await t('draft mode ON (no setting row): a routine answer to a verified customer is stored as a draft, NOT emailed, and the chat goes to Needs you', async () => {
    await pollEmailAccount(account);
    assert.strictEqual(S.sent.length, 0, 'nothing is sent');
    assert.deepStrictEqual(S.aiMsgMeta, [{ emailed: false, withheld: 'draft' }]);
    assert.ok(toNeedsYou(), 'a verified customer\'s draft waits in Needs you');
    assert.strictEqual(SQL(/SET metadata = \$1::jsonb WHERE id/).length, 0, 'the message is never flipped to emailed');
  });

  await t('draft mode ON, sender NOT verified: the draft waits in their thread, the chat is NOT moved to Needs you, nothing is emailed', async () => {
    reset({ verified: false });
    await pollEmailAccount(account);
    assert.strictEqual(S.sent.length, 0);
    assert.deepStrictEqual(S.aiMsgMeta, [{ emailed: false, withheld: 'draft' }]);
    assert.ok(!toNeedsYou(), 'only verified customers reach Needs you');
  });

  await t('switch OFF for the panel: the routine answer is emailed by Chikki, as before', async () => {
    reset({ draftRow: '0' });
    await pollEmailAccount(account);
    assert.strictEqual(S.sent.length, 1, 'one email left');
    assert.strictEqual(S.sent[0].to, 'cust@example.com'); assert.strictEqual(S.sent[0].from, '"Support" <support@store.example>');
    assert.deepStrictEqual(S.aiMsgMeta, [{ emailed: false, withheld: 'sending' }], 'stored as sending first');
    assert.ok(SQL(/SET metadata = \$1::jsonb WHERE id/).some((x) => /"emailed":true/.test(x.params[0])), 'flipped to emailed once SMTP confirmed');
    assert.ok(!toNeedsYou());
  });

  await t('the switch row says ON (\'1\'): same as the default, a draft', async () => {
    reset({ draftRow: '1' });
    await pollEmailAccount(account);
    assert.strictEqual(S.sent.length, 0); assert.strictEqual(S.aiMsgMeta[0].withheld, 'draft');
  });

  await t('the switch cannot be read (database error): fails closed, still a draft, nothing emailed', async () => {
    reset({ settingsThrows: true });
    await pollEmailAccount(account);
    assert.strictEqual(S.sent.length, 0); assert.strictEqual(S.aiMsgMeta[0].withheld, 'draft');
  });

  await t('draft mode ON and the AI escalated: still held with its own label, chat to Needs you (as before), not emailed', async () => {
    reset({ ai: { content: 'Let me get the team on this.', escalated: true, allFailed: false }, verified: false });
    await pollEmailAccount(account);
    assert.strictEqual(S.sent.length, 0);
    assert.deepStrictEqual(S.aiMsgMeta, [{ emailed: false, withheld: 'escalated' }]);
    assert.ok(toNeedsYou(), 'an escalation always lands in Needs you, even for an unverified sender (the old behaviour)');
  });

  await t('a verified customer who calls the store a fraud: the fixed "a person has it" reply STILL goes out on its own in draft mode, and the chat goes to Needs you', async () => {
    reset({ mail: { from: 'cust@example.com', subject: 'Fraud company', text: 'You are a fraud, this is a scam website. My order #1001, phone 9876543210.' } });
    await pollEmailAccount(account);
    assert.strictEqual(S.sent.length, 1, 'the hand-over reply is sent');
    assert.ok(toNeedsYou());
    assert.ok(!S.aiMsgMeta.some((m) => m.withheld === 'draft'), 'it is not stored as a draft');
  });

  await t('a verified customer who asks for a refund: the refund hand-over reply goes out, chat to Needs you', async () => {
    reset({ mail: { from: 'cust@example.com', subject: 'Refund please', text: 'I want a refund for order #1001, my phone 9876543210.' } });
    await pollEmailAccount(account);
    assert.strictEqual(S.sent.length, 1, 'the refund hand-over reply is sent');
    assert.ok(toNeedsYou());
  });

  await t('a verified customer who threatens a chargeback: NO automatic reply at all (master rules 15), no AI draft, chat to Needs you', async () => {
    reset({ mail: { from: 'cust@example.com', subject: 'Chargeback', text: 'If you do not deliver I will raise a chargeback with my bank. Order #1001.' } });
    await pollEmailAccount(account);
    assert.strictEqual(S.sent.length, 0, 'nothing is emailed');
    assert.strictEqual(S.aiMsgMeta.length, 0, 'the AI is not even asked');
    assert.ok(toNeedsYou());
  });

  await t('automatic verification (owner 2026-10-08): a new mail Gmail marked dmarc=pass looks the sender up in the panel\'s orders BEFORE the chat is read; without the pass nothing is looked up; the mail is handled either way', async () => {
    reset({ mail: { from: 'cust@example.com', subject: 'Order #1553', text: 'where is it', headerLines: [{ key: 'authentication-results', line: 'Authentication-Results: mx.google.com; dmarc=pass header.from=example.com' }] } });
    await pollEmailAccount(account);
    const iOrders = S.sql.findIndex((x) => /FROM orders/.test(x.sql)), iMsg = S.sql.findIndex((x) => /INSERT INTO messages \(id, conversation_id, sender, content, email_message_id/.test(x.sql));
    assert.ok(iOrders >= 0 && iMsg > iOrders, 'looked up, and before the message is stored');
    assert.deepStrictEqual(S.aiMsgMeta, [{ emailed: false, withheld: 'draft' }], 'the mail is handled as before');
    reset({ mail: { from: 'cust@example.com', subject: 'Order #1553', text: 'where is it', headerLines: [{ key: 'authentication-results', line: 'Authentication-Results: mx.google.com; dkim=pass; spf=pass' }] } });
    await pollEmailAccount(account);
    assert.strictEqual(SQL(/FROM orders/).length, 0, 'no dmarc pass = no lookup');
    assert.strictEqual(S.aiMsgMeta.length, 1);
  });

  await t('our own address writing to itself is skipped (no reply loop), draft mode or not', async () => {
    reset({ mail: { from: 'support@store.example', subject: 'x', text: 'y' } });
    await pollEmailAccount(account);
    assert.strictEqual(S.sent.length, 0); assert.strictEqual(S.aiMsgMeta.length, 0);
  });

  // ── the route: GET shows the switch, PATCH changes it (Super Admin only) ─────────────────────────────
  const routeSrc = path.join(SRC, 'app/api/panel-email/route.ts');
  const authState = { user: { role: 'admin', username: 'owner' } };
  STUBS['lib/auth.ts'] = { getAuthFromRequest: () => authState.user };
  const { NextRequest } = require('next/server');
  const route = require(routeSrc);
  const req = (method, url, body) => new NextRequest(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const saved = [];
  const realQuery = db.query;
  db.query = async (sql, params) => {
    S.sql.push({ sql, params });
    if (/INSERT INTO chat_settings/.test(sql)) { saved.push([params[0], params[1]]); S.draftRow = params[1]; return { rows: [], rowCount: 1 }; }
    if (/FROM site_emails se/.test(sql)) return { rows: [{ id: 'e1', email: 'a@b.com', created_at: '2026-10-08' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const realQueryOne = db.queryOne;
  const origQO = db.queryOne;
  db.queryOne = async (sql, params) => {
    if (/SELECT id FROM businesses/.test(sql)) return { id: params[0] };
    return origQO(sql, params);
  };

  await t('panel-email GET returns draftOnly: true when nothing was saved', async () => {
    const res = await route.GET(req('GET', '/api/panel-email?businessId=biz1'));
    const body = await res.json();
    assert.strictEqual(res.status, 200); assert.strictEqual(body.draftOnly, true);
  });
  await t('panel-email PATCH {draftOnly:false} saves "0" for the panel\'s site, GET then returns false; PATCH true saves "1"', async () => {
    let res = await route.PATCH(req('PATCH', '/api/panel-email', { businessId: 'biz1', draftOnly: false }));
    assert.strictEqual(res.status, 200); assert.deepStrictEqual(saved.pop(), ['email_draft_only:site1', '0']);
    res = await route.GET(req('GET', '/api/panel-email?businessId=biz1'));
    assert.strictEqual((await res.json()).draftOnly, false);
    res = await route.PATCH(req('PATCH', '/api/panel-email', { businessId: 'biz1', draftOnly: true }));
    assert.strictEqual(res.status, 200); assert.deepStrictEqual(saved.pop(), ['email_draft_only:site1', '1']);
  });
  await t('panel-email PATCH: a team member (not the Super Admin), no login, a missing panel and a non-boolean are all refused', async () => {
    authState.user = { role: 'panel_admin', username: 'rahul' };
    assert.strictEqual((await route.PATCH(req('PATCH', '/api/panel-email', { businessId: 'biz1', draftOnly: false }))).status, 401);
    authState.user = null;
    assert.strictEqual((await route.PATCH(req('PATCH', '/api/panel-email', { businessId: 'biz1', draftOnly: false }))).status, 401);
    authState.user = { role: 'admin', username: 'owner' };
    assert.strictEqual((await route.PATCH(req('PATCH', '/api/panel-email', { draftOnly: false }))).status, 400);
    assert.strictEqual((await route.PATCH(req('PATCH', '/api/panel-email', { businessId: 'biz1', draftOnly: 'no' }))).status, 400);
    assert.strictEqual(saved.length, 0, 'nothing was saved by a refused request');
  });
  db.query = realQuery; db.queryOne = realQueryOne;

  console.log(`EMAIL-DRAFT-FLOW: ${n} groups passed`);
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
