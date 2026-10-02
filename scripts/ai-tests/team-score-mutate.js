// Team score, part 4 (owner, 2026-10-01): mutation checks for the pure modules. Run by hand, NOT in
// `npm run test:ai`:   node scripts/ai-tests/team-score-mutate.js   (about a minute)
// For each mutation: the source text is changed IN MEMORY (never the repo file), every pure module is
// compiled into a temp dir, and team-score-unit.js + team-score-engine.js run in a child process with
// TEAM_SCORE_JS_DIR pointing at it. The suites must FAIL, and at least one failing test must be one of
// the cases named for that mutation (spec section 8.4; M13+ are extra ones added by the tests slice;
// M37+ pin the owner's answers of 2026-10-02: A2 weights, A3 verified only, A4 install-day points;
// M45+ pin the review fixes of 2026-10-02, M54+ the second review pass, M57+ the third, M69+ the fourth,
// M86+ the fifth: lead design v5, A-E).
// Exit 1 if any mutation survives, is caught only by other cases, or its target text is missing.
const fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '../..');
const SRC = {
  'office-hours': 'src/lib/office-hours.ts', 'health-rules': 'src/lib/chat/health-rules.ts',
  escalation: 'src/lib/chat/escalation.ts', waiting: 'src/lib/chat/waiting.ts', 'waiting-sql': 'src/lib/chat/waiting-sql.ts',
  types: 'src/lib/team-score/types.ts', clock: 'src/lib/team-score/clock.ts', words: 'src/lib/team-score/words.ts',
  rules: 'src/lib/team-score/rules.ts', engine: 'src/lib/team-score/engine.ts',
};
const SUITES = ['team-score-unit.js', 'team-score-engine.js'];

