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
| AI replies (model chain, tools, base prompt) | `src/lib/chat/ai.ts` — `DEFAULT_SYSTEM_PROMPT`, `buildSystemPrompt`, `FALLBACK_CHAIN` |
| Order lookup used by the AI | `src/lib/chat/orders.ts` |
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
         chat-tables.sql supabase-chat-cod.sql supabase-chat-faq.sql chat-settings.sql; do
  psql -d tracking_crm -v ON_ERROR_STOP=1 -f "$f" || break
done
```

Never point a local `.env.local` at the production database.
