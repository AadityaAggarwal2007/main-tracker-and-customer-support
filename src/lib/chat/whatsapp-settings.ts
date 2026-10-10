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

// The MESSAGING account id (owner 2026-10-10: Meta's reply to creating a template on the WhatsApp account was
// "WhatsApp accounts cannot be used with this API"; Meta keeps templates and billing on the Messaging account,
// Business Settings > Accounts > Messaging accounts). When it is saved, every template call (list, create,
// edit, delete, the check before a send) uses it; without it they use the WhatsApp account id as before.
export const MESSAGING_KEY = 'whatsapp_messaging_id';
export async function messagingId(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  try {
    const row = await queryOne<{ value: string }>(`SELECT value FROM chat_settings WHERE key = $1`, [MESSAGING_KEY]);
    const v = (row?.value || '').trim();
    if (v) return v;
  } catch (err) {
    console.error('[whatsapp] messaging id read failed:', (err as Error)?.message);
  }
  return (env.WHATSAPP_MESSAGING_ACCOUNT_ID || '').trim();
}
export async function setMessagingId(value: string): Promise<void> {
  await query(
    `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [MESSAGING_KEY, value.trim()]
  );
}
// The id the template calls go to: the Messaging account when saved, else the WhatsApp account.
export async function templatesAccount(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return (await messagingId(env)) || (await wabaId(env));
}

// The daily limit (owner 2026-10-10: the Today board said "limit not known"). Since October 2025 Meta keeps the
// messaging limit on the business PORTFOLIO, not on the number, so the number's messaging_limit_tier often comes back
// empty. The owner reads it in WhatsApp Manager > Overview > Limits ("Start 2,000 new unique conversations per day")
// and types it once in WhatsApp > Setup; the board uses Meta's own tier when the number carries one. Not a secret.
export const DAILY_LIMIT_KEY = 'whatsapp_daily_limit';
export async function dailyLimit(): Promise<number | null> {
  try {
    const row = await queryOne<{ value: string }>(`SELECT value FROM chat_settings WHERE key = $1`, [DAILY_LIMIT_KEY]);
    const n = Number((row?.value || '').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch (err) {
    console.error('[whatsapp] daily limit read failed:', (err as Error)?.message);
    return null;
  }
}
export async function setDailyLimit(value: number | null): Promise<void> {
  await query(
    `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [DAILY_LIMIT_KEY, value ? String(value) : '']
  );
}

// The owner's own WhatsApp number for ShipTrack's alerts (owner 2026-10-10: the AI's OpenRouter credits run low, see
// ai-credit.ts). Saved in WhatsApp > Setup; the alert goes as the approved template "shiptrack_alert". Not a secret.
export const ALERT_TO_KEY = 'whatsapp_alert_to';
export async function alertTo(): Promise<string> {
  try {
    const row = await queryOne<{ value: string }>(`SELECT value FROM chat_settings WHERE key = $1`, [ALERT_TO_KEY]);
    return (row?.value || '').replace(/\D/g, '');
  } catch (err) {
    console.error('[whatsapp] alert number read failed:', (err as Error)?.message);
    return '';
  }
}
export async function setAlertTo(digits: string): Promise<void> {
  await query(
    `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [ALERT_TO_KEY, digits]
  );
}

// More numbers for the alerts (owner 2026-10-10, Chargeback Shield step 2: "Sunny ke paas ... Super Admin ko bhi pata chale";
// then "group chat add karne ka option": the official Cloud API cannot post into an ordinary WhatsApp group (Meta's Groups
// API needs the green-tick Official Business Account, groups made by the API, 8 people), so the alert goes to up to 5
// numbers, the same message each). Stored as digits separated by commas; [] = none. Not a secret.
export const EXTRA_ALERT_KEY = 'whatsapp_alert_extra';
export const EXTRA_ALERT_MAX = 5;
export const parseAlertNumbers = (stored: string): string[] =>
  Array.from(new Set(String(stored || '').split(',').map((x) => x.replace(/\D/g, '')).filter((x) => x.length >= 10))).slice(0, EXTRA_ALERT_MAX);
export async function extraAlertTo(): Promise<string[]> {
  try {
    const row = await queryOne<{ value: string }>(`SELECT value FROM chat_settings WHERE key = $1`, [EXTRA_ALERT_KEY]);
    return parseAlertNumbers(row?.value || '');
  } catch (err) {
    console.error('[whatsapp] extra alert numbers read failed:', (err as Error)?.message);
    return [];
  }
}
export async function setExtraAlertTo(numbers: string[]): Promise<void> {
  await query(
    `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [EXTRA_ALERT_KEY, numbers.join(',')]
  );
}
