import type {
  InAction, InCase, InConv, InHealth, InHolder, InMsg, InPerson, InStatus, PointKind, ScoreInput, SettingsRow, Verdict, Weights,
} from './types';
import { istDay, openMs } from './clock';
import { stripEmailQuote, isTrivialReply, asksForThanks, isSignOff } from './words';
import { ANGRY_MIN, DEFAULT_WEIGHTS, settingsForDay, pointsFrom, scoreWaiting } from './rules';

// ── Small helpers ──
export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const NOT_A_PERSON = new Set(['system', 'ai', 'customer', 'unattributed', 'pool', '']);
export const isPersonKey = (k: string | null | undefined): k is string => typeof k === 'string' && !NOT_A_PERSON.has(k);

// Number of entries <= t / < t in an ascending array.
export function countLE(a: number[], t: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= t) lo = m + 1; else hi = m; }
  return lo;
}
export function countLT(a: number[], t: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < t) lo = m + 1; else hi = m; }
  return lo;
}

// ── Prepared input ──
export interface Msg extends InMsg { au: string | null; ci: number }   // author (agent), index in its chat
export interface ConvData {
  c: InConv;
  msgs: Msg[]; ats: number[];
  lastVis: number[]; lastAgent: number[]; lastAns: number[]; nextVis: number[];
  texts: (string | undefined)[];
  holders: InHolder[]; hAts: number[];
  statuses: InStatus[]; sAts: number[];
  cases: InCase[]; cAts: number[];
  health: InHealth[]; heAts: number[];
}
export interface Hold { start: number; end: number }

export class Ctx {
  input: ScoreInput;
  loadStart: number; loadEnd: number; nowMs: number;
  people: InPerson[]; personMap = new Map<string, InPerson>();
  convs: InConv[]; convMap = new Map<string, InConv>();
  cds = new Map<string, ConvData>();
  msgs: Msg[] = [];
  actions: InAction[]; statuses: InStatus[];
  presence = new Map<string, { first: number; last: number }>();
  firstAct = new Map<string, number>();
  actionNames = new Map<string, string>();
  loginMap = new Map<string, string>();
  cuVis = new Map<string, Msg[]>();
  cuVisAts = new Map<string, number[]>();
  settings: SettingsRow[];
  verdicts: Record<string, Verdict>;
  reportDays: Set<string>;
  eventsDay: string | null; installDay: string; pFrom: string;
  dutyMemo = new Map<string, number | null>();
  weightsMemo = new Map<string, { id: number; w: Weights }>();
  trivialMemo = new Map<string, boolean>();
  askMemo = new Map<string, boolean>();

