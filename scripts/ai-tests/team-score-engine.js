// Team score, part 4 (owner, 2026-10-01): the pure engine (src/lib/team-score/engine.ts) on synthetic
// chats. No database, no model. Every case builds a ScoreInput the way load.ts would and checks the
// exact items (kind, person, time, points, counted / pending, the "why" sentence) and the day counts.
//   E1-E12   pickups, the 10-minute reply, the 2-hour clock, presence
//   E13-E19  thank-you and convinced
//   E20-E24  solved and closed-while-waiting
//   E25-E26  stayed angry and still frustrated
//   E27-E35  events, attribution, points, ranking, determinism, speed, gates
//   X1-X16   the edge cases of spec section 6 that the E rows do not cover
//   X19-X21  owner answers 2026-10-02: verified-only thanks / convinced (A3), points from the
//            install day (A4), closed-while-waiting -2 and convinced +2 (A2)
//   E17b E19b E19c E22b X7b E30c  review fixes 2026-10-02: polite "ok thank u" after a holding
//            line, one convinced per turnaround (the complaint before the answer), closing a waiting
//            chat with no team reply, a courtesy nudge keeps the clock, range parts when weights change
//   E19d     review 2026-10-02 (second pass): "ok thank u" to a holding line after a complaint is not
//            convinced (shown not counted, convinced_not_counted), and does not use the complaint up
//   E19e E19f  review 2026-10-02 (third pass): a later holding line + "ok", or a later new question,
//            never takes back a convinced already earned that day (S7), nor across days (S1b); a later
//            complaint does
//   E17c E19g E19h E19i  fourth pass: "ok thanks" after a holding line with a fact (mixed: S2, the 12
//            lines of the check) goes to the AI, after a pure one it is not counted; only a new question
//            or request that is not a rejection falls back to an earlier acceptance; a complaint in ANY
//            of the customer's chats takes it back; a mixed holding line in S7, and across days
//   E17d E19j E19k E19l E32b  fifth pass (lead design v5): the pure / mixed battery in the engine; a
//            question with push-back is the last word (B); a complaint in any chat after the acceptance
//            takes it back on every path (C); one linear walk back, 2,000 questions under 300 ms (D);
//            "ai_failed" on an "ok" to a mixed line never replaces a +2 already earned (E)
// TEAM_SCORE_JS_DIR (set by team-score-mutate.js only) loads already compiled, mutated modules.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), crypto = require('crypto');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '../..');
const SRC = {
  'office-hours': 'src/lib/office-hours.ts', 'health-rules': 'src/lib/chat/health-rules.ts',
  escalation: 'src/lib/chat/escalation.ts', waiting: 'src/lib/chat/waiting.ts',
  types: 'src/lib/team-score/types.ts', clock: 'src/lib/team-score/clock.ts', words: 'src/lib/team-score/words.ts',
  rules: 'src/lib/team-score/rules.ts', engine: 'src/lib/team-score/engine.ts',
};
let dir = process.env.TEAM_SCORE_JS_DIR;
if (!dir) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-score-engine-'));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
  for (const [name, rel] of Object.entries(SRC)) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
      .replace(/'@\/lib\/office-hours'/g, "'./office-hours'").replace(/'@\/lib\/chat\/([\w-]+)'/g, "'./$1'");
    fs.writeFileSync(path.join(dir, name + '.js'), ts.transpileModule(src, { compilerOptions: { module: 'commonjs', target: 'es2020' } }).outputText);
  }
}
const load = (name) => require(path.join(dir, name + '.js'));
const E = load('engine'), clock = load('clock'), rules = load('rules'), waiting = load('waiting');

let n = 0;
const failed = [];
const t = (name, fn) => {
  try { fn(); n++; } catch (e) { failed.push(name); console.log(`FAIL ${name}: ${String(e && e.message).split('\n')[0].slice(0, 300)}`); }
};
const ist = (s) => Date.parse(s.replace(' ', 'T') + ':00+05:30');
const D0 = '2026-10-04', D = '2026-10-05', D1 = '2026-10-06', D2 = '2026-10-07';
const A = '11111111-1111-4111-8111-111111111111';   // Anurag, junior
const R = '22222222-2222-4222-8222-222222222222';   // Rahul, senior
const V = '33333333-3333-4333-8333-333333333333';   // Ravi, switched off
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const NOREPLY = new RegExp(waiting.NO_REPLY_NEEDED_REGEX.replace(/\[:space:\]/g, '\\s'), 'i');
const DEFAULT_SETTINGS = [{ id: 1, weights: rules.DEFAULT_WEIGHTS, effectiveFrom: '2026-01-01', pointsFrom: '2026-10-03', createdAt: 0 }];

// One synthetic ScoreInput, built like load.ts: window = 3 days before the first day to
// min(last day + 1 day + 24 h, now). Anurag and Rahul are first seen at 09:55 every day (their
// clock starts at 10:00) unless a case changes it.
function fx(opts = {}) {
  const days = opts.days || [D];
  const nowMs = opts.now !== undefined ? ist(opts.now) : ist(days.length > 1 ? '2026-10-09 23:00' : '2026-10-07 23:00');
  const DAY = 86_400_000;
  const inp = {
    days, nowMs,
    loadStartMs: clock.dayStartMs(days[0]) - 3 * DAY,
    loadEndMs: Math.min(clock.dayStartMs(days[days.length - 1]) + DAY + rules.SOLVED_QUIET_MS, nowMs),
    eventsSinceMs: opts.eventsSince === undefined ? ist('2026-10-01 20:42') : opts.eventsSince === null ? null : ist(opts.eventsSince),
    installedMs: ist('2026-10-02 12:00'),
    people: [
      { key: A, name: 'Anurag', tier: 'junior', active: true, canReply: true, logins: ['anurag'] },
      { key: R, name: 'Rahul', tier: 'senior', active: true, canReply: true, logins: ['rahul'] },
      { key: 'owner', name: 'Super Admin', tier: 'owner', active: true, canReply: true, logins: ['boss'] },
      { key: V, name: 'Ravi', tier: 'junior', active: false, canReply: true, logins: ['ravi'] },
    ],
    convs: [], msgs: [], holders: [], statuses: [], cases: [], actions: [], health: [], presence: [],
    verdicts: {}, settings: opts.settings || DEFAULT_SETTINGS,
  };
  if (opts.presence !== false) {
    for (const d of ['2026-10-01', '2026-10-02', '2026-10-03', D0, D, D1, D2, '2026-10-08', '2026-10-09']) {
      for (const k of [A, R]) inp.presence.push({ actor: k, day: d, first: ist(d + ' 09:55'), last: ist(d + ' 19:00') });
    }
  }
  let mid = 0, hid = 0, sid = 0, aid = 0;
  const b = {
    inp,
    conv(id, o = {}) {
      const known = o.known ?? true;
      inp.convs.push(Object.assign({ id, cu: (known ? 'k' : 'c') + md5(o.cuKey || id), source: 'chat', known, status: 'agent_handling',
        mergedInto: null, assignedTo: null, assignedAt: null, caseNow: false }, o));
      delete inp.convs[inp.convs.length - 1].cuKey;
      return b;
    },
    v(conv, at, text, o = {}) {
      const id = o.id || `m${String(++mid).padStart(3, '0')}`;
      inp.msgs.push({ id, conv, sender: 'visitor', at: ist(at), text, aiNotAnswer: false, noReply: NOREPLY.test(text), login: null, eventActor: null });
      return id;
    },
    ag(conv, at, text, who, o = {}) {
      const id = o.id || `m${String(++mid).padStart(3, '0')}`;
      inp.msgs.push({ id, conv, sender: 'agent', at: ist(at), text, aiNotAnswer: false, noReply: false,
        login: o.login !== undefined ? o.login : (who === 'owner' ? 'boss' : who === A ? 'anurag' : who === R ? 'rahul' : null),
        eventActor: o.eventActor !== undefined ? o.eventActor : who });
      return id;
    },
    ai(conv, at, notAnswer = false) {
      const id = `m${String(++mid).padStart(3, '0')}`;
      inp.msgs.push({ id, conv, sender: 'ai', at: ist(at), text: '', aiNotAnswer: notAnswer, noReply: false, login: null, eventActor: null });
      return id;
    },
    hold(conv, at, from, to) { inp.holders.push({ id: ++hid, conv, at: ist(at), from, to }); return b; },
    st(conv, at, from, to, reason, actor) { inp.statuses.push({ id: ++sid, conv, at: ist(at), from, to, reason, actor }); return b; },
    act(conv, at, kind, actor, o = {}) {
      inp.actions.push(Object.assign({ id: ++aid, conv, at: ist(at), kind, actor, actorName: null, from: null, to: null, reason: null,
        take: null, bulk: false, note: null }, o));
      return b;
    },
    cs(conv, at, action) { inp.cases.push({ conv, at: ist(at), action }); return b; },
    hl(conv, at, score) { inp.health.push({ conv, at: ist(at), score }); return b; },
    run() { return E.buildTeamScore(inp); },
  };
  return b;
}
const dayOf = (res, day) => { const d = res.days.find((x) => x.day === day); assert.ok(d, `day ${day} missing`); return d; };
const its = (res, day, actor, kind) => dayOf(res, day).items.filter((i) => (!actor || i.actor === actor) && (!kind || i.kind === kind));
const one = (res, day, actor, kind) => { const x = its(res, day, actor, kind); assert.strictEqual(x.length, 1, `${kind} for ${actor} on ${day}: ${x.length}`); return x[0]; };
const none = (res, day, actor, kind) => assert.strictEqual(its(res, day, actor, kind).length, 0, `${kind} for ${actor} on ${day}`);
const pd = (res, day, key) => dayOf(res, day).people.find((p) => p.key === key);
const kinds = (res, day, actor) => its(res, day, actor).map((i) => i.kind);
// A chat Anurag has held since the day before, in With team (agent_handling).
const heldByA = (f, conv = 'c1', who = A, at = '2026-10-04 12:00') => { f.conv(conv); f.hold(conv, at, null, who); return f; };

// ── Pickups, the 2-hour clock and presence ─────────────────────
t('E1 first reply from the open pool: picked, +1 fast reply, one chat', () => {
  const f = fx(); f.conv('c1');
  f.st('c1', '2026-10-05 13:59', 'ai_handling', 'human_needed', 'handover', 'ai');
  const q = f.v('c1', '2026-10-05 14:00', 'mera order kab aayega');
  f.hold('c1', '2026-10-05 14:06', null, A); f.act('c1', '2026-10-05 14:06', 'claim', A, { reason: 'reply', to: A });
  f.st('c1', '2026-10-05 14:06', 'human_needed', 'agent_handling', 'reply', A);
  const rep = f.ag('c1', '2026-10-05 14:06', 'Aapka order kal deliver ho jayega', A);
  const r = f.run();
  assert.deepStrictEqual(kinds(r, D, A), ['chat', 'fast_reply', 'picked']);
  const p = one(r, D, A, 'picked');
  assert.deepStrictEqual([p.peer, p.why, p.points], [null, 'Picked from the open pool (first reply).', 0]);
  const fr = one(r, D, A, 'fast_reply');
  assert.deepStrictEqual([fr.at, fr.points, fr.counted, fr.pending, fr.msgs], [ist('2026-10-05 14:06'), 1, true, false, [rep, q]]);
  assert.strictEqual(fr.why, 'Anurag took the chat at 14:06 (from the open pool) while the customer waited; first real reply at 14:06: 0 office min.');
  const ch = one(r, D, A, 'chat');
  assert.deepStrictEqual([ch.n, ch.after, ch.points, ch.msgs], [1, 0, 0, [rep]]);
  const c = pd(r, D, A).counts;
  assert.deepStrictEqual([c.replies, c.chats, c.customers, c.picked, c.picked_pool, c.picked_take, c.fast_reply, c.unanswered_2h, c.taken_no_reply],
    [1, 1, 1, 1, 1, 0, 1, 0, 0]);
  assert.strictEqual(pd(r, D, A).points, 1);
  assert.deepStrictEqual(pd(r, D, A).parts.fast_reply, { n: 1, each: 1, points: 1 });
  assert.deepStrictEqual(pd(r, D, A).cus, [r.days[0].items.find((i) => i.kind === 'chat').cu]);
});
t('E2 Take over 14:00 on a customer waiting since 13:50: reply at 14:09 / 14:10 +1, at 14:11 nothing', () => {
  for (const [rep, exp] of [['14:09', 1], ['14:10', 1], ['14:11', 0]]) {
    const f = fx(); f.conv('c1', { status: 'agent_handling' });
    f.st('c1', '2026-10-05 13:49', 'ai_handling', 'human_needed', 'handover', 'ai');
    f.v('c1', '2026-10-05 13:50', 'mera order kab aayega');
    f.hold('c1', '2026-10-05 14:00', null, A); f.act('c1', '2026-10-05 14:00', 'claim', A, { reason: 'take_over', to: A });
    f.st('c1', '2026-10-05 14:00', 'human_needed', 'agent_handling', 'take_over', A);
    f.ag('c1', `2026-10-05 ${rep}`, 'Aapka order kal deliver ho jayega', A);
    const r = f.run();
    assert.strictEqual(its(r, D, A, 'fast_reply').length, exp, rep);
    assert.strictEqual(one(r, D, A, 'picked').why, 'Picked from the open pool (Take over).');
    if (exp) assert.ok(one(r, D, A, 'fast_reply').why.endsWith(`first real reply at ${rep}: ${Number(rep.slice(3)) - 0} office min.`));
  }
});
t('E3 Take at 19:25, reply 10:04 next day: +1 on 6 Oct (9 office min)', () => {
  const f = fx({ days: [D, D1] }); f.conv('c1');
  f.hold('c1', '2026-10-05 09:00', null, R);
  f.v('c1', '2026-10-05 19:20', 'where is my order please tell');
  f.hold('c1', '2026-10-05 19:25', R, A); f.act('c1', '2026-10-05 19:25', 'take', A, { from: R, to: A, take: 'holder_away' });
  f.ag('c1', '2026-10-06 10:04', 'It is in transit, arriving 8 Oct', A);
  const r = f.run();
  const fr = one(r, D1, A, 'fast_reply');
  assert.deepStrictEqual([fr.day, fr.at, fr.points], [D1, ist('2026-10-06 10:04'), 1]);
  assert.strictEqual(fr.why, 'Anurag took the chat at 5 Oct 19:25 (from Rahul) while the customer waited; first real reply at 10:04: 9 office min.');
  none(r, D, A, 'fast_reply');
  const p = one(r, D, A, 'picked');
  assert.deepStrictEqual([p.peer, p.why], [R, 'Took it from Rahul (Rahul was away).']);
  assert.strictEqual(pd(r, D, A).counts.picked_take, 1);
  assert.strictEqual(one(r, D, R, 'taken_from').peer, A);
});
t('E4 held chat, customer 11:00, no reply all day: -3 at 13:00, taken-no-reply at 11:30', () => {
  const f = heldByA(fx());
  const q = f.v('c1', '2026-10-05 11:00', 'mera order kab aayega bhai');
  const r = f.run();
  const u = one(r, D, A, 'unanswered_2h');
  assert.deepStrictEqual([u.at, u.points, u.counted, u.pending, u.msgs], [ist('2026-10-05 13:00'), -3, true, false, [q]]);
  assert.strictEqual(u.why, 'Customer waiting since 11:00 (no reply yet). Anurag held the chat from 4 Oct 12:00. 2 office hours passed at 13:00 with no reply.');
  const tn = one(r, D, A, 'taken_no_reply');
  assert.deepStrictEqual([tn.at, tn.points, tn.counted], [ist('2026-10-05 11:30'), 0, true]);
  assert.strictEqual(tn.why, 'Anurag held this chat from 4 Oct 12:00; the customer waited 510 office min and Anurag sent no reply.');
  assert.deepStrictEqual([pd(r, D, A).counts.unanswered_2h, pd(r, D, A).counts.taken_no_reply, pd(r, D, A).points], [1, 1, -3]);
  assert.deepStrictEqual(pd(r, D, A).parts.unanswered_2h, { n: 1, each: -3, points: -3 });
  // Same day hold: the sentence is exactly the spec's template.
  const g = fx(); g.conv('c1'); g.hold('c1', '2026-10-05 10:30', null, A); g.v('c1', '2026-10-05 11:00', 'mera order kab aayega bhai');
  assert.strictEqual(one(g.run(), D, A, 'unanswered_2h').why,
    'Customer waiting since 11:00 (no reply yet). Anurag held the chat from 10:30. 2 office hours passed at 13:00 with no reply.');
});
t('E4b the Super Admin answers at 12:59: no minus for Anurag, the reply is the owner\'s', () => {
  const f = heldByA(fx());
  f.v('c1', '2026-10-05 11:00', 'mera order kab aayega bhai');
  f.ag('c1', '2026-10-05 12:59', 'Kal aa jayega, courier ne confirm kiya', 'owner');
  const r = f.run();
  none(r, D, A, 'unanswered_2h');
  assert.strictEqual(pd(r, D, A).points, 0);
  assert.strictEqual(one(r, D, 'owner', 'chat').n, 1);
  assert.strictEqual(pd(r, D, 'owner').counts.replies, 1);
  // Info only (0 points), spec 3.5.2: Anurag held it and sent no reply himself while the customer waited 119 min.
  assert.deepStrictEqual(kinds(r, D, A), ['taken_no_reply']);
  const tn = one(r, D, A, 'taken_no_reply');
  assert.deepStrictEqual([tn.at, tn.points], [ist('2026-10-05 11:30'), 0]);
  assert.ok(tn.why.includes('the customer waited 119 office min'), tn.why);
});
t('E5 customer at 18:50: nothing on the day (40 min), -3 next day at 11:20; not in that day: none, team line', () => {
  const f = heldByA(fx({ days: [D, D1] }));
  f.v('c1', '2026-10-05 18:50', 'mera order kab aayega bhai');
  let r = f.run();
  none(r, D, A, 'unanswered_2h');
  const u = one(r, D1, A, 'unanswered_2h');
  assert.strictEqual(u.at, ist('2026-10-06 11:20'));
  assert.strictEqual(u.why, 'Customer waiting since 5 Oct 18:50 (no reply yet). Anurag held the chat from 4 Oct 12:00. 2 office hours passed at 11:20 with no reply.');
  assert.deepStrictEqual([dayOf(r, D).team.absent_waits, dayOf(r, D1).team.absent_waits], [0, 0]);
  f.inp.presence = f.inp.presence.filter((p) => !(p.actor === A && p.day === D1));
  r = f.run();
  none(r, D1, A, 'unanswered_2h');
  none(r, D1, A, 'taken_no_reply');
  assert.deepStrictEqual([dayOf(r, D).team.absent_waits, dayOf(r, D1).team.absent_waits], [0, 1]);
});
t('E6 still unanswered next days: another -3 at 12:00 each day, not at 10:00', () => {
  const f = heldByA(fx({ days: [D, D1, D2], now: '2026-10-09 12:00' }));
  f.v('c1', '2026-10-05 11:00', 'mera order kab aayega bhai');
  const r = f.run();
  assert.strictEqual(one(r, D, A, 'unanswered_2h').at, ist('2026-10-05 13:00'));
  const u = one(r, D1, A, 'unanswered_2h');
  assert.deepStrictEqual([u.at, u.points], [ist('2026-10-06 12:00'), -3]);
  assert.strictEqual(u.why, 'Still waiting from 5 Oct 11:00: another 2 office hours today at 12:00.');
  assert.strictEqual(one(r, D2, A, 'unanswered_2h').at, ist('2026-10-07 12:00'));
});
t('E7 transfer to Rahul at 12:00: Anurag nothing (60 min), Rahul -3 at 14:00, sent / received', () => {
  const f = heldByA(fx());
  f.v('c1', '2026-10-05 11:00', 'mera order kab aayega bhai');
  f.hold('c1', '2026-10-05 12:00', A, R); f.act('c1', '2026-10-05 12:00', 'transfer', A, { from: A, to: R, note: 'please check courier' });
  const r = f.run();
  none(r, D, A, 'unanswered_2h');
  const u = one(r, D, R, 'unanswered_2h');
  assert.strictEqual(u.at, ist('2026-10-05 14:00'));
  assert.strictEqual(u.why, 'Customer waiting since 11:00 (no reply yet). Rahul held the chat from 12:00. 2 office hours passed at 14:00 with no reply.');
  const s = one(r, D, A, 'sent');
  assert.deepStrictEqual([s.peer, s.note, s.why], [R, 'please check courier', 'Sent to Rahul.']);
  assert.deepStrictEqual(pd(r, D, A).counts.sent_to, [{ key: R, name: 'Rahul', n: 1 }]);
  assert.strictEqual(one(r, D, R, 'received').peer, A);
  assert.strictEqual(pd(r, D, R).counts.received, 1);
  none(r, D, R, 'fast_reply');
});
t('E8 ping-pong A 11:00-11:59, R 11:59-12:30, A again: A -3 at 13:31 (no reset), R none', () => {
  const f = heldByA(fx());
  f.v('c1', '2026-10-05 11:00', 'mera order kab aayega bhai');
  f.hold('c1', '2026-10-05 11:59', A, R); f.hold('c1', '2026-10-05 12:30', R, A);
  const r = f.run();
  const u = one(r, D, A, 'unanswered_2h');
  assert.strictEqual(u.at, ist('2026-10-05 13:31'));
  assert.ok(u.why.includes('Anurag held the chat from 12:30.'), u.why);
  none(r, D, R, 'unanswered_2h');
  assert.strictEqual(pd(r, D, R).points, 0);
});
t('E9 Hand to AI at 11:30 pauses the clock; back to the team at 15:00: -3 at 16:30', () => {
  const f = heldByA(fx());
  f.v('c1', '2026-10-05 11:00', 'mera order kab aayega bhai');
  f.st('c1', '2026-10-05 11:30', 'agent_handling', 'ai_handling', 'hand_to_ai', A);
  none(f.run(), D, A, 'unanswered_2h');
  f.st('c1', '2026-10-05 15:00', 'ai_handling', 'agent_handling', 'take_over', A);
  assert.strictEqual(one(f.run(), D, A, 'unanswered_2h').at, ist('2026-10-05 16:30'));
});
t('E10 Refund / Ship again marked 11:30, removed 15:00: paused between, -3 at 16:30', () => {
  const f = heldByA(fx());
  f.v('c1', '2026-10-05 11:00', 'mera order kab aayega bhai');
  f.cs('c1', '2026-10-05 11:30', 'mark').cs('c1', '2026-10-05 15:00', 'remove');
  assert.strictEqual(one(f.run(), D, A, 'unanswered_2h').at, ist('2026-10-05 16:30'));
  const g = heldByA(fx()); g.v('c1', '2026-10-05 11:00', 'mera order kab aayega bhai'); g.cs('c1', '2026-10-05 11:20', 'mark');
  g.inp.convs[0].caseNow = true;
  const r = g.run();
  none(r, D, A, 'unanswered_2h');
  none(r, D, A, 'taken_no_reply');
});
t('E11 held by a switched-off member: nothing for him, the team line counts an open-pool wait', () => {
  const f = heldByA(fx(), 'c1', V);
  f.v('c1', '2026-10-05 11:00', 'mera order kab aayega bhai');
  const r = f.run();
  assert.strictEqual(its(r, D, V).length, 0);
  assert.strictEqual(pd(r, D, V), undefined);
  assert.strictEqual(dayOf(r, D).team.pool_waited_2h, 1);
  assert.strictEqual(dayOf(r, D).team.absent_waits, 0);
});
t('E12 arrives at 14:02, chat inherited at 09:00: -3 at 16:02', () => {
  const f = fx(); f.conv('c1');
  f.hold('c1', '2026-10-05 09:00', null, A);
  f.v('c1', '2026-10-05 09:00', 'mera order kab aayega bhai');
  f.inp.presence = f.inp.presence.map((p) => (p.actor === A && p.day === D ? { ...p, first: ist('2026-10-05 14:02') } : p));
  const u = one(f.run(), D, A, 'unanswered_2h');
  assert.strictEqual(u.at, ist('2026-10-05 16:02'));
  assert.strictEqual(u.why, 'Customer waiting since 09:00 (no reply yet). Anurag held the chat from 09:00. 2 office hours passed at 16:02 with no reply.');
});

