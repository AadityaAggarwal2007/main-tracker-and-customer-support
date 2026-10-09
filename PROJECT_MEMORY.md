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
- **Panel board** (Orders tab top, `src/lib/panel-board.ts`): one card per panel, what to do today.

## Open with the owner (needs his clicks; I act on the screenshot)

1. VASTRIKA > Settings > Copy setup > Copy from vastora > Preview → he sends the lines, I check,
   then Copy now. Same for kurtiya.
2. VASTRIKA > Gmail accounts: the chargeback Gmail showed "cannot be read"; the real reason is now
   displayed (likely a dead App Password → Disconnect + reconnect). Waiting for the screenshot.
3. kurtiya: connect the SAME chargeback Gmail; tick gateways (VASTRIKA = PayU, kurtiya = PayGlocal).
4. VASTRIKA: connect its customer-support Gmail (it has none; the audit showed 1 / 0 / 1).
5. Optional: WhatsApp Cloud API env vars for chargeback alerts; confirm the stray `KEY` repo
   secret was deleted (last screenshot showed only the 3 needed).
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
- The GitHub Actions secret must be the WHOLE private key (7 lines with BEGIN / END); the owner
  copies it with `pbcopy`, never by selecting in Terminal.
