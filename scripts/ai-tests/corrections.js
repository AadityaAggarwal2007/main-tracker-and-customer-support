// Corrections (owner 2026-10-11, "Correction" button): the REAL routes /api/corrections and /api/corrections/[id],
// corrections.ts and corrections-read.ts against a fake database, a fake thread loader and fake mail access; the real
// permissions.ts, team-verify-rules.ts (maskOrder) and corrections-rules.ts. Nothing here touches a real database.
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true }, fileName: filename }).outputText, filename);
const { NextRequest, NextResponse } = require('next/server');

const eq = assert.strictEqual, deq = assert.deepStrictEqual, ok = assert.ok;
const HOUR = 3600000;
const S = {};
function reset() {
  Object.assign(S, {
    rows: [], seq: 0, missing: false, logs: [], user: null,
    convs: [
      { id: 'c-ver', site_id: 'S1', tracker_business_id: 'P1', source: 'chat', verified_order_id: '#1553', verified_via: 'form', merged_into: null, assigned_to: null, status: 'agent_handling' },
      { id: 'c-mail', site_id: 'S1', tracker_business_id: 'P1', source: 'email', verified_order_id: '#1601', verified_via: 'mail', merged_into: null, assigned_to: null, status: 'human_needed' },
      { id: 'c-legacy', site_id: 'S1', tracker_business_id: 'P1', source: 'chat', verified_order_id: '#1200', verified_via: 'legacy', merged_into: null, assigned_to: null, status: 'agent_handling' },
      { id: 'c-visitor', site_id: 'S1', tracker_business_id: 'P1', source: 'chat', verified_order_id: null, verified_via: null, merged_into: null, assigned_to: null, status: 'ai_handling' },
      { id: 'c-phone', site_id: 'S1', tracker_business_id: 'P1', source: 'chat', verified_order_id: null, verified_via: null, phone_match_order_id: '#1300', merged_into: null, assigned_to: null, status: 'ai_handling' },
      { id: 'c-wa', site_id: 'S1', tracker_business_id: 'P1', source: 'whatsapp', verified_order_id: '#1700', verified_via: 'form', merged_into: null, assigned_to: null, status: 'agent_handling' },
      { id: 'c-merged', site_id: 'S1', tracker_business_id: 'P1', source: 'chat', verified_order_id: '#1553', verified_via: 'form', merged_into: 'c-ver', assigned_to: null, status: 'resolved' },
      { id: 'c-p2', site_id: 'S2', tracker_business_id: 'P2', source: 'chat', verified_order_id: '#77', verified_via: 'chat_phone', merged_into: null, assigned_to: null, status: 'agent_handling' },
    ],
    boxes: { box1: { id: 'box1', email: 'help@vastora.in', siteName: 'vastora', panelId: 'P1', panelName: 'vastora' }, box2: { id: 'box2', email: 'help@kurtiya.in', siteName: 'kurtiya', panelId: 'P2', panelName: 'kurtiya' } },
    verified: { 'asha@gmail.com': [{ orderId: '#1601', byName: 'Rahul', at: '2026-10-11T05:00:00.000Z', chatId: 'c-mail' }],
      'two@gmail.com': [{ orderId: '#1801', byName: 'Email match', at: '2026-10-11T05:00:00.000Z', chatId: null }, { orderId: '#1802', byName: 'Email match', at: '2026-10-10T05:00:00.000Z', chatId: null }] },
    panels: { P1: 'vastora', P2: 'kurtiya' }, orders: { 'P1|#1553': 'Asmita Rao', 'P1|#1601': 'Asha', 'P2|#77': 'Priya K' },
  });
}
reset();
const USERS = {
  owner: { role: 'admin', username: 'owner', displayName: 'Super Admin', businessIds: null, permissions: [] },
  rahul: { role: 'agent', id: 'u-rahul', username: 'rahul', displayName: 'Rahul', businessIds: null, permissions: ['chat.view', 'chat.reply'] },
  sunny: { role: 'manager', id: 'u-sunny', username: 'sunny', displayName: 'Sunny', businessIds: null, permissions: null },
  viewer: { role: 'viewer', id: 'u-view', username: 'vikas', displayName: 'Vikas', businessIds: null, permissions: null },
  priya: { role: 'agent', id: 'u-priya', username: 'priya', displayName: 'Priya', businessIds: ['P2'], permissions: ['chat.view', 'chat.reply'] },
  mailer: { role: 'agent', id: 'u-mail', username: 'mailer', displayName: 'Meena', businessIds: null, permissions: ['mail.view', 'mail.reply'] },
  reader: { role: 'agent', id: 'u-read', username: 'reader', displayName: 'Reena', businessIds: null, permissions: ['mail.view'] },
};
const norm = (q) => q.replace(/\s+/g, ' ').trim();
const gone = () => Object.assign(new Error('relation "order_corrections" does not exist'), { code: '42P01' });
const inScope = (r, scope) => scope == null || scope.includes(r.business_id);
const db = {
  query: async (raw, p = []) => {
    const q = norm(raw);
    if (!/order_corrections/.test(q)) throw new Error('fake db: ' + q.slice(0, 100));
    if (S.missing) throw gone();
    if (/^INSERT INTO order_corrections/.test(q)) {
      const row = { id: String(++S.seq), business_id: p[0], source: p[1], conversation_id: p[2], mail_box_id: p[3], mail_uid: p[4], customer_email: p[5], order_id: p[6], kinds: p[7], note: p[8],
        status: 'pending', created_by: p[9], created_by_name: p[10], created_at: new Date(S.now ?? Date.now()), done_by: null, done_by_name: null, done_at: null, done_note: null, updated_at: new Date(S.now ?? Date.now()) };
      S.rows.push(row); return { rows: [{ ...row }] };
    }
    if (/WHERE x\.conversation_id = \$1 ORDER BY/.test(q)) return { rows: S.rows.filter((r) => r.conversation_id === p[0]).sort((a, b) => (b.status === 'pending') - (a.status === 'pending')) };
    if (/WHERE x\.mail_box_id = \$1 AND x\.mail_uid = \$2/.test(q)) return { rows: S.rows.filter((r) => r.mail_box_id === p[0] && r.mail_uid === p[1]) };
    if (/SELECT DISTINCT x\.conversation_id/.test(q)) return { rows: S.rows.filter((r) => r.status === 'pending' && p[0].includes(r.conversation_id)).map((r) => ({ conversation_id: r.conversation_id })) };
    if (/count\(\*\)::int AS n FROM order_corrections x WHERE x\.status = 'pending'/.test(q)) return { rows: [{ n: S.rows.filter((r) => r.status === 'pending' && inScope(r, p[0])).length }] };
    if (/GROUP BY x\.business_id/.test(q)) {
      const out = {};
      for (const r of S.rows) if (r.status === 'pending' && p[0].includes(r.business_id)) { const o = (out[r.business_id] ??= { business_id: r.business_id, pending: 0, overdue: 0 }); o.pending++; if (Date.now() - r.created_at.getTime() >= 24 * HOUR) o.overdue++; }
      return { rows: Object.values(out) };
    }
    if (/AS done_today/.test(q)) {
      const rows = S.rows.filter((r) => inScope(r, p[0]));
      return { rows: [{ pending: rows.filter((r) => r.status === 'pending').length, overdue: rows.filter((r) => r.status === 'pending' && Date.now() - r.created_at.getTime() >= 24 * HOUR).length, done_today: rows.filter((r) => r.status === 'done').length }] };
    }
    if (/\(SELECT b\.name FROM businesses b/.test(q)) {
      S.listSql = q;
      const rows = S.rows.filter((r) => inScope(r, p[0]) && (p[1] == null || p[1].includes(r.status)))
        .sort((a, b) => ((b.status === 'pending') - (a.status === 'pending')) || (a.status === 'pending' ? a.created_at - b.created_at : (b.done_at || b.updated_at) - (a.done_at || a.updated_at)));
      return { rows: rows.map((r) => { const c = S.convs.find((x) => x.id === r.conversation_id); return { ...r, panel_name: S.panels[r.business_id] || null, customer_name: S.orders[`${r.business_id}|${r.order_id}`] || null, chat_verified: !!c && c.verified_order_id === r.order_id && !c.merged_into }; }) };
    }
    if (/WHERE x\.id = \$1 AND \(\$2::text\[\] IS NULL/.test(q)) return { rows: S.rows.filter((r) => r.id === p[0] && inScope(r, p[1])).map((r) => ({ ...r })) };
    if (/^UPDATE order_corrections x SET status = 'pending'/.test(q)) {
      const r = S.rows.find((x) => x.id === p[0] && p[1].includes(x.status)); if (!r) return { rows: [] };
      Object.assign(r, { status: 'pending', done_by: null, done_by_name: null, done_at: null, done_note: null, updated_at: new Date() }); return { rows: [{ ...r }] };
    }
    if (/^UPDATE order_corrections x SET status = \$2/.test(q)) {
      const r = S.rows.find((x) => x.id === p[0] && x.status === 'pending'); if (!r) return { rows: [] };
      Object.assign(r, { status: p[1], done_by: p[2], done_by_name: p[3], done_at: new Date(S.now ?? Date.now()), done_note: p[4], updated_at: new Date(S.now ?? Date.now()) }); return { rows: [{ ...r }] };
    }
    throw new Error('fake db: ' + q.slice(0, 120));
  },
};
const perms = require(path.join(SRC, 'lib/permissions.ts'));
const fakes = {
  '@/lib/db': db,
  '@/lib/auth': { getAuthFromRequest: () => S.user },
  './thread-read': { loadForUser: async (id, user) => { const c = S.convs.find((x) => x.id === id); if (!c) return null; if (user.businessIds && user.businessIds.length && !user.businessIds.includes(c.tracker_business_id)) return null; return { ...c }; } },
  './mail-verify': { verifiedSenders: async (panelId, list) => { const out = {}; for (const e of list) if (S.verified[e] && panelId === 'P1') out[e] = S.verified[e].map((v) => ({ ...v })); return out; } },
  '@/lib/chat/mail-access': {
    mailAccess: async (req, boxId, need) => {
      const user = S.user;
      if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
      const okk = need === 'reply' ? perms.can(user, 'mail.view') && perms.can(user, 'mail.reply') : perms.can(user, 'mail.view');
      if (!okk) return { error: NextResponse.json({ error: 'You do not have access to Mail.' }, { status: 403 }) };
      const box = S.boxes[boxId || ''];
      if (!box || !perms.canAccessPanel(user, box.panelId)) return { error: NextResponse.json({ error: 'Mailbox not found.' }, { status: 404 }) };
      return { user, box };
    },
  },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (fakes[request]) return request;
  if (request.startsWith('@/')) return origResolve.call(this, path.join(SRC, request.slice(2)), parent, ...rest);
  return origResolve.call(this, request, parent, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) { if (fakes[request]) return fakes[request]; return origLoad.call(this, request, parent, ...rest); };
const read = require(path.join(SRC, 'lib/chat/corrections-read.ts'));
const rules = require(path.join(SRC, 'lib/chat/corrections-rules.ts'));
const route = require(path.join(SRC, 'app/api/corrections/route.ts'));
const routeId = require(path.join(SRC, 'app/api/corrections/[id]/route.ts'));

const as = (who) => { S.user = who ? USERS[who] : null; };
const post = async (who, body) => { as(who); const r = await route.POST(new NextRequest('http://x/api/corrections', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })); return { status: r.status, body: await r.json() }; };
const get = async (who, qs = '') => { as(who); const r = await route.GET(new NextRequest('http://x/api/corrections' + qs)); return { status: r.status, body: await r.json() }; };
const patch = async (who, id, body) => { as(who); const r = await routeId.PATCH(new NextRequest(`http://x/api/corrections/${id}`, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), { params: { id } }); return { status: r.status, body: await r.json() }; };
const NOTE = 'New address: 12 Rose Lane, Rohini, Delhi 110085, phone 9876543210';

const realLog = console.log, realErr = console.error;
let pass = 0, fail = 0;
async function t(name, fn) {
  reset();
  console.log = (...a) => { S.logs.push(a.join(' ')); }; console.error = () => {};
  try { await fn(); console.log = realLog; console.error = realErr; pass++; console.log('  ok  ' + name); }
  catch (e) { console.log = realLog; console.error = realErr; fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 12).join('\n       ')); }
}

