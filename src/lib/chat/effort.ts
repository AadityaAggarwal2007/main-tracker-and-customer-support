// How hard Chikki thinks for one reply (owner, 2026-10-01; Panel Settings > Chikki > Logic).
// Like Claude's effort setting: more effort = more thinking and more tokens. The owner's
// choice: VISITORS stay as they are today ("Normal"; a separate visitor / sales AI is built
// later), and a verified customer gets a level by how upset they are, from the frustration
// score: Calm and Uneasy = Normal (what every reply did before), Frustrated = High, Critical =
// Max. An admin can change the level per group; a panel with no choice saved uses DEFAULT_EFFORT.
// Pure: no imports but health-rules (also pure), so the tests and the inbox can use it.

import { combineHealth, healthLevel, scanSignals, type HealthRow } from './health-rules';

export type Effort = 'normal' | 'high' | 'max';
export const EFFORTS: Effort[] = ['normal', 'high', 'max'];
export const CUSTOMER_GROUPS = ['calm', 'uneasy', 'frustrated', 'critical'] as const;
export type CustomerGroup = typeof CUSTOMER_GROUPS[number];
export type EffortGroup = 'visitor' | CustomerGroup;
export type EffortSettings = Record<CustomerGroup, Effort>;

export const DEFAULT_EFFORT: EffortSettings = { calm: 'normal', uneasy: 'normal', frustrated: 'high', critical: 'max' };

// What each level does in getAIResponse (ai.ts).
//   thinking   the model reasons before it writes (DeepSeek V4 "thinking"); off at Normal, as
//              every reply was tested and run before 2026-10-01
//   maxTokens  room for the reply; thinking counts against it, so it is larger when thinking
//              (at 1,500 a thinking model sometimes used it all up and answered blank)
//   examples   how many of the team's approved replies (brain-examples.ts) are shown
//   selfCheck  after the reply is written, one more call checks it against the locked rules
//              and the order's facts and fixes it before it is sent (self-check.ts)
export interface EffortPlan { thinking: boolean; maxTokens: number; examples: number; selfCheck: boolean }
export const EFFORT_PLAN: Record<Effort, EffortPlan> = {
  normal: { thinking: false, maxTokens: 1500, examples: 2, selfCheck: false },
  high:   { thinking: true,  maxTokens: 6000, examples: 3, selfCheck: false },
  max:    { thinking: true,  maxTokens: 6000, examples: 3, selfCheck: true },
};

export function cleanEffortSettings(raw: unknown): EffortSettings {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_EFFORT };
  for (const g of CUSTOMER_GROUPS) {
    const v = String(src[g] ?? '');
    if ((EFFORTS as string[]).includes(v)) out[g] = v as Effort;
  }
  return out;
}

// The score that decides the group: the stored frustration score (health.ts, worked out after
// each customer message, so it lags one message) or the quick count over this chat's own
// messages (swearing, a threat, refund demands, repeats...), whichever is higher. A customer
// whose last message says the problem is solved gets the quick count alone (at most 30).
export function effortScore(stored: number | null | undefined, rows: HealthRow[]): number {
  const sig = scanSignals(rows);
  const quick = combineHealth(null, sig);
  if (sig.calmed) return quick;
  const s = typeof stored === 'number' && Number.isFinite(stored) ? stored : 0;
  return Math.max(s, quick);
}

export function groupFor(isCustomer: boolean, score: number): EffortGroup {
  if (!isCustomer) return 'visitor';
  return healthLevel(score).key as CustomerGroup;
}

// Visitors always get Normal: the owner keeps them as they are until a visitor AI is built.
export function effortFor(group: EffortGroup, settings?: unknown): Effort {
  if (group === 'visitor') return 'normal';
  return cleanEffortSettings(settings)[group];
}

// What one reply cost, handed back by getAIResponse (usage.effort) and stored by the caller in
// chikki_runs (chikki-runs.ts) for the Logic tab. Staff only: never in a widget response.
export interface EffortUsage {
  level: Effort; group: EffortGroup; score: number;
  model: string | null; calls: number;
  promptTokens: number; completionTokens: number; reasoningTokens: number;
  thinking: boolean;     // a thinking call answered (false when it fell back to no thinking)
  checked: boolean;      // the Max self-check ran
  changed: boolean;      // ... and fixed the reply
  ms: number;            // filled in by the caller
  draft?: string;        // the reply before the self-check (tests read it; never stored)
}

export function newEffortUsage(level: Effort, group: EffortGroup, score: number): EffortUsage {
  return { level, group, score, model: null, calls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, thinking: false, checked: false, changed: false, ms: 0 };
}
