// The Manager's Team live board (owner 2026-10-10, step 5). The REAL team-live.ts and team-live-rules.ts against a
// fake database, team and presence. 12 Oct 2026 is a Monday (India).
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true }, fileName: filename }).outputText, filename);

const IST = (d, h, m = 0) => Date.UTC(2026, 9, d, h, m) - 330 * 60000;
const eq = assert.strictEqual, deq = assert.deepStrictEqual, ok = assert.ok;
const S = {};
function reset() {
  Object.assign(S, {
    team: [
      { id: 'u-rahul', name: 'Rahul', active: true, role: 'agent', permissions: ['chat.view', 'chat.reply'], businessIds: null },
      { id: 'u-anurag', name: 'Anurag', active: true, role: 'agent', permissions: ['chat.view', 'chat.reply'], businessIds: ['P2'] },
      { id: 'u-sunny', name: 'Sunny', active: true, role: 'manager', permissions: null, businessIds: null },
      { id: 'u-view', name: 'Viewer', active: true, role: 'viewer', permissions: null, businessIds: null },
      { id: 'u-off', name: 'Old', active: false, role: 'agent', permissions: ['chat.view', 'chat.reply'], businessIds: null },
    ],
    seen: {}, presence: true, fail: {}, args: {},
    held: [], replies: [], moved: [], ai: [], counts: { alone: 0, handed: 0 }, marks: 0,
  });
}
reset();
const norm = (q) => q.replace(/\s+/g, ' ').trim();
const part = (q) => /AS held/.test(q) ? 'held' : /e\.kind = 'reply'/.test(q) ? 'replies' : /no_reply_30/.test(q) ? 'moved'
  : /AS alone/.test(q) ? 'counts' : /m\.sender = 'ai'/.test(q) ? 'ai' : /chat_case_events/.test(q) ? 'marks' : null;
const db = {
  query: async (raw, p = []) => {
    const q = norm(raw); const k = part(q);
    if (!k) throw new Error('fake db: ' + q.slice(0, 100));
    S.args[k] = { q, p };
    if (S.fail[k]) throw Object.assign(new Error('boom'), { code: S.fail[k] });
    if (k === 'counts') return { rows: [S.counts] };
    if (k === 'marks') return { rows: [{ n: S.marks }] };
    return { rows: S[k] };
  },
};
let health = { ok: true, reason: null };
const fakes = {
  '@/lib/db': db,
  '@/lib/auth': { teamEntries: () => S.team.map((e) => ({ ...e })), lastSeenMs: (k) => S.seen[k] ?? null, presenceRead: () => S.presence },
  './holidays': { loadHolidays: async () => [] },
  './ai-health': { aiHealth: () => health, AI_REASON_TEXT: { credits: 'OpenRouter credits ran out' } },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (fakes[request]) return request;
  if (request.startsWith('@/')) return origResolve.call(this, path.join(SRC, request.slice(2)), parent, ...rest);
  return origResolve.call(this, request, parent, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) { if (fakes[request]) return fakes[request]; return origLoad.call(this, request, parent, ...rest); };
const rules = require(path.join(SRC, 'lib/chat/team-live-rules.ts'));
const live = require(path.join(SRC, 'lib/chat/team-live.ts'));

const realErr = console.error;
let pass = 0, fail = 0;
async function t(name, fn) {
  reset(); health = { ok: true, reason: null };
  console.error = () => {};
  try { await fn(); console.error = realErr; pass++; console.log('  ok  ' + name); }
  catch (e) { console.error = realErr; fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 12).join('\n       ')); }
}