// ── Thank-you and convinced ────────────────────────────────────
t('E13 thanks +3 (keyword); the same customer again that day (any chat): not counted', () => {
  const f = heldByA(fx()); f.conv('c2', { cuKey: 'c1' });
  f.v('c1', '2026-10-05 12:55', 'order kab aayega');
  const rep = f.ag('c1', '2026-10-05 13:00', 'Your order arrives on 7 Oct', A);
  const m1 = f.v('c1', '2026-10-05 16:00', 'thank you so much');
  f.v('c1', '2026-10-05 16:30', 'thanks');
  f.ag('c2', '2026-10-05 17:00', 'Your second order also arrives on 7 Oct', A);
  f.v('c2', '2026-10-05 17:05', 'Thank you!');
  const r = f.run();
  const th = its(r, D, A, 'thanks');
  assert.strictEqual(th.length, 3);
  assert.deepStrictEqual([th[0].counted, th[0].points, th[0].by, th[0].msgs], [true, 3, 'keyword', [rep, m1]]);
  assert.strictEqual(th[0].why, "Customer said thanks at 16:00, 180 min after Anurag's reply (keyword check).");
  for (const x of th.slice(1)) assert.deepStrictEqual([x.counted, x.pending, x.points, x.why], [false, false, 0, 'Same customer already counted today']);
  const c = pd(r, D, A).counts;
  assert.deepStrictEqual([c.thanks, c.thanks_not_counted, c.thanks_pending], [1, 2, 0]);
  assert.deepStrictEqual(pd(r, D, A).parts.thanks, { n: 1, each: 3, points: 3 });
});
t('E14 an AI answer in between: the thanks is the AI\'s (team line); an AI "busy" line is skipped', () => {
  for (const [notAnswer, expA, expAi] of [[false, 0, 1], [true, 1, 0]]) {
    const f = heldByA(fx());
    f.v('c1', '2026-10-05 12:55', 'order kab aayega');
    f.ag('c1', '2026-10-05 13:00', 'Your order arrives on 7 Oct', A);
    f.ai('c1', '2026-10-05 13:30', notAnswer);
    f.v('c1', '2026-10-05 16:00', 'thank you so much');
    const r = f.run();
    assert.strictEqual(its(r, D, A, 'thanks').filter((i) => i.counted).length, expA, String(notAnswer));
    assert.strictEqual(dayOf(r, D).team.thanks_after_ai, expAi);
    if (expAi) {
      const x = one(r, D, 'ai', 'thanks');
      assert.deepStrictEqual([x.counted, x.points, x.by], [true, 0, 'keyword']);
      assert.strictEqual(r.candidates.length, 0);
    }
  }
  // An unsure thanks after an AI answer is never sent to the model.
  const g = heldByA(fx()); g.ai('c1', '2026-10-05 13:30'); g.v('c1', '2026-10-05 14:00', 'thanks but kab aayega?');
  const rg = g.run();
  assert.deepStrictEqual([rg.candidates.length, dayOf(rg, D).team.thanks_after_ai, dayOf(rg, D).aiPending], [0, 0, 0]);
});
t('E15 thanks 25 hours after the reply: no item', () => {
  const f = heldByA(fx({ days: [D, D1] }));
  f.ag('c1', '2026-10-05 13:00', 'Your order arrives on 7 Oct', A);
  f.v('c1', '2026-10-06 14:00', 'thank you so much');
  const r = f.run();
  assert.strictEqual(dayOf(r, D1).items.filter((i) => i.kind === 'thanks').length, 0);
  f.inp.msgs[1].at = ist('2026-10-06 12:59');   // 23 h 59 min: counted
  assert.strictEqual(one(f.run(), D1, A, 'thanks').counted, true);
});
t('E16 the member asked for a thank-you 10 minutes before: not counted, asked_thanks 1', () => {
  const f = heldByA(fx());
  f.ag('c1', '2026-10-05 15:50', 'Order kal aayega. agar help hui ho to thank you bol dena', A);
  f.v('c1', '2026-10-05 16:00', 'thank you');
  const r = f.run();
  const th = one(r, D, A, 'thanks');
  assert.deepStrictEqual([th.counted, th.pending, th.points, th.why], [false, false, 0, 'Asked the customer to say thanks at 15:50']);
  assert.deepStrictEqual([pd(r, D, A).counts.asked_thanks, pd(r, D, A).counts.thanks, pd(r, D, A).points], [1, 0, 0]);
  // The ask in an earlier reply (within 24 h) counts too; one by someone else does not.
  const g = heldByA(fx());
  g.ag('c1', '2026-10-05 11:00', 'Please rate us 5 stars', A);
  g.ag('c1', '2026-10-05 15:50', 'Order kal aayega', A);
  g.v('c1', '2026-10-05 16:00', 'thank you');
  assert.strictEqual(one(g.run(), D, A, 'thanks').why, 'Asked the customer to say thanks at 11:00');
  const h = heldByA(fx());
  h.ag('c1', '2026-10-05 11:00', 'Please rate us 5 stars', R);
  h.ag('c1', '2026-10-05 15:50', 'Order kal aayega', A);
  h.v('c1', '2026-10-05 16:00', 'thank you');
  assert.strictEqual(one(h.run(), D, A, 'thanks').counted, true);
});
t('E17 a holding reply, then "ok thanks": not counted (still waiting for the answer)', () => {
  const f = heldByA(fx());
  f.ag('c1', '2026-10-05 15:50', 'We will check and update you', A);
  f.v('c1', '2026-10-05 16:00', 'ok thanks');
  const r = f.run();
  const th = one(r, D, A, 'thanks');
  assert.deepStrictEqual([th.counted, th.why], [false, 'Polite "ok thanks" while still waiting for the answer']);
  assert.strictEqual(pd(r, D, A).counts.thanks_not_counted, 1);
  // After a real answer the same words count.
  const g = heldByA(fx()); g.ag('c1', '2026-10-05 15:50', 'Your order arrives on 7 Oct', A); g.v('c1', '2026-10-05 16:00', 'ok thanks');
  assert.strictEqual(one(g.run(), D, A, 'thanks').counted, true);
});
t('E17b "ok thank u" / "ok thanku" / "ok thnx" / "ok tq" / "ok thanks bhaiya" after a holding line: not counted; after a real answer they count', () => {
  for (const ack of ['ok thank u', 'ok thanku', 'ok thnx', 'ok tq', 'ok thanks bhaiya', 'ok sir thank u']) {
    const f = heldByA(fx());
    f.ag('c1', '2026-10-05 15:50', 'check karke batata hu', A);
    f.v('c1', '2026-10-05 16:00', ack);
    const th = one(f.run(), D, A, 'thanks');
    assert.deepStrictEqual([th.counted, th.points, th.why], [false, 0, 'Polite "ok thanks" while still waiting for the answer'], ack);
    const g = heldByA(fx()); g.ag('c1', '2026-10-05 15:50', 'Your order arrives on 7 Oct', A); g.v('c1', '2026-10-05 16:00', ack);
    assert.deepStrictEqual([one(g.run(), D, A, 'thanks').counted, one(g.run(), D, A, 'thanks').points], [true, 3], ack);
  }
  // More holding lines; a thank-you that says the problem is over still counts after one.
  for (const hold of ['Dekhta hu', 'ruko check kar raha hu', 'Checking, ek minute']) {
    const f = heldByA(fx()); f.ag('c1', '2026-10-05 15:50', hold, A); f.v('c1', '2026-10-05 16:00', 'ok thanks');
    assert.strictEqual(one(f.run(), D, A, 'thanks').counted, false, hold);
  }
  const k = heldByA(fx()); k.ag('c1', '2026-10-05 15:50', 'check karke batata hu', A); k.v('c1', '2026-10-05 16:00', 'thank you so much mil gaya');
  assert.deepStrictEqual([one(k.run(), D, A, 'thanks').counted, one(k.run(), D, A, 'thanks').points], [true, 3]);
});
// The 12 lines of the third-pass check: 'pure' = not counted (keywords), 'mixed' = the AI decides.
const CHECK12 = [
  ['pure', 'Please wait while I check your order'], ['pure', 'please wait, checking your order'], ['pure', 'Kindly wait, we are looking into it'],
  ['pure', 'Please wait a moment while we check the status'], ['pure', 'please wait for some time'],
  ['mixed', 'Let me check if your refund has been initiated'], ['mixed', 'We will update you once it is dispatched'],
  ['mixed', "I'll check if it is delivered and update you"], ['mixed', 'Let me confirm whether the refund is processed'],
  ['mixed', 'Kal tak confirm karke batata hu delivery kab hogi'], ['mixed', 'We will update you within 2 days'], ['mixed', "I'll share the tracking link shortly"],
];
const PENDING_WHY = 'Waiting for the AI check (the keywords could not decide)';
const POLITE_WHY = 'Polite "ok thanks" while still waiting for the answer';
t('E17c S2 and the 12 lines: "ok thanks" after a holding line with a fact goes to the AI (pending, 0 points; a saved verdict decides), after a pure one it is not counted', () => {
  // S2: complaint, "Aapka refund process ho gaya hai, please wait 5-7 working days", "ok thank you".
  const S2 = 'Aapka refund process ho gaya hai, please wait 5-7 working days';
  const s2 = (verdict) => {
    const f = heldByA(fx());
    const ids = {};
    ids.o = f.v('c1', '2026-10-05 11:00', 'refund kab milega, abhi tak nahi aaya');
    ids.rep = f.ag('c1', '2026-10-05 11:05', S2, A);
    ids.m = f.v('c1', '2026-10-05 11:06', 'ok thank you', { id: 'mS2' });
    if (verdict) f.inp.verdicts = { mS2: verdict };
    return { r: f.run(), ids };
  };
  let { r, ids } = s2(null);
  let th = one(r, D, A, 'thanks'), c = one(r, D, A, 'convinced');
  assert.deepStrictEqual([th.counted, th.pending, th.points, th.by, th.why, th.msgs], [false, true, 0, null, PENDING_WHY, [ids.rep, ids.m]]);
  assert.deepStrictEqual([c.counted, c.pending, c.points, c.by, c.why, c.msgs], [false, true, 0, null, PENDING_WHY, [ids.rep, ids.o, ids.m]]);
  assert.deepStrictEqual(r.candidates.map((k) => [k.messageId, k.teamText, k.customerText]), [[ids.m, S2, 'ok thank you']]);
  let pc = pd(r, D, A).counts;
  assert.deepStrictEqual([pc.thanks, pc.thanks_pending, pc.convinced, pc.convinced_pending], [0, 1, 0, 1]);
  assert.deepStrictEqual([pd(r, D, A).parts.thanks.points, pd(r, D, A).parts.convinced.points], [0, 0]);
  // The AI said thanks + convinced: C+3 and C+2, by the AI.
  ({ r, ids } = s2({ thanks: true, convinced: true, source: 'ai' }));
  th = one(r, D, A, 'thanks'); c = one(r, D, A, 'convinced');
  assert.deepStrictEqual([th.counted, th.pending, th.points, th.by, th.msgs], [true, false, 3, 'ai', [ids.rep, ids.m]]);
  assert.deepStrictEqual([c.counted, c.pending, c.points, c.by, c.msgs], [true, false, 2, 'ai', [ids.rep, ids.o, ids.m]]);
  assert.strictEqual(c.why, "Customer complained at 11:00; their last message at 11:06 accepts Anurag's answer.");
  assert.deepStrictEqual([pd(r, D, A).parts.thanks, pd(r, D, A).parts.convinced, r.candidates.length], [{ n: 1, each: 3, points: 3 }, { n: 1, each: 2, points: 2 }, 0]);
  // The AI said no to both (still waiting): nothing.
  ({ r } = s2({ thanks: false, convinced: false, source: 'ai' }));
  none(r, D, A, 'thanks'); none(r, D, A, 'convinced');
  assert.strictEqual(r.candidates.length, 0);
  // The 12 lines + complaint + "ok thanks": 0 points without a verdict; pure = not counted, mixed = pending (AI).
  for (const [kind, line] of CHECK12) {
    const f = heldByA(fx());
    f.v('c1', '2026-10-05 11:00', 'mera order abhi tak nahi aaya, refund chahiye');
    f.ag('c1', '2026-10-05 11:05', line, A);
    const m = f.v('c1', '2026-10-05 11:06', 'ok thanks');
    const rr = f.run();
    const tt = one(rr, D, A, 'thanks'), cc = one(rr, D, A, 'convinced');
    assert.deepStrictEqual([tt.counted, cc.counted, pd(rr, D, A).parts.thanks.points, pd(rr, D, A).parts.convinced.points], [false, false, 0, 0], line);
    if (kind === 'pure') {
      assert.deepStrictEqual([tt.pending, tt.why, cc.pending, cc.why, rr.candidates.length], [false, POLITE_WHY, false, E.HOLDING_ACK_WHY, 0], line);
    } else {
      assert.deepStrictEqual([tt.pending, cc.pending, rr.candidates.map((k) => k.messageId)], [true, true, [m]], line);
    }
  }
  // A short real answer with "ek minute" or "kar diya" in it is mixed: pending, not "not counted".
  for (const line of ['Haan size M available hai, ek minute', 'Refund kar diya hai, ek minute']) {
    const f = heldByA(fx());
    f.v('c1', '2026-10-05 11:00', 'mera order abhi tak nahi aaya, refund chahiye');
    f.ag('c1', '2026-10-05 11:05', line, A);
    const m = f.v('c1', '2026-10-05 11:06', 'ok thanks');
    const rr = f.run();
    assert.deepStrictEqual([one(rr, D, A, 'thanks').pending, one(rr, D, A, 'convinced').pending, rr.candidates.map((k) => k.messageId)], [true, true, [m]], line);
  }
  // A real short holding line: "ok thanks" after it is still not counted, for either rule, never asked of the AI.
  for (const hold of ['Ek minute, check karke batata hu', 'Please wait sir', 'एक मिनट, चेक करके बताता हूँ']) {
    const h = heldByA(fx());
    h.v('c1', '2026-10-05 11:00', 'refund kab milega, abhi tak nahi aaya');
    h.ag('c1', '2026-10-05 11:05', hold, A);
    h.v('c1', '2026-10-05 11:06', 'ok thanks');
    const rh = h.run();
    assert.deepStrictEqual([one(rh, D, A, 'thanks').counted, one(rh, D, A, 'thanks').why], [false, POLITE_WHY], hold);
    assert.deepStrictEqual([one(rh, D, A, 'convinced').counted, one(rh, D, A, 'convinced').why, rh.candidates.length], [false, E.HOLDING_ACK_WHY, 0], hold);
  }
  // A strong thank-you that states the result counts after either kind of holding line (keywords).
  for (const hold of ['check karke batata hu', 'Refund initiated, will update you']) {
    const k = heldByA(fx()); k.ag('c1', '2026-10-05 15:50', hold, A); k.v('c1', '2026-10-05 16:00', 'thank you so much mil gaya');
    const rk = k.run();
    assert.deepStrictEqual([one(rk, D, A, 'thanks').counted, one(rk, D, A, 'thanks').points, one(rk, D, A, 'thanks').by], [true, 3, 'keyword'], hold);
  }
  // Unverified visitor (A3): after a mixed line the unsure "ok thanks" is never sent to the AI and leaves no
  // item; a verdict already saved shows it as not verified. After a pure line: shown not verified, as before.
  const uv = (line, verdict) => {
    const f = fx(); f.conv('c1', { known: false }); f.hold('c1', '2026-10-04 12:00', null, A);
    f.v('c1', '2026-10-05 11:00', 'mera order abhi tak nahi aaya, refund chahiye');
    f.ag('c1', '2026-10-05 11:05', line, A);
    f.v('c1', '2026-10-05 11:06', 'ok thanks', { id: 'mU' });
    if (verdict) f.inp.verdicts = { mU: verdict };
    return f.run();
  };
  let ru = uv(S2);
  none(ru, D, A, 'thanks'); none(ru, D, A, 'convinced');
  assert.strictEqual(ru.candidates.length, 0);
  ru = uv(S2, { thanks: true, convinced: true, source: 'ai' });
  assert.deepStrictEqual([one(ru, D, A, 'thanks').counted, one(ru, D, A, 'thanks').by, one(ru, D, A, 'thanks').why], [false, 'ai', E.NOT_VERIFIED_WHY]);
  assert.deepStrictEqual([one(ru, D, A, 'convinced').counted, one(ru, D, A, 'convinced').by, one(ru, D, A, 'convinced').why], [false, 'ai', E.NOT_VERIFIED_WHY]);
  ru = uv('Please wait while I check your order');
  assert.deepStrictEqual([one(ru, D, A, 'thanks').counted, one(ru, D, A, 'thanks').by, one(ru, D, A, 'thanks').why, ru.candidates.length], [false, 'keyword', E.NOT_VERIFIED_WHY, 0]);
});
t('E18 "thanks but kab aayega?": AI pending -> AI yes counted / AI no nothing / AI failed not counted', () => {
  const mk = () => {
    const f = heldByA(fx());
    f.ag('c1', '2026-10-05 15:50', 'Order is in transit', A);
    f.v('c1', '2026-10-05 16:00', 'thanks but kab aayega?', { id: 'mX' });
    return f;
  };
  let r = mk().run();
  let th = one(r, D, A, 'thanks');
  assert.deepStrictEqual([th.pending, th.counted, th.points, th.by], [true, false, 0, null]);
  assert.deepStrictEqual(r.candidates, [{ messageId: 'mX', conv: 'c1', teamText: 'Order is in transit', customerText: 'thanks but kab aayega?' }]);
  assert.deepStrictEqual([dayOf(r, D).aiPending, pd(r, D, A).counts.thanks_pending, pd(r, D, A).counts.thanks], [1, 1, 0]);
  let f = mk(); f.inp.verdicts = { mX: { thanks: true, convinced: false, source: 'ai' } }; r = f.run();
  th = one(r, D, A, 'thanks');
  assert.deepStrictEqual([th.counted, th.by, th.points], [true, 'ai', 3]);
  assert.strictEqual(th.why, "Customer said thanks at 16:00, 10 min after Anurag's reply (AI check).");
  assert.deepStrictEqual([r.candidates.length, dayOf(r, D).aiPending], [0, 0]);
  f = mk(); f.inp.verdicts = { mX: { thanks: false, convinced: false, source: 'ai' } };
  none(f.run(), D, A, 'thanks');
  f = mk(); f.inp.verdicts = { mX: { thanks: null, convinced: null, source: 'ai_failed' } };
  th = one(f.run(), D, A, 'thanks');
  assert.deepStrictEqual([th.counted, th.pending, th.why], [false, false, 'AI could not decide']);
});
t('E19 "refund chahiye", answer, "theek hai main wait kar lungi": convinced 1 (+2, owner A2); no objection: none', () => {
  for (const [obj, exp] of [[true, 1], [false, 0]]) {
    const f = heldByA(fx());
    const o = f.v('c1', '2026-10-05 11:00', obj ? 'refund chahiye' : 'order kab aayega');
    const rep = f.ag('c1', '2026-10-05 11:10', 'Order 2 din me aa jayega, festive season hai', A);
    const m = f.v('c1', '2026-10-05 11:20', 'theek hai main wait kar lungi');
    const r = f.run();
    assert.strictEqual(its(r, D, A, 'convinced').length, exp);
    if (exp) {
      const c = one(r, D, A, 'convinced');
      assert.deepStrictEqual([c.counted, c.points, c.by, c.msgs], [true, 2, 'keyword', [rep, o, m]]);
      assert.deepStrictEqual(pd(r, D, A).parts.convinced, { n: 1, each: 2, points: 2 });
      assert.strictEqual(c.why, "Customer complained at 11:00; their last message at 11:20 accepts Anurag's answer.");
      assert.strictEqual(pd(r, D, A).counts.convinced, 1);
    }
  }
  // Unsure acceptance goes to the AI; a later complaint is the last word: no item.
  const g = heldByA(fx());
  g.v('c1', '2026-10-05 11:00', 'abhi tak nahi aaya');
  g.ag('c1', '2026-10-05 11:10', 'Courier delay hai, kal tak aa jayega', A);
  g.v('c1', '2026-10-05 11:20', 'Okay I will wait but please make sure it reaches by Monday as it is a gift?', { id: 'mC' });
  let r = g.run();
  assert.deepStrictEqual([one(r, D, A, 'convinced').pending, r.candidates.map((x) => x.messageId)], [true, ['mC']]);
  g.inp.verdicts = { mC: { thanks: false, convinced: true, source: 'ai' } };
  r = g.run();
  assert.deepStrictEqual([one(r, D, A, 'convinced').counted, one(r, D, A, 'convinced').by], [true, 'ai']);
  // The AI could not decide: not counted, and counted as such so the number opens (review 2026-10-02).
  g.inp.verdicts = { mC: { thanks: null, convinced: null, source: 'ai_failed' } };
  r = g.run();
  assert.deepStrictEqual([one(r, D, A, 'convinced').counted, one(r, D, A, 'convinced').why, pd(r, D, A).counts.convinced, pd(r, D, A).counts.convinced_not_counted],
    [false, 'AI could not decide', 0, 1]);
  g.v('c1', '2026-10-05 12:00', 'still not received, fraud');
  none(g.run(), D, A, 'convinced');
});

