// Chat team, part 3 (owner, 2026-10-01): the pure rules only, no database, no routes.
//   U1  office hours (src/lib/office-hours.ts): the night line's switch times and who is "away".
//   U2  who may do what on a chat (src/lib/chat/team-rules.ts), built with the owner's answers:
//       the Super Admin's own first reply / Take over on a chat nobody holds makes it his
//       (OWNER_ACTIONS_CLAIM = true), and a waiting customer may be taken from an away member
//       (AWAY_TAKE = true), never from the Super Admin.
// The routes that use these rules are tested end to end in team-routing.js.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const ts = require('typescript');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-unit-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
const load = (f, from = '../../src/lib/chat') => {
  const js = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, from, f + '.ts'), 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020' } }).outputText;
  fs.writeFileSync(path.join(dir, f + '.js'), js);
  return require(path.join(dir, f + '.js'));
};
const src = (f) => fs.readFileSync(path.resolve(__dirname, '../../src', f), 'utf8');
const oh = load('office-hours', '../../src/lib');
const tr = load('team-rules');
const waiting = load('waiting');
const wsql = load('waiting-sql');
let n = 0; const t = (name, fn) => {
  try { fn(); } catch (e) { e.message = `${name}: ${e.message}`; throw e; }
  n++;
};

// ── U1. Office hours ────────────────────────────────────────────
const at = (iso) => Date.parse(iso);
const MIN = 60_000;

t('U1 office hours: the 10:00 and 19:30 IST switches, from UTC instants', () => {
  const rows = [
    // UTC                       IST          afterHours      office
    ['2026-10-01T04:29:59Z', /* 09:59:59 */ 'this_morning', false],
    ['2026-10-01T04:30:00Z', /* 10:00:00 */ null, true],
    ['2026-10-01T13:59:59Z', /* 19:29:59 */ null, true],
    ['2026-10-01T14:00:00Z', /* 19:30:00 */ 'tomorrow', false],
    ['2026-10-01T18:29:59Z', /* 23:59:59 */ 'tomorrow', false],
    ['2026-10-01T18:30:00Z', /* 00:00 (2 Oct) */ 'this_morning', false],
  ];
  for (const [iso, after, office] of rows) {
    assert.strictEqual(oh.afterHours(at(iso)), after, iso);
    assert.strictEqual(oh.isOfficeHours(at(iso)), office, iso);
  }
  assert.strictEqual(oh.istMinuteOfDay(at('2026-10-01T04:30:00Z')), 600);
  assert.strictEqual(oh.istMinuteOfDay(at('2026-10-01T14:00:00Z')), 1170);
  assert.strictEqual(oh.istMinuteOfDay(at('2026-10-01T18:30:00Z')), 0);
  assert.strictEqual(oh.istMinuteOfDay(at('2026-10-01T18:29:59Z')), 1439);
  assert.strictEqual(oh.istMinuteOfDay(at('1969-12-31T18:00:00Z')), 1410); // before 1970: still 0..1439
  assert.deepStrictEqual([oh.IST_OFFSET_MIN, oh.OFFICE_OPEN_MIN, oh.OFFICE_CLOSE_MIN, oh.AWAY_AFTER_MIN], [330, 600, 1170, 30]);
});

t('U1 todayOpenMs: 10:00 IST of the India day, whatever the seconds', () => {
  assert.strictEqual(oh.todayOpenMs(at('2026-10-01T09:30:42.123Z')), at('2026-10-01T04:30:00Z')); // 15:00:42 IST
  assert.strictEqual(oh.todayOpenMs(at('2026-10-01T04:29:59Z')), at('2026-10-01T04:30:00Z'));     // 09:59:59 IST
  assert.strictEqual(oh.todayOpenMs(at('2026-10-01T19:00:00Z')), at('2026-10-02T04:30:00Z'));     // 00:30 IST, 2 Oct
  assert.strictEqual(oh.todayOpenMs(at('2026-10-01T18:29:59.999Z')), at('2026-10-01T04:30:00Z')); // 23:59:59 IST
});

// IST wall time on 1 Oct 2026 -> UTC ms.
const ist = (hhmm, day = '2026-10-01') => at(`${day}T${hhmm}:00+05:30`);
const YESTERDAY = ist('18:00', '2026-09-30');

