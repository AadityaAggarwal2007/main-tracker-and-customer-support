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

export const panelNameTakenMessage = (name: string) =>
  `A panel named "${name}" already exists. Panel names must be different (capital letters and extra spaces do not count).`;