t('E19b one complaint is one turnaround: later days\' "ok thanks" pay no new convinced; a new complaint does', () => {
  // 4 Oct: complaint, Anurag's answer, accepted (+2). 5 and 6 Oct: routine questions, answered, "ok thanks" / "ok".
  const f = fx({ days: [D0, D, D1] }); f.conv('c1'); f.hold('c1', '2026-10-03 12:00', null, A);
  const o = f.v('c1', '2026-10-04 11:00', 'mera order abhi tak nahi aaya, refund chahiye');
  f.ag('c1', '2026-10-04 11:05', 'Aapka order kal tak deliver ho jayega, courier delay tha', A);
  f.v('c1', '2026-10-04 11:10', 'theek hai main wait kar lungi');
  f.v('c1', '2026-10-05 12:00', 'mil gaya, size exchange ho sakta hai?');
  f.ag('c1', '2026-10-05 12:05', 'Haan exchange ho jayega, link bhej rahi hu', A);
  f.v('c1', '2026-10-05 12:10', 'ok thanks');
  f.v('c1', '2026-10-06 12:00', 'exchange pickup kab hoga');
  f.ag('c1', '2026-10-06 12:05', 'Kal pickup hoga', A);
  f.v('c1', '2026-10-06 12:10', 'ok');
  const r = f.run();
  const c = one(r, D0, A, 'convinced');
  assert.deepStrictEqual([c.counted, c.points, c.msgs[1]], [true, 2, o]);
  none(r, D, A, 'convinced'); none(r, D1, A, 'convinced');
  const m = E.mergeDays(r.days, f.inp.people, f.inp.nowMs).people.find((p) => p.key === A);
  assert.deepStrictEqual([m.counts.convinced, m.parts.convinced], [1, { n: 1, each: 2, points: 2 }]);
  // Rahul answers a routine question the next day: Anurag's turnaround is not his.
  const g = fx({ days: [D0, D] }); g.conv('c1'); g.hold('c1', '2026-10-03 12:00', null, A);
  g.v('c1', '2026-10-04 11:00', 'mera order abhi tak nahi aaya, refund chahiye');
  g.ag('c1', '2026-10-04 11:05', 'Aapka order kal tak deliver ho jayega', A);
  g.v('c1', '2026-10-04 11:10', 'theek hai main wait kar lungi');
  g.v('c1', '2026-10-05 12:00', 'COD available hai kya');
  g.ag('c1', '2026-10-05 12:05', 'Haan COD available hai', R);
  g.v('c1', '2026-10-05 12:10', 'ok got it');
  const rg = g.run();
  assert.strictEqual(one(rg, D0, A, 'convinced').counted, true);
  none(rg, D, R, 'convinced');
  // A NEW complaint on 5 Oct, answered and accepted that day: +2 again.
  const h = fx({ days: [D0, D] }); h.conv('c1'); h.hold('c1', '2026-10-03 12:00', null, A);
  h.v('c1', '2026-10-04 11:00', 'refund chahiye'); h.ag('c1', '2026-10-04 11:05', 'Order 2 din me aa jayega', A); h.v('c1', '2026-10-04 11:10', 'theek hai main wait kar lungi');
  const o2 = h.v('c1', '2026-10-05 12:00', 'abhi tak nahi aaya');
  h.ag('c1', '2026-10-05 12:05', 'Courier se baat ki, kal pakka aa jayega', A);
  h.v('c1', '2026-10-05 12:10', 'ok theek hai');
  const c2 = one(h.run(), D, A, 'convinced');
  assert.deepStrictEqual([c2.counted, c2.points, c2.msgs[1]], [true, 2, o2]);
  // An "ok" to the AI the same day does not use the complaint up: Anurag turns it around next day (+2).
  const k = fx({ days: [D0, D] }); k.conv('c1'); k.hold('c1', '2026-10-03 12:00', null, A);
  const o3 = k.v('c1', '2026-10-04 11:00', 'refund chahiye');
  k.ai('c1', '2026-10-04 11:01'); k.v('c1', '2026-10-04 11:05', 'ok');
  k.ag('c1', '2026-10-05 10:30', 'Order 2 din me aa jayega, festive season hai', A);
  k.v('c1', '2026-10-05 10:40', 'theek hai main wait kar lungi');
  const c3 = one(k.run(), D, A, 'convinced');
  assert.deepStrictEqual([c3.counted, c3.msgs[1]], [true, o3]);
});
t('E19c the complaint must come before the member\'s answer: an unanswered complaint, then "theek hai", is not convinced', () => {
  for (const last of ['ok', 'theek hai', 'ok thanks']) {
    const f = heldByA(fx());
    f.v('c1', '2026-10-05 09:58', 'order status?');
    f.ag('c1', '2026-10-05 10:00', 'Aapka order kal deliver ho jayega', A);
    f.v('c1', '2026-10-05 15:00', 'mujhe refund chahiye, bahut late ho gaya');
    f.v('c1', '2026-10-05 15:30', last);
    none(f.run(), D, A, 'convinced');
  }
  // Complaint, answer, a second complaint, answer, "theek hai": the complaint he answered counts.
  const g = heldByA(fx());
  g.v('c1', '2026-10-05 11:00', 'refund chahiye');
  g.ag('c1', '2026-10-05 11:10', 'Order 2 din me aa jayega', A);
  const o2 = g.v('c1', '2026-10-05 11:20', 'abhi tak nahi aaya yaar, cancel karo');
  const rep = g.ag('c1', '2026-10-05 11:30', 'Courier se baat ki, kal pakka aa jayega', A);
  const m = g.v('c1', '2026-10-05 11:40', 'theek hai main wait kar lungi');
  const c = one(g.run(), D, A, 'convinced');
  assert.deepStrictEqual([c.counted, c.points, c.msgs], [true, 2, [rep, o2, m]]);
});

t('E19d a polite "ok thank u" / "ok tq" to a holding line after a complaint is not convinced; it does not use the complaint up', () => {
  const HOLD_WHY = 'Polite "ok" while still waiting for the answer';
  assert.strictEqual(E.HOLDING_ACK_WHY, HOLD_WHY);
  for (const hold of ['check karke batata hu', 'We will check and update you', 'Dekhta hu']) {
    for (const ack of ['ok thank u', 'ok tq', 'ok thanks', 'ok', 'ok sir thank u', 'ok thanku']) {
      const f = heldByA(fx());
      const o = f.v('c1', '2026-10-05 11:00', 'mera order abhi tak nahi aaya, refund chahiye');
      const rep = f.ag('c1', '2026-10-05 11:05', hold, A);
      const m = f.v('c1', '2026-10-05 11:06', ack);
      const r = f.run();
      const c = one(r, D, A, 'convinced');
      assert.deepStrictEqual([c.counted, c.pending, c.points, c.by, c.why, c.msgs], [false, false, 0, 'keyword', HOLD_WHY, [rep, o, m]], `${hold} / ${ack}`);
      const pc = pd(r, D, A).counts;
      assert.deepStrictEqual([pc.convinced, pc.convinced_pending, pc.convinced_not_counted, pd(r, D, A).parts.convinced.points, r.candidates.length],
        [0, 0, 1, 0, 0], `${hold} / ${ack}`);
      // The same words after a real answer: convinced +2.
      const g = heldByA(fx());
      g.v('c1', '2026-10-05 11:00', 'mera order abhi tak nahi aaya, refund chahiye');
      g.ag('c1', '2026-10-05 11:05', 'Courier se baat ki, kal pakka aa jayega', A);
      g.v('c1', '2026-10-05 11:06', ack);
      const cg = one(g.run(), D, A, 'convinced');
      assert.deepStrictEqual([cg.counted, cg.points], [true, 2], `answer / ${ack}`);
    }
  }
  // The real answer the same day, then "theek hai": +2 once (the complaint was not used up).
  const s = heldByA(fx());
  const o = s.v('c1', '2026-10-05 11:00', 'refund chahiye, abhi tak nahi aaya');
  s.ag('c1', '2026-10-05 11:05', 'check karke batata hu', A); s.v('c1', '2026-10-05 11:06', 'ok tq');
  const rep = s.ag('c1', '2026-10-05 12:00', 'Courier se baat ki, kal pakka aa jayega', A);
  const m = s.v('c1', '2026-10-05 12:10', 'theek hai main wait kar lungi');
  let c = one(s.run(), D, A, 'convinced');
  assert.deepStrictEqual([c.counted, c.points, c.msgs], [true, 2, [rep, o, m]]);
  // Across days: complaint + holding + "ok thank u" on 4 Oct (not counted), the answer + "theek hai" on 5 Oct (+2).
  const x = fx({ days: [D0, D] }); x.conv('c1'); x.hold('c1', '2026-10-03 12:00', null, A);
  const o2 = x.v('c1', '2026-10-04 11:00', 'mera order abhi tak nahi aaya');
  x.ag('c1', '2026-10-04 11:05', 'check karke batata hu', A); x.v('c1', '2026-10-04 11:06', 'ok thank u');
  const rep2 = x.ag('c1', '2026-10-05 11:00', 'Courier se baat ki, kal pakka aa jayega', A);
  const m2 = x.v('c1', '2026-10-05 11:10', 'theek hai main wait kar lungi');
  const rx = x.run();
  assert.deepStrictEqual([one(rx, D0, A, 'convinced').counted, one(rx, D0, A, 'convinced').why], [false, HOLD_WHY]);
  c = one(rx, D, A, 'convinced');
  assert.deepStrictEqual([c.counted, c.points, c.msgs], [true, 2, [rep2, o2, m2]]);
  const merged = E.mergeDays(rx.days, x.inp.people, x.inp.nowMs).people.find((p) => p.key === A).counts;
  assert.deepStrictEqual([merged.convinced, merged.convinced_pending, merged.convinced_not_counted], [1, 0, 1]);
  // Rahul's holding line, "ok tq", then Anurag's answer the same day: Anurag turned it around (+2).
  const y = heldByA(fx());
  const o3 = y.v('c1', '2026-10-05 11:00', 'refund chahiye');
  y.ag('c1', '2026-10-05 11:05', 'We will check and update you', R); y.v('c1', '2026-10-05 11:06', 'ok tq');
  y.ag('c1', '2026-10-05 12:00', 'Order 2 din me aa jayega, festive season hai', A);
  y.v('c1', '2026-10-05 12:10', 'theek hai main wait kar lungi');
  const ry = y.run();
  assert.deepStrictEqual([one(ry, D, A, 'convinced').counted, one(ry, D, A, 'convinced').msgs[1]], [true, o3]);
  assert.deepStrictEqual([one(ry, D, R, 'convinced').counted, one(ry, D, R, 'convinced').why], [false, HOLD_WHY]);
});

t('E19e S7: a later holding line + "ok", or a later new question, never takes back a convinced already earned that day; a later complaint does', () => {
  // 11:00 complaint, 11:05 answer, 11:06 "ok thanks" (+2, +3), 11:07 a new question, 11:10 holding line, 11:11 "ok".
  const s7 = (o = {}) => {
    const f = heldByA(fx());
    const ids = {};
    ids.o = f.v('c1', '2026-10-05 11:00', 'mera order abhi tak nahi aaya, refund chahiye');
    ids.rep = f.ag('c1', '2026-10-05 11:05', 'Courier se baat ki, kal pakka aa jayega', A);
    ids.m = f.v('c1', '2026-10-05 11:06', 'ok thanks');
    if (o.later !== null) f.v('c1', '2026-10-05 11:07', o.later || 'aur mera dusra order kab dispatch hoga');
    if (o.hold !== false) {
      f.ag('c1', '2026-10-05 11:10', 'Ek minute, check karke batata hu', A);
      ids.ack = f.v('c1', '2026-10-05 11:11', o.ack || 'ok');
    }
    return { f, ids };
  };
  const { f, ids } = s7();
  const r = f.run();
  const c = one(r, D, A, 'convinced');
  assert.deepStrictEqual([c.counted, c.pending, c.points, c.by, c.msgs], [true, false, 2, 'keyword', [ids.rep, ids.o, ids.m]]);
  assert.strictEqual(c.why, "Customer complained at 11:00; their message at 11:06 accepts Anurag's answer.");
  const th = one(r, D, A, 'thanks');
  assert.deepStrictEqual([th.counted, th.points, th.msgs], [true, 3, [ids.rep, ids.m]]);
  const pc = pd(r, D, A).counts;
  assert.deepStrictEqual([pc.convinced, pc.convinced_pending, pc.convinced_not_counted, pc.thanks, pc.thanks_not_counted, r.candidates.length], [1, 0, 0, 1, 0, 0]);
  assert.deepStrictEqual([pd(r, D, A).parts.convinced, pd(r, D, A).parts.thanks], [{ n: 1, each: 2, points: 2 }, { n: 1, each: 3, points: 3 }]);
  // "ok thanks" to the holding line: the thank-you rule is unchanged (not counted), convinced stays +2.
  let x = s7({ ack: 'ok thanks' }).f.run();
  assert.deepStrictEqual(its(x, D, A, 'thanks').map((i) => [i.counted, i.why.startsWith('Polite')]), [[true, false], [false, true]]);
  assert.deepStrictEqual([one(x, D, A, 'convinced').counted, one(x, D, A, 'convinced').points], [true, 2]);
  // Only the holding line + "ok" after the acceptance; only the new question after it: +2 for 11:06 both times.
  x = s7({ later: null }).f.run();
  assert.deepStrictEqual([one(x, D, A, 'convinced').counted, one(x, D, A, 'convinced').at], [true, ist('2026-10-05 11:06')]);
  x = s7({ hold: false }).f.run();
  assert.deepStrictEqual([one(x, D, A, 'convinced').counted, one(x, D, A, 'convinced').at, x.candidates.length], [true, ist('2026-10-05 11:06'), 0]);
  // A later complaint is the last word: no convinced (and a holding line + "ok" after it is shown, not counted).
  x = s7({ later: 'abhi tak nahi aaya yaar, fraud hai', hold: false }).f.run();
  none(x, D, A, 'convinced');
  x = s7({ later: 'abhi tak nahi aaya yaar, fraud hai' }).f.run();
  assert.deepStrictEqual([one(x, D, A, 'convinced').counted, one(x, D, A, 'convinced').why, pd(x, D, A).counts.convinced], [false, E.HOLDING_ACK_WHY, 0]);
  // A complaint between the acceptance and the new question: the acceptance is taken back (the question goes to the AI).
  const g = s7({ later: 'abhi tak nahi aaya yaar', hold: false }).f;
  const q = g.v('c1', '2026-10-05 11:08', 'aur mera dusra order kab dispatch hoga', { id: 'mQ' });
  const rg = g.run();
  assert.deepStrictEqual([one(rg, D, A, 'convinced').pending, one(rg, D, A, 'convinced').counted, rg.candidates.map((k) => k.messageId)], [true, false, [q]]);
});
t('E19f S1b: across days the +2 is earned once, on the day of the first acceptance, and never lost to a holding line + "ok thanks"', () => {
  const f = fx({ days: [D0, D] }); f.conv('c1'); f.hold('c1', '2026-10-03 12:00', null, A);
  const o = f.v('c1', '2026-10-04 11:00', 'mera order abhi tak nahi aaya, refund chahiye');
  const rep = f.ag('c1', '2026-10-04 11:05', 'Courier se baat ki, kal pakka aa jayega', A);
  const m = f.v('c1', '2026-10-04 11:06', 'ok');
  f.ag('c1', '2026-10-04 11:10', 'confirm karke update karta hu', A);
  f.v('c1', '2026-10-04 11:11', 'ok thanks');
  f.ag('c1', '2026-10-05 11:00', 'Confirm ho gaya, aapka order kal deliver ho jayega', A);
  f.v('c1', '2026-10-05 11:10', 'theek hai');
  const r = f.run();
  const c = one(r, D0, A, 'convinced');
  assert.deepStrictEqual([c.counted, c.points, c.msgs], [true, 2, [rep, o, m]]);
  assert.strictEqual(c.why, "Customer complained at 11:00; their message at 11:06 accepts Anurag's answer.");
  none(r, D, A, 'convinced');
  assert.deepStrictEqual([one(r, D0, A, 'thanks').counted, one(r, D0, A, 'thanks').why], [false, 'Polite "ok thanks" while still waiting for the answer']);
  const merged = E.mergeDays(r.days, f.inp.people, f.inp.nowMs).people.find((p) => p.key === A);
  assert.deepStrictEqual([merged.counts.convinced, merged.counts.convinced_pending, merged.counts.convinced_not_counted, merged.parts.convinced],
    [1, 0, 0, { n: 1, each: 2, points: 2 }]);
});