// Owner 2026-10-05: the week. 3 Oct 2026 is a Saturday (half day, to 14:00), 4 Oct a Sunday (off), 5 Oct a Monday.
t('U1 the week: Saturday closes at 14:00, Sunday is off, a holiday is off; afterHours names the day the team is back', () => {
  const H = ['2026-10-05'];                                                  // a holiday Monday
  const rows = [
    // IST wall time              afterHours      office   closedWhy    closedSince (IST)      nextOpen (IST)
    ['2026-10-02T20:00', 'tomorrow', false, 'night', '2026-10-02T19:30', '2026-10-03T10:00'],   // Friday night -> Saturday morning
    ['2026-10-03T09:00', 'this_morning', false, 'night', '2026-10-02T19:30', '2026-10-03T10:00'],
    ['2026-10-03T11:00', null, true, null, null, null],                                          // Saturday half day
    ['2026-10-03T13:59', null, true, null, null, null],
    ['2026-10-03T14:00', 'monday', false, 'weekend', '2026-10-03T14:00', '2026-10-05T10:00'],
    ['2026-10-04T12:00', 'tomorrow', false, 'weekend', '2026-10-03T14:00', '2026-10-05T10:00'],   // Sunday: back tomorrow
    ['2026-10-05T01:00', 'this_morning', false, 'night', '2026-10-03T14:00', '2026-10-05T10:00'],
    ['2026-10-05T11:00', null, true, null, null, null],
    ['2026-10-05T20:00', 'tomorrow', false, 'night', '2026-10-05T19:30', '2026-10-06T10:00'],
  ];
  for (const [when, after, office, why, sinceIst, nextIst] of rows) {
    const ms = ist(when.slice(11), when.slice(0, 10));
    assert.strictEqual(oh.afterHours(ms), after, when);
    assert.strictEqual(oh.isOfficeHours(ms), office, when);
    assert.strictEqual(oh.closedWhy(ms), why, when);
    assert.strictEqual(oh.closedSinceMs(ms), sinceIst ? ist(sinceIst.slice(11), sinceIst.slice(0, 10)) : null, when + ' since');
    assert.strictEqual(oh.nextOpenMs(ms), nextIst ? ist(nextIst.slice(11), nextIst.slice(0, 10)) : null, when + ' next');
  }
  // A holiday Monday: Sunday says Tuesday, the Monday itself is a holiday (closed all day), Tuesday is a working day.
  assert.strictEqual(oh.afterHours(ist('12:00', '2026-10-04'), H), 'tuesday');
  assert.strictEqual(oh.closedWhy(ist('12:00', '2026-10-05'), H), 'holiday');
  assert.strictEqual(oh.isOfficeHours(ist('12:00', '2026-10-05'), H), false);
  assert.strictEqual(oh.afterHours(ist('12:00', '2026-10-05'), H), 'tomorrow');
  assert.strictEqual(oh.closedSinceMs(ist('12:00', '2026-10-05'), H), ist('14:00', '2026-10-03'));
  assert.strictEqual(oh.nextOpenMs(ist('12:00', '2026-10-05'), H), ist('10:00', '2026-10-06'));
  assert.strictEqual(oh.afterHours(ist('12:00', '2026-10-06'), H), null);
  // Two holidays in a row and a weekend: the next working day is named.
  assert.strictEqual(oh.afterHours(ist('15:00', '2026-10-03'), ['2026-10-05', '2026-10-06']), 'wednesday');
  // Nobody is away on Sunday, on a holiday, or on Saturday afternoon.
  assert.strictEqual(oh.awayMinutes(null, ist('12:00', '2026-10-04')), null);
  assert.strictEqual(oh.awayMinutes(null, ist('12:00', '2026-10-05'), H), null);
  assert.strictEqual(oh.awayMinutes(null, ist('14:30', '2026-10-03')), null);
  assert.strictEqual(oh.awayMinutes(null, ist('12:00', '2026-10-03')), 120);
  // The holiday list as typed: real dates only, each once, sorted.
  assert.deepStrictEqual(oh.parseHolidays('2026-11-08\n 2026-10-20, junk 2026-02-31\n2026-10-20'), ['2026-10-20', '2026-11-08']);
  assert.deepStrictEqual(oh.parseHolidays(null), []);
  assert.deepStrictEqual([oh.SATURDAY_CLOSE_MIN, oh.WEEKDAY_NAMES.length], [840, 7]);
});

