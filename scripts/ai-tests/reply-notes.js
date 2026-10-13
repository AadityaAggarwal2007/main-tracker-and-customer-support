// Saved replies, "Notes" + the Hello / Regards dress for Suggestions and Sudharo (owner 2026-10-13: "note ka option dede
// upper ... brand wise ... segment wise ... hello aur vastora team yeh sab prebuild"; "suggestion replies bilkul acha nai
// ata as per team, sudharo bhi theek sa kaam nai karta"). The pure rules, the REAL reply-notes.ts on a fake chat_settings
// table, and the wiring of the screens.
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, jsx: 'react-jsx' }, fileName: filename }).outputText, filename);
const eq = assert.strictEqual, deq = assert.deepStrictEqual, ok = assert.ok;
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

// chat_settings: key -> value; tracker_user may INSERT / UPDATE, never DELETE (the fake throws on one).
const S = { rows: new Map(), sql: [] };
const likeRe = (pat) => new RegExp('^' + pat.replace(/\\([\\%_])|([%_])|([.*+?^${}()|[\]])/g, (m, esc, wild, re) => esc ? esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : wild ? (wild === '%' ? '.*' : '.') : '\\' + re) + '$');
const db = {
  queryOne: async (sql, p) => {
    const q = sql.replace(/\s+/g, ' '); S.sql.push(q);
    if (/count\(\*\)::int AS n FROM chat_settings WHERE key LIKE/.test(q)) return { n: [...S.rows.keys()].filter((k) => likeRe(p[0]).test(k)).length };
    if (/SELECT value FROM chat_settings WHERE key = \$1/.test(q)) return S.rows.has(p[0]) ? { value: S.rows.get(p[0]) } : null;
    if (/AS name/.test(q)) return { name: S.brand };
    throw new Error('fake one: ' + q.slice(0, 80));
  },
  query: async (sql, p) => {
    const q = sql.replace(/\s+/g, ' '); S.sql.push(q);
    if (/DELETE/i.test(q)) throw new Error('permission denied for DELETE');
    if (/SELECT key, value FROM chat_settings WHERE key LIKE/.test(q)) return { rows: [...S.rows].filter(([k]) => likeRe(p[0]).test(k)).map(([key, value]) => ({ key, value })) };
    if (/INSERT INTO chat_settings/.test(q)) { if (S.rows.has(p[0])) throw new Error('dup'); S.rows.set(p[0], p[1]); return { rows: [] }; }
    if (/UPDATE chat_settings SET value = \$2/.test(q)) { S.rows.set(p[0], p[1]); return { rows: [] }; }
    throw new Error('fake: ' + q.slice(0, 80));
  },
};
const fakes = { '@/lib/db': db };
const oR = Module._resolveFilename;
Module._resolveFilename = function (r, parent, ...x) { if (fakes[r]) return r; if (r.startsWith('@/')) return oR.call(this, path.join(SRC, r.slice(2)), parent, ...x); return oR.call(this, r, parent, ...x); };
const oL = Module._load; Module._load = function (r, ...x) { return fakes[r] || oL.call(this, r, ...x); };
const R = require(path.join(SRC, 'lib/chat/reply-notes-rules.ts'));
const N = require(path.join(SRC, 'lib/chat/reply-notes.ts'));

const owner = { role: 'admin', username: 'owner' };
const rahul = { role: 'agent', id: 'u-rahul', username: 'rahul', displayName: 'Rahul', permissions: null, businessIds: ['P1'] };
const anurag = { role: 'agent', id: 'u-anurag', username: 'anurag', displayName: 'Anurag', permissions: null, businessIds: ['P1', 'P2'] };
const sunny = { role: 'manager', id: 'u-sunny', username: 'sunny', displayName: 'Sunny', permissions: null, businessIds: null };
const viewer = { role: 'viewer', id: 'u-v', username: 'v', permissions: null, businessIds: null };

