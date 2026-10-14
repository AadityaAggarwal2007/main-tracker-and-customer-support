// ── Email: "AI writes a draft, the team sends" (owner 2026-10-08) ───────────────────────────────
// Until now Chikki answered every incoming email on her own (routine questions sent, the rest held).
// The owner wants the team to send the replies and Chikki to only prepare them, per panel, with the
// switch ON by default (Panel Settings > Email Support). Pure, no imports: the DB part is
// email-draft-mode.ts. In draft mode a reply is held exactly like an escalated one (stored with
// `withheld`, never emailed, shown dashed in the inbox as "Not sent — draft for the team"), with one
// exception:
//   * a customer who is not verified is never moved to Needs you by a draft (only verified customers
//     reach Needs you), the draft just waits in their thread.

// Since 2026-10-14 (owner, after a cancel mail on VASTRIKA got Chikki's reply by itself within the minute: "email ka
// lia humna ai nai lagaya ha toh yeh kasa chal rha ha?") NOTHING goes out by itself in draft mode, not even the fixed
// hand-over line for a fraud claim / refund / cancel / payment request (until then master rules 16 / 17 sent it): the
// line is in the draft, the chat goes to Needs you, the team sends. With the switch OFF it is as before: the hand-over
// line goes out, an escalated reply is held.
// Is this AI reply held back (not emailed)?
export function emailReplyHeld(escalated: boolean, handOverNow: boolean, draftOnly: boolean): boolean {
  if (draftOnly) return true;
  return !handOverNow && escalated;
}

// What the stored draft is labelled: an escalation keeps its own label, a plain draft is "draft".
export function heldKind(escalated: boolean): 'escalated' | 'draft' {
  return escalated ? 'escalated' : 'draft';
}

// A held reply moves the thread to Needs you when the AI escalated it (as before) or the sender is verified.
export function heldMovesToNeedsYou(escalated: boolean, verified: boolean): boolean {
  return escalated || verified;
}

// chat_settings key, one per chat site (= per panel). No row = ON.
export function draftOnlyKey(siteId: string): string {
  return `email_draft_only:${siteId}`;
}

// The stored value: '0' = off (Chikki sends routine answers by herself, as before); anything else = on.
export function parseDraftOnly(value: string | null | undefined): boolean {
  return value !== '0';
}
