# ShipTrack — order tracking + customer chat support

Read this whole file before changing anything. It is the rulebook for any AI
(Claude Code, Codex, Cursor) working in this repo.

## MASTER RULES (owner-approved, read before EVERY task)

The rules for this project are in **`SHIPTRACK_MASTER_RULES.md`** (repo root). It is
the owner's own file: never edit, shorten or "improve" it without the owner saying
so in chat. Read it before any work that touches customer support behaviour,
verification, security, escalation, the database, APIs, support screens or deploys.
After each task, report which rules were touched and PASS / FAIL / NOT APPLICABLE
(section 39 of that file).

**`MASTER_RULES_STATUS.md`** (repo root) is my working tracker: for each master rule,
whether the code meets it today, what is missing, and the build order. It never
changes a rule; it only says where the code stands.

The main target of everything here: no customer irritated, no chargeback, payment
gateways safe, every problem solved in the chat. When unsure: do not guess, do not
reveal, keep the chat open, escalate to `Needs You`.

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
| Order lookup used by the AI | `src/lib/chat/orders.ts`; `src/lib/chat/lookup-guard.ts` forces the lookup once the order ID + full phone are typed (2026-09-30: no last 4 any more, master rules 8.1; `lookup_order` takes `order_id` + `phone_number`, old stored calls with `phone_last4` still count as proof in old chats), and hands over (H1–H6 in `getAIResponse`) when the bot keeps asking; a panel's own prompt gets `PANEL_LOOKUP_RULES` appended |
| Verified chats (widget "Verify yourself" form, Visitors/Customers in the inbox) | `src/app/api/widget/verify` (order ID + full phone via `verifyOrderByPhone`, only within the site's panel; failures limited per visitor, per IP from `clientIp` = nginx's X-Real-IP, per order and per phone), `conversations.verified_order_id`/`verified_at`/`verified_via` (`chat-verified.sql`), also set by a found `lookup_order`. `ai.ts` keeps the verified order in view (`lookupVerifiedOrder`, never stored) and H4 in `getAIResponse` stops it asking for the order ID/last 4 again unless the customer brings up another order (`mentionsAnotherOrder`, `reasksForOrderDetails`). `/api/widget/resume` is RETIRED (2026-09-30): it returned a chat's transcript for a phone number alone; it now always answers `found:false` and never reads the database. A new device continues a chat through the Order ID + full phone form (`/api/widget/verify`), which carries on the earlier chat. `verified_via = 'legacy'` (`chat-verified-legacy.sql`: old chats whose order the pre-2026-09-24 phone/email lookup found) moves the chat out of Visitors with an amber "Old check" badge, and since 2026-09-30 `getAIResponse` treats it as verified for that chat like 'form'/'chat' (owner's rule: never ask a verified customer again); a real proof replaces it. `getAIResponse` also swaps any found lookup in the history window that was not proof (`isProvenLookup`, `UNPROVEN_LOOKUP`) for a needs-verification answer. `/api/chat/conversations?segment=visitors\|customers`. |
| One chat per verified customer | `conversations.customer_key` (`chat-customer-key.sql`) = last 10 digits of the verified order's phone, widget chats only; set by `/api/widget/verify` and by a found `lookup_order` in `ai.ts` (`customerKeyForOrderSql` in `orders.ts`); The form (order + FULL phone) carries on the customer's latest chat on that site only when that chat was also `'form'`-verified for the SAME order (moves it to this `visitor_id`, reopens it if Closed): widget routes trust the stored conversation id, so every device that held a chat keeps reading it, and it must have proved the same thing. Otherwise the device gets its own chat with the key. `/api/chat/conversations` shows each (site_id, customer_key) as ONE row (latest chat among the filtered rows, grouped in SQL before the LIMIT; adds `thread_count`, `group_unread`, `group_needs_human`), `/api/chat/pending` counts it once, and `/api/chat/conversations/[id]` adds `earlier` (up to 5 chats of that customer active before this one, 200 messages each; unread cleared only on those), `earlier_total` and `newer_chat` (a chat active after this one: named, never drawn as earlier; the inbox offers "Open newer chat"). Staff actions still work on one conversation id. |
| Chat subject line (customer's current concern, top of the thread + list row) | `src/lib/chat/subject.ts` (`SUBJECT_LABELS`, `updateConversationSubject`: one small model call, no tools, on the last 12 visible messages; label + one line of at most 90 chars with no phone/email/address/link; skips when no customer message is newer than the last subject; one run per chat at a time; never throws). Fired without awaiting by `/api/widget/message` after the reply is saved and by `email.ts` after an inbound email is stored. Columns `conversations.subject_label`/`subject_summary`/`subject_updated_at` (`chat-subject.sql`), returned by `/api/chat/conversations` and `/api/chat/conversations/[id]`; `category` is unchanged and stays the inbox's fallback. |
| Inbox search (name, phone, order ID / tracking ID, message text) | `src/lib/chat/inbox-search.ts` builds the SQL for `GET /api/chat/conversations?q=` (2+ characters): searches ALL chats of the panels the caller may see (status/segment/category ignored, so Closed chats and visitors are found), scanning `messages` once (`msg_hits` CTE: a separate EXISTS per match kind was ~2 s, this is ~100 ms for 40k messages). Matches the customer name, the name/order ID/tracking ID inside stored lookup results, the verified order, a phone of 6+ digits, visible message text and the subject; adds `hit_order/phone/name/text` and `match_snippet`, best matches (an order) first, still one row per customer. The inbox box (`page.tsx`) waits 300 ms after typing, highlights matches in the list and the thread and scrolls to the newest one, and does not re-run the search on the 3 s poll. |
| Customer health (frustration %, chargeback risk) | `conversations.health_score`/`health_reason`/`health_signals`/`health_updated_at` (`chat-health.sql`), set by `updateConversationHealth` in `src/lib/chat/health.ts` (fired, not awaited, by `/api/widget/message` and `email.ts` after each customer message, like the subject line): one small model call (no tools, reasoning off) reads the customer's last 40 messages across ALL their chats on the site (`customer_key`) plus their verified order's age/status, and the counts in `src/lib/chat/health-rules.ts` (pure, no imports, also used by the inbox and the backfill script: swearing, threats, fraud accusations, refund demands, shouting, repeats, chats, days waiting) are blended in (`combineHealth`: the model leads, the counts pull it up, a threat in the last 3 messages floors it at 85, swearing in the last 2 at 70; if the model is down the counts stand). Levels: Calm 0-24, Uneasy 25-49, Frustrated 50-74, Critical 75+. `/api/chat/conversations` returns `health_score`/`health_reason`/`health_pinned` and lists every OPEN chat scoring `HEALTH_PIN_MIN` (65) or more first, highest first, until it is Closed; on a grouped row it is the latest chat's own status and score that count, so closing what the row opens clears it (a search keeps its own order). The inbox shows a % pill on the row and a Frustration bar in the thread header. Add swear/threat words to the lists in `health-rules.ts`. |
| Problem-type tabs (At risk, Refund / Cancellation, Wrong tracking link, Order delay, Address change, Damaged / Wrong item, Exchange / Return) | `src/lib/chat/inbox-topics.ts` (pure; shared by server and inbox) maps subject labels to tabs. `GET /api/chat/conversations?topic=<key>` lists the OPEN chats of one problem (`risk` = open chats scoring `HEALTH_PIN_MIN`+, whatever the subject; a search ignores tabs) and every answer carries `topic_counts` (open customers per tab, one per grouped row, in the caller's panel scope, whatever tab is open) plus per-row `health_threat` / `health_accuse` ("Threat" / "Fraud claim" tags). Refund and Cancellation are ONE subject label since 2026-09-30 (`Refund / Cancellation`); old rows still say `Refund` / `Cancellation` and `displaySubjectLabel` shows and files them as the merged one. A chat changes tab by itself when its subject changes. |
| COD only in some states | `sites.cod_states` (`chat-cod-states.sql`, e.g. `Gujarat`), set in Panel Settings > Cash on Delivery > "Only in some states" (`/api/panel-chat`, cleaned by `cleanCodStates` in `src/lib/chat/cod.ts` so it can only be state names). When set it replaces the yes/no COD sentence: `codStatesPrompt` tells the agent COD works ONLY for addresses in those states, to bring COD up only when the customer asks, in one plain line with no "not available", to say COD is available to a customer who says they are in one of them, and never to offer to place orders. Once an agent reply in the chat has mentioned COD, `getAIResponse` appends `codAlreadyToldNote` so an insisting customer gets a short, different answer (COD shows at checkout only for those states) instead of the same sentence again. `cod_available` is unused while `cod_states` is set. |
| "Waiting for a reply" timer | `src/lib/chat/waiting.ts` (shared) and the list route: `waiting_since` = when the customer's last visible message was written, if the chat is open and nobody has answered it (or the chat is in Needs you and no team member wrote after it; the AI's "the team will reply" does not count, nor a held-back AI draft that was never sent), and that message is not just "ok" / "thanks" (`NO_REPLY_NEEDED_REGEX`). `waiting_overdue` = 2 hours or more (`WAITING_OVERDUE_HOURS`). The inbox shows a "Waiting 3h 20m" chip on the row and in the thread header (grey under 1 h, amber to 2 h, red from 2 h) and tints overdue rows. The list order (`orderBy` in the route): frustrated AND overdue first, then overdue (longest waiting first), then chats that "Came back" after an auto-close, then frustrated (highest score first), then the rest by activity; a search keeps its own order. Computed at query time, nothing stored. |
| Phone match (RETIRED 2026-09-30 evening: old chats only) | `conversations.phone_match_order_id`/`phone_matched_at` (`chat-phone-match.sql`). **Owner's rule: a phone number alone never makes anyone anything.** A customer is verified only when the ORDER ID and the phone (its last 4 digits, or the full number typed) BOTH match the same order: the widget form, or `lookup_order` in the chat. Since that rule nothing writes `phone_match_order_id`: the detector (`phone-match.ts`) and its three call sites (widget message, save-phone, email poll) were removed, so a new chat where someone only types a number stays a plain visitor: no tag, no Customers row, no name. Chats that were matched before (about 314) were left exactly as they were: they keep the blue "Phone match" tag, their place among the customers and the order's name (italic, "(from order)"); `KNOWN_CUSTOMER` in the list route, the badge and `display-name.ts` still read the column for them. It was never verification (never `verified_order_id`, never read by `ai.ts`); it is now also never created. Both AI prompts say a phone number alone verifies nothing and the order ID is mandatory. |
| Customer name on a chat (the order's name, never one the customer typed) | `src/lib/chat/display-name.ts` (SQL builders only). **A chat tied to an order shows the customer name ON THAT ORDER, always**: its verified order, else the phone-matched one (`phone_match_order_id`), inside the chat's own panel (a trailing "." is cut, like `ai.ts` does). Whatever the customer typed as their name is ignored for such a chat (owner's rule 2026-09-30: the name the parcel goes to is the only name staff read). A chat with no order (a plain visitor), or whose order cannot be found, shows its own name, else "Visitor". The list route joins it (`orderNameJoinSql`, alias `oname`, returns `display_name` + `name_from_order`), the thread route uses the same SQL (`conversation.display_name`), the search matches the order name and the typed one (`hitName` in `inbox-search.ts`), and the inbox prints `convName(c)`. A phone match is a hint, not proof of who is typing, so its name is italic (and "(from order)" in the header, hover says why); a verified customer's name is plain. **Read when the inbox loads, never stored**: `conversations.visitor_name` is untouched, the name follows the order if the match moves, and the AI and every `/api/widget/*` response never see it. The order line (`order-facts.ts`) also needs the chat's site to have a panel. |
| Chats that go to Needs you by themselves (threat, fraud claim, AI failure, repeated answer) | `src/lib/chat/escalation.ts` (detectors + fixed replies, no imports), used by `src/app/api/widget/message/route.ts` and `src/lib/chat/email.ts`; the inbox puts such a waiting chat first and overdue after 1 hour (`URGENT_SQL` in `src/app/api/chat/conversations/route.ts`). Master rules 11, 12, 13, 15, 16. |
| Order line in the thread header (placed on / where it is now / estimated delivery) | `src/lib/chat/order-facts.ts` (`loadOrderFacts`), returned as `order_facts` by `GET /api/chat/conversations/[id]` (behind login + panel scope) and drawn by `OrderLine` in `src/app/admin/chat/page.tsx` next to the customer's name. Uses the chat's `verified_order_id`, else its `phone_match_order_id`, inside the chat's own panel (exactly one matching order, else no line). The status is what the customer's tracking page shows (`buildJourney` in `journey.ts`: stored status moved forward by the order's age; "Order Cancelled" etc.), the date is the order's `estimated_delivery` or the day-13 end of the window; a delivered, cancelled or returning order shows no delivery date. **Staff only:** never read by `ai.ts`, never in a `/api/widget/*` response. Nothing is stored; no SQL file. |
| Two different addresses (master rules 10) | `src/lib/chat/address-conflict.ts` (pure: `addressIn`, `addressConflict`, `addressConflictReply`), `chat-history.ts` (`recentVisitorMessages`); checked by `/api/widget/message` and the email poller for a VERIFIED customer only; a conflict sends the chat to Needs you with a fixed reply (email: held, no auto-reply). |
| One chat per customer (merging duplicates) | `chat-merge.sql` (`conversations.merged_into`, apply BEFORE deploying the code that reads it), `src/lib/chat/merge-chats.ts`: when a customer proves an order in the chat (`verified_via = 'chat_phone'`) and already has a chat for that order, `mergeIntoCustomerChat` (called by `/api/widget/message` after the AI turn) MOVES this chat's messages into the earlier chat and leaves an empty Closed shell with `merged_into`; the form path (`/api/widget/verify`) does the same for the browser's open visitor chat (`mergeVisitorChatInto`). Widget routes follow `merged_into` (`conversationForSite` returns the merged-into id; message and messages routes return `conversationId`, and `widget.js` switches to it and reloads the history in order). The inbox list leaves shells out (`c.merged_into IS NULL`). Nothing is deleted. |
| Delay answer ladder (owner, 2026-09-30) | `src/lib/chat/delay-ladder.ts` (pure: `isDelayAsk`, `delayAsksIn`, `delayStage`, `delayNote`), applied in `getAIResponse` for a VERIFIED customer asking about timing: the reason comes from code (festive-season volume, then heavy network load, then delivery agent not reachable yet) by how late the order is and how many times they asked; never repeated, never invented. The agent name is Karry again (owner). |
| Delivered is marked ONLY by the team (owner, 2026-09-30) | The schedule (`src/lib/journey.ts` `expectedIndexForAge`, `/api/cron/progress-orders`, the CSV importer) stops at Out for Delivery and never writes Delivered; `buildJourney` shows Delivered only when the stored status says so; `PATCH /api/orders` with status Delivered records `delivered_at` / `delivered_by`. The AI's order status (`toFoundOrder` in `orders.ts`) is the tracking page's stage. Never reintroduce an age-based Delivered (it marked 169 orders Delivered on 2026-09-30). |
| The Brain (owner, 2026-10-01) | Table `brain_notes` (`chat-brain.sql`, GRANTed to `tracker_user`; `chat-brain-seed.sql` = the first 8 notes): `site_id` NULL = common to every panel, `kind` rule / fact / lesson, `topics`, `always`. `src/lib/chat/brain.ts` (pure): `topicsIn` finds the topics in the customer's last 3 messages (English / Hinglish / Hindi words), `selectNotes` keeps the always-notes plus topic matches within 3,500 characters / 14 notes, `brainSection` is appended to the system prompt as STORE BRAIN, below the locked rules (the section says the rules win). Read fresh on every message in `getAIResponse`; a read error never stops a reply. API `/api/panel-brain` (GET for anyone on the panel; POST / PATCH / DELETE admin only; a common note needs an admin of all panels); card `src/components/BrainCard.tsx` in Panel Settings under Saved Answers, which also shows the locked rules read-only (`getLockedRules`). Notes restate owner decisions and real mistakes only; never invent store policy in a note. Saved answers (`site_faqs`) stay as they are. **Brain, part 2 (`chat-brain-usage.sql`):** (1) `getAIResponse(..., usage)` hands back which notes were shown; `recordBrainUsage` (`brain-usage.ts`) stores them in `brain_usage` (message_id -> notes) from the widget route and the email poller, and the inbox thread shows "🧠 Title · Title" under that AI reply (staff only; deliberately NOT in `messages.metadata`, which the widget returns to the customer). (2) `brain_notes.audience` all / verified / visitor, filtered in `selectNotes` by whether the chat has a verified order. (3) `shown_count` / `last_shown_at`, shown in the card. (4) `noteProblem` (brain.ts) refuses to save or approve a note that teaches what the locked rules forbid (today / tonight promises, hiding the estimated date, asking for UPI / UTR / screenshot / e-mail, payment links, pay again, promising a refund or cancellation, skipping the order ID + phone check); a sentence that says never / do not first is a ban and passes. (5) The suggestion job also reads chats where a team member EDITED an AI reply (`message_revisions`), the strongest lesson.
**Learning loop (same night):** `chat-brain-learn.sql` (`brain_suggestions`, `brain_reviewed`), `brain-learn.ts` (pure: `maskPersonal`, `parseDraft`, `LEARN_INSTRUCTION`), `brain-suggest.ts` + `/api/cron/brain-suggest?secret=` (crontab `40 3 * * *`, log `/var/log/brain-suggest.log`, max 15 chats a run): for chats in the last 14 days where a team member wrote 25+ characters, one small model call on the MASKED transcript drafts at most one general note, stored as a PENDING suggestion. The AI never reads a suggestion; `/api/panel-brain/suggestions` (POST, admin only) approves it (edited or not) into `brain_notes` with `source 'learned'`, or rejects it; the Brain card shows "Suggested from real chats". A draft is dropped in code if it mentions a phone / order ID / link / e-mail, teaches "today / tonight", hides the date, or is about refund / cancel / payment (owner's locked topics). Live yield is low on purpose (4 drafts from 60 chats), and some drafts are wrong (the team is sometimes wrong): that is why an admin decides. Later idea, not done: move parts of the long live prompt into notes once the live tests show no loss. |
| AI golden conversations (the tests) | `scripts/ai-tests/` (`cases.js` the situations, `harness.js` runs the REAL `getAIResponse` against a fake DB, `run.js`). `npm run test:ai` = offline, scripted model, code-level checks (seconds). `bash scripts/ai-tests/run-on-vps.sh` = the real model with the live prompt and saved answers, using THIS checkout's code before it is deployed (about 2 minutes; writes nothing). **Run both before deploying any change to `ai.ts`, the prompt, saved answers, or the guards; add a case for every wrong answer a customer or the owner finds.** Live results vary a little: a case marked `watch` is reported, not failed. |
| AI answers must be current and never promise "today" (2026-10-01) | `ai.ts` `getAIResponse`: (1) a verified chat's old `lookup_order` results are replaced by a fresh read of the verified order on every turn, and any other found result older than 10 minutes loses its status/date (`FRESH_LOOKUP_MS`, `STALE_STATUS_NOTE`): a customer was told "Order Placed" for an In Transit order from a lookup stored a week earlier; (2) `withoutThinking`: deepseek-v4 calls send `reasoning: {enabled:false}`, because with thinking on it often used all 1500 tokens and answered blank (`finish=length`), which degraded the turn to a weaker model that answered old questions or sent verified customers to Needs you; (3) a verified customer's first reply gets `VERIFIED_NOTE` up front (before, only the H4 retry did); (4) `today-promise.ts` drops any sentence promising arrival today / tonight / tomorrow from every reply (the prompt alone failed 3 of 7 live tests). Test harness pattern: stub `@/lib/db`, `./orders`, `openai`, transpile `ai.ts` with TypeScript. |
| Schedule hangs off the estimated date (owner, 2026-10-01) | `journey.ts` `windowDaysFor` (days from placing to the order's own estimated date when that is 13-20 days, else 13) and `stageStartDay`: Picked Up..In Transit are days 4-5, then State / City / Hub / **Out for Delivery start 6 / 4 / 2 / 1 days before the estimated date** (default window 13: days 7 / 9 / 11 / 12). Before, Out for Delivery started on day 9 whatever the date, so customers saw "Out for Delivery" for 4+ days. The cron (`progress-orders`) passes each order's `estimated_delivery`. The admin "Auto-Progression" minutes (`progression_settings`, all disabled) are NOT read by anything; the card now says so. |
| Auto-close quiet chats + "Came back" (visitor widget chats close after 4 quiet HOURS, verified customers after 4 DAYS; a returning customer's form reopens their Closed chat via `/api/widget/verify`, `verified_via` 'form' or 'chat_phone', never a duplicate; labels: "Closed by AI" for the sweep, "Closed by support" for a team member; the sweep never closes a waiting customer or a PROTECTED chat: Needs you, refund / cancel / payment, threat / fraud, card details sent, master rules 24) | `src/lib/chat/auto-close.ts` (`autoCloseIdleChats`, `AUTO_CLOSE_DAYS = 4`), `GET /api/cron/chat-auto-close?secret=<CRON_SECRET>[&dry=1]` (VPS crontab, hourly, `7 * * * *`, log `/var/log/chat-auto-close.log`), column `conversations.auto_closed_at` (`chat-auto-close.sql`). Owner's main rule 2026-09-30: a chat with **no message from anyone for 4 days** (and not touched: `updated_at`, so Take over, Hand to AI or the verify form reopening it count) is Closed by the system (`status='resolved'`, `unread_count=0`, `auto_closed_at=now()`), and **nothing is ever sent to the customer**. **Never closed: a chat whose customer is still waiting for an answer.** That is the Waiting timer's rule made stricter, never looser (checked against the live list): also waiting are a chat someone owns (Needs you, or taken over) with no team reply since the customer's last message, a Needs you chat no team member ever answered even if the customer's last word is "thanks", and a chat whose last AI message is not an answer (`AI_NOT_AN_ANSWER_REGEX` in `waiting.ts`: the "took longer than expected" apology, or "let me get that confirmed by our team" with no escalation). When the customer writes again the chat reopens by itself (widget message, form, email) and, because `auto_closed_at` stays set, the list shows it as **"Came back"** (`returned` = open AND `auto_closed_at` set): blue chip, counted in "need attention", ordered right after the overdue chats and above merely frustrated ones, until a person acts: Close, Take over, Hand to AI (`PATCH /api/chat/conversations/[id]`) or a staff reply (`/api/chat/messages`) clear it. Not tagged: chats the team closed by hand, and a customer who returns in a NEW chat (another browser or cleared storage: the form only carries on a form-verified chat, an in-chat order ID + last 4 never merges chats); that new chat is still the customer's newest, just without the chip. `?dry=` (any value but 0/false/no) only counts. Undo of a sweep needs the owner's OK: see `chat-auto-close.sql`. |
| Reopen on return | `/api/widget/message`: a visitor message in a Closed (`resolved`) widget chat sets it back to `ai_handling` before the AI is asked, so the AI answers (`human_needed` when the site's AI is off). `human_needed` and `agent_handling` are never changed. An inbound EMAIL in a Closed thread reopens it the same way since 2026-09-30 (`email.ts`: `ai_handling`, or `human_needed` when the mailbox has AI off); before, it was stored in the Closed chat and nobody saw it. |
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
2. **Order lookup privacy.** The AI may only reveal an order after order ID + the
   FULL phone number match (`src/lib/chat/orders.ts`; since 2026-09-30 no last 4). This came out of a real
   privacy incident on 2026-09-11. Never loosen it. **A phone number alone never
   verifies, names or files a chat as a customer; the order ID is mandatory too**
   (owner's rule, 2026-09-30): only order ID + phone BOTH matching one order make a
   chat verified.
3. **Panel scoping.** Every `/api/chat/*` and panel route must filter by the caller's
   `businessIds` from `getAuthFromRequest`. A `viewer` must not be able to change data.
4. **Prompts live in two places.** The base persona (Karry, for Vastora) is
   `DEFAULT_SYSTEM_PROMPT` in `src/lib/chat/ai.ts` and is in Git. Each panel's own
   prompt (`sites.system_prompt`), Saved Answers (`site_faqs`) and COD setting
   (`sites.cod_available`) are in the database and edited from Panel Settings —
   they are not in Git. Keep prompt edits small; the prompt size drives the AI bill.
5. **No destructive SQL**, ever, without the owner saying so in plain words.
   Schema changes are additive (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`).
6. **Quiet chats close by themselves, and nobody is hidden.** A chat with no message
   for 4 days is auto-closed (`src/lib/chat/auto-close.ts`) with nothing sent to the
   customer, but never while the customer is still waiting for an answer; a customer
   who writes again in it reopens it, and it shows near the top as "Came back" until
   a person acts. Do not close chats in bulk
   any other way, and never make the waiting test looser (owner's rule, 2026-09-30).

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
- The crontab that calls `http://localhost:3000/api/cron/*` (every minute, and `chat-auto-close` hourly)
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
         chat-customer-key.sql chat-subject.sql chat-health.sql chat-cod-states.sql chat-phone-match.sql \
         chat-auto-close.sql; do
  psql -d tracking_crm -v ON_ERROR_STOP=1 -f "$f" || break
done
```

Never point a local `.env.local` at the production database.