const MUTATIONS = [
  // ── Spec 8.4 ──
  { id: 'M1', file: 'rules', what: 'UNANSWERED_MIN 120 -> 119', find: 'UNANSWERED_MIN = 120', to: 'UNANSWERED_MIN = 119', by: ['E4'] },
  { id: 'M2', file: 'engine', what: 'no (person, customer, day) thanks dedupe', find: 'else if (thanksSlot.has(', to: 'else if (false && thanksSlot.has(', by: ['E13'] },
  { id: 'M3', file: 'engine', what: 'no holding-reply "ok thanks" check',
    find: "    if (ack === 'pure') {\n      reason = 'Polite", to: "    if (false) {\n      reason = 'Polite", by: ['E17', 'E17b'] },
  { id: 'M4', file: 'engine', what: 'no asked-for-thanks check', find: 'if (ask) { reason', to: 'if (false) { reason', by: ['E16'] },
  { id: 'M5', file: 'clock', what: 'officeMs ignores the 19:30 close', find: 'Math.min(b, close)', to: 'b', by: ['C1', 'E5'] },
  { id: 'M6', file: 'rules', what: 'SOLVED_QUIET_MS 24 h -> 23 h', find: 'SOLVED_QUIET_MS = 24 * 3_600_000', to: 'SOLVED_QUIET_MS = 23 * 3_600_000', by: ['E20', 'E21'] },
  { id: 'M7', file: 'engine', what: 'angry: no "did not get better" check', find: 'hEnd >= hStart', to: 'true', by: ['E25b'] },
  { id: 'M8', file: 'engine', what: 'eligible() always true', find: 'eligible(k: string | null): boolean {', to: 'eligible(k: string | null): boolean { return true;', by: ['E11'] },
  { id: 'M9', file: 'rules', what: 'no human_needed / no-agent waiting branch', find: "  if (status === 'human_needed' && s.laAt === null) return s.lvAt;\n", to: '', by: ['W7'] },
  { id: 'M10', file: 'rules', what: 'settingsForDay returns the latest row',
    find: 'if (r.effectiveFrom <= day && (!best || r.id > best.id)) best = r;', to: 'if (!best || r.id > best.id) best = r;', by: ['E29'] },
  { id: 'M11', file: 'engine', what: 'ping-pong: the 2-hour total restarts on a new hold',
    find: 'const akey = `${ep.key}|${K}`;', to: 'const akey = `${ep.key}|${K}|${hold.start}`;', by: ['E8'] },
  { id: 'M12', file: 'words', what: 'no sarcasm rule', find: "  if (any(SARCASM, t)) return 'unsure';\n", to: '', by: ['W1'] },
  // ── Extra (tests slice) ──
  { id: 'M13', file: 'words', what: 'no request rule (request + thanks is a sure thank-you)', find: "  if (REQUEST.test(t)) return 'unsure';\n", to: '', by: ['W1', 'X14'] },
  { id: 'M14', file: 'words', what: 'a nudge ("hello?") counts as a sign-off', find: '(isCourtesyOnly(t) && !NUDGE.test(t))', to: 'isCourtesyOnly(t)', by: ['W3', 'X7'] },
  { id: 'M15', file: 'engine', what: 'a "hi" reply earns the 10 minutes', find: 'if (ctx.trivial(m)) continue;', to: '', by: ['E35'] },
  { id: 'M16', file: 'engine', what: 'auto-close always solved',
    find: "if (!(acceptsClose(lt) || saysResolved(lt) || keywordThanks(lt) === 'yes')) return;", to: '', by: ['E23'] },
  { id: 'M17', file: 'engine', what: 'no closed-while-waiting', find: 'if (W !== null) {', to: 'if (false) {', by: ['E22'] },
  { id: 'M18', file: 'engine', what: 'repeat day counted from the whole wait (10:00)', find: 'const t = addOfficeMs(s, U - today);', to: 'const t = addOfficeMs(s, U - acc.cum);', by: ['E6'] },
  { id: 'M19', file: 'engine', what: 'taken-no-reply ignores the holder\'s own reply', find: 'if (replied) continue;', to: '', by: ['E34'] },
  { id: 'M20', file: 'engine', what: 'no 24-hour thanks window', find: 'if (M.at - R.at > THANKS_WINDOW_MS) continue;', to: '', by: ['E15'] },
  { id: 'M21', file: 'engine', what: 'thanks after an AI answer goes to nobody', find: "if (R.sender === 'ai') {", to: 'if (false) {', by: ['E14'] },
  { id: 'M22', file: 'engine', what: 'angry for visitors too', find: 'if (!cd.c.known || !cd.health.length) continue;', to: 'if (!cd.health.length) continue;', by: ['E25e'] },
  { id: 'M23', file: 'engine', what: 'the owner is ranked', find: "(key !== 'owner' || OWNER_RANKED)", to: 'true', by: ['E30', 'X2'] },
  { id: 'M24', file: 'engine', what: 'angry without the customer writing that day', find: 'if (countLT(ats, ts) - countLT(ats, dStart) <= 0) continue;', to: '', by: ['E25d'] },
  { id: 'M25', file: 'engine', what: 'Refund / Ship again does not pause the clock', find: '|| ctx.caseOn(cd, a)) continue;', to: ') continue;', by: ['E10'] },
  { id: 'M26', file: 'engine', what: 'the AI status does not pause the clock', find: 'if (!isHumanStatus(ctx.statusAt(cd, a, true))', to: 'if (false', by: ['E9'] },
  { id: 'M27', file: 'rules', what: 'scoreWaiting = waitingSince (no sign-off rule)',
    find: 'if (s.laAt !== null && isSignOff(s.lvText) && (acceptsClose(s.lvText) || s.lrAt == null || s.laAt > s.lrAt)) return null;', to: '', by: ['W7', 'X7'] },
  { id: 'M28', file: 'engine', what: 'frustrated from 30', find: 'if (best === null || best < ANGRY_MIN) continue;', to: 'if (best === null || best < 30) continue;', by: ['E26'] },
  { id: 'M29', file: 'engine', what: 'solved credit window 1 h instead of 72 h', find: 'cd.msgs[j].at >= T - SOLVED_REPLY_WITHIN_MS', to: 'cd.msgs[j].at >= T - 3_600_000', by: ['E23'] },
  { id: 'M30', file: 'engine', what: 'a pickup counts even if the customer was not waiting', find: 'if (ctx.waitAt(cd, T, false) === null) continue;', to: '', by: ['X10'] },
  { id: 'M31', file: 'engine', what: 'no open-pool team line', find: 'addToSet(poolSets, D, cu)', to: 'void 0', by: ['E11'] },
  { id: 'M32', file: 'engine', what: '2-hour items before part 3 went live',
    find: 'const day = istDay(u.t);\n    if (!ctx.isReport(day) || !ctx.eventsOn(day)) continue;', to: 'const day = istDay(u.t);\n    if (!ctx.isReport(day)) continue;', by: ['E33'] },
  { id: 'M33', file: 'clock', what: 'officeMs ignores the 10:00 open', find: 'Math.min(b, close) - Math.max(a, open)', to: 'Math.min(b, close) - a', by: ['C1'] },
  { id: 'M34', file: 'engine', what: 'a thank-you after a close counts as "came back"',
    find: 'if (cameBack(ctx.textOf(zcd, z.ci), !!z.noReply)) { Z = z; break; }', to: '{ Z = z; break; }', by: ['E21'] },
  { id: 'M35', file: 'engine', what: 'presence ignored (everyone in from 10:00)', find: 'if (day < this.installDay) v = openMs(day);', to: 'if (true) v = openMs(day);', by: ['E12', 'E5'] },
  { id: 'M36', file: 'engine', what: 'angry without 60 angry minutes', find: 'if (am < H) continue;', to: '', by: ['E25c'] },
  // ── Owner answers 2026-10-02 ──
  { id: 'M37', file: 'engine', what: 'A3: the verified check removed (a visitor\'s thank-you counts)', find: 'const verified = !!cd.c.known;', to: 'const verified = true;', by: ['X19', 'X6'] },
  { id: 'M38', file: 'engine', what: 'A3: a visitor\'s "convinced" counts', find: "if (!cd.c.known) {\n      // A3: as for thanks", to: "if (false) {\n      // A3: as for thanks", by: ['X19'] },
  { id: 'M39', file: 'engine', what: 'A3: a visitor\'s thanks after an AI answer counts for the team line',
    find: "      if (!verified) continue;                 // A3: a visitor's thanks is not counted, not even for the team line\n", to: '', by: ['X19'] },
  { id: 'M40', file: 'engine', what: 'A2: closed while the customer waited costs nothing', find: "points: ctx.pts('closed_waiting', D),   // A2", to: 'points: 0,', by: ['E22'] },
  { id: 'M41', file: 'rules', what: 'A2: convinced back to 0 by default', find: 'closed_waiting: -2, convinced: 2, customer_answered: 0 };', to: 'closed_waiting: -2, convinced: 0, customer_answered: 0 };', by: ['W10', 'E19'] },
  { id: 'M42', file: 'rules', what: 'A2: closed_waiting not a weight', find: "'angry', 'closed_waiting', 'convinced', 'customer_answered'];", to: "'angry', 'convinced', 'customer_answered'];", by: ['W10', 'E22', 'X21'] },
  { id: 'M43', file: 'engine', what: 'A4: on the install day everyone counts as in (minus for a member who was not in)', find: 'if (day < this.installDay) v = openMs(day);', to: 'if (day <= this.installDay) v = openMs(day);', by: ['X20'] },
  { id: 'M44', file: 'engine', what: 'A2: a settings row without the new key gives 0 instead of the default', find: 'hit = { id: row.id, w: { ...DEFAULT_WEIGHTS, ...(row.weights || {}) } };', to: 'hit = { id: row.id, w: { ...(row.weights || {}) } as Weights };', by: ['X21'] },
  // ── Review fixes 2026-10-02 ──
  { id: 'M45', file: 'engine', what: 'closing a waiting chat with no team reply is free again',
    find: 'if (li < 0 && (!cd.c.known || !isHumanStatus(ctx.statusAt(cd, T, false)))) return;', to: 'if (li < 0) return;', by: ['E22b'] },
  { id: 'M46', file: 'engine', what: 'closing a visitor\'s or an AI-mode chat with no team reply costs -2',
    find: 'if (li < 0 && (!cd.c.known || !isHumanStatus(ctx.statusAt(cd, T, false)))) return;', to: '', by: ['E22b'] },
  { id: 'M47', file: 'rules', what: 'a courtesy nudge after an unanswered question stops the clock again',
    find: '(acceptsClose(s.lvText) || s.lrAt == null || s.laAt > s.lrAt)', to: 'true', by: ['X7b', 'W11'] },
  { id: 'M48', file: 'rules', what: 'a real "got it thanks" after an unanswered question keeps the clock running',
    find: '(acceptsClose(s.lvText) || s.lrAt == null', to: '(s.lrAt == null', by: ['X7b', 'W11'] },
  { id: 'M49', file: 'engine', what: 'convinced: a complaint after the member\'s answer counts', find: 'for (let j = R.ci - 1; j >= 0; j--) {', to: 'for (let j = M.ci - 1; j >= 0; j--) {', by: ['E19c'] },
  { id: 'M50', file: 'engine', what: 'convinced: one complaint pays again on later days',
    find: "(istDay(m.at) !== D || cd.msgs[pa].au !== X)\n        && usesUp(cd.msgs[pa], tj)) break;", to: 'false) break;', by: ['E19b'] },
  { id: 'M51', file: 'words', what: 'isPoliteAck knows only isCourtesyOnly\'s spellings', find: 'ws.every((w) => POLITE_WORDS.has(w) || ACK_THANKS.test(w))', to: 'false', by: ['E17b', 'W11'] },
  { id: 'M52', file: 'words', what: 'no "ek minute" holding line', find: '  /\\b(ek|1)\\s*min(ute)?\\b/i,\n', to: '', by: ['E17b', 'W11'] },
  { id: 'M53', file: 'engine', what: 'range parts keep the last day\'s weight as "each"', find: 'if (q.each !== p.each) q.each = null;', to: 'q.each = p.each;', by: ['E30c'] },
  // ── Review fixes 2026-10-02, second pass ──
  { id: 'M54', file: 'engine', what: 'convinced: "ok thank u" to a holding line pays +2 again', find: "    if (ack === 'pure') {\n      items.push(", to: "    if (false) {\n      items.push(", by: ['E19d'] },
  { id: 'M55', file: 'engine', what: 'convinced: an "ok" to a holding line uses the complaint up',
    find: "const usesUp = (R: InMsg, t: string) => !ackTo(R, t) && keywordConvinced(t) === 'yes';", to: "const usesUp = (R: InMsg, t: string) => keywordConvinced(t) === 'yes';", by: ['E19d', 'E19i'] },
  { id: 'M56', file: 'engine', what: 'not-counted "Convinced" items are not counted (the number cannot be opened)',
    find: 'else c.convinced_not_counted += 1; break;', to: 'break;', by: ['E19', 'E19d', 'X19', 'X17'] },
  // ── Review 2026-10-02, third pass: holding lines and the convinced already earned ──
  { id: 'M57', file: 'engine', what: 'convinced: a later new question takes back the acceptance earned before it',
    find: "if (acc(Q) !== 'yes' && asksMore(Q)) {", to: 'if (false) {', by: ['E19e', 'E19g'] },
  { id: 'M58', file: 'engine', what: 'convinced: an "ok" to a later holding line decides again (the +2 earned before it is lost)',
    find: "while (q >= 0 && acc(all[q]) === 'wait') q--;", to: 'void 0;', by: ['E19e', 'E19f'] },
  { id: 'M58b', file: 'engine', what: 'convinced: the walk back stops at an "ok" to a holding line between the acceptance and a new question',
    find: "          if (a === 'wait') continue;\n", to: '', by: ['E19j'] },
  { id: 'M59', file: 'engine', what: 'convinced: a complaint after the acceptance does not take it back when a new question follows (the walk crosses it)',
    find: 'if (at(P) < wall) break;', to: 'void 0;', by: ['E19e', 'E19h', 'E19k'] },
  { id: 'M60', file: 'engine', what: 'convinced: an "ok" to a holding line is no longer shown when nothing else decides',
    find: "    if (acc(last) === 'wait') judgeConvinced(last, true);\n", to: '', by: ['E19d', 'E19e'] },
  { id: 'M61', file: 'engine', what: 'convinced: an earlier acceptance is described as the last message',
    find: "their ${isLast ? 'last ' : ''}message at", to: 'their last message at', by: ['E19e', 'E19f'] },
  { id: 'M62', file: 'words', what: 'holding line: a 90-character limit is back (a long pure holding line is no longer one)',
    find: 'if (!t || !any(HOLDING, t)) return null;', to: 'if (!t || Array.from(t).length > 90 || !any(HOLDING, t)) return null;', by: ['W12'] },
  { id: 'M63', file: 'words', what: 'holding line: no fact check ("Delivered sir, ek minute", one word left, is pure)',
    find: "  if (any(HOLDING_FACT, t)) return 'mixed';\n", to: '', by: ['W14', 'W12'] },
  { id: 'M64', file: 'words', what: 'holding line: a bare "please wait" is not one ("Please wait while I check your order" + "ok thanks" pays again)',
    find: '  /\\b(please|kindly|pls|plz)\\s+wait\\b/i,\n', to: '', by: ['E17c', 'W12'] },
  { id: 'M67', file: 'words', what: 'holding line: the Devanagari holding phrases dropped',
    find: "  /(चेक करके|चेक कर रहा|चेक कर रही|कन्फर्म करके|देख कर बता|देखकर बता|पता करके|देखता हूँ|देखता हूं|देखती हूँ|देखती हूं|एक मिनट|प्रतीक्षा करें|", to: "  /(XX|", by: ['E17c', 'W12'] },
  { id: 'M68', file: 'words', what: 'holding line: the Devanagari facts dropped',
    find: "  /(हो गया|हो गयी|हो गई|हो चुका|हो चुकी|डिलीवर|डिस्पैच|शिप हो|ट्रैकिंग|लिंक|", to: "  /(XX|", by: ['W12', 'W14'] },
  // ── Review 2026-10-02, fourth pass: pure / mixed holding lines, the AI for mixed, rejections, all chats ──
  { id: 'M69', file: 'engine', what: 'thanks: "ok thanks" after a mixed holding line is a sure keyword thank-you again',
    find: "const kwX: Tri = ack === 'mixed' ? 'unsure' : kw;", to: 'const kwX: Tri = kw;', by: ['E17c'] },
  { id: 'M70', file: 'engine', what: 'convinced: "ok thanks" after a mixed holding line is a sure keyword acceptance again',
    find: "const kc: Tri = ack === 'mixed' ? 'unsure' : keywordConvinced(t);", to: 'const kc: Tri = keywordConvinced(t);', by: ['E17c'] },
  { id: 'M71', file: 'engine', what: 'thanks: a mixed holding line is treated as pure (the AI\'s "thanks" is not counted)',
    find: "    if (ack === 'pure') {\n      reason = 'Polite", to: "    if (ack) {\n      reason = 'Polite", by: ['E17c'] },
  { id: 'M72', file: 'engine', what: 'convinced: a mixed holding line is treated as pure (the AI\'s "convinced" is not counted)',
    find: "    if (ack === 'pure') {\n      items.push(", to: "    if (ack) {\n      items.push(", by: ['E17c', 'E19i'] },
  { id: 'M73', file: 'engine', what: 'convinced: an "ok" to a mixed line the AI judged not convinced takes back the earlier +2',
    find: "v?.convinced === true ? 'yes' : v ? 'wait' : 'unsure';", to: "v?.convinced === true ? 'yes' : v?.convinced === false ? 'no' : v ? 'wait' : 'unsure';", by: ['E19i'] },
  { id: 'M74', file: 'engine', what: 'convinced: an "ok" to a mixed line on an earlier day uses the complaint up (a later day\'s +2 is lost, and a one-day report differs)',
    find: "const usesUp = (R: InMsg, t: string) => !ackTo(R, t) && keywordConvinced(t) === 'yes';", to: "const usesUp = (R: InMsg, t: string) => ackTo(R, t) !== 'pure' && keywordConvinced(t) === 'yes';", by: ['E19i'] },
  { id: 'M85', file: 'engine', what: 'convinced: a mixed "ok" the AI judged convinced does not count (+2 lost)',
    find: "if (a === 'mixed') return v?.convinced === true ? 'yes' :", to: "if (a === 'mixed') return v?.convinced === true ? 'wait' :", by: ['E19i'] },
  { id: 'M75', file: 'engine', what: 'convinced: a new question that is also a rejection ("nahi, kab aayega?") falls back to the earlier +2',
    find: 'isNewAsk(L.t) && !rejectsAnswer(L.t) &&', to: 'isNewAsk(L.t) &&', by: ['E19g'] },
  { id: 'M76', file: 'engine', what: 'convinced: a new question the AI judged not convinced falls back to the earlier +2',
    find: " && ctx.verdictOf(L.M.id)?.convinced !== false;", to: ';', by: ['E19g'] },
  { id: 'M77', file: 'engine', what: 'convinced: any non-rejecting later message (not only a new question) falls back to the earlier +2',
    find: "if (acc(Q) !== 'yes' && asksMore(Q)) {", to: "if (acc(Q) !== 'yes' && !rejectsAnswer(Q.t)) {", by: ['E19g'] },
  { id: 'M78', file: 'engine', what: 'convinced: a complaint in a chat nobody answered (the third chat) is not seen',
    find: 'if (isObjection(ctx.textOf(ctx.cds.get(m.conv)!, m.ci))) obj.push(i);',
    to: 'if (ctx.cds.get(m.conv)!.lastAns[m.ci] >= 0 && isObjection(ctx.textOf(ctx.cds.get(m.conv)!, m.ci))) obj.push(i);', by: ['E19h', 'E19k'] },
  { id: 'M79', file: 'engine', what: 'convinced: the walk back crosses a rejection between the acceptance and the new question',
    find: 'if (!asksMore(P)) break;', to: 'if (!asksMore(P)) continue;', by: ['E19g'] },
  { id: 'M80', file: 'engine', what: 'convinced: the walk back stops at an "ok" to a mixed line still waiting for the AI',
    find: "if (a === 'unsure' && ackTo(P.R, P.t) === 'mixed') continue;", to: '', by: ['E19i'] },
  { id: 'M81', file: 'words', what: 'AI prompt: the holding-line sentence dropped',
    find: ' If the team\'s reply only promises to check, confirm or update later and gives no answer yet, a polite ok / thanks is THANKS=no and CONVINCED=no; if it gives a real answer (even with "please wait N days"), judge normally.', to: '', by: ['W5'] },
  { id: 'M82', file: 'words', what: 'holding line: "kar diya" / "available hai" are not facts (short real answers with "ek minute" are pure again)',
    find: "  /\\b(kar|kr)\\s*(diya|diye|dia|di|dii|liya|liye|lia|li)\\b|\\bavailable\\s+(hai|h|he|hain|hn)\\b|", to: "  /XX|", by: ['E17c', 'W12', 'W14'] },
  { id: 'M83', file: 'words', what: 'rejection: "no" / "not ok" / "I am not convinced" phrases not seen', find: 'return isObjection(t) || REJECT.test(t) ||', to: 'return isObjection(t) ||', by: ['W13', 'E19g'] },
  { id: 'M84', file: 'words', what: 'new question: only a "?" counts (no question / request words)', find: "return t.includes('?') || ASK.test(t) || REQUEST.test(t);", to: "return t.includes('?');", by: ['W13', 'E19g'] },
  // ── Fifth pass (lead design v5) ──
  // A: pure / mixed by what is left of the holding line
  { id: 'M86', file: 'words', what: 'A: what is left is not looked at (every holding line without a fact word is pure again)',
    find: "  const left = leftOver(t);\n  return left.length <= 1 && !left.some((w) => ANSWER_WORD.test(w)) ? 'pure' : 'mixed';", to: "  return 'pure';", by: ['W14', 'E17d'] },
  { id: 'M87', file: 'words', what: 'A: two words left still count as pure ("Wait karo, order aa jayega")',
    find: 'return left.length <= 1 &&', to: 'return left.length <= 2 &&', by: ['W14', 'E17d'] },
  { id: 'M88', file: 'words', what: 'A: a yes / no is filler ("Ji haan, ek minute" is pure)',
    find: "!left.some((w) => ANSWER_WORD.test(w)) ? 'pure'", to: "true ? 'pure'", by: ['W14'] },
  { id: 'M89', file: 'words', what: 'A: the cut stops inside a word ("check karke bata|ta": "ta" is left over)',
    find: "+ ')[a-z]*', re.flags + 'g')", to: "+ ')', re.flags + 'g')", by: ['W12', 'W14'] },
  { id: 'M90', file: 'words', what: 'A: the "will ... check" gap is greedy again (it swallows "your parcel is at the hub")',
    find: "re.source.replace('[^.?!]{0,40}\\\\b', '[^.?!]{0,40}?\\\\b')", to: 're.source', by: ['W14'] },
  { id: 'M91', file: 'words', what: 'A: a chained "... and get back to you" is left over (mixed)', find: '  /\\bget\\s+back\\b/gi,\n', to: '', by: ['W14'] },
  { id: 'M92', file: 'words', what: 'A: the Devanagari filler words dropped ("मैं चेक करके बताता हूँ" is mixed)',
    find: "  'सर मैम जी कृपया थोड़ा बस अभी मैं हम आप आपका आपके आपकी आपको ऑर्डर को का की के से में मे और या हूँ हूं हु रहा रही रहे करता करती करते कर करके ' +\n", to: "  '' +\n", by: ['W14', 'E17d'] },
  // B: a later question with push-back is the last word
  { id: 'M93', file: 'engine', what: 'B: push-back not checked (a "kyu" / "kitne din" question keeps the earlier +2)',
    find: ' && !pushesBack(L.t) && ', to: ' && ', by: ['E19j'] },
  { id: 'M94', file: 'words', what: 'B: only a complaint is push-back (no push-back words)', find: 'if (isObjection(t) || PUSHBACK.test(t)) return true;', to: 'if (isObjection(t)) return true;', by: ['W15', 'E19j'] },
  { id: 'M95', file: 'words', what: 'B: anger (shouting, "???") is not push-back', find: 'return s.caps + s.burst > 0;', to: 'return false;', by: ['W15', 'E19j'] },
  // C: a complaint in any chat after the acceptance takes it back on every path
  { id: 'M96', file: 'engine', what: 'C: a complaint after the deciding message (behind a later "ok") does not take the +2 back',
    find: 'if (!takenBack && judgeConvinced(pick, pick === last)) continue;', to: 'if (judgeConvinced(pick, pick === last)) continue;', by: ['E19k'] },
  { id: 'M97', file: 'engine', what: 'C: a complaint after the customer\'s last message to the member that day takes the +2 back too',
    find: 'x.obj[c] <= at(last);', to: 'true;', by: ['E19k'] },
  // D: one linear walk back
  { id: 'M98', file: 'engine', what: 'D: the walk back rescans the customer\'s messages for every pair (fourth pass, quadratic)',
    find: 'if (at(P) < wall) break;',
    to: 'if ((ctx.cuVis.get(last.cd.c.cu) || []).slice(at(P) + 1, at(Q)).some((m) => isObjection(ctx.textOf(ctx.cds.get(m.conv)!, m.ci)))) break;', by: ['E32b'] },
  // E: ai_failed on an "ok" to a mixed line
  { id: 'M99', file: 'engine', what: 'E: "ai_failed" on an "ok" to a mixed line replaces the +2 earned before with "AI could not decide"',
    find: "v?.convinced === true ? 'yes' : v ? 'wait' : 'unsure';", to: "v?.convinced === true ? 'yes' : v?.convinced === false ? 'wait' : 'unsure';", by: ['E19l'] },
  { id: 'M100', file: 'engine', what: 'E: "ai_failed" on an "ok" to a mixed line with nothing else is no longer shown ("AI could not decide")',
    find: '    } else if (v.convinced !== false) {\n      items.push({ ...base, counted: false, pending: false, points: 0, by: \'ai\', why: AI_FAILED_WHY });\n    } else return false;',
    to: '    } else return false;', by: ['E19l', 'E18'] },
];

