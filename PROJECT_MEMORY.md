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
- Everything applies to ALL panels; never panel-specific code, never "tested on vastora only".
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
  -1) waits for his yes. Next: 7 one "All panels" setup, 8 Chikki's record and fixes with him.

## Open with the owner (needs his clicks; I act on the screenshot)

1. VASTRIKA > Settings > Copy setup > Copy from vastora > Preview → he sends the lines, I check,
   then Copy now. Same for kurtiya.
2. VASTRIKA > Gmail accounts: the chargeback Gmail showed "cannot be read"; the real reason is now
   displayed (likely a dead App Password → Disconnect + reconnect). Waiting for the screenshot.
3. kurtiya: connect the SAME chargeback Gmail; tick gateways (VASTRIKA = PayU, kurtiya = PayGlocal).
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
