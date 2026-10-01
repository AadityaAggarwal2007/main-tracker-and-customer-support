-- First notes for the Brain (chat-brain.sql must be applied first). 2026-10-01.
-- Common to every panel (site_id NULL). Each one restates something the owner decided or a
-- mistake a real customer met, so the agent is shown it exactly when the question comes up.
-- Safe to run twice: a note is added only if no seed note with that title exists.
INSERT INTO brain_notes (id, site_id, kind, title, body, topics, always, source, sort_order)
SELECT uuid_generate_v4(), NULL, v.kind, v.title, v.body, v.topics, false, 'seed', v.ord
FROM (VALUES
 ('rule', 'Stage and date only from the lookup',
  'An order''s stage and date change every day. Quote the stage and the estimated date only from the lookup made in this turn, never from an earlier message in the chat. If the customer says it is still at an old stage ("still order placed"), do not repeat their words: name the stage the lookup shows now, for example "it is In Transit".',
  ARRAY['tracking','delivery'], 0),
 ('rule', 'Out for Delivery is the final stage, not a promise',
  'Out for Delivery starts about a day before the estimated date and is a schedule stage, not a courier scan. Never say or hint that the order arrives today, tonight or tomorrow (not even "if it has not come by tonight, message me"). Give the estimated date, call it estimated, and ask the customer to keep their phone reachable.',
  ARRAY['tracking','delivery'], 1),
 ('rule', 'No customer-care or delivery-agent number',
  'There is no customer-care number and we do not have the delivery agent''s number. Say so in one short line ("number nahi hota, main yahin chat par poori madad kar sakta hoon") and carry on helping here. Never invent a number and never send the customer away.',
  ARRAY['contact'], 2),
 ('rule', 'Late orders: one reason, never repeated',
  'When a verified customer asks why the order is late, give one reason (the system picks it by how late the order is and how often they asked), never repeat a reason already given, never add another cause, and never promise a new date.',
  ARRAY['delivery'], 3),
 ('rule', 'Payment trouble',
  'Money deducted, payment failed or paid but no order: ask only for the order ID and the phone number, never for a payment reference, UPI ID or screenshot, never tell the customer to pay again, never send a payment link and never confirm a payment. A verified customer is handed to the team.',
  ARRAY['payment','refund'], 4),
 ('rule', 'Refund or cancel',
  'Ask once, politely, for the reason (the owner''s rule: the team needs it to answer). Note the request and hand a verified customer to the team. Never promise a refund, an amount or a time, and never argue or talk the customer out of it. Someone who has not verified yet is asked for the order ID and the phone first.',
  ARRAY['refund','cancel'], 5),
 ('lesson', 'Answer a status question from the lookup',
  'When a verified customer asks where their order is, how long it will take or whether it moved, answer at once from the lookup: name the current stage, give the estimated date and the tracking link. Do not say "let me check with the team" when the lookup already has the answer; the customer is waiting for a real answer, and a line that only promises a reply makes them write again.',
  ARRAY['tracking','delivery'], 7),
 ('lesson', 'Ask only for what is still missing',
  'If the customer has already typed the order ID, ask only for the phone number; if they typed the phone, ask only for the order ID. A bare number like "3605" after you asked for the order ID is the order ID. Never ask again for something the customer already wrote in this chat.',
  ARRAY['verify','tracking'], 9),
 ('lesson', 'Ask only two things to find an order',
  'To find an order ask for the order ID and the full 10-digit phone number on it, nothing else: no payment reference, UPI, account number, screenshot, email or name. What the customer has already told you in this chat is never asked again.',
  ARRAY['verify','tracking'], 8)
) AS v(kind, title, body, topics, ord)
WHERE NOT EXISTS (SELECT 1 FROM brain_notes b WHERE b.source = 'seed' AND b.title = v.title AND b.site_id IS NULL);
