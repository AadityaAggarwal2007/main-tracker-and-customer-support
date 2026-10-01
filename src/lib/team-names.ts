// A team member's display name (owner, 2026-10-01). Pure: used by /api/auth/profile (the member's own
// change, once every 15 days) and /api/team (the owner, any time). Customers never see these names.

export const NAME_CHANGE_DAYS = 15;

// Names a member may not take: they would read like the owner, the AI or the store to the team.
const RESERVED = new Set([
  'super admin', 'superadmin', 'admin', 'owner', 'support', 'vastora support', 'vastora', 'shiptrack',
  'karry', 'chikki', 'ai', 'bot', 'system', 'customer', 'team',
]);

export const cleanDisplayName = (x: unknown) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

// The first thing wrong with a new name, or null. others = the other members' names.
export function nameProblem(name: string, others: string[]): string | null {
  if (name.length < 2) return 'Write a name (at least 2 letters)';
  if (!/[\p{L}]/u.test(name)) return 'A name needs letters';
  if (/[<>{}\[\]\\/@#$%^*=|~`]/.test(name)) return 'Use letters, spaces, dots or dashes only';
  if (RESERVED.has(name.toLowerCase())) return 'That name is kept for the system. Use your own name.';
  if (others.some((o) => o.trim().toLowerCase() === name.toLowerCase())) return 'Someone in the team already has that name';
  return null;
}

// When the member may change their name again (null = now).
export function nextNameChange(changedAt: string | Date | null | undefined, now = Date.now()): Date | null {
  if (!changedAt) return null;
  const at = new Date(changedAt).getTime();
  if (Number.isNaN(at)) return null;
  const next = at + NAME_CHANGE_DAYS * 24 * 60 * 60 * 1000;
  return next > now ? new Date(next) : null;
}