t('U1 awayMinutes / isAway: each day starts fresh at 10:00; nobody is away at night', () => {
  assert.strictEqual(oh.awayMinutes(YESTERDAY, ist('10:20')), 20);
  assert.strictEqual(oh.isAway(YESTERDAY, ist('10:20')), false);
  assert.strictEqual(oh.awayMinutes(YESTERDAY, ist('10:30')), 30);
  assert.strictEqual(oh.isAway(YESTERDAY, ist('10:30')), true);
  assert.strictEqual(oh.awayMinutes(ist('14:29'), ist('15:00')), 31);
  assert.strictEqual(oh.isAway(ist('14:29'), ist('15:00')), true);
  assert.strictEqual(oh.awayMinutes(ist('14:55'), ist('15:00')), 5);
  assert.strictEqual(oh.isAway(ist('14:55'), ist('15:00')), false);
  for (const seen of [null, YESTERDAY, ist('20:55'), ist('09:00')]) {
    assert.strictEqual(oh.awayMinutes(seen, ist('21:00')), null);
    assert.strictEqual(oh.isAway(seen, ist('21:00')), false);
  }
  assert.strictEqual(oh.awayMinutes(null, ist('09:59')), null);       // before opening: nobody away
  assert.strictEqual(oh.awayMinutes(null, ist('10:45')), 45);         // never seen at all: from 10:00
  assert.strictEqual(oh.awayMinutes(ist('09:15'), ist('10:10')), 10); // seen before opening: from 10:00
  assert.strictEqual(oh.awayMinutes(ist('15:00') + 5_000, ist('15:00')), 0); // a moment "in the future": just seen, never negative
  assert.strictEqual(oh.awayMinutes(ist('14:30') + 30 * 1000, ist('15:00')), 29); // whole minutes only
  assert.strictEqual(oh.isAway(ist('18:58'), ist('19:29')), true);
  assert.strictEqual(oh.isAway(ist('18:58'), ist('19:30')), false);   // 19:30 is night
});

// ── U2. Team rules ──────────────────────────────────────────────
const R = '11111111-1111-4111-8111-111111111111'; // Rahul, senior
const R2 = '22222222-2222-4222-8222-222222222222'; // a second senior
const A = '33333333-3333-4333-8333-333333333333'; // Anurag, junior
const A2 = '44444444-4444-4444-8444-444444444444'; // a second junior
const V = '55555555-5555-4555-8555-555555555555'; // a member who can read but not reply

const SA = { key: 'owner', name: 'Super Admin', superAdmin: true, senior: true, canReply: true, canCases: true };
const RAHUL = { key: R, name: 'Rahul', superAdmin: false, senior: true, canReply: true, canCases: true };
const ANURAG = { key: A, name: 'Anurag', superAdmin: false, senior: false, canReply: true, canCases: true };
const READER = { key: V, name: 'Reader', superAdmin: false, senior: false, canReply: false, canCases: false };

// Holders as holderOf() builds them; awayMin as office-hours.ts computes it (null at night).
const holder = (key, name, { superAdmin = false, senior = false, awayMin = 5 } = {}) => ({ key, name, superAdmin, senior, awayMin });
const H = {
  none: null,
  junior: holder(A, 'Anurag'),
  junior2: holder(A2, 'Priya'),
  senior: holder(R, 'Rahul', { senior: true }),
  senior2: holder(R2, 'Karan', { senior: true }),
  owner: holder('owner', 'Super Admin', { superAdmin: true, senior: true }),
  awayJunior: holder(A, 'Anurag', { awayMin: 45 }),
  awayJunior2: holder(A2, 'Priya', { awayMin: 45 }),
  awaySenior: holder(R, 'Rahul', { senior: true, awayMin: 45 }),
  awaySenior2: holder(R2, 'Karan', { senior: true, awayMin: 45 }),
  awayOwner: holder('owner', 'Super Admin', { superAdmin: true, senior: true, awayMin: 240 }),
  nightSenior: holder(R, 'Rahul', { senior: true, awayMin: null }),
};
const self = (a) => holder(a.key, a.name, { superAdmin: a.superAdmin, senior: a.senior });

t('U2 the owner answers are built in: away cover on, the Super Admin claims', () => {
  assert.strictEqual(tr.AWAY_TAKE, true);
  assert.strictEqual(tr.OWNER_ACTIONS_CLAIM, false);   // owner 5 Oct: his reply claims nothing (was true, Q2 of 1 Oct)
  assert.strictEqual(tr.OWNER_KEY, 'owner');
});