  constructor(input: ScoreInput) {
    this.input = input;
    const fl = (x: number) => Math.floor(Number(x));
    this.nowMs = fl(input.nowMs);
    this.loadStart = fl(input.loadStartMs);
    this.loadEnd = fl(input.loadEndMs);
    this.people = [...(input.people || [])].sort((a, b) => cmp(a.key, b.key));
    for (const p of this.people) this.personMap.set(p.key, p);
    // Logins: members first, then the owner's (an owner login always means the owner).
    for (const p of this.people) if (p.key !== 'owner') for (const l of p.logins || []) {
      const k = String(l || '').toLowerCase(); if (k && !this.loginMap.has(k)) this.loginMap.set(k, p.key);
    }
    for (const p of this.people) if (p.key === 'owner') for (const l of p.logins || []) {
      const k = String(l || '').toLowerCase(); if (k) this.loginMap.set(k, 'owner');
    }
    this.convs = [...(input.convs || [])].sort((a, b) => cmp(a.id, b.id));
    for (const c of this.convs) {
      this.convMap.set(c.id, c);
      this.cds.set(c.id, {
        c: { ...c, assignedAt: c.assignedAt === null || c.assignedAt === undefined ? null : fl(c.assignedAt) },
        msgs: [], ats: [], lastVis: [], lastAgent: [], lastAns: [], nextVis: [], texts: [],
        holders: [], hAts: [], statuses: [], sAts: [], cases: [], cAts: [], health: [], heAts: [],
      });
    }
    this.settings = [...(input.settings || [])].sort((a, b) => a.id - b.id);
    this.verdicts = input.verdicts || {};
    this.reportDays = new Set(input.days || []);
    this.eventsDay = input.eventsSinceMs === null || input.eventsSinceMs === undefined ? null : istDay(fl(input.eventsSinceMs));
    this.installDay = istDay(fl(input.installedMs));
    this.pFrom = pointsFrom(this.settings);

    // Messages: (at, conv, id).
    const msgs: Msg[] = [];
    for (const m of input.msgs || []) {
      if (!this.convMap.has(m.conv)) continue;
      msgs.push({ ...m, at: fl(m.at), au: null, ci: 0 });
    }
    msgs.sort((a, b) => a.at - b.at || cmp(a.conv, b.conv) || cmp(a.id, b.id));
    for (const m of msgs) {
      if (m.sender === 'agent') m.au = this.authorOf(m);
      const cd = this.cds.get(m.conv)!;
      m.ci = cd.msgs.length;
      cd.msgs.push(m); cd.ats.push(m.at);
    }
    this.msgs = msgs;
    for (const cd of this.cds.values()) {
      const n = cd.msgs.length;
      let v = -1, ag = -1, an = -1;
      for (let i = 0; i < n; i++) {
        const m = cd.msgs[i];
        if (m.sender === 'visitor') v = i;
        if (m.sender === 'agent') { ag = i; an = i; }
        if (m.sender === 'ai' && !m.aiNotAnswer) an = i;
        cd.lastVis.push(v); cd.lastAgent.push(ag); cd.lastAns.push(an);
      }
      cd.nextVis = new Array(n);
      let nx = -1;
      for (let i = n - 1; i >= 0; i--) { if (cd.msgs[i].sender === 'visitor') nx = i; cd.nextVis[i] = nx; }
      cd.texts = new Array(n);
    }
    // Customers' own messages across their chats (24-hour watch, "customer wrote today").
    for (const m of msgs) if (m.sender === 'visitor') {
      const cu = this.convMap.get(m.conv)!.cu;
      if (!this.cuVis.has(cu)) { this.cuVis.set(cu, []); this.cuVisAts.set(cu, []); }
      this.cuVis.get(cu)!.push(m); this.cuVisAts.get(cu)!.push(m.at);
    }

    const holders = (input.holders || []).map((h) => ({ ...h, at: fl(h.at) })).sort((a, b) => a.at - b.at || a.id - b.id);
    for (const h of holders) { const cd = this.cds.get(h.conv); if (cd) { cd.holders.push(h); cd.hAts.push(h.at); } }
    this.statuses = (input.statuses || []).map((s) => ({ ...s, at: fl(s.at) })).sort((a, b) => a.at - b.at || a.id - b.id);
    for (const s of this.statuses) { const cd = this.cds.get(s.conv); if (cd) { cd.statuses.push(s); cd.sAts.push(s.at); } }
    // A remove and a mark at the same instant are a switch (Refund <-> Ship again, one transaction: Chikki's
    // threat move or a person's setCase): the remove first, so the chat stays marked (review fix 2026-10-02).
    const cases = (input.cases || []).map((c) => ({ ...c, at: fl(c.at) }))
      .sort((a, b) => cmp(a.conv, b.conv) || a.at - b.at || (a.action === b.action ? 0 : a.action === 'remove' ? -1 : 1));
    for (const c of cases) { const cd = this.cds.get(c.conv); if (cd) { cd.cases.push(c); cd.cAts.push(c.at); } }
    const health = (input.health || []).map((h) => ({ ...h, at: fl(h.at) }))
      .sort((a, b) => cmp(a.conv, b.conv) || a.at - b.at || a.score - b.score);
    for (const h of health) { const cd = this.cds.get(h.conv); if (cd) { cd.health.push(h); cd.heAts.push(h.at); } }
    this.actions = (input.actions || []).map((a) => ({ ...a, at: fl(a.at) })).sort((a, b) => a.at - b.at || a.id - b.id);
    for (const a of this.actions) if (a.actorName) this.actionNames.set(a.actor, a.actorName);

    const pres = [...(input.presence || [])].sort((a, b) => cmp(a.actor, b.actor) || cmp(a.day, b.day) || a.first - b.first);
    for (const p of pres) {
      const k = `${p.actor}|${p.day}`;
      const old = this.presence.get(k);
      const first = fl(p.first), last = fl(p.last);
      this.presence.set(k, old ? { first: Math.min(old.first, first), last: Math.max(old.last, last) } : { first, last });
    }
    // First thing each person did on each India day: an action, a status change, a reply.
    const note = (k: string | null, t: number) => {
      if (!isPersonKey(k)) return;
      const key = `${k}|${istDay(t)}`;
      const old = this.firstAct.get(key);
      if (old === undefined || t < old) this.firstAct.set(key, t);
    };
    for (const a of this.actions) note(a.actor, a.at);
    for (const s of this.statuses) note(s.actor, s.at);
    for (const m of msgs) if (m.sender === 'agent') note(m.au, m.at);
  }

