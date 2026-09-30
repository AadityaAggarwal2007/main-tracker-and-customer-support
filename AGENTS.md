# ShipTrack — order tracking + customer chat support

Read this whole file before changing anything. It is the rulebook for any AI
(Claude Code, Codex, Cursor) working in this repo.

## What this is

One Next.js 14 app (App Router, `next@14.2.x` — not a newer Next.js) that runs
in production on a single Hostinger VPS:

- Live at `https://shiptrack.store`
- Code on the VPS: `/var/www/tracker`, run by PM2 as the app `tracker`, port 3000
- Secrets on the VPS: `/etc/tracker/.env` (copied to `.env.production.local` on every deploy)
- Database: PostgreSQL on the same VPS, reached through plain `pg` (`src/lib/db.ts`).
  There is no ORM and no Supabase client — the `supabase-*.sql` names are historical.

Chat support used to be a separate app (`support.shiptrack.store`, repo
`chat-support`). On 2026-09-19 it was moved into this app; see commit
"Bring chat support into ShipTrack" for the full story. Do not edit the old repo.

## Map of the code

| Area | Where |
|---|---|
| Admin panel (panels, CSV upload, Shopify connect, progression, team, panel settings) | `src/app/admin/page.tsx` (one large file) |
| Customer tracking page | `src/app/track/`, `src/app/track/[token]/`, `src/lib/journey.ts`, `src/components/JourneyView.tsx` |
| Chat inbox for staff | `src/app/admin/chat/page.tsx`, `src/app/api/chat/*` |
| Chat widget on merchants' storefronts | `public/widget.js`, `src/app/api/widget/*`, `src/lib/chat/widget-api.ts` |
| Files agents attach to replies | `src/lib/chat/attachment-rules.ts` (types + limits), `src/app/api/chat/attachments/*` (upload/remove), `src/app/api/widget/files/[id]` (serves sent files), table `chat_attachments` (`chat-attachments.sql`) |
| Editing/deleting sent messages (⋯ menu in the inbox) | `src/lib/chat/message-rules.ts` (who may change what), `src/app/api/chat/messages/[id]` (details, edit, soft delete), `messages.edited_*`/`deleted_*` + table `message_revisions` (`chat-message-edits.sql`). A deleted message must stay out of the widget, the AI history and the conversation list. |
| AI replies (model chain, tools, base prompt) | `src/lib/chat/ai.ts` — `DEFAULT_SYSTEM_PROMPT`, `buildSystemPrompt`, `FALLBACK_CHAIN` |
| Order lookup used by the AI | `src/lib/chat/orders.ts`; `src/lib/chat/lookup-guard.ts` forces the lookup once ID + last 4 are typed, and hands over (H1–H6 in `getAIResponse`) when the bot keeps asking; a panel's own prompt gets `PANEL_LOOKUP_RULES` appended |
| Verified chats (widget "Verify yourself" form, Visitors/Customers in the inbox) | `src/app/api/widget/verify` (order ID + full phone via `verifyOrderByPhone`, only within the site's panel; failures limited per visitor, per IP from `clientIp` = nginx's X-Real-IP, per order and per phone), `conversations.verified_order_id`/`verified_at`/`verified_via` (`chat-verified.sql`), also set by a found `lookup_order`. `ai.ts` keeps the verified order in view (`lookupVerifiedOrder`, never stored) and H4 in `getAIResponse` stops it asking for the order ID/last 4 again unless the customer brings up another order (`mentionsAnotherOrder`, `reasksForOrderDetails`). `/api/widget/resume` clears the verification when a chat is picked up on another device (a phone number alone is not order ID + last 4). `verified_via = 'legacy'` (`chat-verified-legacy.sql`: old chats whose order the pre-2026-09-24 phone/email lookup found) moves the chat out of Visitors with an amber "Old check" badge, and since 2026-09-30 `getAIResponse` treats it as verified for that chat like 'form'/'chat' (owner's rule: never ask a verified customer again; /api/widget/resume still clears it on another browser); a real proof replaces it. `getAIResponse` also swaps any found lookup in the history window that was not proof (`isProvenLookup`, `UNPROVEN_LOOKUP`) for a needs-verification answer. `/api/chat/conversations?segment=visitors\|customers`. |
| One chat per verified customer | `conversations.customer_key` (`chat-customer-key.sql`) = last 10 digits of the verified order's phone, widget chats only; set by `/api/widget/verify` and by a found `lookup_order` in `ai.ts` (`customerKeyForOrderSql` in `orders.ts`); `/api/widget/resume` clears it with the verification. The form (order + FULL phone) carries on the customer's latest chat on that site only when that chat was also `'form'`-verified for the SAME order (moves it to this `visitor_id`, reopens it if Closed): widget routes trust the stored conversation id, so every device that held a chat keeps reading it, and it must have proved the same thing. Otherwise the device gets its own chat with the key. `/api/chat/conversations` shows each (site_id, customer_key) as ONE row (latest chat among the filtered rows, grouped in SQL before the LIMIT; adds `thread_count`, `group_unread`, `group_needs_human`), `/api/chat/pending` counts it once, and `/api/chat/conversations/[id]` adds `earlier` (up to 5 chats of that customer active before this one, 200 messages each; unread cleared only on those), `earlier_total` and `newer_chat` (a chat active after this one: named, never drawn as earlier; the inbox offers "Open newer chat"). Staff actions still work on one conversation id. |
| Chat subject line (customer's current concern, top of the thread + list row) | `src/lib/chat/subject.ts` (`SUBJECT_LABELS`, `updateConversationSubject`: one small model call, no tools, on the last 12 visible messages; label + one line of at most 90 chars with no phone/email/address/link; skips when no customer message is newer than the last subject; one run per chat at a time; never throws). Fired without awaiting by `/api/widget/message` after the reply is saved and by `email.ts` after an inbound email is stored. Columns `conversations.subject_label`/`subject_summary`/`subject_updated_at` (`chat-subject.sql`), returned by `/api/chat/conversations` and `/api/chat/conversations/[id]`; `category` is unchanged and stays the inbox's fallback. |
| Inbox search (name, phone, order ID / tracking ID, message text) | `src/lib/chat/inbox-search.ts` builds the SQL for `GET /api/chat/conversations?q=` (2+ characters): searches ALL chats of the panels the caller may see (status/segment/category ignored, so Closed chats and visitors are found), scanning `messages` once (`msg_hits` CTE: a separate EXISTS per match kind was ~2 s, this is ~100 ms for 40k messages). Matches the customer name, the name/order ID/tracking ID inside stored lookup results, the verified order, a phone of 6+ digits, visible message text and the subject; adds `hit_order/phone/name/text` and `match_snippet`, best matches (an order) first, still one row per customer. The inbox box (`page.tsx`) waits 300 ms after typing, highlights matches in the list and the thread and scrolls to the newest one, and does not re-run the search on the 3 s poll. |
| Customer health (frustration %, chargeback risk) | `conversations.health_score`/`health_reason`/`health_signals`/`health_updated_at` (`chat-health.sql`), set by `updateConversationHealth` in `src/lib/chat/health.ts` (fired, not awaited, by `/api/widget/message` and `email.ts` after each customer message, like the subject line): one small model call (no tools, reasoning off) reads the customer's last 40 messages across ALL their chats on the site (`customer_key`) plus their verified order's age/status, and the counts in `src/lib/chat/health-rules.ts` (pure, no imports, also used by the inbox and the backfill script: swearing, threats, fraud accusations, refund demands, shouting, repeats, chats, days waiting) are blended in (`combineHealth`: the model leads, the counts pull it up, a threat in the last 3 messages floors it at 85, swearing in the last 2 at 70; if the model is down the counts stand). Levels: Calm 0-24, Uneasy 25-49, Frustrated 50-74, Critical 75+. `/api/chat/conversations` returns `health_score`/`health_reason`/`health_pinned` and lists every OPEN chat scoring `HEALTH_PIN_MIN` (65) or more first, highest first, until it is Closed; on a grouped row it is the latest chat's own status and score that count, so closing what the row opens clears it (a search keeps its own order). The inbox shows a % pill on the row and a Frustration bar in the thread header. Add swear/threat words to the lists in `health-rules.ts`. |
| Problem-type tabs (At risk, Refund / Cancellation, Wrong tracking link, Order delay, Address change, Damaged / Wrong item, Exchange / Return) | `src/lib/chat/inbox-topics.ts` (pure; shared by server and inbox) maps subject labels to tabs. `GET /api/chat/conversations?topic=<key>` lists the OPEN chats of one problem (`risk` = open chats scoring `HEALTH_PIN_MIN`+, whatever the subject; a search ignores tabs) and every answer carries `topic_counts` (open customers per tab, one per grouped row, in the caller's panel scope, whatever tab is open) plus per-row `health_threat` / `health_accuse` ("Threat" / "Fraud claim" tags). Refund and Cancellation are ONE subject label since 2026-09-30 (`Refund / Cancellation`); old rows still say `Refund` / `Cancellation` and `displaySubjectLabel` shows and files them as the merged one. A chat changes tab by itself when its subject changes. |
| COD only in some states | `sites.cod_states` (`chat-cod-states.sql`, e.g. `Gujarat`), set in Panel Settings > Cash on Delivery > "Only in some states" (`/api/panel-chat`, cleaned by `cleanCodStates` in `src/lib/chat/cod.ts` so it can only be state names). When set it replaces the yes/no COD sentence: `codStatesPrompt` tells the agent COD works ONLY for addresses in those states, to bring COD up only when the customer asks, in one plain line with no "not available", to say COD is available to a customer who says they are in one of them, and never to offer to place orders. Once an agent reply in the chat has mentioned COD, `getAIResponse` appends `codAlreadyToldNote` so an insisting customer gets a short, different answer (COD shows at checkout only for those states) instead of the same sentence again. `cod_available` is unused while `cod_states` is set. |
| "Waiting for a reply" timer | `src/lib/chat/waiting.ts` (shared) and the list route: `waiting_since` = when the customer's last visible message was written, if the chat is open and nobody has answered it (or the chat is in Needs you and no team member wrote after it; the AI's "the team will reply" does not count, nor a held-back AI draft that was never sent), and that message is not just "ok" / "thanks" (`NO_REPLY_NEEDED_REGEX`). `waiting_overdue` = 2 hours or more (`WAITING_OVERDUE_HOURS`). The inbox shows a "Waiting 3h 20m" chip on the row and in the thread header (grey under 1 h, amber to 2 h, red from 2 h) and tints overdue rows. The list order (`orderBy` in the route): frustrated AND overdue first, then overdue (longest waiting first), then frustrated (highest score first), then the rest by activity; a search keeps its own order. Computed at query time, nothing stored. |
| Phone match (a visitor whose number is a customer's) | `conversations.phone_match_order_id`/`phone_matched_at` (`chat-phone-match.sql`, includes the backfill), set by `detectPhoneMatch` in `src/lib/chat/phone-match.ts` (fired, not awaited, by `/api/widget/message`, `/api/widget/save-phone` and `email.ts`): the 10-digit numbers (6-9 first, standing alone, +91/0/spaces/dashes allowed) in the visitor's messages, plus a saved `visitor_phone`, are looked up in the orders of THIS chat's panel; the newest match is kept. **A staff hint only, never verification:** it never touches `verified_order_id`, is never read by `ai.ts` / `lookup-guard.ts` / `orders.ts`, never appears in a widget response and never reaches the model, because anyone can type someone else's number (the 2026-09-11 incident); the AI still needs order ID + last 4 or the widget form. The inbox's KNOWN customers (`KNOWN_CUSTOMER` in the list route) are verified OR phone-matched: `segment=customers`, the All tab and every problem tab list only them, `segment=visitors` the rest; a phone-matched chat carries a blue "Phone match · #order" tag instead of the green Verified one. The problem tabs also include "Fraud / Threat" (`fraud`: health signals accuse or threat > 0). |
| Order line in the thread header (placed on / where it is now / estimated delivery) | `src/lib/chat/order-facts.ts` (`loadOrderFacts`), returned as `order_facts` by `GET /api/chat/conversations/[id]` (behind login + panel scope) and drawn by `OrderLine` in `src/app/admin/chat/page.tsx` next to the customer's name. Uses the chat's `verified_order_id`, else its `phone_match_order_id`, inside the chat's own panel (exactly one matching order, else no line). The status is what the customer's tracking page shows (`buildJourney` in `journey.ts`: stored status moved forward by the order's age; "Order Cancelled" etc.), the date is the order's `estimated_delivery` or the day-13 end of the window; a delivered, cancelled or returning order shows no delivery date. **Staff only:** never read by `ai.ts`, never in a `/api/widget/*` response. Nothing is stored; no SQL file. |
| Reopen on return | `/api/widget/message`: a visitor message in a Closed (`resolved`) widget chat sets it back to `ai_handling` before the AI is asked, so the AI answers (`human_needed` when the site's AI is off). `human_needed` and `agent_handling` are never changed. |
| Email support (IMAP poll, threading, held drafts) | `src/lib/chat/email.ts`, `src/app/api/cron/chat-email-poll` |
| Order status emails | `src/lib/smtp-client.ts`, `src/lib/email-templates.ts`, `src/app/api/cron/*` |
| Shopify OAuth + webhooks | `src/app/api/shopify/*` |
| Login, roles, panel scoping | `src/lib/auth.ts` |
| DB schema history | root `*.sql` files, plus `chat-tables.sql` for the chat tables |
| VPS setup + deploy scripts | `vps-setup/` |

## Rules that protect live customers

1. **The widget API is public and live.** `public/widget.js` and `/api/widget/*` are
   called from real Shopify storefronts. Never rename a route, change a response
   shape, or drop the CORS headers/OPTIONS handlers.
2. **Order lookup privacy.** The AI may only reveal an order after order ID + last 4
   digits of the phone match (`src/lib/chat/orders.ts`). This came out of a real
   privacy incident on 2026-09-11. Never loosen it.
3. **Panel scoping.** Every `/api/chat/*` and panel route must filter by the caller's
   `businessIds` from `getAuthFromRequest`. A `viewer` must not be able to change data.
4. **Prompts live in two places.** The base persona (Karry, for Vastora) is
   `DEFAULT_SYSTEM_PROMPT` in `src/lib/chat/ai.ts` and is in Git. Each panel's own
   prompt (`sites.system_prompt`), Saved Answers (`site_faqs`) and COD setting
   (`sites.cod_available`) are in the database and edited from Panel Settings —
   they are not in Git. Keep prompt edits small; the prompt size drives the AI bill.
5. **No destructive SQL**, ever, without the owner saying so in plain words.
   Schema changes are additive (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`).

## Secrets — never in Git

- Real values live only in `/etc/tracker/.env` on the VPS and in your own
  untracked `.env.local`. `.gitignore` blocks every `.env*` file except `.env.example`.
- `.env.example` lists every variable the code reads, with placeholder values.
  If you add a `process.env.X`, add `X=` to `.env.example` in the same commit.
- Never paste a real key, password, token, webhook secret or customer data
  (names, phones, addresses, order exports) into code, commits, SQL files or chat.
- Before every commit, check the diff for secrets: `git diff --cached`.

## The fix loop

1. `git pull origin main` — always start from the latest code.
2. Find the cause before changing code. Make the smallest fix that solves it.
   If the cause is only visible on the live server (errors, cron runs, data),
   look there with the read-only commands in "Working on the VPS".
3. Check it:
   - `npx tsc --noEmit` — the repo already has **20 type errors** (in
     `admin/page.tsx`, `api/businesses`, `api/resync`, `api/upload`, `csv-cleaner.ts`).
     `next.config.js` skips type and lint errors during build, so the build will
     not catch new ones. Do not add any: the count must not go up.
   - `npm run build` must succeed.
   - Run it (`npm run dev`) and try the change if a local database is available.
4. Commit with a message that says what changed for the user and why, then
   `git push origin main`.
5. Deploy it to the VPS as described in "Working on the VPS": ask the developer
   first, run it, check the app came back, and report in plain words.

**To undo a bad deploy:** `git revert <sha>`, push, and deploy again.
Do not force-push `main`.

## Working on the VPS

The developer's machine reaches the server over SSH as the alias `shiptrack-vps`
(set in his `~/.ssh/config`). The server's address is never written in this
repo, because the repo is public. Test access with:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=5 shiptrack-vps true
```

If that fails, the connection is not set up yet. Ask the developer to run this
**in his own Terminal, not through you**, and type the VPS IP and root password
when it asks (once only):

```bash
bash vps-setup/connect.sh
```

Never ask for the root password, and never use one pasted into the chat. If
one is pasted, tell him to change it, because the chat history keeps it.
Do not try other ways in; until SSH works, give him commands to paste into the
Hostinger web console and ask for the output.

The same server also runs other apps (Add ERP, the old chat-support server) and
a shared PostgreSQL. Touch only `/var/www/tracker`, the `tracker` PM2 app, the
tracker lines of the crontab, and the `tracking_crm` database.

### Look freely — read-only, no need to ask

```bash
ssh shiptrack-vps 'pm2 ls'                                          # app up? restarts?
ssh shiptrack-vps 'pm2 logs tracker --lines 100 --nostream'         # recent output + errors
ssh shiptrack-vps 'tail -n 100 /var/log/tracker-err.log'            # older errors
ssh shiptrack-vps 'tail -n 50 /var/log/tracker-cron.log'            # cron runs
ssh shiptrack-vps 'crontab -l'                                      # which crons exist
ssh shiptrack-vps 'cd /var/www/tracker && git log -1 --oneline && git status -sb'  # what code is live
ssh shiptrack-vps "grep -o '^[A-Z_]*=' /etc/tracker/.env"           # env var NAMES only
ssh shiptrack-vps "sudo -u postgres psql -d tracking_crm -c 'SELECT ... LIMIT 20'" # SELECT only
```

Select only the columns you need. Do not pull customer names, phones or
addresses into the chat unless the bug is about them.

### Ask first, then run

Say what you are about to run and why, and wait for a yes in chat:

1. **New SQL file** (before the deploy, only if the fix added one):
   `ssh shiptrack-vps 'cd /var/www/tracker && git pull origin main && sudo -u postgres psql -d tracking_crm -v ON_ERROR_STOP=1 -f <file>.sql'`
2. **Deploy:** `ssh shiptrack-vps 'cd /var/www/tracker && bash vps-setup/5-deploy.sh'`
   It pulls from GitHub, copies `/etc/tracker/.env`, runs `npm ci`, builds and
   reloads PM2.
3. **Check:** `pm2 ls` and `pm2 logs tracker --lines 50 --nostream` as above.
   Then tell the developer what changed, which commit is live, and what he
   should see in the app.

### New environment variables

You never see or set a secret's value. Name the variable, say where its value
comes from (which dashboard, or "ask the owner"), and add `NAME=` with no value
to `.env.example`. The developer adds the value himself:

```bash
ssh -t shiptrack-vps nano /etc/tracker/.env
```

Then deploy. An env-only change still needs a deploy, because `NEXT_PUBLIC_*`
values are baked in at build time.

### Never

- Print secret values: no `cat`/`less`/`head` of `/etc/tracker/.env` or
  `.env.production.local`, no `env`, `printenv` or `pm2 env`.
- Edit files on the server. Every change goes through Git, so the server
  always matches `main` (`git status` clean).
- Run SQL that writes, except a committed `.sql` file. Anything that changes
  or deletes existing rows needs the owner's OK in plain words.
- Touch other apps, Nginx, the firewall, SSH settings, users, packages, or
  reboot, unless the owner asks.

## Things that live only on the VPS (not in this repo)

- `/etc/tracker/.env` — all secrets
- The crontab that calls `http://localhost:3000/api/cron/*` every minute
  (`?key=` = `DRAFT_QUEUE_SECRET`, `?secret=` = `CRON_SECRET`) (`crontab -l`). `vps-setup/4-setup-cron.sh` is the original and may be out of date.
- Nginx config and SSL certificates
- The database and its data

## Running it locally

```bash
npm install
cp .env.example .env.local   # fill in values for a local/dev database only
npm run dev                  # http://localhost:3000
```

The production database only listens on the VPS, so local runs need your own
PostgreSQL. This order is tested on an empty database:

```bash
createdb tracking_crm
psql -d tracking_crm -c "CREATE ROLE tracker_user"   # supabase-chat-faq.sql grants to it
for f in supabase-schema.sql supabase-businesses.sql supabase-multi-panel.sql \
         supabase-progression.sql supabase-draft-queue.sql supabase-email-logs.sql \
         supabase-support.sql supabase-journey.sql supabase-origin-city.sql \
         chat-tables.sql supabase-chat-cod.sql supabase-chat-faq.sql chat-settings.sql \
         chat-attachments.sql chat-message-edits.sql chat-verified.sql \
         chat-customer-key.sql chat-subject.sql chat-health.sql chat-cod-states.sql chat-phone-match.sql; do
  psql -d tracking_crm -v ON_ERROR_STOP=1 -f "$f" || break
done
```

Never point a local `.env.local` at the production database.
