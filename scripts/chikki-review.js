#!/usr/bin/env node
// ── Chikki's record, read only (owner 2026-10-10, step 8: "Chikki ne kya kiya uska record, aur jo galat hai woh theek") ──
// From the Mac:  ssh shiptrack-vps 'cd /var/www/tracker && node scripts/chikki-review.js 30' | pbcopy   then paste it
// in the chat (days: default 30, at most 90; chat box AND email chats of every panel).
// Reads only: every query runs with default_transaction_read_only. Prints, per panel, what Chikki did in the last N days
// (replies, chats it finished alone, chats it handed to the team, "took longer" apologies, held drafts, replies the
// team edited or deleted), the hand-over reasons in the PM2 log, then masked samples for review: the last messages
// before Chikki handed a chat over, the replies the team edited, customers who sounded annoyed right after a Chikki
// reply, and (owner: "ab toh chargeback bhi dekh rha ha") what the customer's chat said before each chargeback. Phone numbers, emails, links, order and tracking numbers are masked; texts are cut to 280 characters;
// no customer name column is read. Nothing here changes Chikki.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DAYS = Math.max(1, Math.min(90, parseInt(process.argv[2] || '30', 10) || 30));
const AI_BUSY_REPLY = 'Sorry, that took longer than expected on my end. Could you send that again?';