function compile(dir, mut) {
  for (const [name, rel] of Object.entries(SRC)) {
    let src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (mut && mut.file === name) {
      const count = src.split(mut.find).length - 1;
      if (count !== 1) return `target text found ${count} times in ${rel}`;
      src = src.replace(mut.find, () => mut.to);
    }
    src = src.replace(/'@\/lib\/office-hours'/g, "'./office-hours'").replace(/'@\/lib\/chat\/([\w-]+)'/g, "'./$1'");
    fs.writeFileSync(path.join(dir, name + '.js'), ts.transpileModule(src, { compilerOptions: { module: 'commonjs', target: 'es2020' } }).outputText);
  }
  return null;
}

function runSuites(dir) {
  const fails = [];
  let crashed = false;
  for (const suite of SUITES) {
    const r = spawnSync(process.execPath, [path.join(__dirname, suite)], { env: { ...process.env, TEAM_SCORE_JS_DIR: dir }, encoding: 'utf8', timeout: 120_000 });
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    for (const m of out.matchAll(/^FAIL (\S+)/gm)) fails.push(m[1]);
    if (r.status !== 0 && !/^FAIL /m.test(out)) crashed = true;   // threw before or outside a case
  }
  return { fails, crashed };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'team-score-mutate-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

// Sanity: the real code passes both suites in this mode.
const base = path.join(tmp, 'base');
fs.mkdirSync(base);
compile(base, null);
const b = runSuites(base);
if (b.fails.length || b.crashed) {
  console.log(`BASELINE FAILS (${b.fails.join(', ') || 'crash'}): fix the suites first`);
  process.exit(1);
}
console.log('baseline: both suites pass on the real code');

let bad = 0;
for (const mut of MUTATIONS) {
  const dir = path.join(tmp, mut.id);
  fs.mkdirSync(dir);
  const err = compile(dir, mut);
  if (err) { bad++; console.log(`${mut.id.padEnd(4)} BROKEN    ${mut.what}: ${err}`); continue; }
  const { fails, crashed } = runSuites(dir);
  const hit = [...new Set(fails.filter((f) => mut.by.includes(f)))];
  let verdict;
  if (hit.length) verdict = 'caught  ';
  else if (fails.length || crashed) { verdict = 'ELSEWHERE'; bad++; }
  else { verdict = 'SURVIVED'; bad++; }
  const by = hit.length ? hit.join(', ') : fails.slice(0, 4).join(', ') || (crashed ? 'suite crashed' : '-');
  console.log(`${mut.id.padEnd(4)} ${verdict} ${mut.what}  [by ${by}${fails.length > hit.length ? `; ${fails.length} failing in all` : ''}]`);
}
console.log(bad ? `TEAM-SCORE MUTATE: ${bad} of ${MUTATIONS.length} not caught as required` : `TEAM-SCORE MUTATE: all ${MUTATIONS.length} mutations caught`);
process.exit(bad ? 1 : 0);