  // ── People ──
  authorOf(m: InMsg): string {
    if (isPersonKey(m.eventActor)) return m.eventActor;
    const l = String(m.login || '').toLowerCase();
    if (l && this.loginMap.has(l)) return this.loginMap.get(l)!;
    return 'unattributed';
  }
  eligible(k: string | null): boolean {
    if (!k) return false;
    if (k === 'owner') return true;
    const p = this.personMap.get(k);
    return !!(p && p.active && p.canReply);
  }
  nameOf(k: string | null): string {
    if (k === null || k === undefined) return 'the open pool';
    const p = this.personMap.get(k);
    if (p) return p.name;
    if (k === 'owner') return 'Super Admin';
    if (k === 'ai') return 'AI';
    if (k === 'unattributed') return 'an old login';
    return this.actionNames.get(k) ?? 'Removed member';
  }

  // ── Gates ──
  isReport(day: string): boolean { return this.reportDays.has(day); }
  eventsOn(day: string): boolean { return this.eventsDay !== null && day >= this.eventsDay; }
  healthOn(day: string): boolean { return day > this.installDay; }
  pointsOn(day: string): boolean { return this.eventsOn(day) && day >= this.pFrom; }
  weights(day: string): { id: number; w: Weights } {
    let hit = this.weightsMemo.get(day);
    if (!hit) {
      const row = settingsForDay(this.settings, day);
      hit = { id: row.id, w: { ...DEFAULT_WEIGHTS, ...(row.weights || {}) } };
      this.weightsMemo.set(day, hit);
    }
    return hit;
  }
  pts(kind: PointKind, day: string): number {
    return this.pointsOn(day) ? Number(this.weights(day).w[kind]) || 0 : 0;
  }

  // When K's clock starts on that day; null = not in that day. Days before the install day have no
  // presence log: everyone counts as in from 10:00 (those days carry no points). From the install day
  // on (points start that day, owner A4) the first presence or action decides, so a member who was not
  // in pays no minus; on the install day presence is known only from the install time on (lenient).
  dutyStart(k: string, day: string): number | null {
    const key = `${k}|${day}`;
    if (this.dutyMemo.has(key)) return this.dutyMemo.get(key)!;
    let v: number | null;
    if (day < this.installDay) v = openMs(day);
    else {
      const p = this.presence.get(key);
      const a = this.firstAct.get(key);
      const first = Math.min(p ? p.first : Infinity, a ?? Infinity);
      v = first === Infinity ? null : Math.max(openMs(day), first);
    }
    this.dutyMemo.set(key, v);
    return v;
  }