t('E19g after an accepted answer: a new question or request keeps the +2; a rejection ("no", "not ok", "nahi", "I am not convinced", an AI "not convinced") takes it back; any other unsure message is the last word (AI)', () => {
  const mk = (laters, verdicts) => {
    const f = heldByA(fx());
    const ids = {};
    ids.o = f.v('c1', '2026-10-05 11:00', 'mera order abhi tak nahi aaya, refund chahiye');
    ids.rep = f.ag('c1', '2026-10-05 11:05', 'Courier se baat ki, kal pakka aa jayega', A);
    ids.m = f.v('c1', '2026-10-05 11:06', 'ok');
    ids.later = laters.map((x, i) => f.v('c1', `2026-10-05 11:${String(8 + i).padStart(2, '0')}`, x, { id: `mL${i}` }));
    if (verdicts) f.inp.verdicts = verdicts;
    return { r: f.run(), ids };
  };
  // A new question or request: +2 for 11:06.
  for (const q of ['dusra order kab aayega?', 'aur mera dusra order kab dispatch hoga', 'bill bhej do', 'दूसरा ऑर्डर कब आएगा', 'can you check my other order']) {
    const { r, ids } = mk([q]);
    const c = one(r, D, A, 'convinced');
    assert.deepStrictEqual([c.counted, c.points, c.msgs, r.candidates.length], [true, 2, [ids.rep, ids.o, ids.m], 0], q);
    assert.strictEqual(c.why, "Customer complained at 11:00; their message at 11:06 accepts Anurag's answer.", q);
  }
  // Rejections: never the +2 of 11:06 (no item, or the rejection itself goes to the AI).
  for (const [later, exp] of [['no', 'none'], ['not ok', 'none'], ['nahi', 'none'], ['I am not convinced', 'pending'], ['nahi, kab aayega?', 'none'],
    ['not ok, when will it come?', 'none'], ["I don't agree, why so late?", 'none'], ['ye sahi nahi hai, kab aayega', 'pending'], ['abhi tak nahi aaya, kab aayega?', 'none']]) {
    const { r, ids } = mk([later]);
    assert.strictEqual(pd(r, D, A).counts.convinced, 0, later);
    if (exp === 'none') none(r, D, A, 'convinced');
    else assert.deepStrictEqual([one(r, D, A, 'convinced').pending, one(r, D, A, 'convinced').msgs[2]], [true, ids.later[0]], later);
  }
  // A new question the AI already judged NOT convinced (a saved verdict) is a rejection too.
  let x = mk(['aur mera dusra order kab dispatch hoga'], { mL0: { thanks: false, convinced: false, source: 'ai' } });
  none(x.r, D, A, 'convinced');
  // A rejection between the acceptance and the new question takes it back as well.
  x = mk(['not ok', 'dusra order kab aayega?']);
  none(x.r, D, A, 'convinced');
  x = mk(['I am not convinced', 'aur mera dusra order kab dispatch hoga']);
  assert.deepStrictEqual([pd(x.r, D, A).counts.convinced, one(x.r, D, A, 'convinced').pending, one(x.r, D, A, 'convinced').msgs[2]], [0, true, x.ids.later[1]]);
  // Two new questions in a row: still the +2 of 11:06.
  x = mk(['dusra order kab aayega?', 'aur bill bhej do']);
  assert.deepStrictEqual([one(x.r, D, A, 'convinced').counted, one(x.r, D, A, 'convinced').msgs[2]], [true, x.ids.m]);
  // Any other unsure later message (not a question, not a rejection) is the last word: the AI decides (c113ed0).
  x = mk(['mujhe kal office jaana hai']);
  assert.deepStrictEqual([one(x.r, D, A, 'convinced').pending, one(x.r, D, A, 'convinced').msgs[2], x.r.candidates.map((k) => k.messageId)],
    [true, x.ids.later[0], [x.ids.later[0]]]);
});
t('E19h a complaint in ANY of the customer\'s chats between the acceptance and the new question takes the +2 back', () => {
  const mk = (c3At) => {
    const f = fx();
    for (const c of ['c1', 'c2', 'c3']) { f.conv(c, { cuKey: 'cust' }); f.hold(c, '2026-10-04 12:00', null, c === 'c3' ? R : A); }
    const ids = {};
    ids.o = f.v('c1', '2026-10-05 11:00', 'mera order abhi tak nahi aaya, refund chahiye');
    ids.rep = f.ag('c1', '2026-10-05 11:05', 'Courier se baat ki, kal pakka aa jayega', A);
    ids.m = f.v('c1', '2026-10-05 11:06', 'theek hai');
    if (c3At) f.v('c3', c3At, 'abhi tak nahi aaya, refund chahiye, bakwas service');
    f.v('c2', '2026-10-05 12:00', 'hello mera exchange ka status batao');
    f.ag('c2', '2026-10-05 12:05', 'Exchange pickup kal hoga', A);
    ids.q = f.v('c2', '2026-10-05 12:06', 'pickup kitne baje hoga bhai');
    return { r: f.run(), ids };
  };
  // No complaint elsewhere: the question in chat c2 keeps the +2 of chat c1.
  let { r, ids } = mk(null);
  assert.deepStrictEqual([one(r, D, A, 'convinced').counted, one(r, D, A, 'convinced').msgs], [true, [ids.rep, ids.o, ids.m]]);
  // A complaint in a third chat (c3, held by Rahul) between them: no +2.
  ({ r } = mk('2026-10-05 11:30'));
  assert.strictEqual(pd(r, D, A).counts.convinced, 0);
  none(r, D, A, 'convinced');
  // The same complaint after the question changes nothing for Anurag's +2.
  ({ r, ids } = mk('2026-10-05 12:30'));
  assert.deepStrictEqual([one(r, D, A, 'convinced').counted, one(r, D, A, 'convinced').msgs[2]], [true, ids.m]);
});
t('E19i a mixed holding line in S7: "ok" to it waits for the AI; AI "not convinced" = still waiting (the earlier +2 stands); AI "convinced" = +2 for it; across days a mixed "ok" never uses the complaint up (same result in a one-day report)', () => {
  const s7m = (o = {}) => {
    const f = heldByA(fx());
    const ids = {};
    ids.o = f.v('c1', '2026-10-05 11:00', 'mera order abhi tak nahi aaya, refund chahiye');
    ids.rep = f.ag('c1', '2026-10-05 11:05', 'Courier se baat ki, kal pakka aa jayega', A);
    ids.m = f.v('c1', '2026-10-05 11:06', 'ok thanks');
    f.v('c1', '2026-10-05 11:07', 'aur mera dusra order kab dispatch hoga');
    ids.rep2 = f.ag('c1', '2026-10-05 11:10', 'Ek minute, aapka dusra order kal dispatch ho jayega', A);
    ids.ack = f.v('c1', '2026-10-05 11:11', 'ok', { id: 'mAck' });
    if (o.q2) ids.q2 = f.v('c1', '2026-10-05 11:20', o.q2);
    if (o.v) f.inp.verdicts = { mAck: o.v };
    return { r: f.run(), ids };
  };
  // No verdict: the "ok" is the last word, the AI decides.
  let { r, ids } = s7m();
  let c = one(r, D, A, 'convinced');
  assert.deepStrictEqual([c.counted, c.pending, c.msgs, r.candidates.map((k) => [k.messageId, k.teamText])],
    [false, true, [ids.rep2, ids.o, ids.ack], [['mAck', 'Ek minute, aapka dusra order kal dispatch ho jayega']]]);
  // The AI: not convinced (still waiting): the +2 of 11:06 stands.
  ({ r, ids } = s7m({ v: { thanks: false, convinced: false, source: 'ai' } }));
  c = one(r, D, A, 'convinced');
  assert.deepStrictEqual([c.counted, c.points, c.by, c.msgs, r.candidates.length], [true, 2, 'keyword', [ids.rep, ids.o, ids.m], 0]);
  // The AI: convinced: +2 for 11:11, once.
  ({ r, ids } = s7m({ v: { thanks: false, convinced: true, source: 'ai' } }));
  c = one(r, D, A, 'convinced');
  assert.deepStrictEqual([c.counted, c.points, c.by, c.msgs], [true, 2, 'ai', [ids.rep2, ids.o, ids.ack]]);
  // Another new question after the mixed "ok" (no verdict): the walk crosses the "ok" and the question: +2 of 11:06, nothing for the AI.
  ({ r, ids } = s7m({ q2: 'aur bill kab bhejoge?' }));
  c = one(r, D, A, 'convinced');
  assert.deepStrictEqual([c.counted, c.msgs, r.candidates.length], [true, [ids.rep, ids.o, ids.m], 0]);
  // Across days: complaint + mixed line + "ok thanks" on 4 Oct, a real answer + "theek hai" on 5 Oct. The mixed
  // "ok" never uses the complaint up (keywords only: a frozen day is computed alone and does not load an
  // earlier day's verdict), so 5 Oct is the same whatever the AI says about 4 Oct, and in a one-day report.
  const xd = (v, days = [D0, D]) => {
    const f = fx({ days }); f.conv('c1'); f.hold('c1', '2026-10-03 12:00', null, A);
    const q = {};
    q.o = f.v('c1', '2026-10-04 11:00', 'mera order abhi tak nahi aaya, refund chahiye');
    q.r0 = f.ag('c1', '2026-10-04 11:05', 'Refund initiated, will update you', A);
    q.m0 = f.v('c1', '2026-10-04 11:06', 'ok thanks', { id: 'mD0' });
    q.r1 = f.ag('c1', '2026-10-05 11:00', 'Courier se baat ki, kal pakka aa jayega', A);
    q.m1 = f.v('c1', '2026-10-05 11:10', 'theek hai');
    if (v) f.inp.verdicts = { mD0: v };
    return { res: f.run(), q };
  };
  const dItem = (res) => JSON.stringify(its(res, D, A, 'convinced'));
  let { res, q } = xd(null);   // 4 Oct waits for the AI; 5 Oct: +2
  assert.deepStrictEqual([one(res, D0, A, 'convinced').pending, one(res, D0, A, 'thanks').pending, res.candidates.map((k) => k.messageId)], [true, true, ['mD0']]);
  assert.deepStrictEqual([one(res, D, A, 'convinced').counted, one(res, D, A, 'convinced').points, one(res, D, A, 'convinced').msgs], [true, 2, [q.r1, q.o, q.m1]]);
  const base5 = dItem(res);
  ({ res } = xd({ thanks: true, convinced: true, source: 'ai' }));   // the AI says yes: +3 and +2 on 4 Oct by the AI
  assert.deepStrictEqual([one(res, D0, A, 'convinced').counted, one(res, D0, A, 'convinced').by, one(res, D0, A, 'thanks').counted, one(res, D0, A, 'thanks').points],
    [true, 'ai', true, 3]);
  assert.strictEqual(dItem(res), base5);
  ({ res } = xd({ thanks: false, convinced: false, source: 'ai' }));   // the AI says no: nothing on 4 Oct
  none(res, D0, A, 'convinced'); none(res, D0, A, 'thanks');
  assert.strictEqual(dItem(res), base5);
  assert.strictEqual(dItem(xd(null, [D]).res), base5);
  assert.strictEqual(dItem(xd({ thanks: true, convinced: true, source: 'ai' }, [D]).res), base5);
});

// ── Fifth pass (lead design v5) ──
const BATTERY_PURE = [
  'Please wait while I check your order', 'please wait, checking your order', 'Kindly wait, we are looking into it',
  'Please wait a moment while we check the status', 'please wait for some time', 'Ek minute, check karke batata hu', 'check karke batata hu sir',
  'thoda wait kariye', 'I am looking into it', 'एक मिनट सर', 'मैं चेक करके बताता हूँ', 'Let me check and update you', 'dekhta hu ek minute',
];
const BATTERY_MIXED = [
  'Pickup kal hoga, thoda wait kariye', 'Order aaj nikal jayega, plz wait', 'Refund 24-48 hours me aa jayega, plz wait', 'आपका ऑर्डर कल पहुँच जाएगा, एक मिनट',
  'रिफंड प्रोसेस हो रहा है, कृपया प्रतीक्षा करें', 'We are looking into the delay, your parcel is at the Delhi hub', 'Wait karo, order aa jayega',
  'Delivery kal tak hogi, please wait', 'Dispatch hua hai sir, please wait', 'Haan COD hai, ek minute', 'Haan size M available hai, ek minute',
  'Aapka refund process ho gaya hai, please wait 5-7 working days', 'Let me check if your refund has been initiated', 'We will update you once it is dispatched',
  "I'll check if it is delivered and update you", 'Kal tak confirm karke batata hu delivery kab hogi', 'We will update you within 2 days',
  "I'll share the tracking link shortly", 'Courier ne pickup kar liya hai, please wait',
];
t('E17d fifth pass, the battery in the engine: complaint + line + "ok thanks": a pure line is not counted (0 points, never the AI); a mixed one waits for the AI with that line as the team text, never "not counted"', () => {
  const run = (line) => {
    const f = heldByA(fx());
    const ids = {};
    ids.o = f.v('c1', '2026-10-05 11:00', 'mera order abhi tak nahi aaya, refund chahiye');
    ids.rep = f.ag('c1', '2026-10-05 11:05', line, A);
    ids.m = f.v('c1', '2026-10-05 11:06', 'ok thanks');
    return { r: f.run(), ids };
  };
  for (const line of BATTERY_PURE) {
    const { r } = run(line);
    const th = one(r, D, A, 'thanks'), c = one(r, D, A, 'convinced');
    assert.deepStrictEqual([th.counted, th.pending, th.points, th.why, c.counted, c.pending, c.points, c.why,
      pd(r, D, A).parts.thanks.points, pd(r, D, A).parts.convinced.points, r.candidates.length],
    [false, false, 0, POLITE_WHY, false, false, 0, E.HOLDING_ACK_WHY, 0, 0, 0], line);
  }
  for (const line of BATTERY_MIXED) {
    const { r, ids } = run(line);
    const th = one(r, D, A, 'thanks'), c = one(r, D, A, 'convinced');
    assert.deepStrictEqual([th.counted, th.pending, th.why, c.counted, c.pending, c.why, c.msgs, pd(r, D, A).parts.convinced.points,
      r.candidates.map((k) => [k.messageId, k.teamText])],
    [false, true, PENDING_WHY, false, true, PENDING_WHY, [ids.rep, ids.o, ids.m], 0, [[ids.m, line]]], line);
  }
  // A strong thank-you that states the result still counts after either kind (keywords): +3.
  for (const line of [BATTERY_PURE[0], BATTERY_MIXED[0]]) {
    const f = heldByA(fx()); f.ag('c1', '2026-10-05 15:50', line, A); f.v('c1', '2026-10-05 16:00', 'thank you so much mil gaya');
    const r = f.run();
    assert.deepStrictEqual([one(r, D, A, 'thanks').counted, one(r, D, A, 'thanks').points, one(r, D, A, 'thanks').by], [true, 3, 'keyword'], line);
  }
});
t('E19j fifth pass (B): after "theek hai", a question with push-back is the last word (never the +2 by keyword); a plain new question keeps it, also behind a holding line + "ok"', () => {
  const mk = (later, verdict) => {
    const f = heldByA(fx());
    const ids = {};
    ids.o = f.v('c1', '2026-10-05 11:00', 'mera order abhi tak nahi aaya, refund chahiye');
    ids.rep = f.ag('c1', '2026-10-05 11:05', 'Courier se baat ki, kal pakka aa jayega', A);
    ids.m = f.v('c1', '2026-10-05 11:06', 'theek hai');
    ids.later = f.v('c1', '2026-10-05 11:08', later, { id: 'mL' });
    if (verdict) f.inp.verdicts = { mL: verdict };
    return { r: f.run(), ids };
  };
  // A question with push-back is a keyword "no" (c113ed0): no item, nothing for the AI.
  for (const later of ['itna time kyu lag raha hai?', 'why is it taking so long?', 'pehle bhi yahi bola tha, kab aayega?', 'aap log kuch karte kyu nahi?',
    'seriously? kitne din aur?', 'dusra order kab aayega???']) {
    const { r } = mk(later);
    none(r, D, A, 'convinced');
    assert.deepStrictEqual([pd(r, D, A).counts.convinced, pd(r, D, A).counts.convinced_pending, r.candidates.length], [0, 0, 0], later);
  }
  // An unsure one with push-back is the last word too: the AI decides it (pending, 0 points), never the +2 of 11:06.
  for (const later of ['mujhe nahi chahiye ab ye order', 'ye kya mazak hai', 'kitna time aur lagega', 'DUSRA ORDER KAB AAYEGA']) {
    const { r, ids } = mk(later);
    const c = one(r, D, A, 'convinced');
    assert.deepStrictEqual([c.counted, c.pending, c.points, c.msgs, r.candidates.map((k) => k.messageId)], [false, true, 0, [ids.rep, ids.o, ids.later], ['mL']], later);
  }
  // ...and the saved verdict decides: not convinced = nothing; convinced = +2 for that message, by the AI.
  let x = mk('ye kya mazak hai', { thanks: false, convinced: false, source: 'ai' });
  none(x.r, D, A, 'convinced');
  x = mk('mujhe nahi chahiye ab ye order', { thanks: false, convinced: true, source: 'ai' });
  assert.deepStrictEqual([one(x.r, D, A, 'convinced').counted, one(x.r, D, A, 'convinced').by, one(x.r, D, A, 'convinced').msgs[2]], [true, 'ai', 'mL']);
  // A plain new question (no push-back) keeps the +2 of 11:06 (E19g).
  for (const later of ['aur mera dusra order kab dispatch hoga', 'pickup kitne baje hoga bhai', 'COD available hai kya']) {
    const { r, ids } = mk(later);
    assert.deepStrictEqual([one(r, D, A, 'convinced').counted, one(r, D, A, 'convinced').msgs[2], r.candidates.length], [true, ids.m, 0], later);
  }
  // A holding line + "ok" between the acceptance and the new question is skipped by the walk back: still the +2 of 11:06.
  const f = heldByA(fx());
  f.v('c1', '2026-10-05 11:00', 'mera order abhi tak nahi aaya, refund chahiye');
  f.ag('c1', '2026-10-05 11:05', 'Courier se baat ki, kal pakka aa jayega', A);
  const m = f.v('c1', '2026-10-05 11:06', 'theek hai');
  f.ag('c1', '2026-10-05 11:10', 'Ek minute, check karke batata hu', A);
  f.v('c1', '2026-10-05 11:11', 'ok');
  f.v('c1', '2026-10-05 11:20', 'aur mera dusra order kab dispatch hoga');
  const r = f.run();
  assert.deepStrictEqual([one(r, D, A, 'convinced').counted, one(r, D, A, 'convinced').msgs[2], r.candidates.length], [true, m, 0]);
});
t('E19k fifth pass (C): a complaint in ANY of the customer\'s chats after the acceptance takes the +2 back on every path, also behind a later "ok" to a holding line', () => {
  const mk = (o = {}) => {
    const f = fx();
    for (const c of ['c1', 'c3']) { f.conv(c, { cuKey: 'cust' }); f.hold(c, '2026-10-04 12:00', null, c === 'c3' ? R : A); }
    f.conv('c4', { cuKey: 'other' }); f.hold('c4', '2026-10-04 12:00', null, R);
    const ids = {};
    ids.o = f.v('c1', '2026-10-05 11:00', 'mera order abhi tak nahi aaya, refund chahiye');
    ids.rep = f.ag('c1', '2026-10-05 11:05', 'Courier se baat ki, kal pakka aa jayega', A);
    ids.m = f.v('c1', '2026-10-05 11:06', 'theek hai');
    if (o.cAt) f.v(o.cConv || 'c3', o.cAt, 'abhi tak nahi aaya, refund chahiye, bakwas service');
    if (o.ask) ids.ask = f.v('c1', '2026-10-05 12:00', o.ask, { id: 'mAsk' });
    else {
      f.ag('c1', '2026-10-05 12:00', o.hold || 'check karke batata hu', A);
      f.v('c1', '2026-10-05 12:01', 'ok', { id: 'mAck' });
    }
    if (o.v) f.inp.verdicts = { mAck: o.v };
    return { r: f.run(), ids };
  };
  // No complaint: the +2 of 11:06 stands behind the "ok" to the holding line (S7).
  let { r, ids } = mk();
  assert.deepStrictEqual([one(r, D, A, 'convinced').counted, one(r, D, A, 'convinced').points, one(r, D, A, 'convinced').msgs], [true, 2, [ids.rep, ids.o, ids.m]]);
  // A complaint in a third chat (held by Rahul, never answered) at 11:30: no +2; the "ok" is shown, not counted.
  ({ r } = mk({ cAt: '2026-10-05 11:30' }));
  assert.deepStrictEqual([pd(r, D, A).counts.convinced, pd(r, D, A).parts.convinced.points, one(r, D, A, 'convinced').counted, one(r, D, A, 'convinced').why],
    [0, 0, false, E.HOLDING_ACK_WHY]);
  // The same behind an "ok" to a MIXED line that the AI judged not convinced, or could not judge.
  for (const v of [{ thanks: false, convinced: false, source: 'ai' }, { thanks: null, convinced: null, source: 'ai_failed' }]) {
    ({ r } = mk({ cAt: '2026-10-05 11:30', hold: 'Ek minute, aapka dusra order kal dispatch ho jayega', v }));
    assert.deepStrictEqual([pd(r, D, A).counts.convinced, its(r, D, A, 'convinced').filter((i) => i.counted).length], [0, 0], v.source);
  }
  // A new question after that complaint: the walk back never crosses the complaint, so the question is the
  // last word and the AI decides it (pending, 0 points), as for a complaint in the same chat (E19e).
  ({ r, ids } = mk({ cAt: '2026-10-05 11:30', ask: 'aur mera dusra order kab dispatch hoga' }));
  assert.deepStrictEqual([one(r, D, A, 'convinced').pending, one(r, D, A, 'convinced').counted, one(r, D, A, 'convinced').msgs[2], r.candidates.map((k) => k.messageId)],
    [true, false, 'mAsk', ['mAsk']]);
  // Not a take-back: a complaint before the acceptance, after the customer's last message to Anurag that day, or by another customer.
  for (const o of [{ cAt: '2026-10-05 10:30' }, { cAt: '2026-10-05 13:00' }, { cAt: '2026-10-05 11:30', cConv: 'c4' }]) {
    ({ r, ids } = mk(o));
    assert.deepStrictEqual([one(r, D, A, 'convinced').counted, one(r, D, A, 'convinced').msgs[2]], [true, ids.m], JSON.stringify(o));
  }
});
t('E19l fifth pass (E): "ai_failed" on an "ok" to a mixed line is still waiting: it never replaces a +2 already earned; on its own it is "AI could not decide"', () => {
  const f = heldByA(fx());
  const o = f.v('c1', '2026-10-05 11:00', 'mera order abhi tak nahi aaya, refund chahiye');
  const rep = f.ag('c1', '2026-10-05 11:05', 'Courier se baat ki, kal pakka aa jayega', A);
  const m = f.v('c1', '2026-10-05 11:06', 'ok thanks');
  f.v('c1', '2026-10-05 11:07', 'aur mera dusra order kab dispatch hoga');
  f.ag('c1', '2026-10-05 11:10', 'Dusra order dispatch ho gaya hai, please wait 2 days', A);
  f.v('c1', '2026-10-05 11:11', 'ok thanks', { id: 'mAck' });
  f.inp.verdicts = { mAck: { thanks: null, convinced: null, source: 'ai_failed' } };
  let r = f.run();
  const c = one(r, D, A, 'convinced');
  assert.deepStrictEqual([c.counted, c.points, c.by, c.msgs, pd(r, D, A).counts.convinced, pd(r, D, A).counts.convinced_not_counted, r.candidates.length],
    [true, 2, 'keyword', [rep, o, m], 1, 0, 0]);
  // S2 alone (no earlier acceptance), the AI failed: "AI could not decide", 0 points, as before.
  const g = heldByA(fx());
  const o2 = g.v('c1', '2026-10-05 11:00', 'refund kab milega, abhi tak nahi aaya');
  const rep2 = g.ag('c1', '2026-10-05 11:05', 'Aapka refund process ho gaya hai, please wait 5-7 working days', A);
  g.v('c1', '2026-10-05 11:06', 'ok thank you', { id: 'mS2' });
  g.inp.verdicts = { mS2: { thanks: null, convinced: null, source: 'ai_failed' } };
  r = g.run();
  const c2 = one(r, D, A, 'convinced');
  assert.deepStrictEqual([c2.counted, c2.pending, c2.points, c2.by, c2.why, c2.msgs, pd(r, D, A).counts.convinced_not_counted, r.candidates.length],
    [false, false, 0, 'ai', 'AI could not decide', [rep2, o2, 'mS2'], 1, 0]);
});

