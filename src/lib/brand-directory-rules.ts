// Payments > Brand Directory (owner 2026-10-17). Pure rules, no imports: the screen, the routes and the tests
// share them. A brand row = founder, brand name, bank account name, up to 10 fields the owner names himself,
// a colour and its place among the founder's cards.
// Owner, same evening: "inko move kar sake, inke colour kar sake, har card mein 10 field; jab bhi koi founder add
// hoga to ye sab apne aap aa jaye" = drag a card to another place, colour it, 10 own fields per card, and a new
// founder starts with the same 11 payment gateway cards.

export const LIMITS = { founder: 80, brand: 80, bank: 120, label: 40, value: 200 } as const;
export const MAX_FIELDS = 10;
export const MAX_ORDER = 500;

// The cards a new founder starts with, in the owner's own spelling (his first founder's 11 cards).
export const DEFAULT_GATEWAYS = [
  'AIRPAY', 'BILLDESK', 'CASHFREE', 'DECENTRO', 'EASEBUZZ', 'PAYGLOCAL', 'PAYTM', 'PAYU', 'PHONE PE', 'PINELABS', 'RAZORPAY',
] as const;

// The card colours ('' = none). The screen draws each from its key (.bd-c-<key>).
export const COLORS: { key: string; name: string }[] = [
  { key: '', name: 'None' }, { key: 'purple', name: 'Purple' }, { key: 'blue', name: 'Blue' }, { key: 'teal', name: 'Teal' },
  { key: 'green', name: 'Green' }, { key: 'yellow', name: 'Yellow' }, { key: 'orange', name: 'Orange' }, { key: 'red', name: 'Red' },
  { key: 'pink', name: 'Pink' }, { key: 'grey', name: 'Grey' },
];
const COLOR_KEYS = new Set(COLORS.map((c) => c.key));

export interface BrandField { label: string; value: string }

export interface BrandInput {
  founderName: string;
  brandName: string;
  bankAccountName: string;
  fields: BrandField[];
  color: string;
}

export interface BrandRow extends BrandInput {
  id: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export const EMPTY_BRAND: BrandInput = { founderName: '', brandName: '', bankAccountName: '', fields: [], color: '' };

const TEXT: { key: 'founderName' | 'brandName' | 'bankAccountName'; name: string; max: number; required?: boolean }[] = [
  { key: 'founderName', name: 'Founder / Owner name', max: LIMITS.founder, required: true },
  { key: 'brandName', name: 'Brand name', max: LIMITS.brand, required: true },
  { key: 'bankAccountName', name: 'Bank account name', max: LIMITS.bank },
];

// One line of plain text: control characters and "<" ">" out, runs of spaces made one, outer spaces cut.
export function cleanText(v: unknown): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
}

// The same name whatever its capitals and spaces: "Jiva", " jiva ", "JIVA".
export const nameKey = (v: string) => cleanText(v).toLowerCase();

export type FieldErrors = Partial<Record<keyof BrandInput, string>>;

// The own fields: at most 10, each label at most 40 and value at most 200; a row with neither is dropped.
export function cleanFields(raw: unknown): { value: BrandField[]; error: string } {
  if (raw === undefined || raw === null) return { value: [], error: '' };
  if (!Array.isArray(raw)) return { value: [], error: 'Fields must be a list' };
  const value: BrandField[] = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') return { value: [], error: 'A field must have a label and a value' };
    const { label, value: v } = f as Record<string, unknown>;
    if ((label !== undefined && label !== null && typeof label !== 'string') || (v !== undefined && v !== null && typeof v !== 'string')) {
      return { value: [], error: 'A field must be text' };
    }
    const l = cleanText(label), val = cleanText(v);
    if (!l && !val) continue;
    if (l.length > LIMITS.label) return { value: [], error: `A field label can be at most ${LIMITS.label} characters` };
    if (val.length > LIMITS.value) return { value: [], error: `A field value can be at most ${LIMITS.value} characters` };
    value.push({ label: l, value: val });
  }
  if (value.length > MAX_FIELDS) return { value: [], error: `At most ${MAX_FIELDS} fields on one card` };
  return { value, error: '' };
}

// Checks a whole form (create) or a part of one (edit: only the keys sent are checked; the rest stay as saved).
export function cleanBrand(input: unknown, partial = false): { value: Partial<BrandInput>; errors: FieldErrors } {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const value: Partial<BrandInput> = {};
  const errors: FieldErrors = {};
  for (const f of TEXT) {
    if (partial && !(f.key in src)) continue;
    const raw = src[f.key];
    if (raw !== undefined && raw !== null && typeof raw !== 'string') { errors[f.key] = `${f.name} must be text`; continue; }
    const v = cleanText(raw);
    if (f.required && !v) { errors[f.key] = `${f.name} is required`; continue; }
    if (v.length > f.max) { errors[f.key] = `${f.name} can be at most ${f.max} characters`; continue; }
    value[f.key] = v;
  }
  if (!partial || 'fields' in src) {
    const f = cleanFields(src.fields);
    if (f.error) errors.fields = f.error; else value.fields = f.value;
  }
  if (!partial || 'color' in src) {
    const c = src.color === undefined || src.color === null ? '' : src.color;
    if (typeof c !== 'string' || !COLOR_KEYS.has(c)) errors.color = 'Pick one of the colours'; else value.color = c;
  }
  return { value, errors };
}

