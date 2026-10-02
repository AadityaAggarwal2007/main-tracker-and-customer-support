// ── Team score (owner, 2026-10-01, part 4): the engine. Pure, deterministic, no I/O. ──
// STAFF ONLY. One ScoreInput (load.ts, one REPEATABLE READ snapshot) in, the per-person, per-day
// items and counts out. Every number on the Team score screen comes from here, and every item
// carries one plain-English sentence saying why (never customer text). Spec: phase 4, section 3.5.
// Owner answers 2026-10-02: a thank-you or "convinced" counts only in a VERIFIED chat (InConv.known),
// and an unverified visitor's message never goes to the AI check (A3); closing a chat while the
// customer waits costs points (A2); points start on the install day, so from that day on the clock
// needs the member to be in (A4).
import type {
  DayResult, EngineResult, InMsg,
  ItemKind, JudgeCandidate, Part, PersonDay, PointKind,
  ScoreInput, ScoreItem, TeamDay,
} from './types';
import { DAY_MS, MIN_MS, istDay, istDayStart, openMs, closeMs, officeMs, addOfficeMs, hhmm, dayLabel, todayIst } from './clock';
import {
  holdingKind, isObjection, keywordThanks, keywordConvinced,
  cameBack, acceptsClose, isPoliteAck, isNewAsk, rejectsAnswer, pushesBack,
} from './words';
import type { Tri } from './words';
import {
  FAST_REPLY_MIN, UNANSWERED_MIN, TAKEN_NO_REPLY_MIN, ANGRY_MIN, ANGRY_HELD_MIN, THANKS_WINDOW_MS, SOLVED_QUIET_MS,
  SOLVED_REPLY_WITHIN_MS, OBJECTION_LOOKBACK_MS, SOLICIT_LOOKBACK_MS, WEIGHT_KEYS,
  isHumanStatus,
} from './rules';
import { saysResolved } from '@/lib/chat/health-rules';
import { isOfficeHours } from '@/lib/office-hours';

import { Ctx, cmp, countLE, countLT, isPersonKey, type ConvData, type Hold, type Msg } from './ctx';
import { emptyCounts } from './merge';

// Moved out of this file on 2026-10-02 (pure move); re-exported so no importer changes.
export { mergeDays } from './merge';
export type { ScoreCounts } from './merge';

export interface Timeline {
  statusAt(conv: string, t: number): string | null;
  holderAt(conv: string, t: number): string | null;          // raw
  effectiveHolder(conv: string, t: number): string | null;
  caseOn(conv: string, t: number): boolean;
  waitAt(conv: string, t: number, inclusive: boolean): number | null;
  score(conv: string, t: number): number | null;
}

// Time for a sentence: '14:05' on the item's own day, else '2 Oct 14:05'.
const when = (ms: number, day: string) => (istDay(ms) === day ? hhmm(ms) : `${dayLabel(istDay(ms))} ${hhmm(ms)}`);
const dateTime = (ms: number) => `${dayLabel(istDay(ms))} ${hhmm(ms)}`;
const mins = (ms: number) => Math.round(ms / MIN_MS);

const AI_PENDING_WHY = 'Waiting for the AI check (the keywords could not decide)';
const AI_FAILED_WHY = 'AI could not decide';
// Owner A3: thanks and convinced count only for a customer verified with order ID + phone.
export const NOT_VERIFIED_WHY = 'Visitor not verified';
// Review 2026-10-02: a polite "ok thank u" / "ok tq" to a holding line ("check karke batata hu")
// accepts nothing yet; the customer is still waiting for the answer. It is not "convinced", as it is
// not a thank-you, and it does not use up the complaint for the real answer that follows. Third pass:
// it is simply ignored for Convinced, so it never cancels an acceptance of a real answer that day;
// it is shown (not counted) only when nothing else decides for that person, customer and day.
// Fourth pass: that is for a 'pure' holding line only ("Please wait while I check your order"). After a
// 'mixed' one, a holding phrase with a fact ("Aapka refund ho gaya hai, please wait 5-7 working days",
// "Let me check if it is delivered"), the keywords cannot tell whether the customer got an answer: the
// "ok thanks" is unsure, the AI decides thanks and convinced (owner Q12: keywords first, AI when unsure).
export const HOLDING_ACK_WHY = 'Polite "ok" while still waiting for the answer';
// 'pure' / 'mixed': a polite "ok thanks" right after that kind of holding line by a team member; null: not one.
const ackTo = (reply: InMsg, customerText: string): 'pure' | 'mixed' | null =>
  reply.sender === 'agent' && isPoliteAck(customerText) ? holdingKind(reply.text || '') : null;


export function makeTimeline(input: ScoreInput): Timeline {
  const ctx = new Ctx(input);
  const cd = (conv: string) => ctx.cds.get(conv) || null;
  return {
    statusAt: (conv, t) => { const d = cd(conv); return d ? ctx.statusAt(d, t, true) : null; },
    holderAt: (conv, t) => { const d = cd(conv); return d ? ctx.holderAt(d, t) : null; },
    effectiveHolder: (conv, t) => { const d = cd(conv); return d ? ctx.effHolder(d, t) : null; },
    caseOn: (conv, t) => { const d = cd(conv); return d ? ctx.caseOn(d, t) : false; },
    waitAt: (conv, t, inclusive) => { const d = cd(conv); return d ? ctx.waitAt(d, t, inclusive) : null; },
    score: (conv, t) => { const d = cd(conv); return d ? ctx.score(d, t) : null; },
  };
}