// ── Solved and closed-while-waiting ────────────────────────────
const e20 = (now) => {
  const f = heldByA(fx({ now }));
  f.inp.convs[0].status = 'resolved';
  f.v('c1', '2026-10-05 14:50', 'mera parcel kahan hai');
  f.ag('c1', '2026-10-05 14:52', 'Out for delivery today evening', A);
  f.v('c1', '2026-10-05 14:55', 'ok got it thanks');
  f.st('c1', '2026-10-05 15:00', 'agent_handling', 'resolved', 'close', 'owner');
  return f;
};
t('E20 closed after "ok got it thanks": +2 solved for the last replier after 24 h; pending before', () => {
  let s = one(e20('2026-10-06 15:01').run(), D, A, 'solved');
  assert.deepStrictEqual([s.counted, s.pending, s.points, s.at], [true, false, 2, ist('2026-10-05 15:00')]);
  assert.strictEqual(s.why, 'Closed at 15:00 (by Super Admin); Anurag gave the last reply at 14:52; no new message from the customer for 24 h.');
  s = one(e20('2026-10-05 16:00').run(), D, A, 'solved');
  assert.deepStrictEqual([s.pending, s.counted, s.points, s.why], [true, false, 0, '24-hour check ends 6 Oct 15:00']);
  s = one(e20('2026-10-06 14:30').run(), D, A, 'solved');           // 23.5 h: the 24-hour check is not over yet
  assert.deepStrictEqual([s.pending, s.counted], [true, false]);
  const r = e20('2026-10-06 15:01').run();
  none(r, D, 'owner', 'closed_waiting');
  assert.deepStrictEqual([pd(r, D, A).counts.solved, pd(r, D, A).counts.solved_pending], [1, 0]);
  assert.strictEqual(pd(e20('2026-10-05 16:00').run(), D, A).counts.solved_pending, 1);
});
t('E21 the customer writes again in a NEW chat within 24 h: not counted', () => {
  const f = e20('2026-10-06 15:01'); f.conv('c2', { cuKey: 'c1' });
  const z = f.v('c2', '2026-10-05 20:00', 'abhi tak nahi aaya');
  let s = one(f.run(), D, A, 'solved');
  assert.deepStrictEqual([s.counted, s.pending, s.points, s.why], [false, false, 0, 'Customer wrote again at 5 Oct 20:00']);
  assert.ok(s.msgs.includes(z));
  // At 23.5 h it is still inside the watch; a thanks or "ok" is not "came back".
  const g = e20('2026-10-07 12:00'); g.conv('c2', { cuKey: 'c1' }); g.v('c2', '2026-10-06 14:30', 'abhi tak nahi aaya');
  s = one(g.run(), D, A, 'solved');
  assert.deepStrictEqual([s.counted, s.why], [false, 'Customer wrote again at 6 Oct 14:30']);
  const h = e20('2026-10-07 12:00'); h.conv('c2', { cuKey: 'c1' }); h.v('c2', '2026-10-06 15:30', 'abhi tak nahi aaya');
  assert.strictEqual(one(h.run(), D, A, 'solved').counted, true);      // after the 24 h
  const k = e20('2026-10-07 12:00'); k.v('c1', '2026-10-05 18:00', 'thank you so much');
  assert.strictEqual(one(k.run(), D, A, 'solved').counted, true);
});
t('E22 closed while the customer waited: closed_waiting -2 for the closer (owner A2), no solved', () => {
  const f = heldByA(fx());
  f.ag('c1', '2026-10-05 14:52', 'Out for delivery today evening', A);
  const w = f.v('c1', '2026-10-05 14:58', 'but I am not at home, can you deliver tomorrow');
  f.st('c1', '2026-10-05 15:00', 'agent_handling', 'resolved', 'close', A);
  const r = f.run();
  const c = one(r, D, A, 'closed_waiting');
  assert.deepStrictEqual([c.at, c.points, c.counted, c.msgs], [ist('2026-10-05 15:00'), -2, true, [w]]);
  assert.strictEqual(c.why, 'Closed at 15:00 while the customer was waiting since 14:58.');
  none(r, D, A, 'solved');
  assert.deepStrictEqual([pd(r, D, A).counts.closed_waiting, pd(r, D, A).points], [1, -2]);
  assert.deepStrictEqual(pd(r, D, A).parts.closed_waiting, { n: 1, each: -2, points: -2 });
  // Someone else closes Anurag's waiting chat: the closer pays, not Anurag.
  const g = heldByA(fx());
  g.ag('c1', '2026-10-05 14:52', 'Out for delivery today evening', A);
  g.v('c1', '2026-10-05 14:58', 'but I am not at home, can you deliver tomorrow');
  g.st('c1', '2026-10-05 15:00', 'agent_handling', 'resolved', 'close', R);
  const rg = g.run();
  assert.deepStrictEqual([one(rg, D, R, 'closed_waiting').points, pd(rg, D, R).points, pd(rg, D, A).points], [-2, -2, 0]);
  // A day before the points start: flagged, no minus.
  const h = heldByA(fx({ days: ['2026-10-02'], now: '2026-10-04 12:00' }), 'c1', A, '2026-10-01 21:00');
  h.ag('c1', '2026-10-02 14:52', 'Out for delivery today evening', A);
  h.v('c1', '2026-10-02 14:58', 'but I am not at home, can you deliver tomorrow');
  h.st('c1', '2026-10-02 15:00', 'agent_handling', 'resolved', 'close', A);
  const rh = h.run();
  assert.deepStrictEqual([one(rh, '2026-10-02', A, 'closed_waiting').points, pd(rh, '2026-10-02', A).points], [0, null]);
});
t('E22b closing a waiting chat with no team reply costs the same -2 (owner A2); a visitor\'s or an AI-mode chat stays free', () => {
  // Needs you after the AI hand-over, Anurag takes it, never replies, closes it: -2.
  const f = fx(); f.conv('c1', { status: 'resolved' });
  f.st('c1', '2026-10-05 10:59', 'ai_handling', 'human_needed', 'handover', 'ai');
  const q = f.v('c1', '2026-10-05 11:00', 'mera order kab aayega');
  f.hold('c1', '2026-10-05 11:05', null, A);
  f.st('c1', '2026-10-05 11:30', 'human_needed', 'resolved', 'close', A);
  let r = f.run();
  const c = one(r, D, A, 'closed_waiting');
  assert.deepStrictEqual([c.at, c.points, c.counted, c.msgs, c.why], [ist('2026-10-05 11:30'), -2, true, [q], 'Closed at 11:30 while the customer was waiting since 11:00.']);
  none(r, D, A, 'solved');
  assert.strictEqual(pd(r, D, A).points, -2);
  // The last team reply was 4 days ago (outside the 72 h credit window): -2.
  const g = fx(); g.conv('c1', { status: 'resolved' });
  g.v('c1', '2026-10-01 11:00', 'size?'); g.ag('c1', '2026-10-01 11:05', 'M size available hai', A); g.hold('c1', '2026-10-01 11:05', null, A);
  g.v('c1', '2026-10-05 11:00', 'mera order kab aayega');
  g.st('c1', '2026-10-05 11:30', 'agent_handling', 'resolved', 'close', A);
  assert.strictEqual(one(g.run(), D, A, 'closed_waiting').points, -2);
  // Nobody holds it, nobody replied, Rahul closes it from the open pool: Rahul -2.
  const h = fx(); h.conv('c1', { status: 'resolved' });
  h.st('c1', '2026-10-05 10:59', 'ai_handling', 'human_needed', 'handover', 'ai');
  h.v('c1', '2026-10-05 11:00', 'mera order abhi tak nahi aaya');
  h.st('c1', '2026-10-05 14:00', 'human_needed', 'resolved', 'close', R);
  r = h.run();
  assert.deepStrictEqual([one(r, D, R, 'closed_waiting').why, pd(r, D, R).points], ['Closed at 14:00 while the customer was waiting since 11:00.', -2]);
  // The same for an unverified visitor: closing junk stays free.
  const v = fx(); v.conv('c1', { status: 'resolved', known: false });
  v.st('c1', '2026-10-05 10:59', 'ai_handling', 'human_needed', 'handover', 'ai');
  v.v('c1', '2026-10-05 11:00', 'asdf');
  v.st('c1', '2026-10-05 14:00', 'human_needed', 'resolved', 'close', R);
  assert.strictEqual(dayOf(v.run(), D).items.filter((i) => i.kind === 'closed_waiting').length, 0);
  // AI mode (the AI is handling it), no team reply: free.
  const ai = fx(); ai.conv('c1', { status: 'resolved' });
  ai.v('c1', '2026-10-05 11:00', 'mera order kab aayega');
  ai.st('c1', '2026-10-05 11:05', 'ai_handling', 'resolved', 'close', A);
  assert.strictEqual(dayOf(ai.run(), D).items.filter((i) => i.kind === 'closed_waiting').length, 0);
  // The last reply came from an old login nobody can be credited with: the closer still pays.
  const u = heldByA(fx());
  u.ag('c1', '2026-10-05 10:00', 'Your order ships tomorrow', null, { login: 'oldstaff', eventActor: null });
  u.v('c1', '2026-10-05 10:30', 'but I need it today, can you check');
  u.st('c1', '2026-10-05 11:00', 'agent_handling', 'resolved', 'close', R);
  r = u.run();
  assert.deepStrictEqual([one(r, D, R, 'closed_waiting').points, its(r, D, null, 'solved').length], [-2, 0]);
});
t('E23 auto-close: solved only after thanks / theek hai / mil gaya, not after a bare "ok"', () => {
  for (const [last, exp] of [['thanks', 1], ['theek hai', 1], ['mil gaya', 1], ['ok', 0], ['k', 0]]) {
    const f = heldByA(fx({ now: '2026-10-07 23:00' }));
    f.v('c1', '2026-10-04 14:50', 'mera parcel kahan hai');
    f.ag('c1', '2026-10-04 14:52', 'Out for delivery today evening', A);
    f.v('c1', '2026-10-04 14:58', last);
    f.st('c1', '2026-10-05 15:00', 'agent_handling', 'resolved', 'auto_close', 'system');
    const r = f.run();
    assert.strictEqual(its(r, D, A, 'solved').length, exp, last);
    if (exp) assert.strictEqual(one(r, D, A, 'solved').why, 'Closed at 15:00 (automatically); Anurag gave the last reply at 4 Oct 14:52; no new message from the customer for 24 h.');
    assert.strictEqual(dayOf(r, D).items.filter((i) => i.kind === 'closed_waiting').length, 0);
  }
});
t('E24 a merge shell\'s close is never solved', () => {
  for (const reason of ['merged_away', 'close']) {
    const f = heldByA(fx());
    Object.assign(f.inp.convs[0], { status: 'resolved', mergedInto: 'c9' });
    f.ag('c1', '2026-10-05 14:52', 'Out for delivery today evening', A);
    f.st('c1', '2026-10-05 15:00', 'agent_handling', 'resolved', reason, 'system');
    none(f.run(), D, A, 'solved');
  }
  const g = heldByA(fx());
  g.ag('c1', '2026-10-05 14:52', 'Out for delivery today evening', A);
  g.st('c1', '2026-10-05 15:00', 'agent_handling', 'resolved', 'merged_away', 'system');
  none(g.run(), D, A, 'solved');
});

// ── Stayed angry and still frustrated ──────────────────────────
const angry = (o = {}) => {
  const f = heldByA(fx(o.fx || {}));
  f.inp.convs[0].known = o.known ?? true;
  if (o.wrote !== false) f.v('c1', '2026-10-05 11:59', 'abhi tak nahi aaya, fraud');
  for (const [at, s] of o.h || [['2026-10-05 09:00', 60], ['2026-10-05 12:00', 75]]) f.hl('c1', at, s);
  return f;
};
t('E25 held all day, 60 -> 75 at 12:00, customer wrote: -2 at 19:30', () => {
  const r = angry().run();
  const a = one(r, D, A, 'angry');
  assert.deepStrictEqual([a.at, a.points, a.counted], [ist('2026-10-05 19:30'), -2, true]);
  assert.strictEqual(a.why, 'At 19:30 Anurag held the chat; anger score 75 (65+ = angry), 60 when the day started for Anurag; angry for 450 office min; customer wrote today.');
  assert.strictEqual(pd(r, D, A).counts.angry, 1);
  assert.deepStrictEqual(pd(r, D, A).parts.angry, { n: 1, each: -2, points: -2 });
});
t('E25b 90 -> 70 (it got better): none', () => none(angry({ h: [['2026-10-05 09:00', 90], ['2026-10-05 12:00', 70]] }).run(), D, A, 'angry'));
t('E25c 75 first reached at 19:00 (30 min): none', () => none(angry({ h: [['2026-10-05 09:00', 60], ['2026-10-05 19:00', 75]] }).run(), D, A, 'angry'));
t('E25d customer silent that day: none', () => none(angry({ wrote: false }).run(), D, A, 'angry'));
t('E25e a visitor chat: none', () => none(angry({ known: false }).run(), D, A, 'angry'));
t('E25f closed at 18:00 at 80 (angry since 11:00): -2 at the close', () => {
  const f = angry({ h: [['2026-10-05 09:00', 40], ['2026-10-05 11:00', 80]] });
  f.st('c1', '2026-10-05 18:00', 'agent_handling', 'resolved', 'close', A);
  const a = one(f.run(), D, A, 'angry');
  assert.deepStrictEqual([a.at, a.points], [ist('2026-10-05 18:00'), -2]);
  assert.strictEqual(a.why, 'At the close at 18:00 Anurag held the chat; anger score 80 (65+ = angry), 40 when the day started for Anurag; angry for 420 office min; customer wrote today.');
});
t('E25g a day on or before the install day: angry and frustrated are "-"', () => {
  const f = heldByA(fx({ days: ['2026-10-02'], now: '2026-10-04 12:00' }), 'c1', A, '2026-10-01 21:00');
  f.v('c1', '2026-10-02 11:00', 'abhi tak nahi aaya'); f.ag('c1', '2026-10-02 11:30', 'Kal aayega', A);
  f.hl('c1', '2026-10-02 10:00', 90);
  const r = f.run();
  assert.deepStrictEqual([pd(r, '2026-10-02', A).counts.angry, pd(r, '2026-10-02', A).counts.frustrated, dayOf(r, '2026-10-02').healthOn], [null, null, false]);
  assert.strictEqual(its(r, '2026-10-02', A, 'angry').length + its(r, '2026-10-02', A, 'frustrated').length, 0);
});
t('E25h today before 19:30: not judged yet (only closes are)', () => {
  none(angry({ fx: { now: '2026-10-05 18:00' } }).run(), D, A, 'angry');
  assert.strictEqual(one(angry({ fx: { now: '2026-10-05 19:30' } }).run(), D, A, 'angry').at, ist('2026-10-05 19:30'));
});
t('E25i sent to Rahul at 19:00: the sender is not judged, Rahul held it 30 min only', () => {
  const f = angry();
  f.hold('c1', '2026-10-05 19:00', A, R); f.act('c1', '2026-10-05 19:00', 'transfer', A, { from: A, to: R, note: 'angry customer pls see' });
  const r = f.run();
  none(r, D, A, 'angry'); none(r, D, R, 'angry');
});
t('E26 replied to 2 known customers, 70 and 40 at the end of the day: frustrated 1', () => {
  const f = fx(); f.conv('c1'); f.conv('c2'); f.conv('c3', { known: false });
  f.ag('c1', '2026-10-05 12:00', 'Order in transit', A); f.ag('c2', '2026-10-05 12:00', 'Order in transit', A); f.ag('c3', '2026-10-05 12:00', 'Order in transit', A);
  f.hl('c1', '2026-10-05 11:00', 70); f.hl('c2', '2026-10-05 11:00', 40); f.hl('c3', '2026-10-05 11:00', 95);
  const r = f.run();
  const x = one(r, D, A, 'frustrated');
  assert.deepStrictEqual([x.conv, x.points, x.at, x.why], ['c1', 0, ist('2026-10-05 23:59') + 59_999, 'Anger score 70 at end of day (65+ = frustrated).']);
  assert.strictEqual(pd(r, D, A).counts.frustrated, 1);
  const g = fx({ now: '2026-10-05 18:00' }); g.conv('c1'); g.ag('c1', '2026-10-05 12:00', 'Order in transit', A); g.hl('c1', '2026-10-05 11:00', 70);
  const fg = one(g.run(), D, A, 'frustrated');
  assert.deepStrictEqual([fg.at, fg.why], [ist('2026-10-05 18:00'), 'Anger score 70 at now (65+ = frustrated).']);
});

