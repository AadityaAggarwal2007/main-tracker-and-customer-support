// ── Panel names: no two panels with the same name ──────────────
// Owner 2026-10-07: a panel (businesses row) must never be created or renamed to a name another
// panel already has. "Same" ignores capital letters and extra spaces: "vastrika", "VASTRIKA " and
// "Vastrika" are one name. The table's own UNIQUE (name) only catches the exact same spelling.
// Pure, no imports: used by /api/businesses (create, rename) and the CSV upload.
export const PANEL_NAME_MAX = 80;

// The name as it is saved: trimmed, runs of spaces / tabs / line breaks become one space.
export function cleanPanelName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, PANEL_NAME_MAX).trim();
}

// What two names are compared by.
export function panelNameKey(raw: unknown): string {
  return cleanPanelName(raw).toLowerCase();
}

// The same key in SQL (panel-name-unique.sql builds its unique index on this exact expression).
export const PANEL_NAME_KEY_SQL = `lower(regexp_replace(btrim(name), '\\s+', ' ', 'g'))`;

// ── Names that are the same store written twice (owner 2026-10-08: "yeh sab panel ki duplicacy band kar") ──
// The exact key above misses "VASTRIKA" / "VASTRIKA STORE" and "vastora" / "vestora": one store, two panels
// (the old CSV upload made them from brand names). Two names are TOO SIMILAR when, ignoring capitals, spaces,
// punctuation and the filler words below, they are the same, or (6+ letters) differ by one letter.
const FILLER_WORDS = new Set(['store', 'shop', 'official', 'online', 'india', 'boutique']);

export function panelNameCore(raw: unknown): string {
  return cleanPanelName(raw).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !FILLER_WORDS.has(w)).join('');
}

function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.slice(i) === l.slice(i + 1);
}

export function panelNamesSimilar(a: unknown, b: unknown): boolean {
  const x = panelNameCore(a);
  const y = panelNameCore(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return Math.min(x.length, y.length) >= 6 && oneEditApart(x, y);
}

export const panelNameSimilarMessage = (name: string, other: string) =>
  `"${name}" looks too much like the existing panel "${other}". Use a clearly different name, or rename "${other}" first.`;

export const panelNameTakenMessage = (name: string) =>
  `A panel named "${name}" already exists. Panel names must be different (capital letters and extra spaces do not count).`;
