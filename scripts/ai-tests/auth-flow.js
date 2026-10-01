// The owner's login change, team renames / typed passwords and the chat address change, run
// through the REAL route code (src/lib/auth.ts, /api/auth/account, /api/team, /api/auth/session,
// /api/chat/conversations/[id]/address) against a small fake database. No network, nothing real.
// The SQL itself (and the address trigger) is checked on the server inside a rolled-back
// transaction; this checks the logic around it.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-flow-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

process.env.AUTH_TOKEN_SECRET = 'test-secret-'.padEnd(48, 'x');
process.env.ADMIN_USERNAME = 'Owner';
process.env.ADMIN_PASSWORD = 'env-pass-123';

// ── Fake modules ───────────────────────────────────────────────
fs.writeFileSync(path.join(dir, 'next-server.js'), `
class NextResponse { static json(body, init = {}) { return { status: init.status || 200, body, json: async () => body }; } }
class NextRequest {}
module.exports = { NextResponse, NextRequest };`);

const db = {
  adminRow: null, adminTable: true, adminError: null, adminGate: null,
  team: [], businesses: [{ id: 'P1' }, { id: 'P2' }],
  conversations: [], orders: [], addressChanges: [], log: [],
};
let nextId = 1;
const cols = (u) => ({ id: u.id, username: u.username, display_name: u.display_name, role: u.role, is_active: u.is_active, last_login: null, created_at: 'now', business_ids: u.business_ids, permissions: u.permissions, created_by: u.created_by });
async function handle(sql, params = []) {
  const q = sql.replace(/\s+/g, ' ').trim();
  db.log.push(q.slice(0, 60));
  const rows = (r) => ({ rows: r, rowCount: r.length });
  if (/FROM admin_login WHERE id = 1/.test(q)) {
    // The row as it was when the read began (a held read returns what it saw then).
    const snap = db.adminRow ? { ...db.adminRow } : null;
    if (db.adminGate) await db.adminGate;
    if (!db.adminTable) { const e = new Error('relation "admin_login" does not exist'); e.code = '42P01'; throw e; }
    if (db.adminError) throw db.adminError;
    return rows(snap ? [snap] : []);
  }
  if (/^INSERT INTO admin_login/.test(q)) {
    const [username, password_hash, updated_by] = params;
    db.adminRow = db.adminRow
      ? { ...db.adminRow, username, password_hash, session_version: db.adminRow.session_version + 1, updated_at: new Date().toISOString(), updated_by }
      : { username, password_hash, session_version: 2, updated_at: new Date().toISOString(), updated_by };
    return rows([{ username: db.adminRow.username, session_version: db.adminRow.session_version, updated_at: db.adminRow.updated_at }]);
  }
  if (/^SELECT id, username, display_name, role, is_active, business_ids, permissions, session_version FROM team_users$/.test(q)) {
    return rows(db.team.map((u) => ({ ...u })));
  }
  if (/FROM team_users WHERE username = \$1 AND is_active = true/.test(q)) {
    return rows(db.team.filter((u) => u.username === params[0] && u.is_active).map((u) => ({ ...u })));
  }
  if (/^UPDATE team_users SET last_login/.test(q)) return rows([]);
  if (/^SELECT 1 FROM team_users WHERE lower\(username\) = \$1/.test(q)) return rows(db.team.filter((u) => u.username.toLowerCase() === params[0]).map(() => ({ '?column?': 1 })));
  if (/^SELECT id FROM businesses/.test(q)) return rows(db.businesses.filter((b) => params[0].includes(b.id)));
  if (/^INSERT INTO team_users/.test(q)) {
    const [username, password_hash, display_name, role, business_ids, permissions, created_by, session_version] = params;
    if (db.team.some((u) => u.username === username)) { const e = new Error('dup'); e.code = '23505'; throw e; }
    const u = { id: 'm' + nextId++, username, password_hash, display_name, role, business_ids, permissions, created_by, session_version, is_active: true };
    db.team.push(u);
    return rows([cols(u)]);
  }
  if (/^SELECT role, username FROM team_users WHERE id::text = \$1/.test(q)) return rows(db.team.filter((u) => u.id === params[0]).map((u) => ({ role: u.role, username: u.username })));
  if (/^UPDATE team_users SET /.test(q)) {
    const set = q.slice('UPDATE team_users SET '.length, q.indexOf(' WHERE '));
    const idParam = Number(q.match(/WHERE id::text = \$(\d+)/)[1]);
    const u = db.team.find((x) => x.id === params[idParam - 1]);
    if (!u) return rows([]);
    const next = { ...u };
    for (const part of set.split(', ')) {
      const m = part.match(/^(\w+) = \$(\d+)$/);
      if (m) next[m[1]] = params[Number(m[2]) - 1];
      else if (part === 'session_version = session_version + 1') next.session_version = u.session_version + 1;
      else if (part !== 'updated_at = now()') throw new Error('fake db: unknown SET ' + part);
    }
    if (next.username !== u.username && db.team.some((x) => x !== u && x.username === next.username)) { const e = new Error('dup'); e.code = '23505'; throw e; }
    Object.assign(u, next);
    return rows([cols(u)]);
  }
  if (/^DELETE FROM team_users/.test(q)) { const before = db.team.length; db.team = db.team.filter((u) => u.id !== params[0]); return { rows: [], rowCount: before - db.team.length }; }
  // Chat address
  if (/^SELECT c.verified_order_id, s.tracker_business_id FROM conversations c/.test(q)) return rows(db.conversations.filter((c) => c.id === params[0]).map((c) => ({ verified_order_id: c.verified_order_id, tracker_business_id: c.panel })));
  if (/^SELECT id, order_id, business_id, address_line1, address_line2, city, state, pincode FROM orders WHERE order_id = \$1 AND business_id::text = \$2::text FOR UPDATE/.test(q)) {
    return rows(db.orders.filter((o) => o.order_id === params[0] && o.business_id === params[1]).map((o) => ({ ...o })));
  }
  if (/^UPDATE orders SET address_line1 = \$1/.test(q)) {
    const o = db.orders.find((x) => x.id === params[6]);
    Object.assign(o, { address_line1: params[0], address_line2: params[1], city: params[2], state: params[3], pincode: params[4], address_edited_by: params[5], address_edited_at: new Date().toISOString() });
    return rows([{ address_edited_at: o.address_edited_at }]);
  }
  if (/^INSERT INTO order_address_changes/.test(q)) { db.addressChanges.push(params); return rows([]); }
  throw new Error('fake db: unexpected SQL: ' + q.slice(0, 120));
}
global.__fakeDb = { handle };
fs.writeFileSync(path.join(dir, 'db.js'), `
const h = (...a) => global.__fakeDb.handle(...a);
module.exports = {
  query: h,
  queryOne: async (sql, p) => (await h(sql, p)).rows[0] ?? null,
  withTransaction: async (fn) => fn({ query: h }),
};`);