t('U2 actorTier', () => {
  assert.deepStrictEqual([SA, RAHUL, ANURAG, READER].map(tr.actorTier), ['owner', 'senior', 'junior', 'junior']);
});

t('U2 canAct: the holder, anyone on an unheld chat, the Super Admin on any; a reader never', () => {
  const rows = [
    // actor   none  self  junior senior senior2 owner awayJunior awaySenior awayOwner
    [SA,     [true, true, true, true, true, true, true, true, true]],
    [RAHUL,  [true, true, false, true /* = self */, false, false, false, true /* = self */, false]],
    [ANURAG, [true, true, true /* = self */, false, false, false, true /* = self */, false, false]],
    [READER, [false, false, false, false, false, false, false, false, false]],
  ];
  for (const [a, want] of rows) {
    const got = [H.none, self(a), H.junior, H.senior, H.senior2, H.owner, H.awayJunior, H.awaySenior, H.awayOwner].map((h) => tr.canAct(a, h));
    assert.deepStrictEqual(got, want, a.name);
  }
  assert.strictEqual(tr.canAct(ANURAG, H.junior2), false);  // a junior on another junior's chat
  assert.strictEqual(tr.canAct(RAHUL, H.awaySenior2), false); // away cover is a Take, not a free reply
});

t('U2 claimsOnAct: a reply / Take over on a chat nobody holds claims it for a member; the Super Admin claims nothing (owner 5 Oct; Q2 of 1 Oct said he did)', () => {
  assert.strictEqual(tr.claimsOnAct(SA, null), false);
  assert.strictEqual(tr.claimsOnAct(RAHUL, null), true);
  assert.strictEqual(tr.claimsOnAct(ANURAG, null), true);
  assert.strictEqual(tr.claimsOnAct(READER, null), false);
  // a held chat is never claimed by acting on it (the Super Admin replies on Anurag's chat: holder unchanged)
  for (const a of [SA, RAHUL, ANURAG]) {
    for (const h of [self(a), H.junior, H.senior, H.owner, H.awaySenior]) assert.strictEqual(tr.claimsOnAct(a, h), false, `${a.name} on ${h.name}`);
  }
});

// Owner 2026-10-05 (answer (a): "sab kar paye sab kuch"): any member takes any other member's chat
// ('member'); a senior's take of a junior and away cover keep their names (the log says why); the
// Super Admin's chats are still nobody's to take.
t('U2 takeKind: owner takes any, senior takes a junior, away cover for a waiting customer, else any member takes any member\'s chat (owner 5 Oct)', () => {
  // nothing to take
  for (const a of [SA, RAHUL, ANURAG, READER]) {
    assert.strictEqual(tr.takeKind(a, null, true), null);
    assert.strictEqual(tr.takeKind(a, self(a), true), null);
  }
  // Super Admin: any member's chat, waiting or not
  for (const h of [H.junior, H.senior, H.awaySenior, H.nightSenior]) assert.strictEqual(tr.takeKind(SA, h, false), 'owner');
  // senior on a junior: always, no waiting needed
  assert.strictEqual(tr.takeKind(RAHUL, H.junior, false), 'senior');
  assert.strictEqual(tr.takeKind(RAHUL, H.awayJunior, true), 'senior'); // 'senior' wins over 'holder_away'
  // senior on another senior: away cover when the customer waits, else the plain member take
  assert.strictEqual(tr.takeKind(RAHUL, H.senior2, true), 'member');
  assert.strictEqual(tr.takeKind(RAHUL, H.awaySenior2, true), 'holder_away');
  assert.strictEqual(tr.takeKind(RAHUL, H.awaySenior2, false), 'member');
  // junior on a senior / another junior: the same (before 5 Oct: null unless away cover)
  assert.strictEqual(tr.takeKind(ANURAG, H.senior, true), 'member');
  assert.strictEqual(tr.takeKind(ANURAG, H.awaySenior, true), 'holder_away');
  assert.strictEqual(tr.takeKind(ANURAG, H.awaySenior, false), 'member');
  assert.strictEqual(tr.takeKind(ANURAG, H.nightSenior, true), 'member'); // at night too (away cover alone never was)
  assert.strictEqual(tr.takeKind(ANURAG, H.junior2, true), 'member');
  assert.strictEqual(tr.takeKind(ANURAG, H.awayJunior2, true), 'holder_away');
  assert.strictEqual(tr.MEMBER_TAKE, true);
  // the Super Admin's chats (owner 5 Oct afternoon, "yeh Super Admin jo aa raha hai yeh bhi hata"): any member
  // takes them too, logged as a plain member take whatever his flags, away or not
  const ownerNoSenior = holder('owner', 'Super Admin', { superAdmin: true, senior: false, awayMin: 240 });
  for (const a of [RAHUL, ANURAG]) {
    for (const h of [H.owner, H.awayOwner, ownerNoSenior]) for (const w of [true, false]) assert.strictEqual(tr.takeKind(a, h, w), 'member', `${a.name} ${h.awayMin} ${w}`);
  }
  assert.strictEqual(tr.takeKind(READER, H.owner, true), null);
  // a member who cannot reply never takes
  for (const h of [H.junior, H.awaySenior, H.awayJunior]) assert.strictEqual(tr.takeKind(READER, h, true), null);
});