export function buildTeamScore(input: ScoreInput): EngineResult {
  const ctx = new Ctx(input);
  const items: ScoreItem[] = [];
  const candidates = new Map<string, JudgeCandidate>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) || 0) + 1);
  const pickedPool = new Map<string, number>(), pickedTake = new Map<string, number>(), askedThanks = new Map<string, number>();
  const poolSets = new Map<string, Set<string>>(), absentSets = new Map<string, Set<string>>();
  const unattributed = new Map<string, Map<string, number>>();
  const addToSet = (m: Map<string, Set<string>>, day: string, v: string) => {
    if (!m.has(day)) m.set(day, new Set()); m.get(day)!.add(v);
  };
  // Only a verified chat's message is ever sent to the AI check (owner A3; the callers check too).
  const addCandidate = (M: Msg, R: Msg, t: string) => {
    if (!ctx.convMap.get(M.conv)?.known) return;
    if (!candidates.has(M.id)) candidates.set(M.id, { messageId: M.id, conv: M.conv, teamText: String(R.text || ''), customerText: t });
  };

  // ── 3.5.2 The clock walk ──
  const U = UNANSWERED_MIN * MIN_MS, T30 = TAKEN_NO_REPLY_MIN * MIN_MS;
  const dayStarts: number[] = [];
  if (ctx.loadEnd > ctx.loadStart) {
    for (let d = istDayStart(ctx.loadStart); d < ctx.loadEnd; d += DAY_MS) if (d > ctx.loadStart) dayStarts.push(d);
  }
  interface Acc { cum: number; crossed: boolean; lastItemDay: string; day: Record<string, number> }
  interface HoldAcc { K: string; cd: ConvData; D: string; hold: Hold; ms: number; at30: number | null }
  interface UA { K: string; cd: ConvData; t: number; repeat: boolean; first: number; holdStart: number }
  const uas: UA[] = [];
  const holdAccs = new Map<string, HoldAcc>();
  for (const cd of ctx.cds.values()) {
    const n = cd.msgs.length;
    if (!n || cd.lastVis[n - 1] < 0 || ctx.loadEnd <= ctx.loadStart) continue;
    const set = new Set<number>([ctx.loadStart, ctx.loadEnd]);
    const add = (t: number) => { if (t > ctx.loadStart && t < ctx.loadEnd) set.add(t); };
    cd.ats.forEach(add); cd.hAts.forEach(add); cd.sAts.forEach(add); cd.cAts.forEach(add);
    for (const d of dayStarts) set.add(d);
    const pts = Array.from(set).sort((a, b) => a - b);
    const cu = cd.c.cu;
    const poolMs = new Map<string, number>();
    const accs = new Map<string, Acc>();
    let ep: { key: string; first: number } | null = null;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      if (a < cd.ats[0]) continue;                       // before the chat's first message: nobody waits
      const W = ctx.waitAt(cd, a, true);
      if (W === null) { ep = null; continue; }
      if (!ep) {
        const fi = ctx.firstUnanswered(cd, a);
        ep = { key: `${cd.c.id}:${a}`, first: fi >= 0 ? cd.msgs[fi].at : W };
      }
      if (!isHumanStatus(ctx.statusAt(cd, a, true)) || ctx.caseOn(cd, a)) continue;
      const D = istDay(a);
      const K = ctx.effHolder(cd, a);
      if (K === null) {
        const before = poolMs.get(ep.key) || 0, after = before + officeMs(a, b);
        poolMs.set(ep.key, after);
        if (before < U && after >= U && ctx.isReport(D) && ctx.eventsOn(D)) addToSet(poolSets, D, cu);
        continue;
      }
      let s = ctx.dutyStart(K, D);
      if (s === null) {
        if (officeMs(a, b) > 0 && ctx.isReport(D) && ctx.eventsOn(D)) addToSet(absentSets, D, cu);
        continue;
      }
      s = Math.max(a, s);
      if (s >= b) continue;
      const ms = officeMs(s, b);
      if (ms <= 0) continue;
      const hold = ctx.holdOf(cd, K, a);
      const akey = `${ep.key}|${K}`;
      let acc = accs.get(akey);
      if (!acc) { acc = { cum: 0, crossed: false, lastItemDay: '', day: {} }; accs.set(akey, acc); }
      const today = acc.day[D] ?? 0;
      if (!acc.crossed && acc.cum + ms >= U) {
        const t = addOfficeMs(s, U - acc.cum);
        uas.push({ K, cd, t, repeat: false, first: ep.first, holdStart: hold.start });
        acc.crossed = true; acc.lastItemDay = istDay(t);
      } else if (acc.crossed && D !== acc.lastItemDay && today + ms >= U) {
        const t = addOfficeMs(s, U - today);
        uas.push({ K, cd, t, repeat: true, first: ep.first, holdStart: hold.start });
        acc.lastItemDay = D;
      }
      acc.cum += ms; acc.day[D] = today + ms;
      const hkey = `${hold.start}|${cd.c.id}|${K}|${D}`;
      let h = holdAccs.get(hkey);
      if (!h) { h = { K, cd, D, hold, ms: 0, at30: null }; holdAccs.set(hkey, h); }
      if (h.at30 === null && h.ms + ms >= T30) h.at30 = addOfficeMs(s, T30 - h.ms);
      h.ms += ms;
    }
  }
  // unanswered_2h: report days with events; one per (K, customer, day), the first instant wins.
  uas.sort((x, y) => x.t - y.t || cmp(x.cd.c.id, y.cd.c.id) || cmp(x.K, y.K) || Number(x.repeat) - Number(y.repeat));
  const uaSeen = new Set<string>();
  for (const u of uas) {
    const day = istDay(u.t);
    if (!ctx.isReport(day) || !ctx.eventsOn(day)) continue;
    const k = `${u.K}|${u.cd.c.cu}|${day}`;
    if (uaSeen.has(k)) continue;
    uaSeen.add(k);
    const fi = ctx.firstUnanswered(u.cd, u.t);
    const why = u.repeat
      ? `Still waiting from ${dateTime(u.first)}: another 2 office hours today at ${hhmm(u.t)}.`
      : `Customer waiting since ${when(u.first, day)} (no reply yet). ${ctx.nameOf(u.K)} held the chat from ${when(u.holdStart, day)}. 2 office hours passed at ${hhmm(u.t)} with no reply.`;
    items.push({
      kind: 'unanswered_2h', actor: u.K, day, at: u.t, conv: u.cd.c.id, cu: u.cd.c.cu,
      msgs: fi >= 0 ? [u.cd.msgs[fi].id] : [], counted: true, pending: false, points: ctx.pts('unanswered_2h', day), why,
    });
  }
  // taken_no_reply (info only, 0 points): held, the customer waited 30 office minutes, and the
  // holder sent nothing in that chat during the hold.
  const tnr = Array.from(holdAccs.values()).filter((h) => h.at30 !== null && ctx.isReport(h.D) && ctx.eventsOn(h.D))
    .sort((x, y) => x.at30! - y.at30! || cmp(x.cd.c.id, y.cd.c.id) || cmp(x.K, y.K));
  const tnrSeen = new Set<string>();
  for (const h of tnr) {
    const k = `${h.K}|${h.cd.c.cu}|${h.D}`;
    if (tnrSeen.has(k)) continue;
    const to = Math.min(h.hold.end, istDayStart(h.at30!) + DAY_MS);
    const replied = h.cd.msgs.some((m) => m.sender === 'agent' && m.au === h.K && m.at >= h.hold.start && m.at < to);
    if (replied) continue;
    tnrSeen.add(k);
    const fi = ctx.firstUnanswered(h.cd, h.at30!);
    items.push({
      kind: 'taken_no_reply', actor: h.K, day: h.D, at: h.at30!, conv: h.cd.c.id, cu: h.cd.c.cu,
      msgs: fi >= 0 ? [h.cd.msgs[fi].id] : [], counted: true, pending: false, points: 0,
      why: `${ctx.nameOf(h.K)} held this chat from ${when(h.hold.start, h.D)}; the customer waited ${mins(h.ms)} office min and ${ctx.nameOf(h.K)} sent no reply.`,
    });
  }

  // ── 3.5.3 Chat items (replies, chats, customers) and the unattributed footer ──
  const chatItems = new Map<string, ScoreItem>();
  for (const m of ctx.msgs) {
    if (m.sender !== 'agent') continue;
    const D = istDay(m.at);
    if (!ctx.isReport(D)) continue;
    const X = m.au!;
    if (X === 'unattributed') {
      const login = String(m.login || '').toLowerCase() || 'unknown';
      if (!unattributed.has(D)) unattributed.set(D, new Map());
      bump(unattributed.get(D)!, login);
      continue;
    }
    const k = `${X}|${m.conv}|${D}`;
    const out = !isOfficeHours(m.at);
    let it = chatItems.get(k);
    if (!it) {
      const conv = ctx.convMap.get(m.conv)!;
      it = { kind: 'chat', actor: X, day: D, at: m.at, conv: m.conv, cu: conv.cu, msgs: [m.id], counted: true, pending: false, points: 0, why: '', n: 0, after: 0 };
      chatItems.set(k, it);
    }
    it.n! += 1; if (out) it.after! += 1;
  }
  const firstChatOfCustomer = new Set<string>();
  for (const it of Array.from(chatItems.values()).sort((a, b) => a.at - b.at || cmp(a.conv, b.conv) || cmp(a.actor, b.actor))) {
    const ck = `${it.actor}|${it.cu}|${it.day}`;
    if (!firstChatOfCustomer.has(ck)) { firstChatOfCustomer.add(ck); it.points = ctx.pts('customer_answered', it.day); }
    it.why = `${ctx.nameOf(it.actor)} sent ${it.n} ${it.n === 1 ? 'reply' : 'replies'} in this chat${it.after ? ` (${it.after} outside 10:00-19:30)` : ''}.`;
    items.push(it);
  }

  // ── 3.5.4 Thank-you and convinced ──
  interface Last { M: Msg; R: Msg; t: string; cd: ConvData; X: string; D: string }
  // Every customer message answering X's reply, per (X, customer, day), in time order: "convinced" below.
  const toX = new Map<string, Last[]>();
  const thanksSlot = new Set<string>();
  const aiThanks = new Set<string>();
  for (const M of ctx.msgs) {
    if (M.sender !== 'visitor') continue;
    const D = istDay(M.at);
    if (!ctx.isReport(D)) continue;
    const cd = ctx.cds.get(M.conv)!;
    const t = ctx.textOf(cd, M.ci);
    const r = M.ci > 0 ? cd.lastAns[M.ci - 1] : -1;
    if (r < 0) continue;
    const R = cd.msgs[r];
    if (M.at - R.at > THANKS_WINDOW_MS) continue;
    const cu = cd.c.cu;
    const verified = !!cd.c.known;
    const kw = keywordThanks(t);
    if (R.sender === 'ai') {
      if (!verified) continue;                 // A3: a visitor's thanks is not counted, not even for the team line
      const v = ctx.verdictOf(M.id);
      if (kw === 'yes' || (v && v.thanks === true)) {
        const ak = `${cu}|${D}`;
        if (!aiThanks.has(ak)) {
          aiThanks.add(ak);
          items.push({
            kind: 'thanks', actor: 'ai', day: D, at: M.at, conv: M.conv, cu, msgs: [R.id, M.id], counted: true, pending: false,
            points: 0, by: kw === 'yes' ? 'keyword' : 'ai',
            why: `Customer said thanks at ${hhmm(M.at)}, ${mins(M.at - R.at)} min after the AI's answer (${kw === 'yes' ? 'keyword check' : 'AI check'}).`,
          });
        }
      }
      continue;
    }
    const X = R.au;
    if (!X || X === 'unattributed') continue;
    const seen = toX.get(`${X}|${cu}|${D}`);
    if (seen) seen.push({ M, R, t, cd, X, D }); else toX.set(`${X}|${cu}|${D}`, [{ M, R, t, cd, X, D }]);
    if (kw === 'no') continue;
    // "ok thanks" to a holding line: 'pure' = not counted below; 'mixed' = never a sure thank-you, the AI decides.
    const ack = ackTo(R, t);
    const kwX: Tri = ack === 'mixed' ? 'unsure' : kw;
    const base = { kind: 'thanks' as ItemKind, actor: X, day: D, at: M.at, conv: M.conv, cu, msgs: [R.id, M.id] };
    if (!verified) {
      // A3: shown as not counted when it surely is a thank-you (keywords, or a verdict already saved);
      // an unsure one is never sent to the AI and leaves no item.
      const v = kwX === 'yes' ? null : ctx.verdictOf(M.id);
      if (kwX === 'yes' || (v && v.thanks === true)) {
        items.push({ ...base, counted: false, pending: false, points: 0, by: kwX === 'yes' ? 'keyword' : 'ai', why: NOT_VERIFIED_WHY });
      }
      continue;
    }
    let by: 'keyword' | 'ai';
    if (kwX === 'yes') by = 'keyword';
    else {
      const v = ctx.verdictOf(M.id);
      if (!v) {
        addCandidate(M, R, t);
        items.push({ ...base, counted: false, pending: true, points: 0, by: null, why: AI_PENDING_WHY });
        continue;
      }
      if (v.thanks === false) continue;
      if (v.thanks !== true) {
        items.push({ ...base, counted: false, pending: false, points: 0, by: 'ai', why: AI_FAILED_WHY });
        continue;
      }
      by = 'ai';
    }
    let reason: string | null = null;
    if (ack === 'pure') {
      reason = 'Polite "ok thanks" while still waiting for the answer';
    } else {
      let ask: Msg | null = null;
      for (let j = M.ci - 1; j >= 0; j--) {
        const m = cd.msgs[j];
        if (m.at < M.at - SOLICIT_LOOKBACK_MS) break;
        if (m.at >= M.at) continue;
        if (m.sender === 'agent' && m.au === X && ctx.asks(m)) { ask = m; break; }
      }
      if (ask) { reason = `Asked the customer to say thanks at ${hhmm(ask.at)}`; bump(askedThanks, `${X}|${D}`); }
      else if (thanksSlot.has(`${X}|${cu}|${D}`)) reason = 'Same customer already counted today';
    }
    if (reason) {
      items.push({ ...base, counted: false, pending: false, points: 0, by, why: reason });
    } else {
      thanksSlot.add(`${X}|${cu}|${D}`);
      items.push({
        ...base, counted: true, pending: false, points: ctx.pts('thanks', D), by,
        why: `Customer said thanks at ${hhmm(M.at)}, ${mins(M.at - R.at)} min after ${ctx.nameOf(X)}'s reply (${by === 'keyword' ? 'keyword check' : 'AI check'}).`,
      });
    }
  }
  // Does the customer's message t (id) accept the staff answer R? 'wait' = a polite "ok" while still
  // waiting: after a pure holding line, or after a mixed one the AI judged not convinced, or could not
  // judge (fifth pass, E: an 'ai_failed' verdict never replaces a +2 already earned with "AI could not
  // decide"; when nothing else decides it is still shown so, below). After a mixed one with no verdict
  // yet: 'unsure'. Otherwise the keywords, then a saved AI verdict when they are unsure.
  const acceptOf = (R: InMsg, t: string, id: string): Tri | 'wait' => {
    const a = ackTo(R, t);
    if (a === 'pure') return 'wait';
    const v = ctx.verdictOf(id);
    if (a === 'mixed') return v?.convinced === true ? 'yes' : v ? 'wait' : 'unsure';
    const kc = keywordConvinced(t);
    if (kc !== 'unsure') return kc;
    return v?.convinced === true ? 'yes' : v?.convinced === false ? 'no' : 'unsure';
  };
  // Worked out once per message: the walk back below reads it again.
  const accMemo = new Map<Last, Tri | 'wait'>();
  const acc = (L: Last): Tri | 'wait' => {
    let a = accMemo.get(L);
    if (a === undefined) { a = acceptOf(L.R, L.t, L.M.id); accMemo.set(L, a); }
    return a;
  };
  // An earlier acceptance that already used the complaint up (turnedAround): keywords only, as before,
  // because that message may be on another day, whose AI verdict a one-day computation (the frozen day)
  // does not load. A polite "ok" to a holding line, pure or mixed, never uses it up.
  const usesUp = (R: InMsg, t: string) => !ackTo(R, t) && keywordConvinced(t) === 'yes';
  // Fifth pass (B): a later message keeps an earlier acceptance only when it is a new question or request
  // (isNewAsk) with no push-back (pushesBack: a complaint, anger, "kyu", "kitne din", "pehle bhi", "mazak",
  // "nahi chahiye", ...) and no rejection ("no", "not ok", "nahi", or an AI verdict convinced = false).
  // Anything else is the last word, as in c113ed0.
  const asksMore = (L: Last) => isNewAsk(L.t) && !rejectsAnswer(L.t) && !pushesBack(L.t) && ctx.verdictOf(L.M.id)?.convinced !== false;
  // The complaint X turned around with the answer L.R: before R (a complaint after it was never
  // answered by X), within 72 h of L.M. A turnaround is used once: an earlier acceptance of a staff
  // answer on another day, or of someone else's answer, already used the complaints before it.
  const turnedAround = (L: Last): Msg | null => {
    const { M, R, cd, X, D } = L;
    for (let j = R.ci - 1; j >= 0; j--) {
      const m = cd.msgs[j];
      if (m.at < M.at - OBJECTION_LOOKBACK_MS) break;
      if (m.at >= M.at || m.sender !== 'visitor') continue;
      const tj = ctx.textOf(cd, j);
      if (isObjection(tj)) return m;
      const pa = j > 0 ? cd.lastAns[j - 1] : -1;
      if (pa >= 0 && cd.msgs[pa].sender === 'agent' && (istDay(m.at) !== D || cd.msgs[pa].au !== X)
        && usesUp(cd.msgs[pa], tj)) break;
    }
    return null;
  };
  // The customer's messages in ALL their chats (ctx.cuVis, message order): each one's place, and the
  // places of their complaints (isObjection). Built once per customer, so every complaint check below is
  // a binary search and the walk back stays linear (fifth pass, D).
  const cuIndex = new Map<string, { pos: Map<Msg, number>; obj: number[] }>();
  const indexOf = (cu: string) => {
    let x = cuIndex.get(cu);
    if (!x) {
      const pos = new Map<Msg, number>(), obj: number[] = [];
      (ctx.cuVis.get(cu) || []).forEach((m, i) => {
        pos.set(m, i);
        if (isObjection(ctx.textOf(ctx.cds.get(m.conv)!, m.ci))) obj.push(i);
      });
      x = { pos, obj };
      cuIndex.set(cu, x);
    }
    return x;
  };
  // The "Convinced" item for the customer's message L; false when L leaves none.
  const judgeConvinced = (L: Last, isLast: boolean): boolean => {
    const { M, R, t, cd, X, D } = L;
    const O = turnedAround(L);
    if (!O) return false;
    const ack = ackTo(R, t);
    // "ok thanks" to a mixed holding line: the keywords cannot decide, the AI does.
    const kc: Tri = ack === 'mixed' ? 'unsure' : keywordConvinced(t);
    if (kc === 'no') return false;
    const base = { kind: 'convinced' as ItemKind, actor: X, day: D, at: M.at, conv: M.conv, cu: cd.c.cu, msgs: [R.id, O.id, M.id] };
    if (!cd.c.known) {
      // A3: as for thanks: not counted, and never a question for the AI.
      const v = kc === 'yes' ? null : ctx.verdictOf(M.id);
      if (kc === 'yes' || (v && v.convinced === true)) {
        items.push({ ...base, counted: false, pending: false, points: 0, by: kc === 'yes' ? 'keyword' : 'ai', why: NOT_VERIFIED_WHY });
        return true;
      }
      return false;
    }
    // "ok thank u" after "check karke batata hu" (a pure holding line): shown, not counted, never asked of the AI.
    if (ack === 'pure') {
      items.push({ ...base, counted: false, pending: false, points: 0, by: 'keyword', why: HOLDING_ACK_WHY });
      return true;
    }
    const okWhy = `Customer complained at ${when(O.at, D)}; their ${isLast ? 'last ' : ''}message at ${hhmm(M.at)} accepts ${ctx.nameOf(X)}'s answer.`;
    if (kc === 'yes') {
      items.push({ ...base, counted: true, pending: false, points: ctx.pts('convinced', D), by: 'keyword', why: okWhy });
      return true;
    }
    const v = ctx.verdictOf(M.id);
    if (!v) {
      addCandidate(M, R, t);
      items.push({ ...base, counted: false, pending: true, points: 0, by: null, why: AI_PENDING_WHY });
    } else if (v.convinced === true) {
      items.push({ ...base, counted: true, pending: false, points: ctx.pts('convinced', D), by: 'ai', why: okWhy });
    } else if (v.convinced !== false) {
      items.push({ ...base, counted: false, pending: false, points: 0, by: 'ai', why: AI_FAILED_WHY });
    } else return false;
    return true;
  };
  // One item at most per (X, customer, day). The deciding message is the customer's last one to X that
  // day, with two exceptions (review 2026-10-02, third to fifth pass): a polite "ok" while still waiting
  // (acceptOf 'wait') is skipped (it decides only when nothing else does), and a later NEW QUESTION OR
  // REQUEST with no push-back and no rejection ("aur mera dusra order kab dispatch hoga") does not take
  // back an earlier acceptance of X's answer. One walk back from the last message (D): it crosses only
  // such questions, polite "ok"s and "ok"s to a mixed line waiting for the AI, and never a complaint the
  // customer made in any chat after the acceptance. Any other later message is the last word (the AI
  // decides an unsure one). C: a complaint in any of the customer's chats after the deciding message, up
  // to their last message to X that day, takes it back on every path (also behind a later polite "ok").
  for (const all of toX.values()) {
    const last = all[all.length - 1];
    const x = indexOf(last.cd.c.cu);
    const at = (L: Last) => x.pos.get(L.M)!;
    let q = all.length - 1;
    while (q >= 0 && acc(all[q]) === 'wait') q--;
    if (q >= 0) {
      const Q = all[q];
      let pick = Q;
      if (acc(Q) !== 'yes' && asksMore(Q)) {
        const k = countLT(x.obj, at(Q));
        const wall = k > 0 ? x.obj[k - 1] : -1;            // the customer's last complaint before Q
        for (let i = q - 1; i >= 0; i--) {
          const P = all[i];
          if (at(P) < wall) break;
          const a = acc(P);
          if (a === 'wait') continue;
          if (a === 'yes') { if (turnedAround(P)) pick = P; break; }
          if (a === 'unsure' && ackTo(P.R, P.t) === 'mixed') continue;
          if (!asksMore(P)) break;
        }
      }
      const c = countLE(x.obj, at(pick));                   // the first complaint after the deciding message
      const takenBack = c < x.obj.length && x.obj[c] <= at(last);
      if (!takenBack && judgeConvinced(pick, pick === last)) continue;
    }
    if (acc(last) === 'wait') judgeConvinced(last, true);
  }

  // ── 3.5.5 Picked, sent, received, taken from, released ──
  for (const a of ctx.actions) {
    const D = istDay(a.at);
    if (!ctx.isReport(D) || !ctx.eventsOn(D) || !isPersonKey(a.actor)) continue;
    const conv = ctx.convMap.get(a.conv);
    if (!conv) continue;
    const X = a.actor;
    const base = { day: D, at: a.at, conv: a.conv, cu: conv.cu, msgs: [] as string[], counted: true, pending: false, points: 0 };
    if (a.kind === 'claim') {
      const how = a.reason === 'take_over' ? ' (Take over)' : a.reason === 'reply' ? ' (first reply)' : '';
      items.push({ ...base, kind: 'picked', actor: X, peer: null, why: `Picked from the open pool${how}.` });
      bump(pickedPool, `${X}|${D}`);
    } else if (a.kind === 'take') {
      const why = a.take === 'senior' ? ' (senior)' : a.take === 'owner' ? ' (Super Admin)' : a.take === 'holder_away' ? ` (${ctx.nameOf(a.from)} was away)` : '';
      items.push({ ...base, kind: 'picked', actor: X, peer: a.from, why: `Took it from ${ctx.nameOf(a.from)}${why}.` });
      bump(pickedTake, `${X}|${D}`);
      if (isPersonKey(a.from) && a.from !== X) {
        items.push({ ...base, kind: 'taken_from', actor: a.from, peer: X, why: `${ctx.nameOf(X)} took this chat${why}.` });
      }
    } else if (a.kind === 'transfer') {
      if (a.bulk) {
        items.push({ ...base, kind: 'released', actor: X, peer: null, why: 'Gave this chat back to the open pool ("Give all to the team").' });
      } else {
        items.push({ ...base, kind: 'sent', actor: X, peer: a.to, note: a.note ?? null, why: `Sent to ${a.to ? ctx.nameOf(a.to) : 'the open pool'}.` });
        if (isPersonKey(a.to) && a.to !== X) {
          items.push({ ...base, kind: 'received', actor: a.to, peer: X, why: `Got this chat from ${ctx.nameOf(X)}.` });
        }
      }
    }
  }

  // ── 3.5.6 Fast first reply ──
  const fastSeen = new Set<string>();
  for (const a of ctx.actions) {
    let X: string | null = null, how = '';
    if ((a.kind === 'claim' || a.kind === 'take') && isPersonKey(a.actor)) {
      X = a.actor; how = a.kind === 'claim' ? 'from the open pool' : `from ${ctx.nameOf(a.from)}`;
    } else if (a.kind === 'transfer' && !a.bulk && isPersonKey(a.to) && a.to !== a.actor) {
      X = a.to; how = `sent by ${ctx.nameOf(a.actor)}`;
    }
    if (!X) continue;
    const cd = ctx.cds.get(a.conv);
    if (!cd) continue;
    const T = a.at;
    if (ctx.waitAt(cd, T, false) === null) continue;
    let star = -1;
    for (let i = countLT(cd.ats, T); i < cd.msgs.length; i++) {
      const m = cd.msgs[i];
      if (m.sender === 'visitor') continue;
      if (m.sender === 'ai') { if (m.aiNotAnswer) continue; break; }   // the AI answered first
      if (m.au !== X) break;                                            // someone else answered first
      if (ctx.trivial(m)) continue;                                     // "hi" / "ok": look at the next one
      star = i; break;
    }
    if (star < 0) continue;
    const A = cd.msgs[star];
    if (ctx.holderAt(cd, A.at) !== X) continue;
    const ms = officeMs(T, A.at);
    if (ms > FAST_REPLY_MIN * MIN_MS) continue;
    const day = istDay(A.at);
    if (!ctx.isReport(day) || !ctx.eventsOn(day)) continue;
    const k = `${X}|${cd.c.cu}|${day}`;
    if (fastSeen.has(k)) continue;
    fastSeen.add(k);
    const lv = cd.lastVis[star];
    items.push({
      kind: 'fast_reply', actor: X, day, at: A.at, conv: cd.c.id, cu: cd.c.cu, msgs: lv >= 0 ? [A.id, cd.msgs[lv].id] : [A.id],
      counted: true, pending: false, points: ctx.pts('fast_reply', day),
      why: `${ctx.nameOf(X)} took the chat at ${when(T, day)} (${how}) while the customer waited; first real reply at ${hhmm(A.at)}: ${mins(ms)} office min.`,
    });
  }

  // ── 3.5.7 Solved and closed-while-waiting ──
  interface Sol { it: ScoreItem; rank: number }
  const solved = new Map<string, Sol>();
  for (const cd of ctx.cds.values()) {
    cd.statuses.forEach((S, si) => {
      if (S.to !== 'resolved') return;
      const T = S.at, D = istDay(T);
      if (!ctx.isReport(D) || !ctx.eventsOn(D)) return;
      if (S.reason === 'merged_away') return;
      if (cd.c.mergedInto !== null && cd.c.mergedInto !== undefined && si === cd.statuses.length - 1) return;
      const before = countLT(cd.ats, T);
      let li = -1;
      for (let j = before - 1; j >= 0 && cd.msgs[j].at >= T - SOLVED_REPLY_WITHIN_MS; j--) {
        const m = cd.msgs[j];
        if (m.sender === 'agent' && !ctx.trivial(m)) { li = j; break; }
      }
      // Closed while the customer waited (owner A2: -2 for the closer) comes BEFORE the solved credit:
      // it is about who closed, not who replied last, so closing a waiting chat with no team reply in
      // the last 72 h (or only an old login's) costs the same. With no staff reply, only a verified
      // chat in Needs you / With team counts, so closing a visitor's junk chat stays free.
      const W = ctx.waitAt(cd, T, false);
      if (W !== null) {
        if (!isPersonKey(S.actor)) return;
        if (li < 0 && (!cd.c.known || !isHumanStatus(ctx.statusAt(cd, T, false)))) return;
        const fi = ctx.firstUnanswered(cd, T - 1);
        items.push({
          kind: 'closed_waiting', actor: S.actor, day: D, at: T, conv: cd.c.id, cu: cd.c.cu,
          msgs: fi >= 0 ? [cd.msgs[fi].id] : [], counted: true, pending: false, points: ctx.pts('closed_waiting', D),   // A2
          why: `Closed at ${hhmm(T)} while the customer was waiting since ${when(W, D)}.`,
        });
        return;
      }
      if (li < 0) return;
      const last = cd.msgs[li];
      const X = last.au!;
      if (X === 'unattributed') return;
      const auto = S.reason === 'auto_close';
      if (auto) {
        const lv = before > 0 ? cd.lastVis[before - 1] : -1;
        if (lv < 0) return;
        const lt = ctx.textOf(cd, lv);
        if (!(acceptsClose(lt) || saysResolved(lt) || keywordThanks(lt) === 'yes')) return;
      }
      const cu = cd.c.cu;
      let Z: Msg | null = null;
      const list = ctx.cuVis.get(cu) || [], ats = ctx.cuVisAts.get(cu) || [];
      for (let j = countLE(ats, T); j < list.length && list[j].at <= T + SOLVED_QUIET_MS; j++) {
        const z = list[j], zcd = ctx.cds.get(z.conv)!;
        if (cameBack(ctx.textOf(zcd, z.ci), !!z.noReply)) { Z = z; break; }
      }
      const head = `Closed at ${hhmm(T)} (${auto ? 'automatically' : `by ${ctx.nameOf(S.actor)}`}); ${ctx.nameOf(X)} gave the last reply at ${when(last.at, D)}`;
      const base = { kind: 'solved' as ItemKind, actor: X, day: D, at: T, conv: cd.c.id, cu, msgs: [last.id] };
      let it: ScoreItem, rank: number;
      if (Z) {
        it = { ...base, msgs: [last.id, Z.id], counted: false, pending: false, points: 0, why: `Customer wrote again at ${dateTime(Z.at)}` };
        rank = 2;
      } else if (ctx.nowMs < T + SOLVED_QUIET_MS) {
        it = { ...base, counted: false, pending: true, points: 0, why: `24-hour check ends ${dateTime(T + SOLVED_QUIET_MS)}` };
        rank = 1;
      } else {
        it = { ...base, counted: true, pending: false, points: ctx.pts('solved', D), why: `${head}; no new message from the customer for 24 h.` };
        rank = 0;
      }
      const k = `${X}|${cu}|${D}`;
      const old = solved.get(k);
      if (!old || rank < old.rank || (rank === old.rank && (it.at < old.it.at || (it.at === old.it.at && cmp(it.conv, old.it.conv) < 0)))) {
        solved.set(k, { it, rank });
      }
    });
  }
  for (const s of solved.values()) items.push(s.it);

  // ── 3.5.8 Stayed angry, and still frustrated ──
  const H = ANGRY_HELD_MIN * MIN_MS;
  for (const D of input.days || []) {
    if (!ctx.healthOn(D)) continue;
    const open = openMs(D), close = closeMs(D), dStart = istDayStart(open);
    const angrySeen = new Set<string>();
    const found: ScoreItem[] = [];
    for (const cd of ctx.cds.values()) {
      if (!cd.c.known || !cd.health.length) continue;
      const judge = new Map<string, { t: number; isClose: boolean }>();
      for (const S of cd.statuses) {
        if (S.to !== 'resolved' || S.reason === 'merged_away' || S.at < open || S.at >= close) continue;
        const K = ctx.effHolder(cd, S.at - 1);
        if (K) judge.set(K, { t: S.at, isClose: true });
      }
      if (ctx.nowMs >= close) {
        const K = ctx.effHolder(cd, close);
        if (K && ctx.statusAt(cd, close, true) !== 'resolved') judge.set(K, { t: close, isClose: false });
      }
      for (const K of Array.from(judge.keys()).sort(cmp)) {
        const { t: ts, isClose } = judge.get(K)!;
        if (ctx.dutyStart(K, D) === null) continue;
        if (ctx.caseOn(cd, ts)) continue;
        const ats = ctx.cuVisAts.get(cd.c.cu) || [];
        if (countLT(ats, ts) - countLT(ats, dStart) <= 0) continue;
        const hEnd = ctx.score(cd, ts);
        if (hEnd === null || hEnd < ANGRY_MIN) continue;
        const hold = ctx.holdOf(cd, K, isClose ? ts - 1 : ts);
        const ws = Math.max(hold.start, open);
        const hStart = ctx.score(cd, ws);
        if (!(hStart === null || hEnd >= hStart)) continue;   // it got better: not judged
        const since = ctx.angrySince(cd, ts);
        if (since === null) continue;
        const from = Math.max(since, ws);
        const am = officeMs(from, ts);
        if (am < H) continue;
        const k = `${K}|${cd.c.cu}|${D}`;
        if (angrySeen.has(k)) continue;
        angrySeen.add(k);
        const lvi = cd.lastVis[Math.max(0, countLT(cd.ats, ts) - 1)] ?? -1;
        found.push({
          kind: 'angry', actor: K, day: D, at: ts, conv: cd.c.id, cu: cd.c.cu,
          msgs: lvi >= 0 && cd.msgs[lvi] && cd.msgs[lvi].at < ts ? [cd.msgs[lvi].id] : [],
          counted: true, pending: false, points: ctx.pts('angry', D),
          why: `At ${isClose ? `the close at ${hhmm(ts)}` : '19:30'} ${ctx.nameOf(K)} held the chat; anger score ${hEnd} (65+ = angry), ${hStart ?? 'unknown'} when the day started for ${ctx.nameOf(K)}; angry for ${mins(am)} office min; customer wrote today.`,
        });
      }
    }
    items.push(...found);
    // Still frustrated: the angriest of the customer's known chats this person replied in that day.
    const tEnd = Math.min(dStart + DAY_MS - 1, ctx.nowMs);
    const byCu = new Map<string, { X: string; cu: string; convs: string[] }>();
    for (const it of chatItems.values()) {
      if (it.day !== D) continue;
      const conv = ctx.convMap.get(it.conv)!;
      if (!conv.known) continue;
      const k = `${it.actor}|${it.cu}`;
      if (!byCu.has(k)) byCu.set(k, { X: it.actor, cu: it.cu, convs: [] });
      byCu.get(k)!.convs.push(it.conv);
    }
    for (const g of byCu.values()) {
      let best: number | null = null, bestConv = '';
      for (const c of g.convs.sort(cmp)) {
        const s = ctx.score(ctx.cds.get(c)!, tEnd);
        if (s !== null && (best === null || s > best)) { best = s; bestConv = c; }
      }
      if (best === null || best < ANGRY_MIN) continue;
      items.push({
        kind: 'frustrated', actor: g.X, day: D, at: tEnd, conv: bestConv, cu: g.cu, msgs: [], counted: true, pending: false, points: 0,
        why: `Anger score ${best} at ${tEnd === ctx.nowMs ? 'now' : 'end of day'} (65+ = frustrated).`,
      });
    }
  }

  // ── 3.5.9 Per person, per day ──
  items.sort((a, b) => cmp(a.day, b.day) || cmp(a.actor, b.actor) || cmp(a.kind, b.kind) || a.at - b.at
    || cmp(a.conv, b.conv) || cmp(a.msgs[0] ?? '', b.msgs[0] ?? '') || cmp(a.why, b.why) || cmp(a.peer ?? '', b.peer ?? ''));
  const today = todayIst(ctx.nowMs);
  const days: DayResult[] = [];
  for (const D of input.days || []) {
    const evOn = ctx.eventsOn(D), hOn = ctx.healthOn(D), pOn = ctx.pointsOn(D);
    const { id: settingsId, w } = ctx.weights(D);
    const dayItems = items.filter((it) => it.day === D);
    const keys = new Set<string>();
    for (const it of dayItems) if (isPersonKey(it.actor)) keys.add(it.actor);
    for (const p of ctx.people) if (p.key === 'owner' || (p.active && p.canReply)) keys.add(p.key);
    const people: PersonDay[] = [];
    for (const key of Array.from(keys).sort(cmp)) {
      const mine = dayItems.filter((it) => it.actor === key);
      const c = emptyCounts(evOn, hOn);
      const cus = new Set<string>();
      const sentTo = new Map<string, { key: string | null; name: string; n: number }>();
      for (const it of mine) {
        switch (it.kind) {
          case 'chat': c.replies += it.n || 0; c.after_hours += it.after || 0; c.chats += 1; cus.add(it.cu); break;
          case 'thanks': if (it.counted) c.thanks += 1; else if (it.pending) c.thanks_pending += 1; else c.thanks_not_counted += 1; break;
          case 'convinced': if (it.counted) c.convinced += 1; else if (it.pending) c.convinced_pending += 1; else c.convinced_not_counted += 1; break;
          case 'frustrated': c.frustrated = (c.frustrated ?? 0) + 1; break;
          case 'unanswered_2h': c.unanswered_2h = (c.unanswered_2h ?? 0) + 1; break;
          case 'taken_no_reply': c.taken_no_reply = (c.taken_no_reply ?? 0) + 1; break;
          case 'picked': c.picked = (c.picked ?? 0) + 1; break;
          case 'sent': {
            c.sent = (c.sent ?? 0) + 1;
            const pk = it.peer ?? '';
            const g = sentTo.get(pk) || { key: it.peer ?? null, name: it.peer ? ctx.nameOf(it.peer) : 'Open pool', n: 0 };
            g.n += 1; sentTo.set(pk, g);
            break;
          }
          case 'received': c.received = (c.received ?? 0) + 1; break;
          case 'taken_from': c.taken_from = (c.taken_from ?? 0) + 1; break;
          case 'released': c.released = (c.released ?? 0) + 1; break;
          case 'fast_reply': c.fast_reply = (c.fast_reply ?? 0) + 1; break;
          case 'solved': if (it.counted) c.solved = (c.solved ?? 0) + 1; else if (it.pending) c.solved_pending = (c.solved_pending ?? 0) + 1; break;
          case 'closed_waiting': c.closed_waiting = (c.closed_waiting ?? 0) + 1; break;
          case 'angry': c.angry = (c.angry ?? 0) + 1; break;
        }
      }
      c.customers = cus.size;
      c.asked_thanks = askedThanks.get(`${key}|${D}`) || 0;
      if (evOn) { c.picked_pool = pickedPool.get(`${key}|${D}`) || 0; c.picked_take = pickedTake.get(`${key}|${D}`) || 0; }
      c.sent_to = Array.from(sentTo.values()).sort((a, b) => b.n - a.n || cmp(a.name, b.name) || cmp(a.key ?? '', b.key ?? ''));
      if (D === today) {
        let holding = 0, waiting = 0;
        for (const conv of ctx.convs) {
          if (conv.assignedTo !== key || !isHumanStatus(conv.status) || conv.caseNow || conv.mergedInto !== null) continue;
          holding += 1;
          const cd = ctx.cds.get(conv.id)!;
          if (ctx.waitAt(cd, ctx.nowMs, true) !== null) waiting += 1;
        }
        c.holding_now = holding; c.waiting_now = waiting;
      }
      const pres = ctx.presence.get(`${key}|${D}`);
      c.online = pres ? { first: hhmm(pres.first), last: hhmm(pres.last) } : null;
      c.days_in = pres || ctx.firstAct.has(`${key}|${D}`) ? 1 : 0;
      let points: number | null = null;
      const parts: Partial<Record<PointKind, Part>> = {};
      if (pOn) {
        points = 0;
        for (const k of WEIGHT_KEYS) parts[k] = { n: 0, each: Number(w[k]) || 0, points: 0 };
        for (const it of mine) {
          if (!it.counted) continue;
          points += it.points;
          const pk: PointKind | null = it.kind === 'chat' ? 'customer_answered'
            : (WEIGHT_KEYS as string[]).includes(it.kind) ? (it.kind as PointKind) : null;
          if (!pk) continue;
          if (pk !== 'customer_answered') parts[pk]!.n += 1;
          parts[pk]!.points += it.points;
        }
        parts.customer_answered!.n = c.customers;
      }
      people.push({ key, counts: c, points, parts, cus: Array.from(cus).sort(cmp) });
    }
    const unat = unattributed.get(D);
    const team: TeamDay = {
      pool_waited_2h: evOn ? (poolSets.get(D)?.size ?? 0) : null,
      absent_waits: evOn ? (absentSets.get(D)?.size ?? 0) : null,
      thanks_after_ai: dayItems.filter((it) => it.kind === 'thanks' && it.actor === 'ai').length,
      unattributed: unat ? Array.from(unat.entries()).sort((a, b) => cmp(a[0], b[0])).map(([login, replies]) => ({ login, replies })) : [],
    };
    days.push({
      day: D, settingsId, pointsOn: pOn, eventsOn: evOn, healthOn: hOn, people, team, items: dayItems,
      aiPending: dayItems.filter((it) => it.pending && (it.kind === 'thanks' || it.kind === 'convinced')).length,
    });
  }
  return { days, candidates: Array.from(candidates.values()) };
}
