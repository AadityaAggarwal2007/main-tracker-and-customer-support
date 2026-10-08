// ── Email: "AI writes a draft, the team sends" (owner 2026-10-08) ───────────────────────────────
// Until now Chikki answered every incoming email on her own (routine questions sent, the rest held).
// The owner wants the team to send the replies and Chikki to only prepare them, per panel, with the
// switch ON by default (Panel Settings > Email Support). Pure, no imports: the DB part is
// email-draft-mode.ts. In draft mode a reply is held exactly like an escalated one (stored with
// `withheld`, never emailed, shown dashed in the inbox as "Not sent — draft for the team"), with two
// exceptions that are NOT drafts:
//   * the fixed hand-over lines for a threat / fraud claim / refund or payment request (master rules
//     11, 16, 17: the customer must hear that a person has it) still go out on their own;
//   * a customer who is not verified is never moved to Needs you by a draft (only verified customers
//     reach Needs you), the draft just waits in their thread.

// Is this AI reply held back (not emailed)?
export function emailReplyHeld(escalated: boolean, handOverNow: boolean, draftOnly: boolean): boolean {
  return !handOverNow && (escalated || draftOnly);
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