(async () => {
  console.log('team-live: the Manager\'s board');
  await t('half hours: from 10:00 India time up to now, at least one, at most 24; labels in India time', () => {
    const open = IST(12, 10);
    eq(rules.slotCount(open, IST(12, 9)), 1);
    eq(rules.slotCount(open, IST(12, 10)), 1);
    eq(rules.slotCount(open, IST(12, 11, 5)), 3);
    eq(rules.slotCount(open, IST(13, 9)), 24);
    deq(rules.slotLabels(open, 4), ['10:00', '10:30', '11:00', '11:30']);
  });
  await t('members: active repliers in the panels, on duty / away / not in, chats held and waiting, replies per half hour, 30-minute misses; the Manager first', async () => {
    const now = IST(12, 11, 10);
    S.seen = { 'u-rahul': IST(12, 11, 5), 'u-sunny': IST(12, 10, 20) };
    S.held = [{ k: 'u-rahul', held: 4, waiting: 2 }, { k: 'u-sunny', held: 1, waiting: 0 }];
    S.replies = [{ k: 'u-rahul', slot: 0, n: 3 }, { k: 'u-rahul', slot: 2, n: 5 }, { k: 'u-sunny', slot: 1, n: 1 }, { k: 'u-rahul', slot: 9, n: 7 }];
    S.moved = [{ k: 'u-rahul', n: 1 }];
    const r = await live.loadTeamLive(null, now);
    deq(r.slotLabels, ['10:00', '10:30', '11:00']);
    eq(r.officeOpen, true);
    deq(r.members.map((m) => m.name), ['Sunny', 'Rahul', 'Anurag'], 'Manager first, then by replies; no viewer, no switched-off login');
    const [sunny, rahul, anurag] = r.members;
    deq([rahul.onDuty, rahul.seenMin, rahul.held, rahul.waiting, rahul.repliesToday, rahul.slots, rahul.movedToManager], [true, 5, 4, 2, 8, [3, 0, 5], 1], 'a slot outside today is not counted');
    deq([sunny.lead, sunny.onDuty, sunny.seenMin, sunny.repliesToday], [true, false, 50, 1], 'away 50 min');
    deq([anurag.onDuty, anurag.seenMin, anurag.held, anurag.slots], [false, null, 0, [0, 0, 0]], 'not in today');
    eq(S.args.replies.p[1], new Date(IST(12, 10)).toISOString(), 'counted from 10:00 today');
  });
  await t('panel scope: a Manager of one panel sees the members who may work there and that panel\'s numbers only', async () => {
    S.team[0].businessIds = ['P1'];
    const r = await live.loadTeamLive(['P2'], IST(12, 12));
    deq(r.members.map((m) => m.name), ['Sunny', 'Anurag']);
    for (const k of ['held', 'replies', 'moved', 'ai', 'counts', 'marks']) deq(S.args[k].p[0], ['P2'], k);
    ok(/s\.tracker_business_id::text = ANY\(\$1::text\[\]\)/.test(S.args.held.q));
  });
  await t('Chikki: replies per half hour (not the WhatsApp fixed reply, not held drafts), chats alone, handed to the team, its marks, and whether it answers', async () => {
    S.ai = [{ slot: 0, n: 12 }, { slot: 1, n: 4 }];
    S.counts = { alone: 9, handed: 3 }; S.marks = 2;
    health = { ok: false, reason: 'credits' };
    const r = await live.loadTeamLive(null, IST(12, 10, 40));
    deq(r.chikki, { ok: false, reason: 'credits', text: 'OpenRouter credits ran out', repliesToday: 16, slots: [12, 4], aloneToday: 9, handedToday: 3, autoMarksToday: 2 });
    ok(/wa_auto_reply/.test(S.args.ai.q) && /withheld/.test(S.args.ai.q) && /m\.deleted_at IS NULL/.test(S.args.ai.q));
    ok(/e\.to_status = 'human_needed' AND e\.actor IN \('ai', 'system'\)/.test(S.args.counts.q));
    ok(/e\.action = 'mark' AND e\.actor_role = 'system'/.test(S.args.marks.q));
  });
  await t('a missing table or a failed read zeroes only its own part; the board always answers', async () => {
    S.held = [{ k: 'u-rahul', held: 4, waiting: 2 }];
    S.fail = { replies: '42P01', counts: 'XX000' };
    S.ai = [{ slot: 0, n: 2 }];
    const r = await live.loadTeamLive(null, IST(12, 10, 10));
    const rahul = r.members.find((m) => m.name === 'Rahul');
    deq([rahul.held, rahul.repliesToday, r.chikki.repliesToday, r.chikki.aloneToday], [4, 0, 2, 0]);
  });
  await t('the route: the Manager and the Super Admin only; the list route gives the Manager his Open cases; the inbox wires the tabs', () => {
    const route = fs.readFileSync(path.join(SRC, 'app/api/chat/team/live/route.ts'), 'utf8');
    ok(/if \(!isTeamLead\(user\)\) return NextResponse\.json\(\{ error: [^}]+\}, \{ status: 403 \}\)/.test(route));
    ok(/loadTeamLive\(panelScope\(user\)\)/.test(route));
    const list = fs.readFileSync(path.join(SRC, 'app/api/chat/conversations/route.ts'), 'utf8');
    ok(/const leadOpen = searchParams\.get\('lead'\) === 'open' && isTeamLead\(user\);/.test(list));
    const side = fs.readFileSync(path.join(SRC, 'app/admin/chat/_components/InboxSidebar.tsx'), 'utf8');
    ok(/title: 'Manager'/.test(side) && /'lead:open'/.test(side) && /'lead:team'/.test(side) && /canChargebacks\(user\)/.test(side));
    const page = fs.readFileSync(path.join(SRC, 'app/admin/chat/page.tsx'), 'utf8');
    ok(/else if \(!isSuperAdmin\(me\)\) setTab\('lead:open'\);/.test(page), 'the Manager opens on Open cases');
  });

  console.log(`TEAM-LIVE: ${pass} groups passed${fail ? `, ${fail} FAILED` : ''}`);
  process.exit(fail ? 1 : 0);
})();