// ── Events, attribution, points and ranking ────────────────────
t('E27 claim, take, transfer with a note, owner "Give all to the team" x2', () => {
  const f = fx(); for (const c of ['c1', 'c2', 'c3', 'c4', 'c5']) f.conv(c);
  f.act('c1', '2026-10-05 11:00', 'claim', A, { reason: 'reply', to: A });
  f.act('c2', '2026-10-05 11:10', 'take', R, { from: A, to: R, take: 'senior' });
  f.act('c3', '2026-10-05 11:20', 'transfer', A, { from: A, to: R, note: 'courier issue' });
  f.act('c4', '2026-10-05 11:30', 'transfer', 'owner', { from: 'owner', to: null, bulk: true });
  f.act('c5', '2026-10-05 11:30', 'transfer', 'owner', { from: 'owner', to: null, bulk: true });
  const r = f.run(), a = pd(r, D, A).counts, rr = pd(r, D, R).counts, o = pd(r, D, 'owner').counts;
  assert.deepStrictEqual([a.picked, a.picked_pool, a.taken_from, a.sent, a.received], [1, 1, 1, 1, 0]);
  assert.deepStrictEqual(a.sent_to, [{ key: R, name: 'Rahul', n: 1 }]);
  assert.strictEqual(one(r, D, A, 'sent').note, 'courier issue');
  assert.strictEqual(one(r, D, A, 'taken_from').why, 'Rahul took this chat (senior).');
  assert.deepStrictEqual([rr.picked, rr.picked_take, rr.picked_pool, rr.received], [1, 1, 0, 1]);
  assert.strictEqual(one(r, D, R, 'picked').why, 'Took it from Anurag (senior).');
  assert.deepStrictEqual([o.released, o.sent, o.picked], [2, 0, 0]);
  assert.ok(its(r, D).every((i) => i.points === 0));
  // A transfer to nobody (open pool) by a member: sent, peer null, no received.
  const g = fx(); g.conv('c1'); g.act('c1', '2026-10-05 11:00', 'transfer', A, { from: A, to: null, note: 'not mine' });
  const rg = g.run();
  assert.deepStrictEqual([one(rg, D, A, 'sent').peer, pd(rg, D, A).counts.sent_to], [null, [{ key: null, name: 'Open pool', n: 1 }]]);
});
t('E28 who wrote a reply: the reply event first, then the login; unknown logins go to the footer', () => {
  const f = fx(); f.conv('c1'); f.conv('c2'); f.conv('c3');
  f.ag('c1', '2026-10-05 12:00', 'hello there order shipped', A, { login: 'rahul', eventActor: A });
  f.ag('c2', '2026-10-05 12:00', 'hello there order shipped', null, { login: 'oldowner', eventActor: null });
  f.v('c2', '2026-10-05 12:10', 'thank you so much');
  f.ag('c3', '2026-10-05 12:00', 'hello there order shipped', null, { login: 'BOSS', eventActor: null });
  const r = f.run();
  assert.deepStrictEqual([pd(r, D, A).counts.replies, pd(r, D, R).counts.replies, pd(r, D, 'owner').counts.replies], [1, 0, 1]);
  assert.deepStrictEqual(dayOf(r, D).team.unattributed, [{ login: 'oldowner', replies: 1 }]);
  assert.strictEqual(dayOf(r, D).items.filter((i) => i.kind === 'thanks').length, 0);
  assert.ok(dayOf(r, D).items.every((i) => i.actor !== 'unattributed'));
  assert.strictEqual(pd(r, D, 'unattributed'), undefined);
});
t('E29 weights v2 from the next day; days before the points start: no points', () => {
  const settings = [...DEFAULT_SETTINGS, { id: 2, weights: { ...rules.DEFAULT_WEIGHTS, thanks: 5 }, effectiveFrom: D1, pointsFrom: '2026-10-03', createdAt: 1 }];
  const f = fx({ days: [D, D1], settings }); f.conv('c1'); f.conv('c2');
  f.ag('c1', '2026-10-05 13:00', 'Your order arrives on 7 Oct', A); f.v('c1', '2026-10-05 14:00', 'thank you');
  f.ag('c2', '2026-10-06 13:00', 'Your order arrives on 7 Oct', A); f.v('c2', '2026-10-06 14:00', 'thank you');
  const r = f.run();
  assert.deepStrictEqual([one(r, D, A, 'thanks').points, one(r, D1, A, 'thanks').points], [3, 5]);
  assert.deepStrictEqual([dayOf(r, D).settingsId, dayOf(r, D1).settingsId], [1, 2]);
  assert.deepStrictEqual([pd(r, D, A).points, pd(r, D1, A).points], [3, 5]);
  assert.deepStrictEqual(pd(r, D1, A).parts.thanks, { n: 1, each: 5, points: 5 });
  const g = fx({ days: ['2026-10-02'], now: '2026-10-04 12:00' }); g.conv('c1');
  g.ag('c1', '2026-10-02 13:00', 'Arrives 7 Oct', A); g.v('c1', '2026-10-02 14:00', 'thank you');
  const rg = g.run();
  assert.deepStrictEqual([dayOf(rg, '2026-10-02').pointsOn, pd(rg, '2026-10-02', A).points, one(rg, '2026-10-02', A, 'thanks').points],
    [false, null, 0]);
  assert.strictEqual(one(rg, '2026-10-02', A, 'thanks').counted, true);
  assert.deepStrictEqual(pd(rg, '2026-10-02', A).parts, {});
});
t('E30 mergeDays: distinct customers, null + 2 = 2, ranking, owner apart, switched-off member listed', () => {
  const f = fx({ days: ['2026-10-02', D, D1] }); f.conv('c1'); f.conv('c2'); f.conv('c3', { cuKey: 'c1' }); f.conv('c4');
  f.ag('c4', '2026-10-02 13:00', 'Your order arrives on 7 Oct', A);                          // a day with no points
  f.ag('c1', '2026-10-05 13:00', 'Your order arrives on 7 Oct', A); f.v('c1', '2026-10-05 14:00', 'thank you');
  f.ag('c3', '2026-10-06 13:00', 'Your order arrives on 7 Oct', A);                          // same customer, next day
  f.ag('c2', '2026-10-06 13:00', 'Your order arrives on 7 Oct', R); f.v('c2', '2026-10-06 14:00', 'thank you');
  f.ag('c2', '2026-10-06 15:00', 'welcome, hope it helped', V);
  f.ag('c4', '2026-10-06 16:00', 'Sorry for the delay, it ships today', 'owner');
  const r = f.run();
  assert.strictEqual(pd(r, '2026-10-02', A).points, null);
  const m = E.mergeDays(r.days, f.inp.people, f.inp.nowMs);
  const a = m.people.find((p) => p.key === A);
  assert.deepStrictEqual([a.counts.customers, a.counts.chats, a.counts.replies, a.points], [2, 3, 3, 3]);
  assert.strictEqual(a.counts.unanswered_2h, 0);          // "-" on one day + 0 on two
  assert.strictEqual(a.counts.online, null);              // several days: no online line
  assert.deepStrictEqual(m.people.map((p) => [p.name, p.rank, p.ranked]), [['Anurag', 1, true], ['Rahul', 2, true], ['Ravi', null, false]]);
  assert.deepStrictEqual([m.owner.key, m.owner.ranked, m.owner.rank, m.owner.counts.replies], ['owner', false, null, 1]);
  assert.deepStrictEqual(m.leader, { key: A, name: 'Anurag', thanks: 1 });
  assert.deepStrictEqual(a.parts.thanks, { n: 1, each: 3, points: 3 });
  const one1 = E.mergeDays([dayOf(r, D)], f.inp.people, f.inp.nowMs);
  assert.deepStrictEqual(one1.people.find((p) => p.key === A).counts.online, { first: '09:55', last: '19:00' });
  // Only days without points: points stay null; nobody thanked: no leader.
  const g = fx({ days: ['2026-10-02'], now: '2026-10-04 12:00' }); g.conv('c1'); g.ag('c1', '2026-10-02 13:00', 'Arrives soon', A);
  const mg = E.mergeDays(g.run().days, g.inp.people, g.inp.nowMs);
  assert.deepStrictEqual([mg.people.find((p) => p.key === A).points, mg.leader, mg.team.pool_waited_2h], [null, null, 0]);
  const before = E.mergeDays(fx({ days: ['2026-10-02'], now: '2026-10-04 12:00', eventsSince: '2026-10-03 10:00' }).run().days, f.inp.people, 0);
  assert.deepStrictEqual([before.team.pool_waited_2h, before.people[0].counts.unanswered_2h], [null, null]);
});
t('E30b ranking order: points, then thanks, then customers, then name', () => {
  const pdRow = (key, points, thanks, customers) => ({ key, points, parts: {}, cus: Array.from({ length: customers }, (_, i) => `k${key}${i}`),
    counts: { replies: 0, after_hours: 0, chats: 0, customers, thanks, thanks_pending: 0, thanks_not_counted: 0, asked_thanks: 0, convinced: 0,
      convinced_pending: 0, frustrated: null, unanswered_2h: null, taken_no_reply: null, picked: null, picked_pool: null, picked_take: null, sent: null,
      sent_to: [], received: null, taken_from: null, released: null, fast_reply: null, solved: null, solved_pending: null, closed_waiting: null,
      angry: null, holding_now: null, waiting_now: null, online: null, days_in: 1 } });
  const people = ['p1', 'p2', 'p3', 'p4', 'p5'].map((k, i) => ({ key: k, name: ['Esha', 'Dev', 'Chetan', 'Bina', 'Amit'][i], tier: 'junior', active: true, canReply: true, logins: [] }));
  const day = { day: D, settingsId: 1, pointsOn: true, eventsOn: true, healthOn: true, items: [], aiPending: 0,
    team: { pool_waited_2h: 0, absent_waits: 0, thanks_after_ai: 0, unattributed: [] },
    people: [pdRow('p1', 5, 1, 1), pdRow('p2', 5, 2, 1), pdRow('p3', 5, 2, 3), pdRow('p4', null, 9, 9), pdRow('p5', 5, 2, 3)] };
  const m = E.mergeDays([day], people, 0);
  assert.deepStrictEqual(m.people.map((p) => p.key), ['p5', 'p3', 'p2', 'p1', 'p4']);   // Amit / Chetan tie broken by name
  assert.deepStrictEqual(m.leader, { key: 'p4', name: 'Bina', thanks: 9 });
});
t('E30c a range where the weights changed: "n x each" only when every day had the same weight', () => {
  const settings = [...DEFAULT_SETTINGS, { id: 2, weights: { ...rules.DEFAULT_WEIGHTS, thanks: 5 }, effectiveFrom: D1, pointsFrom: '2026-10-03', createdAt: 1 }];
  const f = fx({ days: [D, D1], settings }); f.conv('c1'); f.conv('c2'); f.conv('c3');
  f.ag('c1', '2026-10-05 13:00', 'Your order arrives on 7 Oct', A); f.v('c1', '2026-10-05 14:00', 'thank you');
  f.ag('c2', '2026-10-05 13:00', 'Your order arrives on 8 Oct', A); f.v('c2', '2026-10-05 14:00', 'thank you');
  f.ag('c3', '2026-10-06 13:00', 'Your order arrives on 9 Oct', A); f.v('c3', '2026-10-06 14:00', 'thank you');
  const r = f.run();
  const a = E.mergeDays(r.days, f.inp.people, f.inp.nowMs).people.find((p) => p.key === A);
  assert.deepStrictEqual([a.points, a.parts.thanks], [11, { n: 3, each: null, points: 11 }]);   // 2 x 3 + 1 x 5, not "3 x +5"
  assert.deepStrictEqual(a.parts.solved, { n: 0, each: 2, points: 0 });                        // the same weight both days
  // One day, or days with the same weights: each stays the number.
  assert.deepStrictEqual(E.mergeDays([dayOf(r, D)], f.inp.people, f.inp.nowMs).people.find((p) => p.key === A).parts.thanks, { n: 2, each: 3, points: 6 });
});
const scenario = (now = '2026-10-09 12:00') => {
  const f = fx({ days: [D, D1], now }); f.conv('c1'); f.conv('c2'); heldByA(f, 'c5');
  f.hold('c1', '2026-10-04 12:00', null, A);
  f.v('c1', '2026-10-05 11:00', 'refund chahiye'); f.ag('c1', '2026-10-05 13:30', 'Order 2 din me aa jayega', A); f.v('c1', '2026-10-05 13:40', 'theek hai main wait kar lungi');
  f.st('c1', '2026-10-05 15:00', 'agent_handling', 'resolved', 'close', A);
  f.v('c2', '2026-10-05 12:00', 'order kab aayega'); f.hold('c2', '2026-10-05 12:10', null, R); f.act('c2', '2026-10-05 12:10', 'claim', R, { to: R, reason: 'take_over' });
  f.ag('c2', '2026-10-05 12:15', 'kal aa jayega', R); f.v('c2', '2026-10-05 12:20', 'thanks but kab tak?');
  f.v('c5', '2026-10-05 10:30', 'size exchange karna hai'); f.cs('c5', '2026-10-05 16:00', 'mark');
  f.hl('c1', '2026-10-05 11:30', 70); f.hl('c2', '2026-10-05 11:30', 80);
  return f;
};
t('E31 determinism: shuffled input gives byte-identical output', () => {
  const f = scenario();
  const base = JSON.stringify(f.run());
  assert.ok(JSON.parse(base).days[0].items.length >= 8);
  const sh = (a, seed) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = (i * seed + 7) % (i + 1); [b[i], b[j]] = [b[j], b[i]]; } return b; };
  for (const seed of [7919, 104729, 3]) {
    for (const k of ['convs', 'msgs', 'holders', 'statuses', 'cases', 'actions', 'health', 'presence', 'people', 'settings']) f.inp[k] = sh(f.inp[k], seed);
    assert.strictEqual(JSON.stringify(f.run()), base, `seed ${seed}`);
  }
});
t('E31b rows written after D+2 00:00 do not change day D', () => {
  const base = JSON.stringify(scenario().run().days[0]);
  const f = scenario();
  f.st('c1', '2026-10-07 11:00', 'resolved', 'human_needed', 'reopen', 'customer'); f.v('c1', '2026-10-07 11:00', 'abhi tak nahi aaya');
  f.ag('c2', '2026-10-07 12:00', 'sorry for the delay', R);
  f.hold('c1', '2026-10-07 13:00', A, R); f.act('c1', '2026-10-07 13:00', 'transfer', A, { from: A, to: R, note: 'pls see' }); f.hl('c1', '2026-10-07 13:00', 90);
  f.cs('c5', '2026-10-07 10:00', 'remove');
  assert.strictEqual(JSON.stringify(f.run().days[0]), base);
});
t('E32 speed: 3,000 chats, 40,000 messages, 2,000 holder rows in under 1.5 s', () => {
  const f = fx({ now: '2026-10-06 23:00' });
  let seed = 1;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const t0d = ist('2026-10-02 00:00');
  for (let c = 0; c < 3000; c++) f.conv('c' + c, { status: rnd() < 0.5 ? 'agent_handling' : 'human_needed' });
  const texts = ['mera order kab aayega', 'thank you', 'ok', 'refund chahiye', 'theek hai wait kar lunga', 'thanks but kab?', 'hello?'];
  for (let i = 0; i < 40000; i++) {
    const c = 'c' + Math.floor(rnd() * 3000), at = t0d + Math.floor(rnd() * 4 * 86_400_000), x = rnd();
    if (x < 0.5) f.inp.msgs.push({ id: 'x' + i, conv: c, sender: 'visitor', at, text: texts[i % texts.length], aiNotAnswer: false, noReply: false, login: null, eventActor: null });
    else if (x < 0.8) f.inp.msgs.push({ id: 'x' + i, conv: c, sender: 'agent', at, text: 'Your order is in transit and arrives soon', aiNotAnswer: false, noReply: false, login: null, eventActor: rnd() < 0.5 ? A : R });
    else f.inp.msgs.push({ id: 'x' + i, conv: c, sender: 'ai', at, text: '', aiNotAnswer: rnd() < 0.2, noReply: false, login: null, eventActor: null });
  }
  for (let i = 0; i < 2000; i++) f.inp.holders.push({ id: i + 1, conv: 'c' + Math.floor(rnd() * 3000), at: t0d + Math.floor(rnd() * 4 * 86_400_000), from: null, to: rnd() < 0.5 ? A : R });
  for (let i = 0; i < 3000; i++) f.inp.health.push({ conv: 'c' + i, at: t0d + Math.floor(rnd() * 4 * 86_400_000), score: Math.floor(rnd() * 100) });
  for (let i = 0; i < 1500; i++) f.inp.statuses.push({ id: i + 1, conv: 'c' + Math.floor(rnd() * 3000), at: t0d + Math.floor(rnd() * 4 * 86_400_000), from: 'agent_handling', to: rnd() < 0.5 ? 'resolved' : 'agent_handling', reason: 'close', actor: A });
  const t0 = Date.now(); const r = f.run(); const ms = Date.now() - t0;
  assert.ok(r.days[0].items.length > 1000);
  assert.ok(ms < 1500, `${ms} ms`);
});
t('E32b speed (fifth pass, D): one customer, one member, 2,000 new questions after an acceptance in one day: one walk back, under 300 ms, still the +2', () => {
  const f = heldByA(fx());
  f.v('c1', '2026-10-05 10:00', 'mera order abhi tak nahi aaya, refund chahiye');
  f.ag('c1', '2026-10-05 10:01', 'Courier se baat ki, kal pakka aa jayega', A);
  const m = f.v('c1', '2026-10-05 10:02', 'theek hai');
  const t0 = ist('2026-10-05 10:03');
  for (let i = 0; i < 2000; i++) {
    f.inp.msgs.push({ id: 'q' + i, conv: 'c1', sender: 'visitor', at: t0 + i * 15_000, text: 'aur mera dusra order kab dispatch hoga ' + i,
      aiNotAnswer: false, noReply: false, login: null, eventActor: null });
  }
  let best = Infinity, r = null;
  for (let k = 0; k < 3 && best >= 300; k++) { const s0 = Date.now(); r = f.run(); best = Math.min(best, Date.now() - s0); }
  assert.ok(best < 300, `${best} ms`);
  const c = one(r, D, A, 'convinced');
  assert.deepStrictEqual([c.counted, c.points, c.msgs[2], r.candidates.length], [true, 2, m, 0]);
});
t('E33 a day before part 3 went live: event numbers "-", replies and thanks still counted, no points', () => {
  const f = heldByA(fx({ eventsSince: '2026-10-06 10:00' }));
  f.v('c1', '2026-10-05 11:00', 'order kab'); f.ag('c1', '2026-10-05 13:00', 'Your order arrives on 7 Oct', A); f.v('c1', '2026-10-05 14:00', 'thank you');
  f.act('c1', '2026-10-05 13:00', 'claim', A, { reason: 'reply', to: A });
  f.st('c1', '2026-10-05 15:00', 'agent_handling', 'resolved', 'close', A);
  const r = f.run(), c = pd(r, D, A).counts;
  for (const k of ['unanswered_2h', 'taken_no_reply', 'picked', 'picked_pool', 'sent', 'received', 'fast_reply', 'solved', 'closed_waiting']) assert.strictEqual(c[k], null, k);
  assert.deepStrictEqual([c.chats, c.replies, c.thanks, pd(r, D, A).points, dayOf(r, D).eventsOn, dayOf(r, D).team.pool_waited_2h], [1, 1, 1, null, false, null]);
  assert.deepStrictEqual(kinds(r, D, A).filter((k) => !['chat', 'thanks', 'frustrated', 'angry', 'convinced'].includes(k)), []);
  assert.deepStrictEqual([fx({ eventsSince: null }).run().days[0].eventsOn], [false]);
});
t('E34 a reply deleted by its author is not loaded: the wait goes on; one deleted by someone else counts', () => {
  const f = heldByA(fx());
  f.v('c1', '2026-10-05 11:00', 'mera order kab aayega bhai');
  one(f.run(), D, A, 'unanswered_2h');                                         // absent reply => item
  f.ag('c1', '2026-10-05 11:30', 'Kal aa jayega', A);                          // loaded (deleted by another person)
  const r = f.run();
  none(r, D, A, 'unanswered_2h'); none(r, D, A, 'taken_no_reply');
});
t('E35 Take at 14:00, "hi" at 14:01, real reply at 14:20: no +1 and no -3; real reply at 14:08: +1', () => {
  const mk = (real) => {
    const f = fx(); f.conv('c1', { status: 'agent_handling' });
    f.hold('c1', '2026-10-05 09:00', null, R);
    f.v('c1', '2026-10-05 13:50', 'mera order kab aayega');
    f.hold('c1', '2026-10-05 14:00', R, A); f.act('c1', '2026-10-05 14:00', 'take', A, { from: R, to: A, take: 'holder_away' });
    f.ag('c1', '2026-10-05 14:01', 'hi', A); f.ag('c1', real, 'Aapka order kal deliver ho jayega', A);
    return f.run();
  };
  let r = mk('2026-10-05 14:20');
  none(r, D, A, 'fast_reply'); none(r, D, A, 'unanswered_2h');
  r = mk('2026-10-05 14:08');
  const fr = one(r, D, A, 'fast_reply');
  assert.deepStrictEqual([fr.at, fr.why], [ist('2026-10-05 14:08'), 'Anurag took the chat at 14:00 (from Rahul) while the customer waited; first real reply at 14:08: 8 office min.']);
  assert.strictEqual(one(r, D, A, 'chat').n, 2);
});