let pass = 0, fail = 0;
async function t(name, fn) {
  S.rows = new Map(); S.sql = []; S.brand = 'VASTRIKA';
  const log = console.log, err = console.error; console.error = () => {};
  try { await fn(); console.error = err; pass++; log('  ok  ' + name); }
  catch (e) { console.error = err; fail++; log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 6).join('\n       ')); }
}

(async () => {
  console.log('reply-notes: saved replies + Hello / Regards');

  await t('pure: Hello <first name> + Regards, <Brand> Team; never twice; a sentence that starts "Thank you" stays', () => {
    eq(R.wrapReply('Your order is on its way.', { name: 'PRIYA sharma', brand: 'Vastora' }), 'Hello Priya,\n\nYour order is on its way.\n\nRegards,\nVastora Team');
    eq(R.wrapReply('Ok.', {}), 'Hello,\n\nOk.\n\nRegards,\nSupport Team');
    eq(R.unwrapReply('Hi Priya, your order is on its way. Regards, Vastora Support'), 'Your order is on its way.');
    eq(R.unwrapReply('Hello!\n\nWe checked it.\n\nThanks,\nTeam Vastora'), 'We checked it.');
    eq(R.unwrapReply('Dear customer,\nAapka order aa raha hai ji.\n\nRegards,'), 'Aapka order aa raha hai ji.');
    eq(R.unwrapReply('Thank you for your patience.'), 'Thank you for your patience.');
    eq(R.unwrapReply('ur link pls check'), 'ur link pls check', 'nothing cut = untouched');
    const twice = R.wrapReply(R.unwrapReply(R.wrapReply('We are on it.', { name: 'Ravi', brand: 'kurtiya' })), { name: 'Ravi', brand: 'kurtiya' });
    eq(twice, 'Hello Ravi,\n\nWe are on it.\n\nRegards,\nkurtiya Team');
    eq(R.firstName('ravi123@gmail.com'), 'Ravi'); eq(R.firstName('  '), ''); eq(R.firstName('A'), '');
  });

  await t('pure: a note is filled for the customer ({name} {order} {tracking} {brand}); no tracking link = that line goes', () => {
    const body = 'Your order {order} is on its way.\nTrack it here: {tracking}\n{brand} is with you.';
    eq(R.fillNote(body, { name: 'ansh', order: '1091', brand: 'VASTRIKA', tracking: 'https://shiptrack.store/track/x' }),
      'Hello Ansh,\n\nYour order #1091 is on its way.\nTrack it here: https://shiptrack.store/track/x\nVASTRIKA is with you.\n\nRegards,\nVASTRIKA Team');
    eq(R.fillNote(body, { brand: 'VASTRIKA' }, false), 'Your order is on its way.\nVASTRIKA is with you.');
    eq(R.fillNote('Hi {name}, done.\n\nRegards, Team', { name: 'Ansh', brand: 'kurtiya' }), 'Hello Ansh,\n\nDone.\n\nRegards,\nkurtiya Team', 'the note\'s own greeting / sign-off replaced');
    for (const s of R.NOTE_STARTERS) {
      ok(R.isNoteSegment(s.segment) && !('error' in R.cleanNote(s)), s.title);
      ok(!/\b(today|tonight|tomorrow|aaj|kal)\b/i.test(s.body) && !/refund (?:in|within) \d/i.test(s.body), 'a starter promises no day: ' + s.title);
    }
  });

  await t('pure: cleanNote checks the segment, the name, the reply, no "<", no form link', () => {
    eq(R.cleanNote({ segment: 'x', title: 'a', body: 'b' }).error, 'Pick a segment');
    eq(R.cleanNote({ segment: 'cancel', title: ' ', body: 'b' }).error, 'Give the note a short name');
    eq(R.cleanNote({ segment: 'cancel', title: 'a', body: '' }).error, 'Write the reply');
    ok(R.cleanNote({ segment: 'cancel', title: 'a'.repeat(81), body: 'b' }).error);
    ok(R.cleanNote({ segment: 'cancel', title: 'a', body: 'b'.repeat(2001) }).error);
    eq(R.cleanNote({ segment: 'cancel', title: 'a', body: '<b>hi</b>' }).error, 'Leave out < and >');
    eq(R.cleanNote({ segment: 'refund', title: 'a', body: 'Fill https://forms.gle/abc' }).error, 'Form links cannot be saved in a note');
    deq(R.cleanNote({ segment: 'cancel', title: '  Before   dispatch ', body: 'Line one  \r\n\n\n\nLine two ' }), { segment: 'cancel', title: 'Before dispatch', body: 'Line one\n\nLine two' });
  });

  await t('pure: the notes block for the drafts (at most 15 / 3,500 characters) and a stored note read back', () => {
    const block = R.notesForPrompt([{ segment: 'cancel', title: 'Cancel', body: 'Your order {order}\nis cancelled.' }, { segment: 'reship', title: 'Again', body: 'We send it again.' }]);
    eq(block, '- [Cancel order] Cancel: Your order {order} / is cancelled.\n- [Ship again] Again: We send it again.');
    eq(R.notesForPrompt(Array.from({ length: 40 }, (_, i) => ({ segment: 'other', title: 'n' + i, body: 'x' }))).split('\n').length, 15);
    ok(R.notesForPrompt([{ segment: 'other', title: 't', body: 'y'.repeat(5000) }]) === '', 'one note over the cap = nothing');
    deq(R.parseStoredNote(JSON.stringify({ segment: 'cancel', title: 'T', body: 'B', by: 'x' })), { segment: 'cancel', title: 'T', body: 'B' });
    eq(R.parseStoredNote(JSON.stringify({ segment: 'cancel', title: 'T', body: 'B', deleted: true })), null);
    eq(R.parseStoredNote('not json'), null);
  });

  await t('server: anyone who replies adds and reads the panel\'s notes; the brand comes with them; another panel stays apart', async () => {
    const add = await N.addNote(rahul, 'P1', { segment: 'cancel', title: 'Cancel before dispatch', body: 'Your order {order} has been cancelled. https://shiptrack.store/track/x?utm_source=chatgpt.com' });
    ok(!('error' in add), JSON.stringify(add));
    eq(add.value.body, 'Your order {order} has been cancelled. https://shiptrack.store/track/x', 'link junk cut');
    eq(add.value.byName, 'Rahul');
    ok([...S.rows.keys()][0].startsWith('reply_note:P1:'));
    await N.addNote(anurag, 'P2', { segment: 'reship', title: 'Other panel', body: 'Hi' });
    const list = await N.listNotes(rahul, 'P1');
    eq(list.value.brand, 'VASTRIKA');
    deq(list.value.notes.map((n) => [n.title, n.canEdit]), [['Cancel before dispatch', true]]);
    eq((await N.listNotes(rahul, 'P2')).status, 404, 'a panel outside the login = 404');
    deq((await N.listNotes(sunny, 'P2')).value.notes.map((n) => n.title), ['Other panel']);
    eq((await N.listNotes(viewer, 'P1')).status, 403, 'a login that cannot reply sees nothing');
    eq((await N.addNote(rahul, 'P1', { segment: 'refund', title: 'x', body: 'https://docs.google.com/forms/d/1' })).status, 400);
  });

  await t('server: only the writer, the Manager or the Super Admin change or delete; delete keeps the row (no DELETE grant)', async () => {
    const a = (await N.addNote(rahul, 'P1', { segment: 'delay', title: 'Late', body: 'We are on it.' })).value;
    eq((await N.listNotes(anurag, 'P1')).value.notes[0].canEdit, false);
    eq((await N.changeNote(anurag, 'P1', a.id, { segment: 'delay', title: 'Mine now', body: 'x' }, false)).status, 403);
    const s = await N.changeNote(sunny, 'P1', a.id, { segment: 'delay', title: 'Late order', body: 'We are on it, ji.' }, false);
    eq(s.value.title, 'Late order'); eq(s.value.by, 'u-rahul', 'the writer stays');
    eq((await N.changeNote(owner, 'P1', a.id, null, true)).value, null);
    eq((await N.listNotes(rahul, 'P1')).value.notes.length, 0);
    ok(JSON.parse([...S.rows.values()][0]).deleted === true, 'the row stays, marked deleted');
    ok(!S.sql.some((q) => /DELETE/i.test(q)));
    eq((await N.changeNote(rahul, 'P1', a.id, { segment: 'delay', title: 'x', body: 'y' }, false)).status, 404, 'a deleted note is gone');
    eq((await N.changeNote(rahul, 'P1', 'not-an-id', {}, false)).status, 404);
  });

  await t('server: at most 300 notes a panel; the panel id cannot widen the LIKE', async () => {
    for (let i = 0; i < 300; i++) S.rows.set(`reply_note:P1:${String(i).padStart(36, '0')}`, JSON.stringify({ segment: 'other', title: 't' + i, body: 'b' }));
    eq((await N.addNote(rahul, 'P1', { segment: 'other', title: 'one more', body: 'b' })).status, 409);
    S.rows.set('reply_note:PX:1', JSON.stringify({ segment: 'other', title: 'leak', body: 'b' }));
    eq((await N.listNotes(owner, 'P_')).value.notes.length, 0, '"_" is not a wildcard');
  });

  await t('wiring: the route, the window in Mail and Chat Support, Suggestions / Sudharo dressed and fed the notes', () => {
    const route = read('app/api/reply-notes/route.ts');
    ok(/export async function GET/.test(route) && /export async function POST/.test(route) && /export async function PATCH/.test(route) && /getAuthFromRequest/.test(route));
    const run = read('lib/chat/suggest-run.ts');
    ok(/teamNotes: await teamNotes\(conv\.tracker_business_id\)/.test(run), 'the drafts get the panel\'s notes');
    ok(/options: dress\(options\)/.test(run) && /options: dress\(hit\.options/.test(run), 'drafts dressed, the cache keeps bare texts');
    ok(/wrapReply\(body, await nameAndBrand\(conv, src\)\)/.test(run), 'Sudharo dressed');
    ok(/strpos\(btrim\(\$5\), btrim\(COALESCE\(options->>\$3::int, ''\)\)\) = 0/.test(run), 'Hello / Regards around a picked draft is not an edit');
    const reader = read('components/mail/MailReader.tsx');
    ok(/<ReplyNotesDialog/.test(reader) && /NotebookPen size=\{15\} \/> Notes/.test(reader) && /wrap, lang: sugg\?\.lang/.test(reader));
    const page = read('app/admin/chat/page.tsx');
    ok(/<ReplyNotesDialog/.test(page) && /onNotes=/.test(page) && /wrap: replyWrap, lang: suggLang/.test(page) && /&wrap=0/.test(page));
    ok(/onNotes &&/.test(read('app/admin/chat/_components/Composer.tsx')));
    const dlg = read('components/ReplyNotesDialog.tsx');
    ok(/\/api\/reply-notes\?panel=/.test(dlg) && /navigator\.clipboard\.writeText/.test(dlg) && /NOTE_STARTERS/.test(dlg) && /Hello \/ Regards/.test(dlg));
    for (const f of ['app/api/mail/polish/route.ts', 'app/api/mail/suggest/route.ts', 'app/api/chat/polish/route.ts', 'app/api/chat/conversations/[id]/suggest/route.ts']) ok(/wrap/.test(read(f)), f);
    for (const f of ['lib/chat/reply-notes.ts', 'lib/chat/reply-notes-rules.ts', 'components/ReplyNotesDialog.tsx']) ok(!/vastora|vastrika|kurtiya/i.test(read(f).replace(/\/\/.*$/gm, '')), 'no panel name in code: ' + f);
  });

  console.log(`reply-notes: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
