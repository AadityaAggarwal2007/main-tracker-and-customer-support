// Payments > Brand Directory (owner 2026-10-17): the database side. Super Admin only (the routes check).
// Table brand_directory (brand-directory.sql). Parameterised queries only; a missing table = NotInstalled.
import { query, queryOne } from '@/lib/db';
import type { BrandInput, BrandRow } from '@/lib/brand-directory-rules';

export class NotInstalled extends Error {}
// Owner 2026-10-17: the same brand name may be saved more than once. Duplicate only answers the old unique key
// (brand_directory_name_key) on an install where brand-directory.sql has not been run again since.
export class Duplicate extends Error {}

interface Row {
  id: string | number; founder_name: string; brand_name: string; bank_account_name: string;
  custom_field_1_label: string; custom_field_1_value: string; custom_field_2_label: string; custom_field_2_value: string;
  created_at: string | Date; updated_at: string | Date;
}

const COLS = `id, founder_name, brand_name, bank_account_name, custom_field_1_label, custom_field_1_value,
  custom_field_2_label, custom_field_2_value, created_at, updated_at`;

const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const toRow = (r: Row): BrandRow => ({
  id: String(r.id),
  founderName: r.founder_name, brandName: r.brand_name, bankAccountName: r.bank_account_name || '',
  customField1Label: r.custom_field_1_label || '', customField1Value: r.custom_field_1_value || '',
  customField2Label: r.custom_field_2_label || '', customField2Value: r.custom_field_2_value || '',
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});

function dbError(e: unknown): never {
  const code = (e as { code?: string })?.code;
  if (code === '42P01') throw new NotInstalled();
  if (code === '23505') throw new Duplicate();
  throw e;
}

export const validId = (id: string) => /^[1-9][0-9]{0,17}$/.test(id);

export async function listBrands(): Promise<BrandRow[]> {
  try {
    const r = await query<Row>(`SELECT ${COLS} FROM brand_directory ORDER BY lower(btrim(brand_name)), id`);
    return r.rows.map(toRow);
  } catch (e) { return dbError(e); }
}

export async function getBrand(id: string): Promise<BrandRow | null> {
  try {
    const r = await queryOne<Row>(`SELECT ${COLS} FROM brand_directory WHERE id = $1`, [id]);
    return r ? toRow(r) : null;
  } catch (e) { return dbError(e); }
}

export async function createBrand(v: BrandInput, actor: string): Promise<BrandRow> {
  try {
    const r = await queryOne<Row>(
      `INSERT INTO brand_directory (founder_name, brand_name, bank_account_name, custom_field_1_label, custom_field_1_value,
         custom_field_2_label, custom_field_2_value, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING ${COLS}`,
      [v.founderName, v.brandName, v.bankAccountName, v.customField1Label, v.customField1Value,
        v.customField2Label, v.customField2Value, actor],
    );
    return toRow(r as Row);
  } catch (e) { return dbError(e); }
}

// Changes only the fields sent; the others stay as saved. null = no such brand.
export async function updateBrand(id: string, v: Partial<BrandInput>, actor: string): Promise<BrandRow | null> {
  try {
    const r = await queryOne<Row>(
      `UPDATE brand_directory SET
         founder_name         = COALESCE($2, founder_name),
         brand_name           = COALESCE($3, brand_name),
         bank_account_name    = COALESCE($4, bank_account_name),
         custom_field_1_label = COALESCE($5, custom_field_1_label),
         custom_field_1_value = COALESCE($6, custom_field_1_value),
         custom_field_2_label = COALESCE($7, custom_field_2_label),
         custom_field_2_value = COALESCE($8, custom_field_2_value),
         updated_by = $9, updated_at = now()
       WHERE id = $1 RETURNING ${COLS}`,
      [id, v.founderName ?? null, v.brandName ?? null, v.bankAccountName ?? null, v.customField1Label ?? null,
        v.customField1Value ?? null, v.customField2Label ?? null, v.customField2Value ?? null, actor],
    );
    return r ? toRow(r) : null;
  } catch (e) { return dbError(e); }
}

// Removes ONE brand row by its id. false = no such brand.
export async function deleteBrand(id: string): Promise<boolean> {
  try {
    const r = await query(`DELETE FROM brand_directory WHERE id = $1`, [id]);
    return (r.rowCount ?? 0) === 1;
  } catch (e) { return dbError(e); }
}
