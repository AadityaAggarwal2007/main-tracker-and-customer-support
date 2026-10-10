// The WhatsApp Business Account (WABA) id the template calls need (whatsapp-templates.ts). Typed once in
// Settings > WhatsApp and kept in chat_settings (`whatsapp_waba_id`); the env WHATSAPP_BUSINESS_ACCOUNT_ID
// is the fallback. Not a secret (it is an account number, not a key), so it may live in the database.
import { query, queryOne } from '@/lib/db';

export const WABA_KEY = 'whatsapp_waba_id';

export async function wabaId(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  try {
    const row = await queryOne<{ value: string }>(`SELECT value FROM chat_settings WHERE key = $1`, [WABA_KEY]);
    const v = (row?.value || '').trim();
    if (v) return v;
  } catch (err) {
    console.error('[whatsapp] waba id read failed:', (err as Error)?.message);
  }
  return (env.WHATSAPP_BUSINESS_ACCOUNT_ID || '').trim();
}

export async function setWabaId(value: string): Promise<void> {
  await query(
    `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [WABA_KEY, value.trim()]
  );
}

// The Meta APP id (the "ship track msg" app): the profile picture upload runs on the app. Not a secret.
export const APP_KEY = 'whatsapp_app_id';
export async function appId(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  try {
    const row = await queryOne<{ value: string }>(`SELECT value FROM chat_settings WHERE key = $1`, [APP_KEY]);
    const v = (row?.value || '').trim();
    if (v) return v;
  } catch (err) {
    console.error('[whatsapp] app id read failed:', (err as Error)?.message);
  }
  return (env.WHATSAPP_APP_ID || '').trim();
}
export async function setAppId(value: string): Promise<void> {
  await query(
    `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [APP_KEY, value.trim()]
  );
}