  // ── Per-chat timeline ──
  textOf(cd: ConvData, i: number): string {
    let t = cd.texts[i];
    if (t === undefined) {
      const m = cd.msgs[i];
      t = String(m.text || '');
      if (cd.c.source === 'email' && m.sender === 'visitor') t = stripEmailQuote(t);
      cd.texts[i] = t;
    }
    return t;
  }
  trivial(m: Msg): boolean {
    let v = this.trivialMemo.get(m.id);
    if (v === undefined) { v = isTrivialReply(m.text || ''); this.trivialMemo.set(m.id, v); }
    return v;
  }
  asks(m: Msg): boolean {
    let v = this.askMemo.get(m.id);
    if (v === undefined) { v = asksForThanks(m.text || ''); this.askMemo.set(m.id, v); }
    return v;
  }
  statusAt(cd: ConvData, t: number, inclusive = true): string | null {
    const n = inclusive ? countLE(cd.sAts, t) : countLT(cd.sAts, t);
    if (n > 0) return cd.statuses[n - 1].to;
    if (cd.statuses.length) return cd.statuses[0].from;
    return cd.c.status;
  }
  caseOn(cd: ConvData, t: number): boolean {
    const n = countLE(cd.cAts, t);
    if (n > 0) return cd.cases[n - 1].action === 'mark';
    if (cd.cases.length) return cd.cases[0].action === 'remove';
    return !!cd.c.caseNow;
  }
  holderAt(cd: ConvData, t: number): string | null {
    const n = countLE(cd.hAts, t);
    if (n > 0) return cd.holders[n - 1].to;
    if (cd.holders.length) return cd.holders[0].from;
    return cd.c.assignedAt === null || t >= cd.c.assignedAt ? cd.c.assignedTo : null;
  }
  effHolder(cd: ConvData, t: number): string | null {
    const h = this.holderAt(cd, t);
    return this.eligible(h) ? h : null;
  }
  // The continuous run of K as the raw holder that contains t.
  holdOf(cd: ConvData, K: string, t: number): Hold {
    const rows = cd.holders, n = countLE(cd.hAts, t);
    let start: number, end = Infinity;
    if (n > 0) {
      let j = n - 1;
      while (j > 0 && rows[j - 1].to === K) j--;
      start = j === 0 && rows[0].from === K ? Math.min(this.loadStart, rows[0].at) : rows[j].at;
    } else if (rows.length) start = Math.min(this.loadStart, rows[0].at);
    else start = cd.c.assignedAt ?? this.loadStart;
    for (let i = n; i < rows.length; i++) if (rows[i].to !== K) { end = rows[i].at; break; }
    return { start, end };
  }
  // Is the customer waiting at t (messages and status up to and including t, or strictly before)?
  waitAt(cd: ConvData, t: number, inclusive: boolean): number | null {
    const n = inclusive ? countLE(cd.ats, t) : countLT(cd.ats, t);
    if (n === 0) return null;
    const lv = cd.lastVis[n - 1];
    if (lv < 0) return null;
    const la = cd.lastAgent[n - 1];
    const last = cd.msgs[n - 1];
    const lvText = this.textOf(cd, lv);
    // Only when it matters (a sign-off after a team answer): the customer's last message that is not
    // a sign-off, walking back over the trailing "ok" / "sir" / "thanks" lines.
    let lrAt: number | null | undefined;
    if (la >= 0 && isSignOff(lvText)) {
      let v = lv;
      while (v >= 0 && isSignOff(this.textOf(cd, v))) v = v > 0 ? cd.lastVis[v - 1] : -1;
      lrAt = v >= 0 ? cd.msgs[v].at : null;
    }
    return scoreWaiting({
      lvAt: cd.msgs[lv].at, lvNoReply: !!cd.msgs[lv].noReply, lvText,
      laAt: la >= 0 ? cd.msgs[la].at : null, lastSender: last.sender,
      lastAiNotAnswer: last.sender === 'ai' && !!last.aiNotAnswer, lrAt,
    }, this.statusAt(cd, t, inclusive));
  }
  // The first customer message after the latest answer at or before t (sentences only).
  firstUnanswered(cd: ConvData, t: number): number {
    const n = countLE(cd.ats, t);
    if (!n) return -1;
    const ans = cd.lastAns[n - 1];
    const i = ans + 1 < cd.msgs.length ? cd.nextVis[ans + 1] : -1;
    if (i >= 0 && i < n) return i;
    return cd.lastVis[n - 1];
  }
  score(cd: ConvData, t: number): number | null {
    const n = countLE(cd.heAts, t);
    return n > 0 ? cd.health[n - 1].score : null;
  }
  // The earliest time from which every score up to t is >= ANGRY_MIN; null if the score at t is not.
  angrySince(cd: ConvData, t: number): number | null {
    let i = countLE(cd.heAts, t) - 1;
    if (i < 0 || cd.health[i].score < ANGRY_MIN) return null;
    let since = cd.health[i].at;
    while (i >= 0 && cd.health[i].score >= ANGRY_MIN) { since = cd.health[i].at; i--; }
    return since;
  }
  verdictOf(id: string): Verdict | null {
    return Object.prototype.hasOwnProperty.call(this.verdicts, id) ? this.verdicts[id] : null;
  }
}
