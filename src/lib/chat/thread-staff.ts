import { AuthUser } from '@/lib/auth';
import { isOfficeHours } from '@/lib/office-hours';
import { cachedHolidays } from './holidays';
import { canAct, claimsOnAct, type TakeKind } from './team-rules';
import { caseMarkState, holderOf, holderView, shownAway, staffActor, takeFor, transferList } from './team-routing';
import type { ConversationRow } from './thread-read';

// What this person may do on this chat, decided here from team-rules.ts (the inbox draws it and
// never guesses). Computed in memory; the waiting query runs only for away cover.
export async function staffBlock(conv: ConversationRow, user: AuthUser) {
  const now = Date.now();
  const actor = staffActor(user);
  const h = holderOf(conv.assigned_to, conv.tracker_business_id, now);
  // A merged shell on a stale screen: read only (the actions refuse it too).
  const live = !!actor && !conv.merged_into;
  const take: TakeKind | null = live && actor ? await takeFor(null, actor, h, conv.id).catch(() => null) : null;
  const mark = actor ? caseMarkState(actor, now) : { allowed: false, override: false, note: null };
  return {
    me: actor?.key ?? null,
    holder: holderView(h),
    can_act: live && !!actor && canAct(actor, h),
    claims: live && !!actor && claimsOnAct(actor, h),
    take,
    transfer_to: live && actor && conv.status !== 'resolved'
      ? transferList(actor, h, conv.tracker_business_id, now).map((t) => ({
        key: t.key, name: t.name, senior: t.senior,
        away_min: shownAway(t.awayMin),
      }))
      : [],
    can_mark_case: mark.allowed,
    mark_override: mark.override,
    mark_note: mark.note,
    office_open: isOfficeHours(now, cachedHolidays()),
  };
}