t('U2 takeKind: away means AWAY_AFTER_MIN (30) of office time, the same number as office-hours.ts', () => {
  const at30 = holder(R, 'Rahul', { senior: true, awayMin: oh.AWAY_AFTER_MIN });
  const at29 = holder(R, 'Rahul', { senior: true, awayMin: oh.AWAY_AFTER_MIN - 1 });
  assert.strictEqual(tr.takeKind(ANURAG, at30, true), 'holder_away');
  assert.strictEqual(tr.takeKind(ANURAG, at29, true), 'member');   // not away yet: the plain take (owner 5 Oct)
  // end to end with the clock: Rahul last seen 14:15, customer waiting
  const rahulAt = (now) => holder(R, 'Rahul', { senior: true, awayMin: oh.awayMinutes(ist('14:15'), now) });
  assert.strictEqual(tr.takeKind(ANURAG, rahulAt(ist('14:40')), true), 'member');    // 25 min: not away cover
  assert.strictEqual(tr.takeKind(ANURAG, rahulAt(ist('15:00')), true), 'holder_away'); // 45 min, office hours
  assert.strictEqual(tr.takeKind(ANURAG, rahulAt(ist('15:00')), false), 'member');   // customer not waiting
  assert.strictEqual(tr.takeKind(ANURAG, rahulAt(ist('21:00')), true), 'member');    // night: awayMin null, never away cover
});

const M = (key, name, o = {}) => ({ key, name, active: true, canReply: true, senior: false, panelOk: true, awayMin: null, ...o });
const MEMBERS = [
  M(R, 'Rahul', { senior: true }),
  M(A, 'Anurag', { awayMin: 40 }),
  M('66666666-6666-4666-8666-666666666666', 'Switched off', { active: false }),
  M(V, 'Reader', { canReply: false }),
  M('77777777-7777-4777-8777-777777777777', 'Other panel', { panelOk: false }),
];
const keys = (list) => list.map((x) => x.key);

t('U2 transferTargets: never yourself or the holder; switched-off, non-repliers and other panels left out', () => {
  // Anurag on a chat nobody holds, and on his own chat
  for (const h of [null, self(ANURAG)]) {
    const got = tr.transferTargets(ANURAG, h, MEMBERS);
    assert.deepStrictEqual(keys(got), [R, 'owner']);
    assert.deepStrictEqual(got[0], { key: R, name: 'Rahul', senior: true, awayMin: null });
    assert.strictEqual(got[1].name, 'Super Admin');
  }
  // Rahul on his own chat: Anurag (away 40 min is still a valid target) and Super Admin
  const r = tr.transferTargets(RAHUL, self(RAHUL), MEMBERS);
  assert.deepStrictEqual(keys(r), [A, 'owner']);
  assert.deepStrictEqual(r[0], { key: A, name: 'Anurag', senior: false, awayMin: 40 });
  // someone else's chat: no targets at all (Transfer is only for your own chat)
  // Owner 5 Oct (answer 4): a member's chat may be handed on by another member (never the Super Admin's).
  assert.ok(tr.transferTargets(ANURAG, H.senior, MEMBERS).length > 0 && !tr.transferTargets(ANURAG, H.senior, MEMBERS).some((t) => t.key === R || t.key === A));
  assert.ok(tr.transferTargets(RAHUL, H.junior, MEMBERS).length > 0 && !tr.transferTargets(RAHUL, H.junior, MEMBERS).some((t) => t.key === A || t.key === R));
  assert.ok(tr.transferTargets(RAHUL, H.owner, MEMBERS).length > 0 && !tr.transferTargets(RAHUL, H.owner, MEMBERS).some((t) => t.key === 'owner' || t.key === R), 'his chat too, never back to him or to yourself');
  assert.deepStrictEqual(tr.transferTargets(READER, H.junior, MEMBERS), []);
  assert.deepStrictEqual([tr.canTransfer(ANURAG, H.senior), tr.canTransfer(ANURAG, H.owner), tr.canTransfer(READER, H.junior), tr.canTransfer(ANURAG, null)], [true, true, false, true]);
  assert.deepStrictEqual(tr.transferTargets(READER, null, MEMBERS), []);
});

