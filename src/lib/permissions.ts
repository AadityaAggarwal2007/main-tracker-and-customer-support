// Who may do what in ShipTrack (owner, 2026-10-01: "apne ladkon ko alag-alag panel pakda de").
// Pure: no imports, used by the API routes (server-side checks: the real gate), by auth.ts and by
// the screens (only to hide what someone cannot use).
//
// Roles
//   admin       the SUPER ADMIN: the owner's own login from the server settings, never a team
//               member. Everything, including team logins, Shopify, mailboxes, deleting panels
//               and the Danger Zone (a route that still checks role === 'admin' is super-admin only).
//   panel_admin "Admin" in the Team screen: runs the panels it is given (orders, chat, Chikki,
//               panel settings); no team, no Shopify, no mailboxes, no deleting panels.
//   manager     orders and chat support.
//   agent       "Chat agent": chat support only (and reading orders).
//   viewer      reads orders and chats, changes nothing.
// A member's ticks can differ from the role's (team_users.permissions); NULL = the role's list.
// Only the owner creates members (owner's choice, 2026-10-01).

export type Role = 'admin' | 'panel_admin' | 'manager' | 'agent' | 'viewer';
export const TEAM_ROLES: Exclude<Role, 'admin'>[] = ['panel_admin', 'manager', 'agent', 'viewer'];

export const PERMISSIONS = [
  'orders.view', 'orders.update', 'orders.cancel', 'orders.upload', 'orders.email', 'orders.delete',
  'chat.view', 'chat.reply', 'chat.cases', 'chat.edit', 'chat.senior',
  'chikki.edit', 'settings.panel',
] as const;
export type Permission = typeof PERMISSIONS[number];

export const PERMISSION_GROUPS: { title: string; items: { key: Permission; label: string; hint: string }[] }[] = [
  { title: 'Orders', items: [
    { key: 'orders.view', label: 'See orders', hint: 'Orders list, search, order details' },
    { key: 'orders.update', label: 'Change order status', hint: 'Move an order on, mark Delivered' },
    { key: 'orders.cancel', label: 'Cancel orders', hint: 'Mark an order Cancelled' },
    { key: 'orders.upload', label: 'Upload CSV', hint: 'Bring orders in from a Shopify export' },
    { key: 'orders.email', label: 'Send tracking emails', hint: 'Email customers their tracking link' },
    { key: 'orders.delete', label: 'Delete orders', hint: 'Remove an order for good' },
  ] },
  { title: 'Chat support', items: [
    { key: 'chat.view', label: 'Open Chat Support', hint: 'Read chats and emails' },
    { key: 'chat.reply', label: 'Reply to customers', hint: 'Reply, take over, hand to AI, close, transfer (own or unowned chats)' },
    { key: 'chat.cases', label: 'Refund / Ship again', hint: 'Mark or remove Refund and Ship again' },
    { key: 'chat.edit', label: 'Edit any message', hint: 'Edit or delete messages others sent' },
    // Owner, 2026-10-01: Super Admin > Senior > Junior (src/lib/chat/team-rules.ts). No role preset
    // has it: the owner ticks it per member in Team, and ticking it never signs anyone out.
    { key: 'chat.senior', label: 'Senior', hint: "Takes a junior's chat; marks Refund / Ship again (a junior may mark only while no senior has been in ShipTrack for 30 min, 10:00-19:30)" },
  ] },
  { title: 'Chikki and panel settings', items: [
    { key: 'chikki.edit', label: 'Teach Chikki', hint: 'Saved answers, notes, lessons, team examples' },
    { key: 'settings.panel', label: 'Panel settings', hint: 'Branding, chat widget, COD, custom instructions' },
  ] },
];

export const ROLE_INFO: Record<Exclude<Role, 'admin'>, { label: string; hint: string; perms: Permission[] }> = {
  panel_admin: { label: 'Admin', hint: 'Runs the panels you give: orders, chat, Chikki and panel settings',
    perms: ['orders.view', 'orders.update', 'orders.cancel', 'orders.upload', 'orders.email', 'orders.delete', 'chat.view', 'chat.reply', 'chat.cases', 'chat.edit', 'chikki.edit', 'settings.panel'] },
  manager: { label: 'Manager', hint: 'Orders and chat support',
    perms: ['orders.view', 'orders.update', 'orders.cancel', 'orders.upload', 'orders.email', 'chat.view', 'chat.reply', 'chat.cases'] },
  agent: { label: 'Chat agent', hint: 'Answers customers in Chat Support',
    perms: ['orders.view', 'chat.view', 'chat.reply', 'chat.cases'] },
  viewer: { label: 'Viewer', hint: 'Can look, cannot change anything',
    perms: ['orders.view', 'chat.view'] },
};

export function isRole(x: unknown): x is Role {
  return x === 'admin' || TEAM_ROLES.includes(x as Exclude<Role, 'admin'>);
}

// A team member's permissions: their own ticks if saved, else the role's. Unknown keys dropped.
export function resolvePermissions(role: string, custom?: readonly string[] | null): Permission[] {
  if (role === 'admin') return [...PERMISSIONS];
  const base = Array.isArray(custom) ? custom : (ROLE_INFO[role as Exclude<Role, 'admin'>]?.perms ?? []);
  return PERMISSIONS.filter((p) => base.includes(p));
}

export function cleanPermissions(raw: unknown): Permission[] {
  const list = Array.isArray(raw) ? raw.map(String) : [];
  return PERMISSIONS.filter((p) => list.includes(p));
}

export interface PermissionHolder { role: string; permissions?: readonly string[] | null; businessIds?: readonly string[] | null }

export const isSuperAdmin = (u: PermissionHolder | null | undefined) => !!u && u.role === 'admin';

export function can(u: PermissionHolder | null | undefined, perm: Permission): boolean {
  if (!u) return false;
  if (u.role === 'admin') return true;
  return resolvePermissions(u.role, u.permissions).includes(perm);
}

// A member limited to some panels may only touch those; null / empty = every panel.
export function canAccessPanel(u: PermissionHolder | null | undefined, businessId: string | null | undefined): boolean {
  if (!u) return false;
  if (!u.businessIds || u.businessIds.length === 0) return true;
  return !!businessId && u.businessIds.includes(businessId);
}
