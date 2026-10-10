// ── Who is on duty, and who gets the next chat (owner 2026-10-10: "jitni bhi enquiry aayengi, apne aap team members
// ko assign ho jayengi; subah login karte hi chats milna shuru; login nahi kiya to absent, koi chat nahi") ──
// Pure: no imports. The server (auto-assign.ts) fills the inputs from the team list, presence and the database.

export interface DutyInput {
  active: boolean;          // the login is switched on
  canReply: boolean;        // chat.reply
  lead: boolean;            // the Manager (team.lead) or the Super Admin: they take escalations, not the queue
  panelOk: boolean;         // may work in the chat's panel
  officeOpen: boolean;      // office hours now (isOfficeHours, holidays included)
  seenTodayMs: number | null; // last time seen in ShipTrack (presence), epoch ms
  openedTodayMs: number;    // today's office opening (10:00 IST), epoch ms
  awayMin: number | null;   // minutes away (office-hours.ts awayMinutes); null outside office hours
}

// On duty = office open, the member has been in ShipTrack today since the office opened (they logged in and use it)
// and is not away 30+ minutes. Not logged in today = absent: no chat is given to them.
export const AWAY_OFF_DUTY_MIN = 30;
export function onDuty(d: DutyInput): boolean {
  if (!d.active || !d.canReply || d.lead || !d.panelOk || !d.officeOpen) return false;
  if (d.seenTodayMs === null || d.seenTodayMs < d.openedTodayMs) return false;
  return d.awayMin === null || d.awayMin < AWAY_OFF_DUTY_MIN;
}

export interface Candidate { key: string; name: string; load: number; lastAssignedMs: number }
// The member with the fewest open chats; on a tie the one given a chat longest ago (round robin); then by name.
export function pickAssignee(cands: Candidate[]): Candidate | null {
  if (!cands.length) return null;
  return [...cands].sort((a, b) => a.load - b.load || a.lastAssignedMs - b.lastAssignedMs || a.name.localeCompare(b.name))[0];
}