t('U2 transferTargets: "Me (Super Admin)" and "Nobody (open pool)" for the Super Admin only', () => {
  // unheld: every member + Me, no Nobody (it is already in the open pool)
  const free = tr.transferTargets(SA, null, MEMBERS);
  assert.deepStrictEqual(keys(free), [R, A, 'owner']);
  assert.strictEqual(free[2].name, 'Me (Super Admin)');
  // Anurag's chat: Rahul, Me, Nobody
  const held = tr.transferTargets(SA, H.junior, MEMBERS);
  assert.deepStrictEqual(keys(held), [R, 'owner', null]);
  assert.deepStrictEqual(held[2], { key: null, name: 'Nobody (open pool)', senior: false, awayMin: null });
  // his own chat: members and Nobody, never himself
  const mine = tr.transferTargets(SA, H.owner, MEMBERS);
  assert.deepStrictEqual(keys(mine), [R, A, null]);
  // a member never gets Nobody
  assert.ok(!keys(tr.transferTargets(ANURAG, self(ANURAG), MEMBERS)).includes(null));
  // the Super Admin's own away minutes ride on his entry when given
  assert.strictEqual(tr.transferTargets(ANURAG, null, MEMBERS, 55).find((x) => x.key === 'owner').awayMin, 55);
  assert.strictEqual(tr.transferTargets(ANURAG, null, MEMBERS).find((x) => x.key === 'owner').awayMin, null);
});

t('U2 transferStatus: known -> Needs you, visitor -> agent_handling, case / Nobody keep, Closed refused', () => {
  const chat = (status, known, case_kind = null) => ({ status, known, case_kind });
  assert.strictEqual(tr.transferStatus(chat('ai_handling', true), false), 'human_needed');
  assert.strictEqual(tr.transferStatus(chat('agent_handling', true), false), 'human_needed');
  assert.strictEqual(tr.transferStatus(chat('human_needed', true), false), 'human_needed');
  assert.strictEqual(tr.transferStatus(chat('ai_handling', false), false), 'agent_handling'); // a visitor never reaches Needs you
  assert.strictEqual(tr.transferStatus(chat('human_needed', false), false), 'agent_handling');
  assert.strictEqual(tr.transferStatus(chat('agent_handling', true, 'refund'), false), 'agent_handling');
  assert.strictEqual(tr.transferStatus(chat('human_needed', true, 'reship'), false), 'human_needed');
  assert.strictEqual(tr.transferStatus(chat('ai_handling', true), true), 'ai_handling');       // to Nobody: kept
  assert.strictEqual(tr.transferStatus(chat('agent_handling', false), true), 'agent_handling');
  for (const toNobody of [false, true]) {
    assert.strictEqual(tr.transferStatus(chat('resolved', true), toNobody), null);
    assert.strictEqual(tr.transferStatus(chat('resolved', true, 'refund'), toNobody), null);
  }
});

