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
//   manager     orders and chat support, and the team's lead (owner 2026-10-10: "Sunny is the main guy, every
//               chargeback is on him"): the Manager panel, the whole team's score, refund forms / requests and
//               chargebacks (team.lead, refunds.manage, chargebacks.view). Full bank / UPI details stay the Super Admin's.
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
  'mail.view', 'mail.reply',
  'team.lead', 'refunds.manage', 'chargebacks.view',
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
  // Owner 2026-10-08: the Mail tab (the real Gmail inbox of each panel) is the Super Admin's. No role
  // preset has these ticks: the owner gives them to a member by hand, and only for that member's panels.
  { title: 'Mail (Gmail inbox)', items: [
    { key: 'mail.view', label: 'Open Mail', hint: "Read the last 30 days of the panel's Gmail inbox (opening a mail marks it read in Gmail)" },
    { key: 'mail.reply', label: 'Reply from Mail', hint: 'Send a reply from the panel\'s Gmail address (needs Open Mail)' },
  ] },
  // Owner 2026-10-10: the Manager (Sunny) runs the team and owns every chargeback. In the Manager preset.
  { title: 'Manager', items: [
    { key: 'team.lead', label: 'Team lead', hint: "Manager panel in Chat Support, the whole team's score and live board" },
    { key: 'refunds.manage', label: 'Refunds', hint: 'Send the refund form; see, approve, reject and mark refund requests Refunded (full bank / UPI details stay the Super Admin\'s)' },
    { key: 'chargebacks.view', label: 'Chargebacks', hint: 'The Chargebacks tab and its alerts; mark them done' },
  ] },
];

export const ROLE_INFO: Record<Exclude<Role, 'admin'>, { label: string; hint: string; perms: Permission[] }> = {
  panel_admin: { label: 'Admin', hint: 'Runs the panels you give: orders, chat, Chikki and panel settings',
    perms: ['orders.view', 'orders.update', 'orders.cancel', 'orders.upload', 'orders.email', 'orders.delete', 'chat.view', 'chat.reply', 'chat.cases', 'chat.edit', 'chikki.edit', 'settings.panel'] },
  manager: { label: 'Manager', hint: 'Runs the team: orders, chat support, refunds and chargebacks, the team score',
    perms: ['orders.view', 'orders.update', 'orders.cancel', 'orders.upload', 'orders.email', 'chat.view', 'chat.reply', 'chat.cases', 'team.lead', 'refunds.manage', 'chargebacks.view'] },
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

// The Manager's areas (owner 2026-10-10): the Super Admin always, a member only with the tick.
export const isTeamLead = (u: PermissionHolder | null | undefined) => isSuperAdmin(u) || can(u, 'team.lead');
export const canRefunds = (u: PermissionHolder | null | undefined) => isSuperAdmin(u) || can(u, 'refunds.manage');
export const canChargebacks = (u: PermissionHolder | null | undefined) => isSuperAdmin(u) || can(u, 'chargebacks.view');
// The panels a login's lists are limited to: null = every panel (the Super Admin, or a member with no limit).
export const panelScope = (u: PermissionHolder | null | undefined): string[] | null =>
  !u || isSuperAdmin(u) || !u.businessIds || u.businessIds.length === 0 ? null : [...u.businessIds];

// A member limited to some panels may only touch those; null / empty = every panel.
export function canAccessPanel(u: PermissionHolder | null | undefined, businessId: string | null | undefined): boolean {
  if (!u) return false;
  if (!u.businessIds || u.businessIds.length === 0) return true;
  return !!businessId && u.businessIds.includes(businessId);
}