// What a card shows as a field's label: the owner's own, else "Field 1", "Field 2" ...
export const labelOf = (label: string, n: number) => cleanText(label) || `Field ${n}`;

// The two own fields of the first version (custom_field_1 / 2 columns) as fields, for a row saved before the
// owner asked for 10; empty ones are left out. Labels kept as typed ("Custom Field 1" when there was none).
export function legacyFields(l1: string, v1: string, l2: string, v2: string): BrandField[] {
  const out: BrandField[] = [];
  if (cleanText(l1) || cleanText(v1)) out.push({ label: cleanText(l1) || 'Custom Field 1', value: cleanText(v1) });
  if (cleanText(l2) || cleanText(v2)) out.push({ label: cleanText(l2) || 'Custom Field 2', value: cleanText(v2) });
  return out;
}

// A card order sent by the screen: distinct row ids, at most MAX_ORDER. null = not a valid order.
export function cleanOrder(ids: unknown): string[] | null {
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_ORDER) return null;
  const out = ids.map((x) => (typeof x === 'number' ? String(x) : x));
  if (!out.every((x) => typeof x === 'string' && /^[1-9][0-9]{0,17}$/.test(x))) return null;
  return new Set(out).size === out.length ? (out as string[]) : null;
}

// The founder's list after one card is dragged onto another: it takes that card's place.
export function moveCard<T extends { id: string }>(list: T[], fromId: string, toId: string): T[] {
  const from = list.findIndex((x) => x.id === fromId), to = list.findIndex((x) => x.id === toId);
  if (from < 0 || to < 0 || from === to) return list;
  const next = [...list];
  const [card] = next.splice(from, 1);
  next.splice(to, 0, card);
  return next;
}

// The gateway cards a founder still lacks (capitals / spaces ignored), in DEFAULT_GATEWAYS' order.
export function missingGateways(have: Pick<BrandInput, 'brandName'>[]): string[] {
  const got = new Set(have.map((b) => nameKey(b.brandName)));
  return DEFAULT_GATEWAYS.filter((g) => !got.has(nameKey(g)));
}

// Distinct founders, ignoring capitals and extra spaces ("Sunny", "sunny ", "SUNNY" = one).
export function uniqueFounders(rows: Pick<BrandInput, 'founderName'>[]): number {
  return new Set(rows.map((r) => nameKey(r.founderName)).filter(Boolean)).size;
}

// Case-insensitive search over every field (the own labels and values too). Empty = everything.
export function matchesSearch(row: Pick<BrandInput, 'founderName' | 'brandName' | 'bankAccountName' | 'fields'>, q: string): boolean {
  const words = nameKey(q).split(' ').filter(Boolean);
  if (!words.length) return true;
  const hay = [
    row.founderName, row.brandName, row.bankAccountName,
    ...(row.fields || []).flatMap((f, i) => [labelOf(f.label, i + 1), f.value]),
  ].map(nameKey).join(' | ');
  return words.every((w) => hay.includes(w));
}

// One group per founder (capitals / extra spaces ignored), founders A-Z, each founder's cards in the order the owner
// dragged them (sortOrder), then by name. The name shown is the spelling most of their brands use (the first on a tie).
export function founderGroups<T extends BrandInput & { sortOrder?: number }>(rows: T[]): { key: string; name: string; brands: T[] }[] {
  const by = new Map<string, T[]>();
  for (const r of rows) {
    const k = nameKey(r.founderName);
    if (!k) continue;
    by.set(k, [...(by.get(k) || []), r]);
  }
  return [...by.entries()].map(([key, list]) => {
    const seen = new Map<string, number>();
    for (const r of list) { const n = cleanText(r.founderName); seen.set(n, (seen.get(n) || 0) + 1); }
    let name = '', best = 0;
    for (const [n, c] of seen) if (c > best) { name = n; best = c; }
    const brands = [...list].sort((a, b) => ((a.sortOrder ?? 0) - (b.sortOrder ?? 0)) || nameKey(a.brandName).localeCompare(nameKey(b.brandName)));
    return { key, name, brands };
  }).sort((a, b) => a.key.localeCompare(b.key));
}

export const DUPLICATE_ERROR = 'The server still blocks a repeated brand name: run brand-directory.sql once more';
export const NOT_INSTALLED_ERROR = 'Brand Directory is not installed yet: run brand-directory.sql once on the server';
export const NEEDS_UPDATE_ERROR = 'Brand Directory needs one more step for colours, 10 fields and moving cards: run brand-directory.sql once more on the server';