t('U2 caseMarkGate: senior / Super Admin always; a junior only while every senior is away; no senior ticked = today', () => {
  const g = (a, away) => tr.caseMarkGate(a, away);
  for (const away of ['none', true, false]) {
    assert.deepStrictEqual(g(SA, away), { allowed: true, override: false });
    assert.deepStrictEqual(g(RAHUL, away), { allowed: true, override: false });
    assert.deepStrictEqual(g(READER, away), { allowed: false, override: false }); // no chat.cases
  }
  assert.deepStrictEqual(g({ ...SA, canCases: false }, 'none'), { allowed: false, override: false });
  assert.deepStrictEqual(g(ANURAG, 'none'), { allowed: true, override: false });
  assert.deepStrictEqual(g(ANURAG, true), { allowed: true, override: true });
  assert.deepStrictEqual(g(ANURAG, false), { allowed: false, override: false });
  // with the clock: Rahul seen 14:29 -> away at 15:00 (junior may, override); seen 14:55 -> not;
  // 10:20 with Rahul seen yesterday -> not yet; 21:00 -> never (nobody is away at night)
  assert.deepStrictEqual(g(ANURAG, oh.isAway(ist('14:29'), ist('15:00'))), { allowed: true, override: true });
  assert.deepStrictEqual(g(ANURAG, oh.isAway(ist('14:55'), ist('15:00'))), { allowed: false, override: false });
  assert.deepStrictEqual(g(ANURAG, oh.isAway(YESTERDAY, ist('10:20'))), { allowed: false, override: false });
  assert.deepStrictEqual(g(ANURAG, oh.isAway(YESTERDAY, ist('21:00'))), { allowed: false, override: false });
});

t('U2 cleanTransferNote: one line, 3-200 code points, must say something', () => {
  for (const bad of ['', '  a ', '12!', 'ab', '   ', '...', '\n\n\t', '😀😀😀', null, undefined, 42, {}, ['note']]) {
    assert.strictEqual(tr.cleanTransferNote(bad), null, JSON.stringify(bad));
  }
  assert.strictEqual(tr.cleanTransferNote('abc'), 'abc');
  assert.strictEqual(tr.cleanTransferNote('  Customer\nwants a\r\nrefund,\tplease   check  '), 'Customer wants a refund, please check');
  assert.strictEqual(tr.cleanTransferNote('line one line two end'), 'line one line two end');
  assert.strictEqual(tr.cleanTransferNote('abc‮def⁦ghi⁩'), 'abc def ghi');   // no text-direction tricks
  assert.strictEqual(tr.cleanTransferNote('a\u0000b\u007Fc'), 'a b c');
  assert.strictEqual(tr.cleanTransferNote('रिफंड चाहिए, देख लो'), 'रिफंड चाहिए, देख लो');     // any script counts as a letter
  assert.strictEqual(tr.cleanTransferNote('x'.repeat(250)), 'x'.repeat(200));
  assert.strictEqual(tr.cleanTransferNote('x'.repeat(200)), 'x'.repeat(200));
  const emoji = tr.cleanTransferNote('ok ' + '😀'.repeat(300));                         // never splits a character
  assert.strictEqual(Array.from(emoji).length, 200);
  assert.ok(emoji.endsWith('😀') && !/[\uD800-\uDBFF]$/.test(emoji));
  assert.strictEqual(tr.cleanTransferNote('a'.repeat(199) + '   ' + 'b'.repeat(20)), 'a'.repeat(199)); // cut lands on a space: trimmed
  assert.strictEqual(tr.cleanTransferNote('Kal subah call karna\n\n'), 'Kal subah call karna');
});

t('pure modules stay pure; the waiting SQL lives in one place', () => {
  assert.ok(!/^\s*import\s/m.test(src('lib/office-hours.ts')), 'office-hours.ts must have no imports');
  assert.ok(!/^\s*import\s/m.test(src('lib/chat/team-rules.ts')), 'team-rules.ts must have no imports');
  // no invisible text-direction characters in the rules source (they were once written literally)
  assert.ok(!/[‪-‮⁦-⁩]/.test(src('lib/chat/team-rules.ts')));
  // waiting-sql.ts carries the same regexes as waiting.ts, and the list route no longer has its own copy
  assert.ok(wsql.WAITING_SINCE_SQL.includes(`~* '${waiting.NO_REPLY_NEEDED_REGEX}'`));
  assert.ok(wsql.WAITING_SINCE_SQL.includes(`~* '${waiting.AI_NOT_AN_ANSWER_REGEX}'`));
  assert.ok(/^LEFT JOIN LATERAL \(/.test(wsql.WAITING_LATERAL) && /\) w ON true$/.test(wsql.WAITING_LATERAL));
  const route = src('app/api/chat/conversations/route.ts');
  assert.ok(/import \{[^}]*WAITING_LATERAL[^}]*\} from '@\/lib\/chat\/waiting-sql'/.test(route));
  assert.ok(!/const WAITING_(LATERAL|SINCE_SQL)\s*=/.test(route));
});

console.log(`TEAM UNIT: ${n} groups passed`);
