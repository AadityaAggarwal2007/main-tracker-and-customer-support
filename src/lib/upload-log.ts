import { query } from '@/lib/db';

// One row per CSV upload (upload-logs-panel.sql, owner 2026-10-08): which file went into which panel,
// who, how many, the first and last order number, and the warning the uploader clicked past. The upload
// route calls it once per chunk and the chunks add up in the same row. Never throws: a record that
// cannot be written must not stop an upload. Before the SQL file is applied it falls back to the old
// one-line record on the last chunk.
export interface UploadRecord {
  uploadId: string | null;
  file: string;
  businessId: string;
  panelName: string | null;
  user: string;
  total: number;
  newOrders: number;
  updated: number;
  skipped: number;
  firstOrder: string | null;
  lastOrder: string | null;
  warning: string | null;
  isLastChunk: boolean;
}

export async function recordUpload(r: UploadRecord): Promise<void> {
  const warning = r.warning ? r.warning.slice(0, 500) : null;
  try {
    if (!r.uploadId) throw new Error('no upload id');
    await query(
      `INSERT INTO upload_logs (upload_id, filename, total_rows, new_orders, updated_orders, skipped_rows, uploaded_by,
                                business_id, panel_name, first_order, last_order, warning_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (upload_id) WHERE upload_id IS NOT NULL DO UPDATE SET
         total_rows = upload_logs.total_rows + EXCLUDED.total_rows,
         new_orders = upload_logs.new_orders + EXCLUDED.new_orders,
         updated_orders = upload_logs.updated_orders + EXCLUDED.updated_orders,
         skipped_rows = upload_logs.skipped_rows + EXCLUDED.skipped_rows,
         last_order = EXCLUDED.last_order,
         updated_at = now()`,
      [r.uploadId.slice(0, 64), r.file, r.total, r.newOrders, r.updated, r.skipped, r.user, r.businessId, r.panelName, r.firstOrder, r.lastOrder, warning]
    );
  } catch {
    if (!r.isLastChunk) return;
    try {
      await query(
        `INSERT INTO upload_logs (filename, total_rows, new_orders, updated_orders, skipped_rows, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [r.file, r.total, r.newOrders, r.updated, r.skipped, r.user]
      );
    } catch { /* upload_logs might not exist */ }
  }
}
