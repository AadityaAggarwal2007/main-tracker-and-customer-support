# PROJECT MEMORY — read this first (then AGENTS.md only for the rows you need)

Written 2026-10-09 so a new session does not re-read the whole repo. Keep it SHORT: update the
"Where things stand" and "Open with the owner" parts when they change, nothing else grows.

## What this is, in five lines

- ShipTrack: order tracking + customer chat support, one Next.js 14 app, PostgreSQL via `pg`,
  live at shiptrack.store from `/var/www/tracker` on one Hostinger VPS (PM2 app `tracker`).
- Repo `AadityaAggarwal2007/main-tracker-and-customer-support`, default branch `main`.
- Three panels (stores) on one install: **vastora**, **VASTRIKA**, **kurtiya**. Same code for all;
  only each panel's TEXT (prompt, saved answers, Brain notes, courier, Gmail) lives in the database.
- The AI for customers is "Karry" (customers) / "Chikki" (staff screens). Model chain in
  `src/lib/chat/ai-models.ts` (DeepSeek V4 Pro first, cheap V4 Flash for side jobs).
- Rules: `AGENTS.md` (the map, one row per feature) and `SHIPTRACK_MASTER_RULES.md` (the
  owner's own file, never edit). Report master rules touched (PASS / FAIL / N/A) after a task.

## How the owner works with me (standing instructions, 2026-10-09)

- He writes Hinglish; answer in Hinglish, short, plain words, no jargon.
- **"directly push, dont suggest me do"**: I make the change, open the PR and MERGE it myself
  (GitHub MCP: `create_pull_request` then `merge_pull_request`). I never tell him to merge.
- **Deploy is automatic**: a merge to `main` runs `.github/workflows/deploy.yml` (ssh with the
  repo secrets `VPS_HOST` / `VPS_USER` / `VPS_SSH_KEY`, then `vps-setup/5-deploy.sh`). Check it
  with `actions_list` / `actions_get` / `get_job_logs`; re-run with `actions_run_trigger` if the
  ssh step timed out. It NEVER runs SQL.
- **SQL files are his to run** (he pastes the one-line command in his Terminal): only after he
  says yes; anything that changes or deletes rows needs his plain-words OK.
- **We are building ShipTrack, not a panel** (owner 2026-10-14: "jo bhi command dunga woh 3 pa kya jitna panel bhi
  add honge un sabpa laga hamesha, we are building shiptrack not a specific panel"). EVERY request applies to every
  panel today (vastora, VASTRIKA, kurtiya) AND every panel added later, even when he shows one panel's screenshot:
  no panel name / id in code, defaults that a NEW panel gets by itself (no copy step he has to remember), a setting
  stored per panel works for any panel id, tests use made-up panel ids, and the report says it holds for all panels.
- Never ask for or handle the root password, a secret's value, a private key; never print
  `/etc/tracker/.env`. If he pastes a secret into chat, tell him to regenerate it.
- Dev branch: `claude/gracious-meitner-3de4a7`. After each merge:
  `git fetch origin main && git checkout -B claude/gracious-meitner-3de4a7 origin/main`
  then `git push -u origin claude/gracious-meitner-3de4a7 --force-with-lease` (the branch holds
  only merged history, so this is safe). Commits need the attribution lines the session gives.
- There is no `ssh` binary in the cloud container: everything on the VPS goes through the
  deploy workflow or a command he pastes.

## Checks before a push

- `npx tsc --noEmit` = 0 errors. `npm run test:ai` all suites green (adds a new src file a tested
  module imports to that suite's compile list). `npm run build` when a page / route changed.
- UI check without a database: `next start -p 3111` + Playwright with `/api/**` mocked
  (chromium at `/opt/pw-browsers/chromium`); kill with `fuser -k 3111/tcp`.
- Database logic without a database: PGlite scratch scripts (`@electric-sql/pglite`) in the
  session scratchpad, running the real `.sql` file first.

## Where things stand (2026-10-09, after PR #31 = main 3af692a, auto-deployed OK)

Done and live:
- Settings > **Copy setup** (`PanelCopyCard`, `/api/panel-copy`, `src/lib/panel-copy*.ts`):
  Preview then Copy now; adds only, replaces only with "Replace" ticked; backup row in
  `chat_settings` `panel_copy:<time>:<target>`. "Start from" select in New panel.
- Settings > **Gmail accounts**: overview tiles + "Gmail 1 · Customer support" (purple) and
  "Gmail 2 · Chargeback protection" (red), labelled Disconnect buttons with named confirms.
- **Chargeback**: one `chargeback-setup.sql` (run by the owner, reported 2 / 2 / 5 / t / t);
  shared chargeback Gmail across panels, routing by order → gateway checklist → "unsure";
  poller signs in with every row's App Password; IPv4 Gmail host; real IMAP reason shown
  (`mailErrorText`). WhatsApp alerts need env `WHATSAPP_*` (not set yet).
- **Suggested replies + Sudharo** in email chats too, every panel; list column explanation folded.
- **Auto-deploy** workflow working (first live run 2026-10-09; port 22 timed out once, so it
  tries 3 times).
- **Chargebacks filter** (PR #33): only a mail with a dispute word is a chargeback; the gateway's
  ₹100 payment / settlement / OTP mails sit under "Other mail", uncounted, no WhatsApp, no chat tag.
- **"Today" tab** (first in the sidebar, the start screen; `src/lib/panel-board.ts`, `PanelBoard.tsx`):
  the day, totals, the morning routine, one card per panel with what to do + Gmail read status.
- **Mail tab fast on every panel**: `src/lib/chat/mail-cache.ts` keeps each Gmail's list + mails in the
  server's memory AND in `<app>/.mail-cache/mail-cache.json` (survives deploys); the minute poller refreshes
  lists and reads 10 mails/min ahead until the whole month is kept. From this VPS a Gmail sign-in is 2-14 s.
  An open mail is full width by default. A refresh comes back to the same tab / mailbox / mail / chat.
- **Mail store (11 Oct, "history ko load karke rakh")**: `mail-store.sql` (owner runs it) + `mail-sync.ts`: one
  kept Gmail connection per mailbox copies INBOX + Sent (30 days, then every new mail) into the database every
  30 s, bodies too; the Mail tab then reads only the database (list, mail, conversation by Gmail thread, reply).
  Before the SQL is run the old memory copy keeps working. Test with a scratch Postgres: `MAIL_STORE_PG=... node
  scripts/ai-tests/mail-store.js`.
- **Mail looks like Gmail (11 Oct)**: boxes To reply / Replied / Not customers (`mail-filters.ts bucketOf`), one line per
  conversation across the width, the conversation as cards, Reply at the bottom, Send opens the next mail to answer.
- **Mail, ekdam tich (11 Oct evening)**: `mail-outbox.sql` (owner runs it) + `mail-outbox.ts`: a reply is queued and sent in the
  background with SMTP timeouts (Sending… / Sent / Not sent · Try again in the conversation); the sync copies a just-arrived
  mail's body first and releases its lease (75 s) at the end; a live-read body is kept; the frame is as tall as the mail; a
  "Customer" card (order, items, place, payment, chat) stands next to the open mail (`/api/mail/customer`).
- **Mail: Unread fixed, no gap under the list, Active / Closed cases (11 Oct afternoon, "active case aur close case")**:
  marking read through PATCH now reads the whole Gmail thread (the row stayed bold) and the sync never undoes a click Gmail
  has not taken; the list card ends under its content; one case per customer per mailbox in `chat_settings`
  (`mail_case:<box>:<address>`, `mail-cases.ts`, `POST /api/mail/case`): Close case / Reopen case on the open mail, a closed
  customer leaves To reply and comes back to Active cases by himself when he writes again. No SQL file.
  **Cases close by themselves (11 Oct 12:45, live test: he replied and the customer stayed active; "Chat Support jaisa,
  apne aap")**: the rule runs on TIMES (`mail-filters.ts` `caseState`): Active = the customer's newest mail has no reply
  from us after it (`storeList`'s new `replied_at` -> `repliedAt` on the row; a reply from here counts at once; since
  13:02 a reply to the CUSTOMER in any Gmail thread counts, `to_addrs`, after Bhanu's two threads on kurtiya) and no
  Close case after it; Closed = we replied after it, or someone pressed Close case (for a mail that needs no reply);
  a customer who writes again is Active again; Reopen keeps it Active until we reply again or close again. The reader
  says "Case closed · replied <ago>" or "Case closed by <name> · <ago>"; Send from Active cases opens the next active
  customer. To reply / Replied / Not customers keep their own rule. Tests: `mail-store.js` 29/29 on PostgreSQL, 10 pure.
- **WhatsApp in Chat Support (2026-10-10, first test with Jatin)**: `src/lib/chat/whatsapp.ts` (Cloud API
  send text / template, webhook parse, signature), `whatsapp-inbound.ts` (a message to the business number
  = a chat `source 'whatsapp'`, `visitor_id 'wa:<digits>'`, With team, unread; wamid dedupe), route
  `GET/POST /api/whatsapp/webhook` (no login; GET = Meta's verify, POST signed with WHATSAPP_APP_SECRET when
  set), the staff reply route sends the text back (`wa_sent` / `wa_id` / `wa_error` on the message; the inbox
  shows the refusal, e.g. the 24-hour window). Chikki does NOT answer on WhatsApp. Env names in `.env.example`:
  WHATSAPP_CLOUD_TOKEN, WHATSAPP_PHONE_NUMBER_ID (=1335396902996145), WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET,
  WHATSAPP_API_BASE (default v25.0), WHATSAPP_PANEL_ID (default: the default panel). The owner's setup file
  (uploaded, CONFIDENTIAL) holds a permanent System User token that was shared in chat: he must rotate it;
  never commit or echo it. Test: `scripts/ai-tests/whatsapp.js` (in test:ai) + R68 in team-routing.js.
  **Templates (same day):** Settings > WhatsApp card (WABA id saved in chat_settings, templates list / new / delete,
  "Message a number" = first message by approved template, opens the chat); inbox "Template" button on a WhatsApp
  chat. Routes `/api/whatsapp/templates|settings|start`. Live test with the owner's own number 9289144767 worked
  (inbound showed in Open case as "Aaditya Aggarwal"). WABA id = 28873951022288651 (he types it in the card).
  **Profile (same day):** the card also shows the number's live state (name + review status, quality, limit),
  asks Meta for a display-name change, edits the business profile (about, description, address, email, websites,
  category) and the profile picture (needs the Meta App id 1427249435405269 typed in the card), and edits a
  template. Business hours are not in Meta's API. Owner typed the WABA id and made a template (awaiting approval).
  **Own tab (15:30):** admin tab "WhatsApp" (`src/components/whatsapp/*`): Setup checklist, Number & profile, Templates,
  Send, Activity, each with a WhatsApp-styled phone preview. The Settings card is gone. Live, the profile read
  answered "(#10) Application does not have permission": the System User token lacks rights -> Business
  Settings > System users > Assign assets (app + WABA, full control), new token with whatsapp_business_management,
  .env, deploy (= the token rotation). The screen explains this under the error.
  **Later same day:** token rotated by the owner (new System User token), WABA id corrected to 971683758658688 (the
  billing page's 28873951022288651 was a different asset); Setup > Check token (debug_token) says all fine: valid,
  all permissions, account + number readable and the number is in the account. Profile still answers (#10) while
  the display name "Shiptrack" is under Meta review (not our bug; retry after approval). No template exists on
  this account yet: the owner makes one (Templates tab), waits for Meta. New **Test** tab: send a text to a number
  and watch the conversation with ticks on a phone, live. Reply test within 24 h of the owner's own message works
  without a template. Screenshot of `.env` was shown once in chat: DB password, OpenRouter key, Gmail app password,
  Shopify secrets, admin password are exposed there; rotate them (OpenRouter key and Gmail app password first).

  **Order placed template + brands (evening):** presets `order_placed` (header, 4 values) and `order_tracking` (header,
  5 values) with "Each brand's own words" (per-panel brand name + support email, `chat_settings wa_brand:<panel>`).
  Creating a template on the WhatsApp account answered code 100/2388339 "WhatsApp accounts cannot be used with this
  API": Meta keeps templates on the MESSAGING account (28873951022288651), so Setup has a "Messaging account id"
  field and every template call uses it. `order_placed` is now PENDING at Meta.
  **Automation (owner: "har naye order par apne aap, on/off, kitne bheje kitne fail, 48 ghante baad tracking link"):**
  WhatsApp > Automation tab. Per panel ON / OFF (default OFF, ON needs an APPROVED `order_placed` and the table),
  ON starts the clock (only orders placed after it, within 24 h; Shopify and CSV alike, no Shopify code touched).
  Worker `whatsapp-auto.ts` rides on the minute cron (`chat-email-poll` route, no new crontab line); rows in
  `wa_auto_sends` (**`whatsapp-automation.sql`, waits for the owner's yes**), tracking link 48 h later only in office
  hours, retries for hiccups, delivery reports by wamid. Open: the owner makes + gets `order_tracking` approved (button
  "Tracking link template"), runs the SQL (his yes), switches one panel ON. Webhook signature (WHATSAPP_APP_SECRET)
  still not set (red line in Setup): after the automation, one step at a time.
  **Evening state:** SQL run, both templates APPROVED, WHATSAPP_APP_SECRET set (webhook checked), VASTRIKA and kurtiya
  ON, vastora OFF (its checkout recharge ran out). The number is ShipTrack's for every brand, NOT a help line (owner,
  after a team member replied "Dear Customer ... Team Vastrika"): a customer's message gets one fixed reply per chat
  per 24 h, "this number only sends order updates, for help email <brand email>" (`whatsapp-autoreply.ts`). The
  Automation tab's list is brand-wise: Brand row + one line per order with both messages, filters and search.
  Date filter (11 Oct, "aaj ke kitne gaye, raat ko kyun"): Today / Yesterday / 7 days / a date (India days); a
  "What happened" card (orders came in vs messaged, failed / skipped with reasons, why some orders got nothing), messages
  per hour with night shaded, Night / Office hours chips. Order-placed goes when the order comes in (night order = night
  message, by design); tracking links only in office hours.
  A customer who writes STOP (or "band karo") gets no more automatic messages (`whatsapp-stop.ts`, START undoes it).
  The Today board shows the number's health to the Super Admin: Meta quality, customers messaged in 24 h vs the
  daily limit, failed today, wrote STOP; plus a morning-routine step. The real limit is 2,000 a day (WhatsApp Manager
  > Overview > Limits; Meta keeps it on the portfolio, so the owner types it once in WhatsApp > Setup).
- **Manager plan (2026-10-10, 8 PRs, plan approved; Sunny = Manager, owns every chargeback):** done so far:
  1 permissions `team.lead` / `refunds.manage` / `chargebacks.view` (manager preset; reveal stays Super Admin's);
  2 a member sees only their own + unheld chats, "Team chats", "Send to Manager" (mark + chat to him);
  3 auto-assign every minute to members on duty (`auto-assign.ts`); 4 no reply in 30 min = the Manager's + red bar
  (`escalate-late.ts`); 5 the Manager panel in Chat Support: "Manager" group first (Open cases `?lead=open`, Refund,
  Ship again, Team live, links to Chargebacks / Team score), the Manager opens on Open cases; Team live =
  `GET /api/chat/team/live` (`team-live.ts`: per member replies per half hour, on duty, held / waiting, 30-min
  misses; Chikki's row); 6 the open chat loads fast (`thread-sync.ts`: newest 200 + "Load older", the 3-second
  poll asks only `?after=` what changed, a full load every 30 s); `chat-speed.sql` (one index, CONCURRENTLY, without
  -1) was run by him (valid = t); 7 "All panels" setup (Settings > All panels setup: Make from vastora, then switch
  each panel to All panels; `{brand}` = each panel's name; storage in chat_settings + site_faqs `site_id '*'`, no SQL),
  plus the brand fix: the locked rules said "Karry from the Vastora team" on EVERY panel; now each panel's own name.
  Live AI test 51/51; made from vastora (5 names -> {brand}, 43 answers); all three panels switched to All panels
  (kurtiya checked live: "Karry from the Kurtiya team"). 8 Chikki's record: `scripts/chikki-review.js` (read only,
  masked) -> he pastes the output -> fixes one at a time. First run done (10 Oct): fixed address-echo eating order
  numbers / dates, the "wait till 7-8 PM" promise, replies to Gmail bounces. Waiting on the owner: Buy 1 Get 1 /
  pack-of-N answer, "is this site fake?" answer for visitors, vastora WhatsApp automation ON (customers say they never
  got an order ID). Second run: all "took longer" = OpenRouter credits / monthly key limit (6 days). Owner answers:
  status first, then the weekend note (done); "site genuine?" = a saved answer he adds; BOGO and automation later.
- **Same night:** AI down -> visitors get "Thanks for writing to <brand>! share order ID + phone" (no "took longer");
  Mail conversation has its own Gmail connection + a server copy (it kept spinning); AI credit meter on Today +
  WhatsApp alert (`ai-credit.ts`): the owner must (1) make the "ShipTrack alert template" in WhatsApp > Templates and
  wait for Meta, (2) type his number in WhatsApp > Setup "Your WhatsApp number for ShipTrack alerts", (3) still turn
  on OpenRouter Auto top-up / raise the key's monthly limit.
- **Chargeback Shield, step 1 (2026-10-10 night, owner: "chargeback bilkul rok paaye ... fake site / fake link / time
  zyada ... critical wale Sunny ke paas, Super Admin ko bhi pata chale"):** `src/lib/chargeback/risk-rules.ts` (pure
  score per PREPAID order from the customer's chat + email + WhatsApp: chargeback / legal threat, store called fake,
  fake / stuck link, Delivered-not-received, days late, refund asks, repeat asks, waiting for us, health, channels,
  charged back before; minus solved / reshipped / delivered; ONE next step), `risk.ts` (loader, 2 min cache; the
  chargeback mail -> order by email / phone when it names no order number, also in `poll.ts` for new mails; the
  study), `GET /api/chargebacks/risk[?view=study]`, Chargebacks tab = "Chargeback Shield" with Stop them / Chargebacks
  / Study (`src/components/chargeback/*`). Rulebook 9.15. **Step 2 done (`risk-escalate.ts`, rulebook 9.16):** Critical -> the chat goes
  to the Manager by itself (office hours, once in 7 days), red bar for the team, ONE WhatsApp per Critical order to the
  owner's alert number + up to 5 more numbers (WhatsApp > Setup; a WhatsApp group is not possible: Meta allows groups
  only for green-tick accounts), Today "Chargeback risk" box + routine step. Owner must: type his number and Sunny's in
  WhatsApp > Setup, have `shiptrack_alert` approved, send the Study screenshot (weights still untuned).
- **11 Oct (night):** Study showed 3 real chargebacks (VASTRIKA PayU x2, vastora Easebuzz), all "Order not found": the
  mails carry no order number / customer email / phone of ours. Added "Link order" on an alert (Super Admin / Manager)
  + what the mail mentions in Study. Owner ticked Sunny's 3 permissions. AI down + visitor typed order ID + phone: the
  code verifies it itself (`ai-down-check.ts`, rulebook 1.8).
- **11 Oct morning:** owner: Mail "Conversation" still spinning on every panel (his tab was also old: Cmd+Shift+R).
  Conversation now built from the list (their mails, instant) + the server's Sent read behind it; Gmail errors logged as
  `[mail-error]` / `[mail-timing] thread`. Owner also: "mail ka UI/UX bahut bura, kuch samajh nahi aata" -> redesign
  proposed (chat-style conversation, Reply needed / Replied / Not customers), waiting for his yes.
- **11 Oct 13:10, WhatsApp out of Chat Support** (owner: "hamara WhatsApp no-reply identity hai; saari WhatsApp chats
  Chat Support se nikaal ke WhatsApp tab mein daal do; abhi mujhe bhi confusion hai, ladke kaise chalayenge"): a
  `source = 'whatsapp'` chat lives ONLY in WhatsApp > Chats. `waiting-sql.ts` `NOT_WHATSAPP_SQL` is in the inbox list /
  search / every count, `/api/chat/pending`, the Today board chat numbers, auto-assign, the 30-minute move + red bar, Team
  live, the chargeback-risk move (`risk.ts` prefers a chat-box / email chat as "the chat") and the team score's Q1.
  Opening by id and the reply route unchanged (the tab's reply box still sends). "Open in Chat Support" button removed;
  Send / Activity "Open the chat" now opens it inside the WhatsApp tab. Rulebook 7.16, AGENTS.md WhatsApp row.

- **11 Oct 13:10, "Team ka Verify button":** Chat Support > open chat > "What to do next" > Verify (website + email
  chats, never WhatsApp): the team types Order ID + full phone, `POST /api/chat/conversations/[id]/verify`,
  `src/lib/chat/team-verify.ts` + `team-verify-rules.ts`, `verified_via = 'team'` ("by team" badge, Remove for a
  wrong click, `chat_events` kind `verify`). Not strict proof (no automatic Refund promise), like the Mail
  tab's check. Rulebook 2.11; `team-routing.js` R73. No SQL.

- **11 Oct, "Correction" (approved plan):** a team member presses Correction on a VERIFIED chat (website / email, never
  WhatsApp) or a verified sender's mail; the row (kinds + note) shows in Chat Support > **Corrections** for everyone
  (pending oldest first, red after 24 h; a chip on the row, a line at the top of the chat, a Today line + routine step);
  only the Super Admin / Manager mark it done / cancelled / reopened and change the order (Edit address / items from
  the row = the chat header's editors). Unverified chat: "Verify first" with Verify now or a ready "please verify"
  line for the reply box (EN / Hinglish). `src/lib/chat/corrections*.ts`, `/api/corrections`, `CorrectionDialog.tsx`,
  `CorrectionsPanel.tsx`. **`order-corrections.sql` waits for his yes** (until then: 503 "not installed", nothing breaks).
  Tests: `corrections.js` 9 groups. Rulebook 7.17.

- **14 Oct, email never answers by itself in draft mode**: a verified customer's cancel / refund / fraud / payment mail used to
  get Chikki's fixed hand-over reply (branded blue box) even with drafts ON (master rules 16 / 17). Owner: "email ka lia
  humna ai nai lagaya". Now draft mode sends NOTHING by itself (`email-draft.ts emailReplyHeld`); the switch OFF behaves as
  before. Bounce mails in the Mail tab say "not delivered to X, why" (no Verify / Notes / reply); Chat Support's "Also
  send by Gmail" adds "Regards, <brand> Support" only when the text has no sign-off.

- **14 Oct, no-subject mails**: our reply went out as "Re: Your enquiry", so Gmail kept it in a separate conversation
  (customer's mail looked unanswered in Gmail). Now "Re:" alone (`replySubject`, `reply-mail.ts`). Old replies stay where
  they are (Sent, "Re: Your enquiry").

- **14 Oct, review sweep (3 reviewers)**: fixed `unwrapReply` cutting real "Thank you for ..." sentences (sign-off only on
  its own line / after a sentence end, never "thanks for/to ..."); old cached drafts double-wrapped; Sudharo with the tick
  OFF keeps the member's greeting / sign-off; `useBrandPanel` reads the session flag once; the inbox keeps an `?open=` chat;
  a Manager cannot be a brand manager; deleted notes not counted; chargeback poller retries a mail whose alert failed (5
  tries) instead of skipping it; `ensureMailCaseChat` never re-points a chat verified for another order + advisory lock;
  a shared chargeback box uses the newest App Password; the test alert reports partial failures; a Meta template-list
  hiccup uses the last approved template.

- **14 Oct, Mail review**: the conversation, Suggestions context, verified-address mails and the first copy read the
  same 60 days as the list (`STORE_LIST_DAYS`); `endsWithSignOff` reads only the end (last line, or a name under a bare
  "Regards,"); paste from Word / Excel stays text; a file dropped outside the reply card never leaves the page; a send our
  90 s cap cut is failed with "may still have been sent" (never re-sent by itself); a verified sender is never a bounce.
  Not changed: `storeList`'s reply lookup over 60 days (EXPLAIN on the VPS if the list gets slow).

- **14 Oct, phone edit**: the Edit address dialog (chat header, Corrections, Mail customer card) also changes the
  customer's phone (`orders.customer_mobile`, logged in `order_address_changes`). **`order-phone-edit.sql` RUN by the owner
  14 Oct** (CREATE FUNCTION / DROP TRIGGER / CREATE TRIGGER): a CSV re-upload keeps the team's phone.
  Owner then: the customer verifies with the NEW number and the screens show **NC** next to the tick (`number-changed.ts`).

- **14 Oct, live log check (owner pasted `pm2 logs`)**: (1) merging a customer's duplicate chats ALWAYS failed
  ("permission denied for table message_revisions": tracker_user has SELECT + INSERT only), now a savepoint skips that
  copy column (`merge-chats.ts`); (2) the shared chargeback Gmail's Mail-tab box failed "Invalid credentials" every
  minute: the poller now gives every row of the group the App Password Gmail accepted (`poll.ts` signIn); (3) bursts
  of "Connection terminated due to connection timeout": pool wait 3 s -> 10 s (`db.ts`); (4) "Failed to find Server
  Action" = bots, harmless. DB check same day: corrections installed, Sunny = manager, all 3 panels on the common
  setup, NO brand managers set yet, draft-only ON on every panel.

- **14 Oct, chargeback causes (owner's answers)**: NO proactive late-order message to customers ("sara customer fall
  jaenga"); courier real scans: later. Built: promises waiting 2+ days (Refund form not sent / refund request not
  decided or paid / Ship again not sent) on the Today board, a red bar for the Super Admin + Manager in Chat Support and
  one WhatsApp a working day at 10:30 to the alert numbers (`src/lib/refund/stuck*.ts`). Next: bounce -> back to To reply.
- **14 Oct, bounces (VASTRIKA: Gmail's own "appears suspicious and wasn't delivered")**: Gmail puts its bounce report
  inside the customer's conversation, so the Mail list showed the bounce as the row (Not customers) and the customer,
  closed by our undelivered reply, vanished from To reply. Fixed: the row is the newest non-bounce mail, a bounce after
  our last reply puts the customer back to To reply / Active with the reason ("Reply not delivered"), a warning on top
  when Gmail stopped our mails today. Gmail gives no exact reason for "suspicious"; told the owner: no resending the same
  text, short replies without links, and checked how many mails each Gmail sends a day (query given).
- **14 Oct, Gmail sending pace**: the live count showed VASTRIKA's support Gmail at ~30 mails a day until 10 Oct and
  136-173 a day from 11 Oct (the Mail tab outbox), the other support Gmail up to 100. Owner: a Workspace per brand is not
  worth it (a brand runs 20-25 days, about 3,000 mails), "gap wala bana de, 1 minute mein 3-4": the outbox now sends at
  most 4 mails a minute per Gmail, 15 s apart, across both processes. Advice given: reuse an older Gmail for a new
  brand instead of a fresh one each time; short replies, no repeated text to a bounced customer.
- **15 Oct, inbox full**: a VASTRIKA customer's Gmail was out of storage (452 4.2.2) and the team re-sent the reply
  several times. Now the reply box asks before sending to a customer whose mails came back for a reason resending cannot
  fix (full / no such address / Gmail's suspicious block / daily limit), and says how many came back.
- **15 Oct, WhatsApp 130429**: Meta answered "Rate limit hit" for the ShipTrack number: 59 order messages Failed and
  the VASTRIKA chargeback alert never arrived. Built: ONE message per order once the owner's new template
  `order_placed_link` (order placed + tracking link) is approved by Meta; 2 messages a minute for the whole install;
  a 130429 pauses the number 15 min and the messages / alerts wait and go again by themselves; the 59 failed ones go
  back in line. OWNER TO DO: WhatsApp > Templates > "Order placed + tracking link (one message)" > send to Meta.
- **15 Oct, chargeback reminders + PayGlocal on vastora**: a gateway's reminders of one dispute are now ONE card
  ("N mails", one Mark done for all) and the tab says "N chargebacks pending" (badge and Today board count cases too).
  A PayGlocal mail showed on vastora (Easebuzz) because it came into vastora's OWN chargeback Gmail:
  some PayGlocal account has that Gmail as its dispute email. Now flagged "PayGlocal not on this panel" with Move to
  kurtiya (the panel that ticks PayGlocal). OWNER TO CHECK: which brand that PayGlocal merchant / MID is.

## Open with the owner (needs his clicks; I act on the screenshot)

1. VASTRIKA > Settings > Copy setup > Copy from vastora > Preview → he sends the lines, I check,
   then Copy now. Same for kurtiya.
2. (Done 14 Oct) the shared chargeback Gmail reads fine on VASTRIKA ("Working"), kurtiya uses the same one; gateways
   ticked VASTRIKA = PayU only, kurtiya = PayGlocal only.
4. VASTRIKA: connect its customer-support Gmail (it has none; the audit showed 1 / 0 / 1).
5. WhatsApp test with Jatin (number +91 87964 14056): the owner adds WHATSAPP_CLOUD_TOKEN,
   WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN (and WHATSAPP_APP_SECRET) to `/etc/tracker/.env`,
   deploys (env-only change still needs a deploy), sets the Callback URL
   `https://shiptrack.store/api/whatsapp/webhook` + the verify token in Meta App Dashboard > WhatsApp >
   Configuration, subscribes to `messages`, switches the app to Live, then Jatin texts the number and
   the chat shows in Chat Support > With team > Open case; the team replies from the inbox (within 24 h
   of his message). Afterwards rotate the token. Also: confirm the stray `KEY` repo secret was deleted.
6. A Manager login for Sunny: Team > Add member, role Manager, pick the panels; the password is
   shown once (Copy all / WhatsApp). I cannot create it from here (no database access).
7. Run `order-corrections.sql` (one line: `cd /var/www/tracker && git pull origin main && sudo -u postgres psql -d tracking_crm -v ON_ERROR_STOP=1 -f order-corrections.sql`)
   so the Correction button and the Corrections section work (additive, no deletes).

## Gotchas that cost time before

- ImapFlow errors say only "Command failed": read `responseText` / `code` /
  `authenticationFailed` (`mailErrorText` in `src/lib/chat/mailbox-status.ts`).
- `tracker_user` needs explicit GRANTs: a new table without them fails silently in the app.
- `chat_settings` GRANT was missing once (2026-10-08): run `chat-settings.sql` again if a setting
  "does not save".
- Order numbers repeat across panels and are stored WITH a leading `#`; `order_items` is keyed by
  order number only (known, not fixed).
- Team member replies and the suggest / polish routes accept `source` 'chat' or 'email'.
- OpenRouter credits / the key's monthly limit ran out once (2026-10-10 night): every model 402 for 3 h, every
  visitor got the "took longer than expected" line. The Today board now shows a red banner; the owner
  recharges at openrouter.ai (Credits + the key's monthly limit).
- The GitHub Actions secret must be the WHOLE private key (7 lines with BEGIN / END); the owner
  copies it with `pbcopy`, never by selecting in Terminal.