// ── Compile the real code next to the fakes ────────────────────
const compile = (from, to) => {
  let src = fs.readFileSync(path.join(SRC, from), 'utf8')
    .replace(/from '@\/lib\/auth'/g, "from './auth'")
    .replace(/from '@\/lib\/db'/g, "from './db'")
    .replace(/from '@\/lib\/permissions'/g, "from './permissions'")
    .replace(/from '@\/lib\/chat\/order-address-db'/g, "from './order-address-db'")
    .replace(/from '@\/lib\/chat\/order-address'/g, "from './order-address'")
    .replace(/from 'next\/server'/g, "from './next-server'");
  fs.writeFileSync(path.join(dir, to + '.js'), ts.transpileModule(src, { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true } }).outputText);
};
compile('lib/permissions.ts', 'permissions');
compile('lib/auth.ts', 'auth');
compile('app/api/auth/account/route.ts', 'account');
compile('app/api/team/route.ts', 'team');
compile('app/api/auth/session/route.ts', 'session');
compile('lib/chat/order-address.ts', 'order-address');
compile('lib/chat/order-address-db.ts', 'order-address-db');
compile('app/api/chat/conversations/[id]/address/route.ts', 'address');
const fresh = () => {
  // A restart: new module instances and an empty login cache.
  delete global.__shiptrackTeam; delete global.__shiptrackAccountFails;
  for (const k of Object.keys(require.cache)) if (k.startsWith(dir)) delete require.cache[k];
  return { auth: require(path.join(dir, 'auth.js')), account: require(path.join(dir, 'account.js')), team: require(path.join(dir, 'team.js')), session: require(path.join(dir, 'session.js')), address: require(path.join(dir, 'address.js')) };
};
const reqOf = (token, body, url = 'http://x/api') => ({
  headers: { get: (k) => (k.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : null) },
  json: async () => { if (body === undefined) throw new Error('no body'); return body; },
  url,
});