// ── Spec section 6 edge cases ──────────────────────────────────
t('X1 night (case 29): customer 19:00, answered 11:29 next day = 119 office min, no -3; at 11:31: -3 at 11:30', () => {
  for (const [ans, exp] of [['2026-10-06 11:29', 0], ['2026-10-06 11:31', 1]]) {
    const f = heldByA(fx({ days: [D, D1] }));
    f.v('c1', '2026-10-05 19:00', 'mera order kab aayega bhai'); f.ag('c1', ans, 'Kal tak aa jayega', A);
    const r = f.run();
    none(r, D, A, 'unanswered_2h');
    assert.strictEqual(its(r, D1, A, 'unanswered_2h').length, exp, ans);
    if (exp) assert.strictEqual(one(r, D1, A, 'unanswered_2h').at, ist('2026-10-06 11:30'));
  }
});
t('X2 the Super Admin holding a chat is judged in his own row (case 10)', () => {
  const f = heldByA(fx(), 'c1', 'owner');
  f.inp.presence.push({ actor: 'owner', day: D, first: ist('2026-10-05 09:30'), last: ist('2026-10-05 20:00') });
  f.v('c1', '2026-10-05 11:00', 'mera order kab aayega bhai');
  let r = f.run();
  assert.strictEqual(one(r, D, 'owner', 'unanswered_2h').at, ist('2026-10-05 13:00'));
  assert.strictEqual(pd(r, D, 'owner').points, -3);
  none(r, D, A, 'unanswered_2h');
  const m = E.mergeDays(r.days, f.inp.people, f.inp.nowMs);
  assert.deepStrictEqual([m.owner.points, m.people.some((p) => p.key === 'owner')], [-3, false]);
  f.inp.presence = f.inp.presence.filter((p) => p.actor !== 'owner');      // not in that day: no minus, team line
  r = f.run();
  none(r, D, 'owner', 'unanswered_2h');
  assert.strictEqual(dayOf(r, D).team.absent_waits, 1);
});
t('X3 "Give all to the team" (case 11): released, later waits are open-pool waits', () => {
  const f = heldByA(fx(), 'c1', 'owner');
  f.inp.presence.push({ actor: 'owner', day: D, first: ist('2026-10-05 09:30'), last: ist('2026-10-05 20:00') });
  f.v('c1', '2026-10-05 10:00', 'mera order kab aayega bhai');
  f.hold('c1', '2026-10-05 11:00', 'owner', null); f.act('c1', '2026-10-05 11:00', 'transfer', 'owner', { from: 'owner', to: null, bulk: true });
  const r = f.run();
  assert.deepStrictEqual(kinds(r, D, 'owner'), ['released', 'taken_no_reply']);
  assert.strictEqual(dayOf(r, D).team.pool_waited_2h, 1);
});
t('X4 away-cover take after a -3 (case 13): the -3 stays, taken_from, the taker\'s 10 minutes', () => {
  const f = heldByA(fx());
  f.v('c1', '2026-10-05 11:00', 'mera order kab aayega bhai');
  f.hold('c1', '2026-10-05 14:00', A, R); f.act('c1', '2026-10-05 14:00', 'take', R, { from: A, to: R, take: 'holder_away' });
  f.ag('c1', '2026-10-05 14:05', 'Sorry for the wait, it arrives tomorrow', R);
  const r = f.run();
  assert.strictEqual(one(r, D, A, 'unanswered_2h').at, ist('2026-10-05 13:00'));
  assert.strictEqual(one(r, D, A, 'taken_from').peer, R);
  assert.strictEqual(one(r, D, R, 'fast_reply').why, 'Rahul took the chat at 14:00 (from Anurag) while the customer waited; first real reply at 14:05: 5 office min.');
  none(r, D, R, 'unanswered_2h');
});
t('X5 two people, same customer, same day (case 27): each earns a thank-you', () => {
  const f = heldByA(fx());
  f.ag('c1', '2026-10-05 11:00', 'Your order arrives on 7 Oct', A); f.v('c1', '2026-10-05 11:10', 'thank you');
  f.hold('c1', '2026-10-05 14:00', A, R); f.act('c1', '2026-10-05 14:00', 'transfer', A, { from: A, to: R, note: 'size exchange' });
  f.v('c1', '2026-10-05 14:30', 'size L me exchange ho jayega?'); f.ag('c1', '2026-10-05 14:35', 'Yes, exchange booked for size L', R); f.v('c1', '2026-10-05 14:40', 'thanks a lot');
  const r = f.run();
  assert.deepStrictEqual([one(r, D, A, 'thanks').counted, one(r, D, R, 'thanks').counted], [true, true]);
  none(r, D, R, 'fast_reply');                    // the customer was not waiting when Rahul got the chat
});
t('X6 email (case 24): the quote and sign-off are stripped before judging', () => {
  const f = fx(); f.conv('e1', { source: 'email', known: true });
  f.ag('e1', '2026-10-05 11:00', 'Your order arrives on 7 Oct', A);
  f.v('e1', '2026-10-05 12:00', 'Got it, thank you\n\nOn Mon, 5 Oct 2026, Vastora Support wrote:\n> Your order arrives on 7 Oct');
  f.ag('e1', '2026-10-06 11:00', 'Order shipped', R);
  let r = f.run();
  assert.strictEqual(one(r, D, A, 'thanks').counted, true);
  const g = fx(); g.conv('e1', { source: 'email', known: true });
  g.ag('e1', '2026-10-05 11:00', 'Your order arrives on 7 Oct', A);
  g.v('e1', '2026-10-05 12:00', 'Where is my order?\n\nThanks,\nRam');
  r = g.run();
  none(r, D, A, 'thanks');
  assert.ok(r.days[0].items.every((i) => !i.why.includes('Ram')));
  // An email sender who never verified (order ID + phone) is a visitor too (owner A3).
  const h = fx(); h.conv('e1', { source: 'email', known: false });
  h.ag('e1', '2026-10-05 11:00', 'Your order arrives on 7 Oct', A);
  h.v('e1', '2026-10-05 12:00', 'Got it, thank you\n\nOn Mon, 5 Oct 2026, Vastora Support wrote:\n> Your order arrives on 7 Oct');
  const th = one(h.run(), D, A, 'thanks');
  assert.deepStrictEqual([th.counted, th.points, th.why], [false, 0, 'Visitor not verified']);
});
t('X7 "ok got it thanks" after a team answer stops the clock (case 41); "hello?" does not', () => {
  for (const [last, exp] of [['ok got it thanks', 0], ['theek hai', 0], ['👍', 0], ['hello?', 1], ['hi', 1], ['Please check my order status. Thank you', 1]]) {
    const f = heldByA(fx());
    f.inp.convs[0].status = 'human_needed';
    f.v('c1', '2026-10-05 10:30', 'mera order kab aayega');
    f.ag('c1', '2026-10-05 10:40', 'Your order arrives on 7 Oct', A);
    f.v('c1', '2026-10-05 11:00', last);
    assert.strictEqual(its(f.run(), D, A, 'unanswered_2h').length, exp, last);
  }
  // Needs you with no team answer yet: even "ok" waits (the inbox rule).
  const g = fx(); g.conv('c1', { status: 'human_needed' }); g.hold('c1', '2026-10-04 12:00', null, A);
  g.st('c1', '2026-10-05 10:00', 'ai_handling', 'human_needed', 'handover', 'ai'); g.v('c1', '2026-10-05 10:59', 'refund chahiye'); g.v('c1', '2026-10-05 11:00', 'ok');
  assert.strictEqual(one(g.run(), D, A, 'unanswered_2h').at, ist('2026-10-05 12:59'));   // from the first unanswered message
});
t('X7b a courtesy nudge ("sir", "bhai") after a question nobody answered keeps the clock; a real thank-you still ends the wait', () => {
  const mk = (nudge, close) => {
    const f = heldByA(fx());
    f.v('c1', '2026-10-05 10:30', 'M size hai?');
    f.ag('c1', '2026-10-05 10:35', 'Haan M size available hai', A);
    const q = f.v('c1', '2026-10-05 12:00', 'mera order kab aayega? 3 din ho gaye');
    if (nudge) f.v('c1', '2026-10-05 12:30', nudge);
    if (close) f.st('c1', '2026-10-05 12:45', 'agent_handling', 'resolved', 'close', A);
    return { f, q };
  };
  for (const nudge of [null, 'sir', 'bhai', 'sir ji']) {
    const { f, q } = mk(nudge, false);
    const u = one(f.run(), D, A, 'unanswered_2h');
    assert.deepStrictEqual([u.at, u.points, u.msgs], [ist('2026-10-05 14:00'), -3, [q]], String(nudge));
    const r = mk(nudge, true).f.run();
    assert.deepStrictEqual([one(r, D, A, 'closed_waiting').points, its(r, D, A, 'solved').length], [-2, 0], String(nudge));
  }
  // "sir" right after Anurag's answer is a sign-off: closing then is solved (+2), no -3.
  const h = heldByA(fx());
  h.v('c1', '2026-10-05 10:30', 'mera order kab aayega');
  h.ag('c1', '2026-10-05 10:35', 'Aapka order 7 Oct ko aa jayega', A);
  h.v('c1', '2026-10-05 10:40', 'sir');
  h.st('c1', '2026-10-05 12:45', 'agent_handling', 'resolved', 'close', A);
  const rh = h.run();
  assert.deepStrictEqual([one(rh, D, A, 'solved').counted, one(rh, D, A, 'solved').points], [true, 2]);
  none(rh, D, A, 'closed_waiting'); none(rh, D, A, 'unanswered_2h');
  // "got it thanks" after an unanswered question: the thank-you (+3), and no -3 for the same message.
  const k = heldByA(fx());
  k.v('c1', '2026-10-05 10:30', 'M size hai?');
  k.ag('c1', '2026-10-05 10:35', 'Haan M size available hai', A);
  k.v('c1', '2026-10-05 12:00', 'mera order kab aayega? 3 din ho gaye');
  k.v('c1', '2026-10-05 12:30', 'got it thanks');
  const rk = k.run();
  assert.deepStrictEqual([one(rk, D, A, 'thanks').counted, one(rk, D, A, 'thanks').points], [true, 3]);
  none(rk, D, A, 'unanswered_2h');
});
t('X8 one -3 per person per customer per day, across the customer\'s chats', () => {
  const f = heldByA(fx()); heldByA(f, 'c2'); f.inp.convs[1].cu = f.inp.convs[0].cu;
  f.v('c1', '2026-10-05 11:00', 'mera order kab aayega bhai'); f.v('c2', '2026-10-05 11:30', 'hello? reply karo');
  const r = f.run();
  const u = one(r, D, A, 'unanswered_2h');
  assert.deepStrictEqual([u.conv, u.at], ['c1', ist('2026-10-05 13:00')]);
  assert.strictEqual(its(r, D, A, 'taken_no_reply').length, 1);
});
t('X9 a transfer received while the customer waits is a pickup (sent by)', () => {
  const f = heldByA(fx());
  f.v('c1', '2026-10-05 13:55', 'mera order kab aayega bhai');
  f.hold('c1', '2026-10-05 14:00', A, R); f.act('c1', '2026-10-05 14:00', 'transfer', A, { from: A, to: R, note: 'courier query' });
  f.ag('c1', '2026-10-05 14:05', 'It arrives on 7 Oct', R);
  assert.strictEqual(one(f.run(), D, R, 'fast_reply').why, 'Rahul took the chat at 14:00 (sent by Anurag) while the customer waited; first real reply at 14:05: 5 office min.');
});
t('X10 no 10-minute reply when the customer was not waiting, or someone else answered first', () => {
  let f = fx(); f.conv('c1');
  f.v('c1', '2026-10-05 13:50', 'mera order kab aayega'); f.ag('c1', '2026-10-05 13:55', 'Kal aa jayega', 'owner');
  f.hold('c1', '2026-10-05 14:00', null, A); f.act('c1', '2026-10-05 14:00', 'claim', A, { reason: 'take_over', to: A });
  f.ag('c1', '2026-10-05 14:02', 'Main dekh raha hu, tracking update aa gaya', A);
  none(f.run(), D, A, 'fast_reply');
  f = fx(); f.conv('c1');
  f.v('c1', '2026-10-05 13:50', 'mera order kab aayega');
  f.hold('c1', '2026-10-05 14:00', null, A); f.act('c1', '2026-10-05 14:00', 'claim', A, { reason: 'take_over', to: A });
  f.ag('c1', '2026-10-05 14:02', 'Kal aa jayega', 'owner'); f.ag('c1', '2026-10-05 14:03', 'Haan, kal tak deliver hoga', A);
  none(f.run(), D, A, 'fast_reply');
  // A real AI answer before the member's reply: no +1 either.
  f = fx(); f.conv('c1');
  f.v('c1', '2026-10-05 13:50', 'mera order kab aayega');
  f.hold('c1', '2026-10-05 14:00', null, A); f.act('c1', '2026-10-05 14:00', 'claim', A, { reason: 'take_over', to: A });
  f.ai('c1', '2026-10-05 14:01'); f.ag('c1', '2026-10-05 14:03', 'Haan, kal tak deliver hoga', A);
  none(f.run(), D, A, 'fast_reply');
});
t('X11 an AI-pending thanks does not take the day\'s slot', () => {
  const f = heldByA(fx());
  f.ag('c1', '2026-10-05 15:50', 'Order is in transit', A);
  f.v('c1', '2026-10-05 16:00', 'thanks but kab aayega?'); f.ag('c1', '2026-10-05 16:10', 'It arrives on 7 Oct', A); f.v('c1', '2026-10-05 16:30', 'thank you');
  const th = its(f.run(), D, A, 'thanks');
  assert.deepStrictEqual(th.map((x) => [x.pending, x.counted]), [[true, false], [false, true]]);
});
t('X12 live numbers only for today: holding now and waiting now', () => {
  const f = fx({ now: '2026-10-05 15:00' });
  f.conv('c1', { status: 'agent_handling', assignedTo: A, assignedAt: ist('2026-10-05 10:00') });
  f.conv('c2', { status: 'human_needed', assignedTo: A, assignedAt: ist('2026-10-05 10:00') });
  f.conv('c3', { status: 'resolved', assignedTo: A, assignedAt: ist('2026-10-05 10:00') });
  f.conv('c4', { status: 'agent_handling', assignedTo: A, assignedAt: ist('2026-10-05 10:00'), caseNow: true });
  f.v('c1', '2026-10-05 14:00', 'kab aayega'); f.v('c2', '2026-10-05 13:00', 'kab aayega'); f.ag('c2', '2026-10-05 13:10', 'Kal', A);
  let c = pd(f.run(), D, A).counts;
  assert.deepStrictEqual([c.holding_now, c.waiting_now], [2, 1]);
  c = pd(fx({ days: [D] }).run(), D, A).counts;
  assert.deepStrictEqual([c.holding_now, c.waiting_now], [null, null]);
});
t('X13 who is listed: active members (zeroes), the owner, anyone with an item; online and days in', () => {
  const r = fx().run();
  const keys = dayOf(r, D).people.map((p) => p.key).sort();
  assert.deepStrictEqual(keys, [A, R, 'owner'].sort());
  const a = pd(r, D, A);
  assert.deepStrictEqual([a.counts.replies, a.counts.online, a.counts.days_in, a.points, a.cus], [0, { first: '09:55', last: '19:00' }, 1, 0, []]);
  assert.deepStrictEqual([pd(r, D, 'owner').counts.online, pd(r, D, 'owner').counts.days_in], [null, 0]);
});
t('X14 a request ending in "thank you" is not a sure thank-you and keeps the clock running', () => {
  const f = heldByA(fx());
  f.ag('c1', '2026-10-05 10:30', 'Your order arrives on 7 Oct', A);
  f.v('c1', '2026-10-05 11:00', 'Please check my order status. Thank you', { id: 'mQ' });
  const r = f.run();
  const th = one(r, D, A, 'thanks');
  assert.deepStrictEqual([th.counted, th.pending, th.points], [false, true, 0]);
  assert.deepStrictEqual(r.candidates.map((x) => x.messageId), ['mQ']);
  assert.strictEqual(one(r, D, A, 'unanswered_2h').at, ist('2026-10-05 13:00'));
});
t('X15 after-hours replies count as replies, marked outside 10:00-19:30', () => {
  const f = fx(); f.conv('c1');
  f.ag('c1', '2026-10-05 09:30', 'Good morning, checking', A); f.ag('c1', '2026-10-05 12:00', 'It ships today', A); f.ag('c1', '2026-10-05 21:00', 'Shipped now', A);
  const r = f.run();
  const ch = one(r, D, A, 'chat');
  assert.deepStrictEqual([ch.n, ch.after, ch.at], [3, 2, ist('2026-10-05 09:30')]);
  assert.strictEqual(ch.why, 'Anurag sent 3 replies in this chat (2 outside 10:00-19:30).');
  assert.deepStrictEqual([pd(r, D, A).counts.replies, pd(r, D, A).counts.after_hours], [3, 2]);
});
t('X16 no customer text and no raw customer key ever leaves the engine', () => {
  const f = scenario();
  // Not a new question or request, so it is the last word after "theek hai" and goes to the AI (E19g).
  f.v('c1', '2026-10-05 16:00', 'mera number 9876543210 hai SECRETWORD');
  const res = f.run();
  const out = JSON.stringify(res.days);                   // what the report shows and freezes
  assert.ok(!out.includes('SECRETWORD') && !/9876543210/.test(out));
  assert.ok(res.candidates.some((c) => c.customerText.includes('SECRETWORD')));   // only the judge's queue carries text (masked when sent)
  for (const it of JSON.parse(out).flatMap((d) => d.items)) {
    assert.ok(/^[kc][0-9a-f]{32}$/.test(it.cu), it.cu);
    assert.ok(!/refund chahiye|theek hai main|order kab aayega/.test(it.why), it.why);
  }
});

