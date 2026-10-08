import { checkEnvPassword, readSuperAdminRow, verifyPassword } from '@/lib/auth';

// The Super Admin's own password, asked again before something big (a new panel, owner 2026-10-08:
// "sirf super admin hi new panel bana paye aur woh bhi password ke saath"). The same check as
// Login & security (the saved login, else the .env one). Wrong tries: 5 per 15 minutes, in memory
// (one server process), so a stolen login cannot guess it here. Never logged or answered.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;
const g = globalThis as unknown as { __shiptrackOwnerPwFails?: { n: number; until: number } };

export type OwnerPasswordResult = 'ok' | 'wrong' | 'locked' | 'error';

export async function checkOwnerPassword(password: unknown): Promise<OwnerPasswordResult> {
  const fails = g.__shiptrackOwnerPwFails;
  if (fails && fails.until > Date.now() && fails.n >= MAX_FAILS) return 'locked';
  if (typeof password !== 'string' || !password) return 'wrong';
  let ok: boolean;
  try {
    const row = await readSuperAdminRow();
    ok = row ? verifyPassword(row.password_hash, password) : checkEnvPassword(password);
  } catch {
    return 'error';
  }
  if (!ok) {
    const f = g.__shiptrackOwnerPwFails;
    g.__shiptrackOwnerPwFails = !f || f.until < Date.now() ? { n: 1, until: Date.now() + WINDOW_MS } : { n: f.n + 1, until: f.until };
    return 'wrong';
  }
  g.__shiptrackOwnerPwFails = undefined;
  return 'ok';
}
