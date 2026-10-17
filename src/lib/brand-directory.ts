// Payments > Brand Directory (owner 2026-10-17): the database side. Super Admin only (the routes check).
// Table brand_directory (brand-directory.sql). Parameterised queries only; a missing table = NotInstalled, a table
// without the evening's columns (fields, color, sort_order) = NeedsUpdate.
import { query, queryOne } from '@/lib/db';
import { DEFAULT_GATEWAYS, legacyFields, type BrandField, type BrandInput, type BrandRow } from '@/lib/brand-directory-rules';

export class NotInstalled extends Error {}
export class NeedsUpdate extends Error {}
// Owner 2026-10-17: the same brand name may be saved more than once. Duplicate only answers the old unique key
// (brand_directory_name_key) on an install where brand-directory.sql has not been run again since.
export class Duplicate extends Error {}

interface Row {
  id: string | number; founder_name: string; brand_name: string; bank_account_name: string;
  custom_field_1_label: string; custom_field_1_value: string; custom_field_2_label: string; custom_field_2_value: string;
  fields: unknown; color: string; sort_order: number;
  created_at: string | Date; updated_at: string | Date;
}

const COLS = `id, founder_name, brand_name, bank_account_name, custom_field_1_label, custom_field_1_value,
  custom_field_2_label, custom_field_2_value, fields, color, sort_order, created_at, updated_at`;

// The same founder as the rules' nameKey (capitals and outer spaces; the routes already made inner spaces one).
const SAME_FOUNDER = `lower(btrim(founder_name)) = lower(btrim($1))`;

const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
function fieldsOf(r: Row): BrandField[] {
  let f = r.fields;
  if (typeof f === 'string') { try { f = JSON.parse(f); } catch { f = []; } }
  const list = Array.isArray(f)
    ? f.filter((x) => x && typeof x === 'object').map((x) => ({ label: String((x as BrandField).label ?? ''), value: String((x as BrandField).value ?? '') }))
    : [];
  return list.length ? list : legacyFields(r.custom_field_1_label || '', r.custom_field_1_value || '', r.custom_field_2_label || '', r.custom_field_2_value || '');
}
const toRow = (r: Row): BrandRow => ({
  id: String(r.id),
  founderName: r.founder_name, brandName: r.brand_name, bankAccountName: r.bank_account_name || '',
  fields: fieldsOf(r), color: r.color || '', sortOrder: Number(r.sort_order) || 0,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});

function dbError(e: unknown): never {
  const code = (e as { code?: string })?.code;
  if (code === '42P01') throw new NotInstalled();
  if (code === '42703') throw new NeedsUpdate();
  if (code === '23505') throw new Duplicate();
  throw e;
}

export const validId = (id: string) => /^[1-9][0-9]{0,17}$/.test(id);

export async function listBrands(): Promise<BrandRow[]> {
  try {
    const r = await query<Row>(`SELECT ${COLS} FROM brand_directory ORDER BY lower(btrim(founder_name)), sort_order, lower(btrim(brand_name)), id`);
    return r.rows.map(toRow);
  } catch (e) { return dbError(e); }
}

export async function getBrand(id: string): Promise<BrandRow | null> {
  try {
    const r = await queryOne<Row>(`SELECT ${COLS} FROM brand_directory WHERE id = $1`, [id]);
    return r ? toRow(r) : null;
  } catch (e) { return dbError(e); }
}

// A new card goes after the founder's last one.
export async function createBrand(v: BrandInput, actor: string): Promise<BrandRow> {
  try {
    const r = await queryOne<Row>(
      `INSERT INTO brand_directory (founder_name, brand_name, bank_account_name, fields, color, sort_order, created_by, updated_by)
       VALUES ($1, $2, $3, $4::jsonb, $5,
         COALESCE((SELECT max(sort_order) + 1 FROM brand_directory WHERE ${SAME_FOUNDER}), 0), $6, $6)
       RETURNING ${COLS}`,
      [v.founderName, v.brandName, v.bankAccountName, JSON.stringify(v.fields || []), v.color || '', actor],
    );
    return toRow(r as Row);
  } catch (e) { return dbError(e); }
}

// Owner 2026-10-17: a new founder starts with the 11 payment gateway cards. Adds, after the founder's last card,
// each gateway they do not have yet (capitals / spaces ignored); one statement, so a second click adds nothing.
export async function addGateways(founderName: string, actor: string): Promise<BrandRow[]> {
  try {
    const r = await query<Row>(
      `INSERT INTO brand_directory (founder_name, brand_name, sort_order, created_by, updated_by)
       SELECT $1, g.name,
         COALESCE((SELECT max(sort_order) FROM brand_directory WHERE ${SAME_FOUNDER}), -1) + g.ord, $3, $3
       FROM unnest($2::text[]) WITH ORDINALITY AS g(name, ord)
       WHERE NOT EXISTS (SELECT 1 FROM brand_directory b
         WHERE lower(btrim(b.founder_name)) = lower(btrim($1)) AND lower(btrim(b.brand_name)) = lower(btrim(g.name)))
       RETURNING ${COLS}`,
      [founderName, [...DEFAULT_GATEWAYS], actor],
    );
    return r.rows.map(toRow);
  } catch (e) { return dbError(e); }
}

// Changes only the fields sent; the others stay as saved. Saving the fields also empties the first version's two
// columns, so an emptied list never brings them back. null = no such brand.
export async function updateBrand(id: string, v: Partial<BrandInput>, actor: string): Promise<BrandRow | null> {
  try {
    const r = await queryOne<Row>(
      `UPDATE brand_directory SET
         founder_name         = COALESCE($2, founder_name),
         brand_name           = COALESCE($3, brand_name),
         bank_account_name    = COALESCE($4, bank_account_name),
         fields               = COALESCE($5::jsonb, fields),
         custom_field_1_label = CASE WHEN $5::jsonb IS NULL THEN custom_field_1_label ELSE '' END,
         custom_field_1_value = CASE WHEN $5::jsonb IS NULL THEN custom_field_1_value ELSE '' END,
         custom_field_2_label = CASE WHEN $5::jsonb IS NULL THEN custom_field_2_label ELSE '' END,
         custom_field_2_value = CASE WHEN $5::jsonb IS NULL THEN custom_field_2_value ELSE '' END,
         color                = COALESCE($6, color),
         updated_by = $7, updated_at = now()
       WHERE id = $1 RETURNING ${COLS}`,
      [id, v.founderName ?? null, v.brandName ?? null, v.bankAccountName ?? null,
        v.fields ? JSON.stringify(v.fields) : null, v.color ?? null, actor],
    );
    return r ? toRow(r) : null;
  } catch (e) { return dbError(e); }
}

// The order the owner dragged the cards into: each id gets its place (0, 1, 2 ...). Not an edit: updated_at stays.
export async function setOrder(ids: string[]): Promise<number> {
  try {
    const r = await query(
      `UPDATE brand_directory b SET sort_order = o.ord - 1
       FROM unnest($1::bigint[]) WITH ORDINALITY AS o(id, ord) WHERE b.id = o.id`,
      [ids],
    );
    return r.rowCount ?? 0;
  } catch (e) { return dbError(e); }
}

// Removes ONE brand row by its id. false = no such brand.
export async function deleteBrand(id: string): Promise<boolean> {
  try {
    const r = await query(`DELETE FROM brand_directory WHERE id = $1`, [id]);
    return (r.rowCount ?? 0) === 1;
  } catch (e) { return dbError(e); }
}
