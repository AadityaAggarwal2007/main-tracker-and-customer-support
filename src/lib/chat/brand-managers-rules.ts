// ── Brand managers (owner 2026-10-14: "humna brand ka hisab sa ladko ko select kia, anurag is handling kurtiya, rahul is
// handling vastrika"; answers: their brand's chats to them first, they open on their own brand, both may look at the other
// brands but never mixed: "dusri brand ki chat dekhna mix mat kar, staff ka lia alag alag karde bilkul") ──
// Pure (no imports). One member per panel, set by the Super Admin in Team; the same for every panel, today's and later ones.
// A member may manage several panels. Server: brand-managers.ts; the screens: brandHome.ts.

export type BrandManagers = Record<string, string>;   // panel id -> team member id

export const BRAND_MANAGER_PREFIX = 'brand_manager:';

// The stored rows (chat_settings `brand_manager:<panel id>` = {"member": "<id>" | null}) -> the map; a cleared one is left out.
export function parseBrandManagers(rows: { key: string; value: string }[]): BrandManagers {
  const out: BrandManagers = {};
  for (const r of rows) {
    if (!r.key.startsWith(BRAND_MANAGER_PREFIX)) continue;
    try {
      const v = JSON.parse(r.value) as { member?: unknown };
      if (typeof v.member === 'string' && v.member) out[r.key.slice(BRAND_MANAGER_PREFIX.length)] = v.member;
    } catch { /* a broken row = no manager */ }
  }
  return out;
}

// Auto-assign: a panel's chat goes to its brand manager when they are among the members on duty; otherwise to the usual
// fewest-chats pick among everyone on duty (so nothing waits while the manager is away or logged out).
export function brandFirst<T extends { key: string }>(onDuty: T[], panelId: string | null | undefined, managers: BrandManagers): T[] {
  const m = panelId ? managers[panelId] : undefined;
  if (!m) return onDuty;
  const mine = onDuty.filter((c) => c.key === m);
  return mine.length ? mine : onDuty;
}

// The panels this member manages, in the given panel order.
export function panelsOf(memberId: string | null | undefined, managers: BrandManagers, order: string[] = Object.keys(managers)): string[] {
  if (!memberId) return [];
  return order.filter((p) => managers[p] === memberId);
}

// Which panel a staff screen shows (pure; brandHome.ts runs it): `separate` = a team member (never the Super Admin or the
// Manager), who always looks at ONE brand, never "All panels" mixed. The first page of a browser session opens on their own
// brand (`firstVisit`); after that the panel they picked stays, as long as they may see it.
export function brandPanelFor(current: string, allowed: string[], home: string[], separate: boolean, firstVisit: boolean): string {
  if (!separate) return current;
  const ownHome = home.find((p) => allowed.includes(p)) || '';
  if (firstVisit && ownHome) return ownHome;
  if (current && allowed.includes(current)) return current;
  return ownHome || allowed[0] || '';
}