(async () => {
  console.log('corrections: the Correction button, the list, done / cancel / reopen');
  await t('create on a verified chat: the row carries the panel, the verified order, the deduplicated kinds and the note; the log masks the order and never holds the note', async () => {
    const r = await post('rahul', { conversationId: 'c-ver', kinds: ['size', 'colour', 'size', 'Colour'], note: `  ${NOTE}  ` });
    eq(r.status, 200, JSON.stringify(r.body));
    const c = r.body.correction;
    deq([c.business_id, c.source, c.conversation_id, c.order_id, c.kinds, c.note, c.status, c.created_by, c.created_by_name], ['P1', 'chat', 'c-ver', '#1553', ['size', 'colour'], NOTE, 'pending', 'u-rahul', 'Rahul']);
    const line = S.logs.find((l) => /^\[correction\]/.test(l));
    ok(line && /order=#\*\*53/.test(line) && /kinds=size,colour/.test(line) && /by u-rahul/.test(line), line);
    ok(!S.logs.some((l) => l.includes('Rose Lane') || l.includes('9876543210')), 'the note is never logged');
    // an email chat is source 'email'; the Super Admin is 'owner'
    const m = await post('owner', { conversationId: 'c-mail', kinds: 'pincode', note: '110085' });
    deq([m.status, m.body.correction.source, m.body.correction.created_by, m.body.correction.created_by_name], [200, 'email', 'owner', 'Super Admin']);
    // bad input: no kind, an unknown kind, an empty note, a note with "<", a note over 500
    for (const body of [{ kinds: [], note: 'x' }, { kinds: ['sizee'], note: 'x' }, { kinds: ['size'], note: '  ' }, { kinds: ['size'], note: 'a <b> c' }, { kinds: ['size'], note: 'x'.repeat(501) }]) {
      const b = await post('rahul', { conversationId: 'c-ver', ...body });
      eq(b.status, 400, JSON.stringify(body).slice(0, 40));
    }
    eq((await post('rahul', { kinds: ['size'], note: 'x' })).status, 400, 'conversationId required');
  });
  await t('409 "Verify this customer first" on a visitor and on a phone match; an old legacy check counts as verified; a merged shell is refused', async () => {
    const v = await post('rahul', { conversationId: 'c-visitor', kinds: ['address'], note: NOTE });
    deq([v.status, v.body.error], [409, rules.CORRECTION_TEXT.verifyFirst]);
    eq((await post('rahul', { conversationId: 'c-phone', kinds: ['address'], note: NOTE })).status, 409, 'a phone match is not verification');
    const l = await post('rahul', { conversationId: 'c-legacy', kinds: ['address'], note: NOTE });
    deq([l.status, l.body.correction.order_id], [200, '#1200']);
    eq((await post('rahul', { conversationId: 'c-merged', kinds: ['address'], note: NOTE })).status, 409);
    eq(S.rows.length, 1);
  });
  await t('400 on a WhatsApp chat (never Chat Support\'s), 403 without chat.reply, 404 for a chat of another panel, 401 signed out', async () => {
    const w = await post('rahul', { conversationId: 'c-wa', kinds: ['address'], note: NOTE });
    deq([w.status, w.body.error], [400, rules.CORRECTION_TEXT.whatsapp]);
    eq((await post('viewer', { conversationId: 'c-ver', kinds: ['address'], note: NOTE })).status, 403);
    eq((await post('priya', { conversationId: 'c-ver', kinds: ['address'], note: NOTE })).status, 404, 'Priya is limited to P2');
    eq((await post('priya', { conversationId: 'c-p2', kinds: ['address'], note: NOTE })).status, 200);
    eq((await post(null, { conversationId: 'c-ver', kinds: ['address'], note: NOTE })).status, 401);
    eq(S.rows.length, 1);
  });
  await t('the Mail tab: a verified sender gets the row with the mailbox, uid, address and their chat; not verified = 409; two verified orders need orderId; Mail reply access only', async () => {
    const r = await post('mailer', { mail: { box: 'box1', uid: 4410, email: 'Asha@gmail.com' }, kinds: ['size'], note: 'Size M' });
    eq(r.status, 200, JSON.stringify(r.body));
    const c = r.body.correction;
    deq([c.business_id, c.source, c.conversation_id, c.mail_box_id, c.mail_uid, c.customer_email, c.order_id], ['P1', 'mail', 'c-mail', 'box1', 4410, 'asha@gmail.com', '#1601']);
    const u = await post('mailer', { mail: { box: 'box1', uid: 4411, email: 'nobody@gmail.com' }, kinds: ['size'], note: 'Size M' });
    deq([u.status, u.body.error], [409, rules.CORRECTION_TEXT.verifySenderFirst]);
    const two = await post('mailer', { mail: { box: 'box1', uid: 4412, email: 'two@gmail.com' }, kinds: ['size'], note: 'Size M' });
    deq([two.status, two.body.error], [409, rules.CORRECTION_TEXT.pickOrder]);
    eq((await post('mailer', { mail: { box: 'box1', uid: 4412, email: 'two@gmail.com', orderId: '#1999' }, kinds: ['size'], note: 'Size M' })).status, 409, 'not one of theirs');
    const picked = await post('mailer', { mail: { box: 'box1', uid: 4412, email: 'two@gmail.com', orderId: '1802' }, kinds: ['size'], note: 'Size M' });
    deq([picked.status, picked.body.correction.order_id, picked.body.correction.conversation_id], [200, '#1802', null], 'with or without #; no chat = null');
    eq((await post('reader', { mail: { box: 'box1', uid: 4410, email: 'asha@gmail.com' }, kinds: ['size'], note: 'Size M' })).status, 403, 'mail.view alone cannot');
    eq((await post('mailer', { mail: { box: 'box9', uid: 4410, email: 'asha@gmail.com' }, kinds: ['size'], note: 'Size M' })).status, 404);
    eq((await post('mailer', { mail: { box: 'box1', uid: 0, email: 'asha@gmail.com' }, kinds: ['size'], note: 'Size M' })).status, 400);
    // the open mail's own rows (the "Correction pending" line): Mail view access
    const g = await get('reader', '?box=box1&uid=4410');
    deq([g.status, g.body.rows.map((x) => x.order_id)], [200, ['#1601']]);
    eq((await get('reader', '?box=box2&uid=4410')).body.rows.length, 0);
  });
  await t('the list: everyone with chat.view sees every row of their panels, pending oldest first then done newest first; counts; another panel is a 404; a viewer may read, a mail-only login may not', async () => {
    S.now = Date.now() - 30 * HOUR; await post('rahul', { conversationId: 'c-ver', kinds: ['address'], note: 'old one' });
    S.now = Date.now() - 2 * HOUR; await post('rahul', { conversationId: 'c-mail', kinds: ['phone'], note: 'newer' });
    S.now = Date.now() - HOUR; await post('owner', { conversationId: 'c-p2', kinds: ['size'], note: 'kurtiya' });
    delete S.now;
    const all = await get('owner', '?status=pending');
    eq(all.status, 200);
    deq(all.body.rows.map((r) => [r.note, r.customer_name, r.panel_name, r.overdue, r.chat_verified]), [['old one', 'Asmita Rao', 'vastora', true, true], ['newer', 'Asha', 'vastora', false, true], ['kurtiya', 'Priya K', 'kurtiya', false, true]]);
    deq(all.body.counts, { pending: 3, overdue: 1, done_today: 0 });
    ok(all.body.rows[0].age_ms >= 30 * HOUR - 5000);
    deq((await get('priya', '?status=pending')).body.rows.map((r) => r.note), ['kurtiya'], 'Priya sees only P2');
    eq((await get('priya', '?status=pending&panel=P1')).status, 404);
    deq((await get('owner', '?status=pending&panel=P2')).body.rows.map((r) => r.note), ['kurtiya']);
    eq((await get('viewer', '?status=pending')).status, 200, 'chat.view is enough to read');
    eq((await get('mailer', '?status=pending')).status, 403);
    eq((await get(null)).status, 401);
    // done and cancelled sit together under ?status=done, the newest first
    S.now = Date.now() - 60000; await patch('owner', '1', { action: 'done' });
    delete S.now; await patch('owner', '2', { action: 'cancel' });
    const done = await get('owner', '?status=done');
    deq(done.body.rows.map((r) => [r.note, r.status]), [['newer', 'cancelled'], ['old one', 'done']]);
    deq(done.body.counts, { pending: 1, overdue: 0, done_today: 1 });
    eq((await get('owner')).body.rows.length, 3, 'no status = everything');
  });
  await t('done / cancel / reopen: the Super Admin and the Manager (team.lead) only; a member 403; the note at most 300; wrong state 409; another panel 404; the log never holds the note', async () => {
    await post('rahul', { conversationId: 'c-ver', kinds: ['address'], note: NOTE });
    await post('rahul', { conversationId: 'c-p2', kinds: ['size'], note: 'p2 row' });
    eq((await patch('rahul', '1', { action: 'done' })).status, 403, 'Rahul asked for it, Sunny closes it');
    eq((await patch('viewer', '1', { action: 'done' })).status, 403);
    const d = await patch('sunny', '1', { action: 'done', note: ' Changed in ShipTrack, new address saved ' });
    eq(d.status, 200, JSON.stringify(d.body));
    deq([d.body.correction.status, d.body.correction.done_by, d.body.correction.done_by_name, d.body.correction.done_note, !!d.body.correction.done_at], ['done', 'u-sunny', 'Sunny', 'Changed in ShipTrack, new address saved', true]);
    eq((await patch('sunny', '1', { action: 'done' })).status, 409, 'already done');
    eq((await patch('sunny', '1', { action: 'cancel' })).status, 409);
    const re = await patch('owner', '1', { action: 'reopen' });
    deq([re.status, re.body.correction.status, re.body.correction.done_by, re.body.correction.done_note], [200, 'pending', null, null]);
    eq((await patch('owner', '1', { action: 'reopen' })).status, 409, 'already pending');
    eq((await patch('owner', '1', { action: 'done', note: 'x'.repeat(301) })).status, 400);
    eq((await patch('owner', '1', { action: 'done', note: 'a <b>' })).status, 400);
    eq((await patch('owner', '1', { action: 'finish' })).status, 400);
    eq((await patch('owner', '99', { action: 'done' })).status, 404);
    eq((await patch('owner', 'abc', { action: 'done' })).status, 404);
    // Priya (P2 only) may be a lead there and still not touch a P1 row
    USERS.priya.permissions = ['chat.view', 'chat.reply', 'team.lead'];
    try {
      eq((await patch('priya', '1', { action: 'cancel' })).status, 404);
      eq((await patch('priya', '2', { action: 'cancel' })).status, 200);
    } finally { USERS.priya.permissions = ['chat.view', 'chat.reply']; }
    eq((await patch(null, '1', { action: 'done' })).status, 401);
    const lines = S.logs.filter((l) => /^\[correction\]/.test(l));
    ok(lines.some((l) => / done by u-sunny/.test(l)) && lines.some((l) => / reopen by owner/.test(l)) && lines.some((l) => / cancel by u-priya/.test(l)), lines.join('\n'));
    ok(!S.logs.some((l) => l.includes('Rose Lane') || l.includes('new address saved')), 'neither the note nor the done note is logged');
  });
  await t('order-corrections.sql not run yet: every route answers 503 in plain words, every light read answers nothing, nothing throws', async () => {
    S.missing = true;
    const p = await post('rahul', { conversationId: 'c-ver', kinds: ['address'], note: NOTE });
    deq([p.status, p.body.error], [503, rules.CORRECTION_TEXT.notInstalled]);
    deq([(await get('owner', '?status=pending')).status, (await patch('owner', '1', { action: 'done' })).status], [503, 503]);
    eq((await post('mailer', { mail: { box: 'box1', uid: 4410, email: 'asha@gmail.com' }, kinds: ['size'], note: 'Size M' })).status, 503);
    deq(await read.listForConversation('c-ver'), []);
    deq(await read.listForMail('box1', 4410), []);
    deq(Array.from(await read.pendingCorrectionConvIds(['c-ver', 'c-mail'])), []);
    eq(await read.pendingCorrectionCount(null), 0);
    eq((await read.correctionsByPanel(['P1'])).size, 0);
    eq((await get('reader', '?box=box1&uid=4410')).body.rows.length, 0, 'the Mail tab line is simply empty');
  });
  await t('the light reads: the inbox row chip, the sidebar badge (in scope), the board\'s per-panel pending / overdue', async () => {
    S.now = Date.now() - 30 * HOUR; await post('rahul', { conversationId: 'c-ver', kinds: ['address'], note: 'a' });
    S.now = Date.now() - HOUR; await post('rahul', { conversationId: 'c-mail', kinds: ['size'], note: 'b' }); await post('owner', { conversationId: 'c-p2', kinds: ['size'], note: 'c' });
    delete S.now;
    await patch('owner', '2', { action: 'done' });
    deq(Array.from(await read.pendingCorrectionConvIds(['c-ver', 'c-mail', 'c-p2', null])).sort(), ['c-p2', 'c-ver']);
    deq(Array.from(await read.pendingCorrectionConvIds([])), []);
    eq(await read.pendingCorrectionCount(null), 2); eq(await read.pendingCorrectionCount(['P2']), 1); eq(await read.pendingCorrectionCount(['P9']), 0);
    const by = await read.correctionsByPanel(['P1', 'P2']);
    deq([by.get('P1'), by.get('P2')], [{ pending: 1, overdue: 1 }, { pending: 1, overdue: 0 }]);
    deq((await read.listForConversation('c-mail')).map((r) => r.status), ['done']);
  });
  await t('the wiring: the thread answers corrections + staff.can_correct, the list the chip + the badge, the board the line and the routine step, never on WhatsApp, the SQL file and the rulebook', () => {
    const src = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
    ok(/const corrections = await listForConversation\(params\.id\);/.test(src('app/api/chat/conversations/[id]/route.ts')) && /\n    corrections,\n/.test(src('app/api/chat/conversations/[id]/route.ts')));
    ok(/can_correct: live && !!actor && actor\.canReply && conv\.source !== 'whatsapp'/.test(src('lib/chat/thread-staff.ts')));
    ok(/r\.correction_pending = corrIds\.has\(String\(r\.id\)\);/.test(src('app/api/chat/conversations/route.ts')) && /corrections_pending: correctionsPending,/.test(src('app/api/chat/conversations/route.ts')));
    ok(/correctionsByPanel\(ids\)/.test(src('lib/panel-board-server.ts')) && /go: 'corrections'/.test(src('lib/panel-board.ts')) && /Every correction done/.test(src('lib/panel-board.ts')));
    ok(/section=corrections/.test(src('app/admin/chat/page.tsx')) && /section=corrections/.test(src('app/admin/page.tsx')));
    ok(/conv\.source !== 'whatsapp'/.test(src('app/admin/chat/_components/NextStep.tsx')), 'the button is never offered on a WhatsApp chat');
    ok(/correctionsItem/.test(src('app/admin/chat/_components/InboxSidebar.tsx')) && /simpleGroups[\s\S]*correctionsItem/.test(src('app/admin/chat/_components/InboxSidebar.tsx')), 'the section is in both menus');
    ok(/Correction/.test(src('components/mail/MailReader.tsx')) && /\/api\/corrections\?box=/.test(src('components/mail/MailReader.tsx')));
    const sql = fs.readFileSync(path.resolve(__dirname, '../../order-corrections.sql'), 'utf8');
    ok(/CREATE TABLE IF NOT EXISTS order_corrections/.test(sql) && /GRANT SELECT, INSERT, UPDATE ON order_corrections TO tracker_user/.test(sql) && !/GRANT[^;]*DELETE/.test(sql) && !/DROP /.test(sql));
    ok(/conversation_id\s+text,/.test(sql), 'conversations.id is text (chat-tables.sql)');
    for (const k of rules.CORRECTION_KIND_KEYS) ok(sql.includes(k) || k === 'other' || k === 'pack' || k === 'bogo', k);
    const rb = require(path.join(SRC, 'lib/chat/rulebook.ts'));
    const rule = rb.RULEBOOK.find((s) => s.key === 'team').rules.find((r) => r.id === '7.17');
    ok(rule && /Correction/.test(rule.title) && /Manager/.test(rule.text) && /nothing is ever sent/i.test(rule.text), 'rulebook 7.17 in section 7');
    ok(/corrections\.js/.test(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')), 'in npm run test:ai');
  });

  console.log(`CORRECTIONS: ${pass} groups passed${fail ? `, ${fail} FAILED` : ''}`);
  process.exit(fail ? 1 : 0);
})();