// psql: the server's database as postgres (like scripts/ai-tests/run.js), or REVIEW_PSQL_URL for a test database.
function sql(text) {
  const env = { ...process.env, PGOPTIONS: '-c default_transaction_read_only=on' };
  const args = ['-At', '-v', 'ON_ERROR_STOP=1', '-c', text];
  const out = process.env.REVIEW_PSQL_URL
    ? execFileSync('psql', [process.env.REVIEW_PSQL_URL, ...args], { encoding: 'utf8', env, maxBuffer: 1 << 26 })
    : execFileSync('sudo', ['-u', 'postgres', 'env', 'PGOPTIONS=-c default_transaction_read_only=on', 'psql', '-d', 'tracking_crm', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const t = out.trim();
  return t ? JSON.parse(t) : [];
}
function safe(what, text) {
  try { return sql(text) || []; } catch (e) { console.log(`  (${what}: could not read: ${String(e.message || e).split('\n')[0].slice(0, 160)})`); return []; }
}

// As src/lib/chat/brain-learn.ts maskPersonal, plus a 6-digit PIN code.
const mask = (s) => String(s || '')
  .replace(/https?:\/\/\S+/gi, '[link]')
  .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
  .replace(/(?<![\w])(?:ST|AWB)[A-Z0-9]{6,}\b/gi, '[tracking id]')
  .replace(/#\s?\d{2,}/g, '[order]')
  .replace(/(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g, '[phone]')
  .replace(/\d{5,}/g, '[number]')
  .replace(/\s+/g, ' ').trim();
const cut = (s, n = 280) => { const m = mask(s); return m.length > n ? m.slice(0, n - 1) + '…' : m; };
const who = { visitor: 'Customer', ai: 'Chikki', agent: 'Team', system: 'System' };
const since = `now() - interval '${DAYS} days'`;
const AI_MSG = `m.sender = 'ai' AND m.deleted_at IS NULL AND COALESCE(m.metadata->>'withheld', '') = '' AND COALESCE(m.metadata->>'wa_auto_reply', '') <> 'true'`;
const READABLE = `x.sender IN ('visitor', 'ai', 'agent') AND x.deleted_at IS NULL AND COALESCE(x.metadata->>'hidden', 'false') <> 'true' AND x.content IS NOT NULL AND btrim(x.content) <> ''`;

console.log(`CHIKKI REVIEW · last ${DAYS} days · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);

// ── 1. Numbers per panel ──
console.log('\n1. NUMBERS PER PANEL');
const per = safe('numbers', `SELECT COALESCE(json_agg(t ORDER BY t.ai_replies DESC), '[]') FROM (
  SELECT s.name AS panel,
    (SELECT count(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.site_id = s.id AND m.created_at > ${since} AND ${AI_MSG})::int AS ai_replies,
    (SELECT count(DISTINCT m.conversation_id) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.site_id = s.id AND m.created_at > ${since} AND ${AI_MSG})::int AS ai_chats,
    (SELECT count(DISTINCT m.conversation_id) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.site_id = s.id AND m.created_at > ${since} AND ${AI_MSG}
        AND c.status IN ('ai_handling', 'resolved')
        AND NOT EXISTS (SELECT 1 FROM messages a WHERE a.conversation_id = c.id AND a.sender = 'agent' AND a.created_at > ${since}))::int AS alone,
    (SELECT count(DISTINCT e.conversation_id) FROM chat_events e WHERE e.site_id = s.id::text AND e.kind = 'status' AND e.to_status = 'human_needed' AND e.actor IN ('ai', 'system') AND e.created_at > ${since})::int AS handed,
    (SELECT count(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.site_id = s.id AND m.sender = 'ai' AND m.created_at > ${since} AND m.content = '${AI_BUSY_REPLY.replace(/'/g, "''")}')::int AS busy,
    (SELECT count(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.site_id = s.id AND m.sender = 'ai' AND m.created_at > ${since} AND COALESCE(m.metadata->>'withheld', '') <> '')::int AS held,
    (SELECT count(DISTINCT r.message_id) FROM message_revisions r JOIN messages m ON m.id = r.message_id JOIN conversations c ON c.id = m.conversation_id WHERE c.site_id = s.id AND m.sender = 'ai' AND r.action = 'edit' AND r.created_at > ${since})::int AS team_edited,
    (SELECT count(DISTINCT r.message_id) FROM message_revisions r JOIN messages m ON m.id = r.message_id JOIN conversations c ON c.id = m.conversation_id WHERE c.site_id = s.id AND m.sender = 'ai' AND r.action = 'delete' AND r.created_at > ${since})::int AS team_deleted
  FROM sites s) t WHERE t.ai_replies > 0 OR t.handed > 0`);
for (const p of per) {
  const pct = (n) => (p.ai_chats ? ` (${Math.round((100 * n) / p.ai_chats)}%)` : '');
  console.log(`- ${p.panel}: ${p.ai_replies} replies in ${p.ai_chats} chats · finished alone ${p.alone}${pct(p.alone)} · handed to team ${p.handed}${pct(p.handed)} · "took longer" ${p.busy} · held drafts ${p.held} · team edited ${p.team_edited} · team deleted ${p.team_deleted}`);
}
if (!per.length) console.log('- no Chikki replies in this window');

// ── 2. Why chats were handed over (PM2 log, as far back as it goes) ──
console.log('\n2. HAND-OVER REASONS (PM2 log)');
try {
  const dir = path.join(process.env.HOME || '/root', '.pm2', 'logs');
  const files = fs.readdirSync(dir).filter((f) => /^tracker-out/.test(f)).map((f) => path.join(dir, f));
  const reasons = {}; let failed = 0, lines = 0;
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/handed to a person: (.+)$/);
      if (m) { const k = m[1].trim().replace(/[0-9a-f-]{20,}/gi, '').slice(0, 60); reasons[k] = (reasons[k] || 0) + 1; lines++; }
      if (/Every model failed/.test(line)) failed++;
    }
  }
  for (const [k, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`- ${k}: ${n}`);
  if (!lines) console.log('- none in the log');
  console.log(`- "every model failed": ${failed}`);
} catch (e) { console.log(`- could not read the PM2 log: ${e.message}`); }

// ── 3. The last messages before Chikki handed a chat over ──
console.log('\n3. BEFORE A HAND-OVER (latest 20, last 4 messages each)');
const hand = safe('hand-overs', `SELECT COALESCE(json_agg(t ORDER BY t.at DESC), '[]') FROM (
  SELECT DISTINCT ON (e.conversation_id) e.conversation_id AS id, e.created_at AS at, s.name AS panel, c.source, c.verified_order_id IS NOT NULL AS verified,
    (SELECT json_agg(y ORDER BY y.created_at) FROM (SELECT x.sender, x.content, x.created_at FROM messages x
       WHERE x.conversation_id = e.conversation_id AND ${READABLE} AND x.created_at <= e.created_at + interval '5 seconds'
       ORDER BY x.created_at DESC LIMIT 4) y) AS msgs
  FROM chat_events e JOIN conversations c ON c.id = e.conversation_id JOIN sites s ON s.id = c.site_id
  WHERE e.kind = 'status' AND e.to_status = 'human_needed' AND e.actor IN ('ai', 'system') AND e.created_at > ${since}
  ORDER BY e.conversation_id, e.created_at DESC) t`).slice(0, 20);
hand.forEach((h, i) => {
  console.log(`[H${i + 1}] ${h.panel} · ${h.source === 'email' ? 'email' : 'chat'} · ${h.verified ? 'verified' : 'visitor'} · ${String(h.id).slice(0, 8)}`);
  for (const m of h.msgs || []) console.log(`   ${who[m.sender] || m.sender}: ${cut(m.content)}`);
});
if (!hand.length) console.log('- none');

// ── 4. Chikki replies the team edited ──
console.log('\n4. TEAM EDITED A CHIKKI REPLY (latest 15)');
const edits = safe('edits', `SELECT COALESCE(json_agg(t ORDER BY t.at DESC), '[]') FROM (
  SELECT r.created_at AS at, s.name AS panel, r.previous_content AS before, r.new_content AS after,
    (SELECT v.content FROM messages v WHERE v.conversation_id = m.conversation_id AND v.sender = 'visitor' AND v.deleted_at IS NULL AND v.created_at < m.created_at ORDER BY v.created_at DESC LIMIT 1) AS asked
  FROM message_revisions r JOIN messages m ON m.id = r.message_id JOIN conversations c ON c.id = m.conversation_id JOIN sites s ON s.id = c.site_id
  WHERE m.sender = 'ai' AND r.action = 'edit' AND r.created_at > ${since}
  ORDER BY r.created_at DESC LIMIT 15) t`);
edits.forEach((x, i) => {
  console.log(`[E${i + 1}] ${x.panel}`);
  console.log(`   Customer: ${cut(x.asked)}`);
  console.log(`   Chikki:   ${cut(x.before)}`);
  console.log(`   Team:     ${cut(x.after)}`);
});
if (!edits.length) console.log('- none');

// ── 5. Customer sounded annoyed right after a Chikki reply ──
console.log('\n5. ANNOYED RIGHT AFTER CHIKKI (latest 20)');
const pairs = safe('pairs', `SELECT COALESCE(json_agg(t ORDER BY t.at DESC), '[]') FROM (
  SELECT m.created_at AS at, s.name AS panel, c.verified_order_id IS NOT NULL AS verified, m.content AS chikki,
    (SELECT v.content FROM messages v WHERE v.conversation_id = m.conversation_id AND v.sender = 'visitor' AND v.deleted_at IS NULL AND v.created_at < m.created_at ORDER BY v.created_at DESC LIMIT 1) AS before,
    n.content AS next
  FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN sites s ON s.id = c.site_id
  JOIN LATERAL (SELECT v.content FROM messages v WHERE v.conversation_id = m.conversation_id AND v.sender = 'visitor' AND v.deleted_at IS NULL
                  AND v.created_at > m.created_at AND v.created_at < m.created_at + interval '30 minutes' ORDER BY v.created_at LIMIT 1) n ON true
  WHERE ${AI_MSG} AND m.created_at > ${since}
  ORDER BY m.created_at DESC LIMIT 6000) t`);
const ANNOYED = [
  /\b(already|i told you|told you|again and again|same (thing|answer|reply|message)|not answering|you are not|useless|stupid|nonsense|rubbish|worst|fraud|scam|cheat|fake|real person|human|bot|robot)\b/i,
  /\b(kitni baar|kitne baar|phir se|pehle hi|bata (diya|chuka|chuki)|de (diya|chuka|chuki)|samajh nahi|samjh nahi|samjha nahi|bakwas|bekar|faltu|dhokha|chor|insaan|kisi se baat|baat karao|jawab do|reply karo)\b/i,
  /(\?\?\?|!!!|बकवास|धोखा|कितनी बार)/,
];
const annoyed = pairs.filter((p) => ANNOYED.some((r) => r.test(p.next || ''))).slice(0, 20);
annoyed.forEach((p, i) => {
  console.log(`[A${i + 1}] ${p.panel} · ${p.verified ? 'verified' : 'visitor'}`);
  if (p.before) console.log(`   Customer: ${cut(p.before)}`);
  console.log(`   Chikki:   ${cut(p.chikki)}`);
  console.log(`   Customer: ${cut(p.next)}`);
});
console.log(annoyed.length ? `(${annoyed.length} of ${pairs.length} Chikki replies that got an answer within 30 minutes)` : `- none of ${pairs.length} replies`);

// ── 6. Before a chargeback: the customer's chat (any channel) for the charged-back order ──
// Only mails with a dispute word (as src/lib/chargeback/parse.ts chargebackKind; the gateway's payment mails are not
// chargebacks). The chat is the verified one for that order in that panel; its last 6 messages before the mail.
console.log('\n6. BEFORE A CHARGEBACK (the customer\'s chat, last 6 messages before the alert)');
const cbs = safe('chargebacks', `SELECT COALESCE(json_agg(t ORDER BY t.at DESC), '[]') FROM (
  SELECT a.received_at AS at, a.gateway, b.name AS panel, a.subject,
    (SELECT json_build_object('source', c.source, 'status', c.status, 'case', c.case_kind, 'msgs',
        (SELECT json_agg(y ORDER BY y.created_at) FROM (SELECT x.sender, x.content, x.created_at FROM messages x
           WHERE x.conversation_id = c.id AND ${READABLE} AND x.created_at <= a.received_at ORDER BY x.created_at DESC LIMIT 6) y))
       FROM conversations c JOIN sites s ON s.id = c.site_id
      WHERE s.tracker_business_id::text = a.business_id AND a.order_id IS NOT NULL
        AND regexp_replace(c.verified_order_id, '[^0-9]', '', 'g') = regexp_replace(a.order_id, '[^0-9]', '', 'g')
      ORDER BY c.last_message_at DESC NULLS LAST LIMIT 1) AS chat
  FROM chargeback_alerts a LEFT JOIN businesses b ON b.id::text = a.business_id
  WHERE a.received_at > ${since}
    AND (a.subject || ' ' || left(a.snippet, 1500)) ~* '(charge ?back|dispute (raised|notice|initiated|opened)|retrieval request|representment|pre-?arbitration|cardholder has disputed)'
  ORDER BY a.received_at DESC LIMIT 20) t`);
cbs.forEach((x, i) => {
  console.log(`[C${i + 1}] ${x.panel || '?'} · ${x.gateway} · ${String(x.at).slice(0, 10)} · ${x.chat ? `${x.chat.source} chat, now ${x.chat.status}${x.chat.case ? ', ' + x.chat.case : ''}` : 'no chat found for the order'}`);
  for (const m of (x.chat && x.chat.msgs) || []) console.log(`   ${who[m.sender] || m.sender}: ${cut(m.content)}`);
});
if (!cbs.length) console.log('- none (or no chargeback table yet)');
console.log('\nEND');