let n = 0;
const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error('FAIL ' + name); throw e; } };

(async () => {
  let { auth, account, team, session, address } = fresh();
  const who = (token) => auth.getAuthFromRequest(reqOf(token));

  await t('cold start: a super-admin token waits for the first read, then counts', async () => {
    const tok = auth.generateToken('Owner', 'admin', null, { name: 'Super Admin' });
    assert.strictEqual(who(tok), null);                 // refused before the logins are read
    const s = await session.GET(reqOf(tok));             // the session check waits for them
    assert.strictEqual(s.status, 200);
    assert.strictEqual(who(tok).role, 'admin');
  });

  let envTok;
  await t('.env login works while nothing is saved; exact case as before', async () => {
    const r = await auth.authenticateUser('Owner', 'env-pass-123');
    assert.ok(r && r.user.role === 'admin');
    envTok = r.token;
    assert.strictEqual(await auth.authenticateUser('Owner', 'wrong'), null);
    assert.strictEqual(await auth.authenticateUser('owner', 'env-pass-123'), null);
    const g = await account.GET(reqOf(envTok));
    assert.deepStrictEqual([g.status, g.body.username, g.body.savedInPanel], [200, 'Owner', false]);
  });

  await t('team member cannot take the owner username; members get a random start version', async () => {
    const r1 = await team.POST(reqOf(envTok, { displayName: 'Ravi', username: 'owner', role: 'agent' }));
    assert.strictEqual(r1.status, 409);
    const r2 = await team.POST(reqOf(envTok, { displayName: 'Ravi', username: 'ravi', role: 'agent' }));
    assert.strictEqual(r2.status, 200);
    assert.ok(r2.body.password && r2.body.password.length === 12);
    assert.ok(db.team[0].session_version >= 2);
  });

  await t('account: refuses a wrong current password, then blocks after 5', async () => {
    for (let i = 0; i < 5; i++) assert.strictEqual((await account.POST(reqOf(envTok, { currentPassword: 'nope', newPassword: 'Another-pass-1' }))).status, 400);
    assert.strictEqual((await account.POST(reqOf(envTok, { currentPassword: 'env-pass-123', newPassword: 'Another-pass-1' }))).status, 429);
    delete global.__shiptrackAccountFails;
  });

  await t('account: checks the new login before saving', async () => {
    const post = (b) => account.POST(reqOf(envTok, { currentPassword: 'env-pass-123', ...b }));
    assert.strictEqual((await post({})).status, 400);                                   // nothing to change
    assert.strictEqual((await post({ username: 'Owner' })).status, 400);                // same username
    assert.strictEqual((await post({ username: 'bad name!' })).status, 400);
    assert.strictEqual((await post({ username: 'ravi' })).status, 409);                 // a member has it
    assert.strictEqual((await post({ newPassword: 'short' })).status, 400);
    assert.strictEqual((await post({ newPassword: 'env-pass-123' })).status, 400);      // the current one
    assert.strictEqual((await post({ username: 'jatin.owner', newPassword: 'xxjatin.ownerxx' })).status, 400); // has the username
    assert.strictEqual((await account.POST(reqOf(null, { currentPassword: 'env-pass-123', newPassword: 'Another-pass-1' }))).status, 403);
    assert.strictEqual(db.adminRow, null);
  });

  let tok2;
  await t('account: new username + password signs out every older owner login at once', async () => {
    const staffTok = (await auth.authenticateUser('Owner', 'env-pass-123')).token; // a staff phone with the shared login
    const r = await account.POST(reqOf(envTok, { currentPassword: 'env-pass-123', username: 'Jatin.Owner', newPassword: 'N3w-strong-pass' }));
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual([db.adminRow.username, db.adminRow.session_version], ['jatin.owner', 2]);
    assert.ok(db.adminRow.password_hash.startsWith('s1$') && !db.adminRow.password_hash.includes('N3w'));
    tok2 = r.body.token;
    assert.strictEqual(who(envTok), null);
    assert.strictEqual(who(staffTok), null);
    assert.strictEqual(who(tok2).role, 'admin');
    assert.strictEqual(await auth.authenticateUser('Owner', 'env-pass-123'), null);   // the .env login is dead
    const again = await auth.authenticateUser('JATIN.owner', 'N3w-strong-pass');      // any letter case
    assert.ok(again && again.user.username === 'jatin.owner');
    assert.strictEqual(who(again.token).role, 'admin');
    const g = await account.GET(reqOf(tok2));
    assert.deepStrictEqual([g.body.username, g.body.savedInPanel], ['jatin.owner', true]);
  });

  let tok3;
  await t('account: password only keeps the username, raises the version again', async () => {
    const r = await account.POST(reqOf(tok2, { currentPassword: 'N3w-strong-pass', username: 'jatin.owner', newPassword: 'Third-pass-777' }));
    assert.strictEqual(r.status, 200);
    tok3 = r.body.token;
    assert.deepStrictEqual([db.adminRow.username, db.adminRow.session_version], ['jatin.owner', 3]);
    assert.strictEqual(who(tok2), null);
    assert.strictEqual(who(tok3).role, 'admin');
    assert.strictEqual((await team.POST(reqOf(tok3, { displayName: 'Jatin Two', username: 'jatin.owner', role: 'agent' }))).status, 409);
    assert.strictEqual((await team.POST(reqOf(tok3, { displayName: 'Old Name', username: 'owner', role: 'agent' }))).status, 409);
  });

  await t('a reload that began before the change cannot bring the old login back', async () => {
    let open; db.adminGate = new Promise((r) => { open = r; });
    const reload = auth.refreshTeamCache();                 // reads admin_login, held at the gate
    await new Promise((r) => setTimeout(r, 5));
    const before = { ...db.adminRow };
    db.adminGate = null;                                     // the account route's own reads pass
    const r = await account.POST(reqOf(tok3, { currentPassword: 'Third-pass-777', newPassword: 'Fourth-pass-888' }));
    assert.strictEqual(r.status, 200);
    open(); await reload;                                    // the old read finishes last
    assert.strictEqual(who(tok3), null);
    assert.strictEqual(who(r.body.token).role, 'admin');
    assert.ok(before.session_version === 3 && db.adminRow.session_version === 4);
    tok3 = r.body.token;
  });

  await t('a reset on the server is felt at the next login, and no later than the 30 s reload', async () => {
    const { scryptSync, randomBytes } = require('crypto');
    const salt = randomBytes(16);
    db.adminRow = { ...db.adminRow, password_hash: `s1$${salt.toString('base64')}$${scryptSync('Reset-pass-5555', salt, 32).toString('base64')}`, session_version: db.adminRow.session_version + 1 };
    assert.strictEqual(who(tok3).role, 'admin');             // until the reload
    const r = await auth.authenticateUser('jatin.owner', 'Reset-pass-5555');
    assert.ok(r);
    assert.strictEqual(who(tok3), null);
    assert.strictEqual(who(r.token).role, 'admin');
    tok3 = r.token;
  });

  await t('restart after a change: old tokens stay dead, the new one comes back', async () => {
    ({ auth, account, team, session, address } = fresh());
    assert.strictEqual((await session.GET(reqOf(tok3))).status, 200);
    assert.strictEqual(auth.getAuthFromRequest(reqOf(envTok)), null);
    assert.strictEqual(auth.getAuthFromRequest(reqOf(tok2)), null);
  });

  await t('database trouble: no owner login (not the .env one), team logins unaffected by that', async () => {
    db.adminError = Object.assign(new Error('timeout'), { code: '57014' });
    assert.strictEqual(await auth.authenticateUser('Owner', 'env-pass-123'), null);
    assert.strictEqual(await auth.authenticateUser('jatin.owner', 'Reset-pass-5555'), null);
    db.adminError = null;
  });

  await t('before admin-login.sql: the .env login still works', async () => {
    const saved = db.adminRow; db.adminRow = null; db.adminTable = false;
    ({ auth, account, team, session, address } = fresh());
    const r = await auth.authenticateUser('Owner', 'env-pass-123');
    assert.ok(r);
    assert.strictEqual((await session.GET(reqOf(r.token))).status, 200);
    db.adminTable = true; db.adminRow = saved;
    ({ auth, account, team, session, address } = fresh());
  });

  const H = (tk) => auth.getAuthFromRequest(reqOf(tk));
  await t('team: rename signs the member out; a new member with the old name gets none of it', async () => {
    const ravi = db.team.find((u) => u.username === 'ravi');
    const { scryptSync, randomBytes } = require('crypto');
    const salt = randomBytes(16);
    ravi.password_hash = `s1$${salt.toString('base64')}$${scryptSync('Ravi-pass-111', salt, 32).toString('base64')}`;
    await auth.refreshTeamCache(true);
    const rt = (await auth.authenticateUser('ravi', 'Ravi-pass-111')).token;
    assert.strictEqual(H(rt).role, 'agent');
    const bad = await team.PATCH(reqOf(tok3, { id: ravi.id, username: 'Bad Name' }));
    assert.strictEqual(bad.status, 400);
    const r = await team.PATCH(reqOf(tok3, { id: ravi.id, username: 'ravi.k' }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(H(rt), null);
    const rt2 = (await auth.authenticateUser('ravi.k', 'Ravi-pass-111')).token;   // same password, new name
    assert.strictEqual(H(rt2).username, 'ravi.k');
    const nr = await team.POST(reqOf(tok3, { displayName: 'New Ravi', username: 'ravi', role: 'panel_admin' }));
    assert.strictEqual(nr.status, 200);
    assert.strictEqual(H(rt), null);                                             // old token, new person: refused
    const legacy = auth.generateToken('ravi', 'agent', null, { sv: 1 });         // an old-style token, no member id
    assert.strictEqual(H(legacy), null);
    const newRavi = db.team.find((u) => u.username === 'ravi');
    const sameVersion = auth.generateToken('ravi', 'agent', null, { sv: newRavi.session_version, uid: ravi.id });
    assert.strictEqual(H(sameVersion), null);                                    // another person's id: refused
    assert.strictEqual(H(auth.generateToken('ravi', 'panel_admin', null, { sv: newRavi.session_version, uid: newRavi.id })).username, 'ravi');
    assert.strictEqual((await team.PATCH(reqOf(tok3, { id: ravi.id, username: 'ravi' }))).status, 409); // taken
    assert.strictEqual((await team.PATCH(reqOf(tok3, { id: ravi.id, username: 'jatin.owner' }))).status, 409);
  });

  await t('team: a typed password is checked, saved hashed, signs out, and works', async () => {
    const ravi = db.team.find((u) => u.username === 'ravi.k');
    const tk = (await auth.authenticateUser('ravi.k', 'Ravi-pass-111')).token;
    assert.strictEqual((await team.PATCH(reqOf(tok3, { id: ravi.id, password: 'short' }))).status, 400);
    assert.strictEqual((await team.PATCH(reqOf(tok3, { id: ravi.id, password: 'my-ravi.k-pass' }))).status, 400);
    const r = await team.PATCH(reqOf(tok3, { id: ravi.id, password: 'Typed-pass-2468' }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.password, undefined);                               // never answered back
    assert.ok(ravi.password_hash.startsWith('s1$'));
    assert.strictEqual(H(tk), null);
    assert.ok(await auth.authenticateUser('ravi.k', 'Typed-pass-2468'));
    assert.strictEqual(await auth.authenticateUser('ravi.k', 'Ravi-pass-111'), null);
    const reset = await team.PATCH(reqOf(tok3, { id: ravi.id, resetPassword: true }));
    assert.ok(reset.body.password && reset.body.password.length === 12);
    assert.strictEqual((await team.POST(reqOf(H(tk) ? tk : 'x', { displayName: 'X', username: 'xyz', role: 'agent' }))).status, 403);
  });

  // ── Chat address ─────────────────────────────────────────────
  db.orders.push({ id: 'o1', order_id: '#1001', business_id: 'P1', address_line1: '12 MG Road', address_line2: '', city: 'Pune', state: 'Maharashtra', pincode: '411001' });
  db.orders.push({ id: 'o2', order_id: '#1002', business_id: 'P1', address_line1: 'Old Lane', address_line2: 'Near Park', city: 'Surat', state: 'Gujrat', pincode: '395001' });
  db.conversations.push({ id: 'c1', verified_order_id: '#1001', panel: 'P1' }, { id: 'c2', verified_order_id: null, panel: 'P1' }, { id: 'c3', verified_order_id: '#1002', panel: 'P1' });
  const good = { line1: ' 45  New  Street ', line2: 'Opp. School', city: 'Mumbai', state: 'maharashtra', pincode: '400 001' };
  const patch = (tk, conv, body) => address.PATCH(reqOf(tk, body), { params: { id: conv } });

  await t('address: only logins that may change orders, only verified chats, only their panels', async () => {
    const agent = await team.POST(reqOf(tok3, { displayName: 'Chat Only', username: 'chat.only', role: 'agent' }));
    const agentTok = (await auth.authenticateUser('chat.only', agent.body.password)).token;
    assert.strictEqual((await patch(agentTok, 'c1', good)).status, 403);
    const mgr = await team.POST(reqOf(tok3, { displayName: 'P2 Manager', username: 'p2.mgr', role: 'manager', businessIds: ['P2'] }));
    const mgrTok = (await auth.authenticateUser('p2.mgr', mgr.body.password)).token;
    assert.strictEqual((await patch(mgrTok, 'c1', good)).status, 404);
    assert.strictEqual((await patch(tok3, 'c2', good)).status, 409);
    assert.strictEqual((await patch(null, 'c1', good)).status, 401);
    assert.strictEqual(db.addressChanges.length, 0);
  });

  await t('address: checks what was typed, saves it tidy, logs old and new', async () => {
    assert.strictEqual((await patch(tok3, 'c1', { ...good, pincode: '12345' })).status, 400);
    assert.strictEqual((await patch(tok3, 'c1', { ...good, state: 'Gotham' })).status, 400);
    assert.strictEqual((await patch(tok3, 'c1', { ...good, line1: 'x' })).status, 400);
    const r = await patch(tok3, 'c1', good);
    assert.strictEqual(r.status, 200);
    const o = db.orders[0];
    assert.deepStrictEqual([o.address_line1, o.address_line2, o.city, o.state, o.pincode], ['45 New Street', 'Opp. School', 'Mumbai', 'Maharashtra', '400001']);
    assert.ok(o.address_edited_at && o.address_edited_by === 'Super Admin');
    assert.strictEqual(r.body.address.edited_by, 'Super Admin');
    assert.strictEqual(db.addressChanges.length, 1);
    const [orderUuid, orderId, biz, conv, oldA, newA, by] = db.addressChanges[0];
    assert.deepStrictEqual([orderUuid, orderId, biz, conv, by], ['o1', '#1001', 'P1', 'c1', 'jatin.owner']);
    assert.strictEqual(JSON.parse(oldA).line1, '12 MG Road');
    assert.strictEqual(JSON.parse(newA).city, 'Mumbai');
    const same = await patch(tok3, 'c1', good);
    assert.ok(same.status === 200 && same.body.unchanged === true && db.addressChanges.length === 1);
  });

  await t('address: an odd old state stays allowed unchanged', async () => {
    const r = await patch(tok3, 'c3', { line1: 'Old Lane 2', line2: 'Near Park', city: 'Surat', state: 'Gujrat', pincode: '395001' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(db.orders[1].state, 'Gujrat');
    assert.strictEqual((await patch(tok3, 'c3', { line1: 'Old Lane 2', line2: '', city: 'Surat', state: 'Gujratt', pincode: '395001' })).status, 400);
  });

  await t('address helpers: text and state list', async () => {
    const oa = require(path.join(dir, 'order-address.js'));
    assert.strictEqual(oa.addressText({ line1: '12 MG Road', line2: '', city: 'Pune', state: 'Maharashtra', pincode: '411001' }), '12 MG Road, Pune, Maharashtra 411001');
    assert.strictEqual(oa.INDIAN_STATES.length, 36);
    assert.ok('error' in oa.cleanAddress({ line1: 'abc', city: 'Pune', state: 'Maharashtra', pincode: '011001' }));
    assert.ok('address' in oa.cleanAddress({ line1: 'abc', city: 'Pune', state: 'DELHI', pincode: '110001' }));
  });

  await t('server reset script: makes a password the login accepts, signs older logins out', async () => {
    // The real script, run with a fake pg (it never reaches a database here).
    const { execFileSync } = require('child_process');
    const fakePg = path.join(dir, 'node_modules', 'pg');
    fs.mkdirSync(fakePg, { recursive: true });
    fs.writeFileSync(path.join(fakePg, 'index.js'), `
      class Client { async connect() {} async end() {}
        async query(sql, params) {
          require('fs').writeFileSync(process.env.CAPTURE, JSON.stringify({ sql, params }));
          return process.env.NO_ROW ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ username: 'jatin.owner' }] };
        } }
      module.exports = { Client };`);
    fs.copyFileSync(path.resolve(__dirname, '../admin-login-reset.js'), path.join(dir, 'reset.js'));
    const cap = path.join(dir, 'cap.json');
    const run = (extra = {}) => execFileSync(process.execPath, [path.join(dir, 'reset.js')], { env: { PATH: process.env.PATH, DATABASE_URL: 'postgres://fake', CAPTURE: cap, ...extra } }).toString();
    const out = run();
    const pw = (out.match(/Password: (\S+)/) || [])[1];
    const { sql, params } = JSON.parse(fs.readFileSync(cap, 'utf8'));
    assert.ok(pw && pw.length === 14);
    assert.ok(/session_version = session_version \+ 1/.test(sql) && /WHERE id = 1/.test(sql));
    assert.ok(auth.verifyPassword(params[0], pw));
    assert.ok(!auth.verifyPassword(params[0], pw + 'x'));
    assert.ok(/No saved login yet/.test(run({ NO_ROW: '1' })));
  });

  console.log(`AUTH-FLOW: ${n} groups passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
