// The half hours of the Manager's live board (team-live.ts): today from the office opening (10:00 IST) up to now,
// at least one, at most the 24 of a long day. Pure.
export const SLOT_MS = 30 * 60_000;
const IST_MS = 330 * 60_000;

export function slotCount(openMs: number, nowMs: number): number {
  if (nowMs <= openMs) return 1;
  return Math.min(24, Math.floor((nowMs - openMs) / SLOT_MS) + 1);
}

// "10:00", "10:30", ... in India time.
export function slotLabels(openMs: number, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(openMs + i * SLOT_MS + IST_MS);
    out.push(`${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`);
  }
  return out;
}
