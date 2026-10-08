import { query, queryOne } from '@/lib/db';
import { draftOnlyKey, parseDraftOnly } from './email-draft';

// The per-panel switch behind email-draft.ts, one row of chat_settings (no SQL file: the table exists).
// Fail closed: a missing row or a read error means ON (the team sends), never a surprise auto-reply.
export async function emailDraftOnly(siteId: string): Promise<boolean> {
  try {
    const row = await queryOne<{ value: string }>(`SELECT value FROM chat_settings WHERE key = $1`, [draftOnlyKey(siteId)]);
    return parseDraftOnly(row?.value);
  } catch (err) {
    console.error('[email] draft switch read failed, using ON:', (err as Error)?.message);
    return true;
  }
}

export async function setEmailDraftOnly(siteId: string, on: boolean): Promise<void> {
  await query(
    `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [draftOnlyKey(siteId), on ? '1' : '0']
  );
}
