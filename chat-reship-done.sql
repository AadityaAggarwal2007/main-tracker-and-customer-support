-- ============================================================
-- Ship again: "the new parcel was sent" (owner 2026-10-03 09:25: "mujhe samajh nahi aa raha ki
-- humne kisko bhej diya kisko nahi ... upar likha dikhe ki Ship again ho gaya, jo nahi hue woh
-- upar"). A chat in Ship again now carries whether the team sent the new shipment (fship label /
-- new tracking link) and which AWB it got:
--   conversations.reshipped_at / reshipped_by   when and who (a team member's name) sent it
--   conversations.reship_awb / reship_link      the new AWB and the tracking link, as pasted
-- Set by PATCH /api/chat/conversations/[id]/reship (the "Mark reshipped" button) and by the staff
-- reply route when a reply in a Ship again chat carries an fship / courier tracking link or AWB
-- (src/lib/chat/reship.ts). Cleared when the mark is removed or changed. The Ship again list shows
-- "To ship" chats first and "Reshipped" ones last. The customer is told nothing by this.
-- Additive only, safe to run twice; tracker_user already updates conversations.
-- ============================================================
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS reshipped_at timestamptz;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS reshipped_by text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS reship_awb text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS reship_link text;
