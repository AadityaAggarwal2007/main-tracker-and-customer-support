// Payments > Brand Directory (owner 2026-10-17). Pure rules, no imports: the screen, the routes and the tests
// share them. A brand row = founder, brand name, bank account name and two fields the owner names himself.

export const LIMITS = { founder: 80, brand: 80, bank: 120, label: 40, value: 200 } as const;
export const DEFAULT_LABEL_1 = 'Custom Field 1';
export const DEFAULT_LABEL_2 = 'Custom Field 2';

export interface BrandInput {
  founderName: string;
  brandName: string;
  bankAccountName: string;
  customField1Label: string;
  customField1Value: string;
  customField2Label: string;
  customField2Value: string;
}

export interface BrandRow extends BrandInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export const EMPTY_BRAND: BrandInput = {
  founderName: '', brandName: '', bankAccountName: '',
  customField1Label: '', customField1Value: '', customField2Label: '', customField2Value: '',
};

const FIELDS: { key: keyof BrandInput; name: string; max: number; required?: boolean }[] = [
  { key: 'founderName', name: 'Founder / Owner name', max: LIMITS.founder, required: true },
  { key: 'brandName', name: 'Brand name', max: LIMITS.brand, required: true },
  { key: 'bankAccountName', name: 'Bank account name', max: LIMITS.bank },
  { key: 'customField1Label', name: 'Custom field 1 label', max: LIMITS.label },
  { key: 'customField1Value', name: 'Custom field 1 value', max: LIMITS.value },
  { key: 'customField2Label', name: 'Custom field 2 label', max: LIMITS.label },
  { key: 'customField2Value', name: 'Custom field 2 value', max: LIMITS.value },
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

// Checks a whole form (create) or a part of one (edit: only the keys sent are checked; the rest stay as saved).
export function cleanBrand(input: unknown, partial = false): { value: Partial<BrandInput>; errors: FieldErrors } {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const value: Partial<BrandInput> = {};
  const errors: FieldErrors = {};
  for (const f of FIELDS) {
    if (partial && !(f.key in src)) continue;
    const raw = src[f.key];
    if (raw !== undefined && raw !== null && typeof raw !== 'string') { errors[f.key] = `${f.name} must be text`; continue; }
    const v = cleanText(raw);
    if (f.required && !v) { errors[f.key] = `${f.name} is required`; continue; }
    if (v.length > f.max) { errors[f.key] = `${f.name} can be at most ${f.max} characters`; continue; }
    value[f.key] = v;
  }
  return { value, errors };
}

// What a card shows as a custom field's label: the owner's own, else "Custom Field 1 / 2".
export const labelOf = (label: string, n: 1 | 2) => cleanText(label) || (n === 1 ? DEFAULT_LABEL_1 : DEFAULT_LABEL_2);

// Distinct founders, ignoring capitals and extra spaces ("Sunny", "sunny ", "SUNNY" = one).
export function uniqueFounders(rows: Pick<BrandInput, 'founderName'>[]): number {
  return new Set(rows.map((r) => nameKey(r.founderName)).filter(Boolean)).size;
}

// Case-insensitive search over every field (both custom labels and values too). Empty = everything.
export function matchesSearch(row: BrandInput, q: string): boolean {
  const words = nameKey(q).split(' ').filter(Boolean);
  if (!words.length) return true;
  const hay = [
    row.founderName, row.brandName, row.bankAccountName,
    labelOf(row.customField1Label, 1), row.customField1Value,
    labelOf(row.customField2Label, 2), row.customField2Value,
  ].map(nameKey).join(' | ');
  return words.every((w) => hay.includes(w));
}

// One group per founder (capitals / extra spaces ignored), founders A-Z, each founder's brands A-Z. The name shown
// is the spelling most of their brands use (the first such one on a tie).
export function founderGroups<T extends BrandInput>(rows: T[]): { key: string; name: string; brands: T[] }[] {
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
    const brands = [...list].sort((a, b) => nameKey(a.brandName).localeCompare(nameKey(b.brandName)));
    return { key, name, brands };
  }).sort((a, b) => a.key.localeCompare(b.key));
}

export const DUPLICATE_ERROR = 'The server still blocks a repeated brand name: run brand-directory.sql once more';
export const NOT_INSTALLED_ERROR = 'Brand Directory is not installed yet: run brand-directory.sql once on the server';