t('X18 the per-chat timeline (spec 3.5.1): status, case, holder and score before, at and after their rows', () => {
  const f = fx();
  f.conv('c1', { status: 'resolved', caseNow: true, assignedTo: R, assignedAt: ist('2026-10-05 15:00') });
  f.conv('c2', { status: 'human_needed', caseNow: true, assignedTo: V, assignedAt: null });
  f.conv('c3', { status: 'agent_handling', caseNow: false });
  f.st('c1', '2026-10-05 12:00', 'agent_handling', 'resolved', 'close', A);
  f.cs('c1', '2026-10-05 12:00', 'mark');
  f.hold('c1', '2026-10-05 11:00', 'owner', A);
  f.cs('c3', '2026-10-05 12:00', 'remove');
  f.hl('c1', '2026-10-05 11:00', 70); f.hl('c1', '2026-10-05 13:00', 40);
  f.v('c1', '2026-10-05 10:00', 'kab aayega'); f.ag('c1', '2026-10-05 10:30', 'Kal', A); f.v('c1', '2026-10-05 10:45', 'hello?');
  const tl = E.makeTimeline(f.inp);
  const at = (h) => ist('2026-10-05 ' + h);
  // Status: the last row at or before t, else the first row's "from", else the chat's own status.
  assert.deepStrictEqual([tl.statusAt('c1', at('11:59')), tl.statusAt('c1', at('12:00')), tl.statusAt('c2', at('11:00'))], ['agent_handling', 'resolved', 'human_needed']);
  // Case: the last row; before a first "remove" it was on; before a first "mark" it was off; no rows: caseNow.
  assert.deepStrictEqual([tl.caseOn('c1', at('11:59')), tl.caseOn('c1', at('12:00')), tl.caseOn('c3', at('11:00')), tl.caseOn('c3', at('12:00')), tl.caseOn('c2', at('11:00'))],
    [false, true, true, false, true]);
  // Holder: the last row; before the first row its "from"; no rows: assignedTo from assignedAt on.
  assert.deepStrictEqual([tl.holderAt('c1', at('10:59')), tl.holderAt('c1', at('11:00')), tl.holderAt('c2', at('09:00'))], ['owner', A, V]);
  assert.strictEqual(tl.effectiveHolder('c2', at('09:00')), null);                       // switched off: nobody
  const g = fx(); g.conv('c1', { assignedTo: R, assignedAt: ist('2026-10-05 15:00') });
  const tg = E.makeTimeline(g.inp);
  assert.deepStrictEqual([tg.holderAt('c1', at('14:59')), tg.holderAt('c1', at('15:00'))], [null, R]);
  // Waiting: inclusive or not of what happens at t; a nudge after the answer waits.
  assert.deepStrictEqual([tl.waitAt('c1', at('10:00'), false), tl.waitAt('c1', at('10:00'), true), tl.waitAt('c1', at('10:30'), true), tl.waitAt('c1', at('11:00'), true)],
    [null, at('10:00'), null, at('10:45')]);
  assert.strictEqual(tl.waitAt('c1', at('12:00'), true), null);                          // closed
  // Score: the last health row at or before t.
  assert.deepStrictEqual([tl.score('c1', at('10:59')), tl.score('c1', at('11:00')), tl.score('c1', at('13:30'))], [null, 70, 40]);
});

// ── Owner answers 2026-10-02 ───────────────────────────────────
t('X19 owner A3: thanks / convinced count only for verified customers; a visitor is never sent to the AI', () => {
  // A sure thank-you from a visitor: shown, not counted, no points, no slot.
  const f = fx(); f.conv('v1', { known: false });
  const rep = f.ag('v1', '2026-10-05 13:00', 'Your order arrives on 7 Oct', A);
  const m = f.v('v1', '2026-10-05 13:10', 'thank you so much');
  let r = f.run();
  let th = one(r, D, A, 'thanks');
  assert.deepStrictEqual([th.counted, th.pending, th.points, th.by, th.why, th.msgs], [false, false, 0, 'keyword', 'Visitor not verified', [rep, m]]);
  assert.deepStrictEqual([pd(r, D, A).counts.thanks, pd(r, D, A).counts.thanks_not_counted, pd(r, D, A).points, pd(r, D, A).parts.thanks],
    [0, 1, 0, { n: 0, each: 3, points: 0 }]);
  assert.strictEqual(E.NOT_VERIFIED_WHY, 'Visitor not verified');
  // The same words from a verified customer: +3.
  const g = fx(); g.conv('k1');
  g.ag('k1', '2026-10-05 13:00', 'Your order arrives on 7 Oct', A); g.v('k1', '2026-10-05 13:10', 'thank you so much');
  th = one(g.run(), D, A, 'thanks');
  assert.deepStrictEqual([th.counted, th.points], [true, 3]);
  // An unsure visitor message: no item, never an AI candidate, nothing pending.
  const u = fx(); u.conv('v1', { known: false }); u.conv('k1');
  u.ag('v1', '2026-10-05 15:50', 'Order is in transit', A); u.v('v1', '2026-10-05 16:00', 'thanks but kab aayega?', { id: 'mV' });
  u.ag('k1', '2026-10-05 15:50', 'Order is in transit', A); u.v('k1', '2026-10-05 16:00', 'thanks but kab aayega?', { id: 'mK' });
  r = u.run();
  assert.deepStrictEqual(its(r, D, A, 'thanks').map((i) => [i.conv, i.pending]), [['k1', true]]);
  assert.deepStrictEqual([r.candidates.map((c) => c.messageId), dayOf(r, D).aiPending, pd(r, D, A).counts.thanks_pending], [['mK'], 1, 1]);
  // A verdict saved before (any reason): a yes is still not counted for a visitor.
  u.inp.verdicts = { mV: { thanks: true, convinced: false, source: 'ai' } };
  th = its(u.run(), D, A, 'thanks').find((i) => i.conv === 'v1');
  assert.deepStrictEqual([th.counted, th.pending, th.by, th.why], [false, false, 'ai', 'Visitor not verified']);
  // Convinced from a visitor: shown, not counted; an unsure one is not judged.
  const c = fx(); c.conv('v1', { known: false });
  c.v('v1', '2026-10-05 11:00', 'refund chahiye'); c.ag('v1', '2026-10-05 11:10', 'Order 2 din me aa jayega, festive season hai', A);
  c.v('v1', '2026-10-05 11:20', 'theek hai main wait kar lungi');
  r = c.run();
  const cv = one(r, D, A, 'convinced');
  assert.deepStrictEqual([cv.counted, cv.pending, cv.points, cv.by, cv.why], [false, false, 0, 'keyword', 'Visitor not verified']);
  assert.deepStrictEqual([pd(r, D, A).counts.convinced, pd(r, D, A).counts.convinced_pending, pd(r, D, A).counts.convinced_not_counted, pd(r, D, A).points],
    [0, 0, 1, 0], 'the not-counted "Convinced" can be opened (review 2026-10-02)');
  const cu = fx(); cu.conv('v1', { known: false });
  cu.v('v1', '2026-10-05 11:00', 'abhi tak nahi aaya'); cu.ag('v1', '2026-10-05 11:10', 'Courier delay hai, kal tak aa jayega', A);
  cu.v('v1', '2026-10-05 11:20', 'Okay I will wait but please make sure it reaches by Monday as it is a gift?', { id: 'mC' });
  r = cu.run();
  none(r, D, A, 'convinced');
  assert.deepStrictEqual([r.candidates.length, dayOf(r, D).aiPending], [0, 0]);
  cu.inp.verdicts = { mC: { thanks: false, convinced: true, source: 'ai' } };
  assert.deepStrictEqual([one(cu.run(), D, A, 'convinced').counted, one(cu.run(), D, A, 'convinced').why], [false, 'Visitor not verified']);
  // A visitor's thanks after an AI answer: not in the team line either.
  const a = fx(); a.conv('v1', { known: false });
  a.v('v1', '2026-10-05 13:00', 'where is my parcel'); a.ai('v1', '2026-10-05 13:01'); a.v('v1', '2026-10-05 13:05', 'thank you so much');
  r = a.run();
  assert.deepStrictEqual([its(r, D, 'ai', 'thanks').length, dayOf(r, D).team.thanks_after_ai], [0, 0]);
});
t('X20 owner A4: points start on the install day; angry the day after; from the install day presence decides', () => {
  const I = '2026-10-02';                                   // fx() installs at 2026-10-02 12:00
  const settings = [{ id: 1, weights: rules.DEFAULT_WEIGHTS, effectiveFrom: '2026-01-01', pointsFrom: I, createdAt: 0 }];
  const f = heldByA(fx({ days: [I], now: '2026-10-04 12:00', settings }), 'c1', A, '2026-10-01 21:00');
  f.ag('c1', '2026-10-02 13:00', 'Your order arrives on 7 Oct', A); f.v('c1', '2026-10-02 14:00', 'thank you');
  f.hl('c1', '2026-10-02 10:00', 90);
  let r = f.run();
  assert.deepStrictEqual([dayOf(r, I).pointsOn, dayOf(r, I).healthOn, one(r, I, A, 'thanks').points, pd(r, I, A).points, pd(r, I, A).counts.angry],
    [true, false, 3, 3, null]);
  // Install day, member not in (no presence, no action that day): no -3; the team line counts the wait.
  const wait = (presence, day, customerAt) => {
    const g = fx({ days: [day], now: '2026-10-04 12:00', settings, presence });
    g.conv('c1'); g.hold('c1', '2026-09-30 12:00', null, A);
    g.v('c1', customerAt, 'mera order kab aayega bhai');
    return g;
  };
  r = wait(false, I, '2026-10-02 11:00').run();
  none(r, I, A, 'unanswered_2h');
  assert.deepStrictEqual([pd(r, I, A).points, dayOf(r, I).team.absent_waits], [0, 1]);
  // In that day (presence from 09:55): -3 at 13:00.
  r = wait(undefined, I, '2026-10-02 11:00').run();
  const u = one(r, I, A, 'unanswered_2h');
  assert.deepStrictEqual([u.at, u.points, pd(r, I, A).points], [ist('2026-10-02 13:00'), -3, -3]);
  // An action that day (a reply in another chat at 12:30) also counts as being in: clock from 12:30.
  const h = wait(false, I, '2026-10-02 11:00'); h.conv('c2'); h.ag('c2', '2026-10-02 12:30', 'Your order is packed', A);
  assert.strictEqual(one(h.run(), I, A, 'unanswered_2h').at, ist('2026-10-02 14:30'));
  // The day before the install day: no presence log yet, everyone counts as in (numbers only, no points).
  r = wait(false, '2026-10-01', '2026-10-01 11:00').run();
  const u0 = one(r, '2026-10-01', A, 'unanswered_2h');
  assert.deepStrictEqual([u0.at, u0.points, pd(r, '2026-10-01', A).points, dayOf(r, '2026-10-01').pointsOn], [ist('2026-10-01 13:00'), 0, null, false]);
});
t('X21 owner A2: a settings row saved before closed_waiting existed takes the default -2; its own convinced 0 stays', () => {
  const old = { thanks: 3, solved: 2, fast_reply: 1, unanswered_2h: -3, angry: -2, convinced: 0, customer_answered: 0 };
  const f = heldByA(fx({ settings: [{ id: 1, weights: old, effectiveFrom: '2026-01-01', pointsFrom: '2026-10-03', createdAt: 0 }] }));
  f.ag('c1', '2026-10-05 14:52', 'Out for delivery today evening', A);
  f.v('c1', '2026-10-05 14:58', 'but I am not at home, can you deliver tomorrow');
  f.st('c1', '2026-10-05 15:00', 'agent_handling', 'resolved', 'close', A);
  f.conv('c2');
  f.v('c2', '2026-10-05 11:00', 'refund chahiye'); f.ag('c2', '2026-10-05 11:10', 'Order 2 din me aa jayega, festive season hai', A);
  f.v('c2', '2026-10-05 11:20', 'theek hai main wait kar lungi');
  const r = f.run();
  assert.deepStrictEqual([one(r, D, A, 'closed_waiting').points, one(r, D, A, 'convinced').points], [-2, 0]);
  assert.deepStrictEqual([pd(r, D, A).parts.closed_waiting, pd(r, D, A).parts.convinced, pd(r, D, A).points],
    [{ n: 1, each: -2, points: -2 }, { n: 1, each: 0, points: 0 }, -2]);
  // mergeDays carries the new part through a range.
  const m = E.mergeDays(r.days, f.inp.people, f.inp.nowMs);
  assert.deepStrictEqual(m.people.find((p) => p.key === A).parts.closed_waiting, { n: 1, each: -2, points: -2 });
});

// Random chats over 4 days: the engine's own promises hold for every item.
function randomInput(seed, nChats = 250, nMsgs = 3500) {
  const f = fx({ days: [D, D1], now: '2026-10-09 12:00' });
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const t0 = ist('2026-10-03 00:00'), span = 5 * 86_400_000;
  const who = [A, R, 'owner', V];
  for (let c = 0; c < nChats; c++) f.conv('c' + c, { cuKey: 'u' + Math.floor(rnd() * nChats * 0.7), known: rnd() < 0.7, source: rnd() < 0.1 ? 'email' : 'chat',
    status: pick(['agent_handling', 'human_needed', 'resolved', 'ai_handling']) });
  const texts = ['mera order kab aayega', 'thank you', 'ok', 'refund chahiye', 'theek hai wait kar lunga', 'thanks but kab?', 'hello?', 'abhi tak nahi aaya',
    'ok got it thanks', 'Please check my order status. Thank you', '🙏', 'mil gaya', 'fraud company'];
  const replies = ['Your order arrives on 7 Oct', 'hi', 'We will check and update you', 'agar help hui to thank you bol dena', 'ok', 'Refund processed'];
  for (let i = 0; i < nMsgs; i++) {
    const conv = 'c' + Math.floor(rnd() * nChats), at = t0 + Math.floor(rnd() * span), x = rnd();
    const id = 'r' + String(i).padStart(5, '0');
    if (x < 0.5) f.inp.msgs.push({ id, conv, sender: 'visitor', at, text: pick(texts), aiNotAnswer: false, noReply: false, login: null, eventActor: null });
    else if (x < 0.85) { const k = pick(who); f.inp.msgs.push({ id, conv, sender: 'agent', at, text: pick(replies), aiNotAnswer: false, noReply: false, login: rnd() < 0.1 ? 'oldowner' : null, eventActor: rnd() < 0.1 ? null : k }); }
    else f.inp.msgs.push({ id, conv, sender: 'ai', at, text: '', aiNotAnswer: rnd() < 0.3, noReply: false, login: null, eventActor: null });
  }
  for (const m of f.inp.msgs) if (m.sender === 'visitor') m.noReply = NOREPLY.test(m.text);
  const last = new Map();
  for (let i = 0; i < 400; i++) {
    const conv = 'c' + Math.floor(rnd() * nChats), at = t0 + Math.floor(rnd() * span);
    f.inp.holders.push({ id: i + 1, conv, at, from: null, to: rnd() < 0.2 ? null : pick(who) });
  }
  f.inp.holders.sort((a, b) => a.at - b.at || a.id - b.id);
  for (const h of f.inp.holders) { h.from = last.has(h.conv) ? last.get(h.conv) : null; last.set(h.conv, h.to); }
  const lastSt = new Map();
  for (let i = 0; i < 300; i++) {
    const conv = 'c' + Math.floor(rnd() * nChats), at = t0 + Math.floor(rnd() * span);
    f.inp.statuses.push({ id: i + 1, conv, at, from: null, to: pick(['resolved', 'agent_handling', 'human_needed', 'ai_handling']),
      reason: pick(['close', 'auto_close', 'merged_away', 'reply', 'take_over']), actor: pick([A, R, 'owner', 'system', 'customer']) });
  }
  f.inp.statuses.sort((a, b) => a.at - b.at || a.id - b.id);
  for (const s2 of f.inp.statuses) { s2.from = lastSt.get(s2.conv) || 'ai_handling'; lastSt.set(s2.conv, s2.to); }
  for (let i = 0; i < 300; i++) {
    const conv = 'c' + Math.floor(rnd() * nChats), at = t0 + Math.floor(rnd() * span), kind = pick(['claim', 'take', 'transfer']);
    f.act(conv, clock.istDay(at) + ' ' + clock.hhmm(at), kind, pick(who), { from: pick([A, R, null]), to: pick([A, R, 'owner', null]), take: pick(['senior', 'holder_away', 'owner']),
      bulk: kind === 'transfer' && rnd() < 0.2, note: kind === 'transfer' ? 'see this' : null, reason: pick(['reply', 'take_over']) });
  }
  for (let i = 0; i < 60; i++) f.cs('c' + Math.floor(rnd() * nChats), clock.istDay(t0 + Math.floor(rnd() * span)) + ' 12:00', pick(['mark', 'remove']));
  for (let i = 0; i < 600; i++) f.inp.health.push({ conv: 'c' + Math.floor(rnd() * nChats), at: t0 + Math.floor(rnd() * span), score: Math.floor(rnd() * 100) });
  for (let i = 0; i < 40; i++) f.inp.verdicts['r' + String(Math.floor(rnd() * nMsgs)).padStart(5, '0')] = pick([
    { thanks: true, convinced: true, source: 'ai' }, { thanks: false, convinced: false, source: 'ai' }, { thanks: null, convinced: null, source: 'ai_failed' }]);
  return f;
}
t('X17 random chats: every promise the engine makes holds', () => {
  for (const seed of [3, 17, 2026]) {
    const f = randomInput(seed);
    const res = f.run();
    assert.ok(res.days.every((d) => d.items.length > 50), `seed ${seed}: too few items`);
    for (const d of res.days) {
      const w = rules.settingsForDay(f.inp.settings, d.day).weights;
      const seen = new Map();
      for (const it of d.items) {
        assert.strictEqual(it.day, d.day);
        assert.strictEqual(clock.istDay(it.at), it.day, `${it.kind} at ${it.at} on ${it.day}`);
        assert.ok(/^[kc][0-9a-f]{32}$/.test(it.cu));
        assert.ok(!(it.counted && it.pending), it.kind);
        assert.ok(it.why && !/kab aayega|refund chahiye|fraud company|abhi tak nahi/.test(it.why), it.why);
        if (!d.pointsOn || !it.counted) assert.strictEqual(it.points, 0, `${it.kind} points ${it.points}`);
        const pk = it.kind === 'chat' ? 'customer_answered' : it.kind;
        if (d.pointsOn && it.counted && pk in w && it.actor !== 'ai') {
          if (it.kind !== 'chat') assert.strictEqual(it.points, w[pk], it.kind);
        }
        if (['taken_no_reply', 'picked', 'sent', 'received', 'taken_from', 'released', 'frustrated'].includes(it.kind)) assert.strictEqual(it.points, 0, it.kind);
        // Owner A3: a thank-you or "convinced" counts only in a verified chat.
        if ((it.kind === 'thanks' || it.kind === 'convinced') && it.counted) {
          assert.ok(f.inp.convs.find((c) => c.id === it.conv).known, `${it.kind} counted for a visitor`);
        }
        // Once per person, customer and day.
        const once = { unanswered_2h: 1, fast_reply: 1, solved: 1, angry: 1, taken_no_reply: 1, frustrated: 1 }[it.kind] || (it.kind === 'thanks' && it.counted ? 1 : 0);
        if (once) { const k = `${it.kind}|${it.counted}|${it.actor}|${it.cu}`; assert.ok(!seen.has(k), `twice: ${k}`); seen.set(k, 1); }
        assert.ok(it.actor !== 'unattributed' && (it.actor !== 'ai' || it.kind === 'thanks'), it.actor);
        if (!d.eventsOn) assert.ok(['chat', 'thanks', 'convinced', 'angry', 'frustrated'].includes(it.kind), it.kind);
      }
      for (const p of d.people) {
        const mine = d.items.filter((i) => i.actor === p.key && i.counted);
        if (d.pointsOn) assert.strictEqual(p.points, mine.reduce((s2, i) => s2 + i.points, 0), p.key);
        else assert.strictEqual(p.points, null);
        assert.strictEqual(p.counts.customers, p.cus.length);
        assert.strictEqual(p.counts.chats, d.items.filter((i) => i.actor === p.key && i.kind === 'chat').length);
        // Every "Convinced" item is counted, pending or not counted, and the three numbers say which.
        const cv = d.items.filter((i) => i.actor === p.key && i.kind === 'convinced');
        assert.deepStrictEqual([p.counts.convinced, p.counts.convinced_pending, p.counts.convinced_not_counted],
          [cv.filter((i) => i.counted).length, cv.filter((i) => i.pending).length, cv.filter((i) => !i.counted && !i.pending).length], p.key);
      }
    }
    // Owner A3: an unverified visitor's message is never sent to the AI check.
    const convOf = new Map(f.inp.msgs.map((m) => [m.id, m.conv]));
    for (const c of res.candidates) assert.ok(f.inp.convs.find((x) => x.id === convOf.get(c.messageId)).known, `candidate ${c.messageId} is a visitor's`);
    assert.ok(res.days.some((d) => d.items.some((i) => i.why === 'Visitor not verified')), `seed ${seed}: no visitor thank-you seen`);
    // Shuffled input: the same bytes.
    const base = JSON.stringify(res);
    for (const k of ['convs', 'msgs', 'holders', 'statuses', 'cases', 'actions', 'health', 'presence']) f.inp[k] = [...f.inp[k]].reverse();
    assert.strictEqual(JSON.stringify(f.run()), base, `seed ${seed}: shuffle`);
  }
});

if (failed.length) {
  console.log(`TEAM-SCORE ENGINE: ${failed.length} failed (${failed.join(' | ')}), ${n} passed`);
  process.exit(1);
}
console.log(`TEAM-SCORE ENGINE: ${n} groups passed`);
