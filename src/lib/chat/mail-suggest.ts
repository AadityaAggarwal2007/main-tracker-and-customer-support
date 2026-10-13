// ── Suggestions and "Sudharo" in the Mail tab (owner 2026-10-13: "gmail pa grammer sudharna wala aur suggestion wala
// bhi dede, yeh log baar baar chat gpt sa kar rha ha") ──
// The same drafting as Chat Support (suggest-run.ts: Chikki's knowledge, the same guards, mails as "Hi <name>, ...
// Regards, <brand> Support"), fed with the MAIL conversation from the mail store: the open mail's Gmail thread and the
// customer's other mails / our replies of the last 30 days, oldest first, each cut before the quoted original. The
// sender's verified order (Mail verification) gives the order facts; an unverified sender gets drafts with no order
// facts at all (they can only ask for the order ID + phone). Nothing is sent: the text goes into the reply box.
import { query, queryOne } from '@/lib/db';
import { sinceDate } from './mail-view';
import { verifiedSenders } from './mail-verify';
import type { Row, SuggestConv, SuggestSource } from './suggest-run';

const MAX_MAILS = 12;
const MAX_CHARS = 1500;

// Pure: a mail's own words, without the quoted original under it (Gmail's "On ... wrote:", "> " lines, Outlook's
// "-----Original Message-----" / "From: ... Sent: ..."), at most MAX_CHARS.
export function ownWords(text: string | null | undefined): string {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const l = line.trim();
    if (/^On .{4,200}wrote:?$/i.test(l) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(l) || (/^From:\s.+/i.test(l) && out.length > 0)) break;
    if (l.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_CHARS);
}

interface MailRow { folder: 'inbox' | 'sent'; uid: string | number; thread_id: string | null; from_addr: string; body_text: string | null; subject: string; sent_at: string }

export interface MailSuggestContext { conv: SuggestConv; src: SuggestSource; address: string }

// The conversation of the open mail as rows for the model; null = the mail is not in the mail store (yet).
export async function mailSuggestContext(box: { id: string; panelId: string | null; siteId?: string | null }, uid: number, now = Date.now()): Promise<MailSuggestContext | null> {
  const open = await queryOne<{ thread_id: string | null; from_addr: string; from_name?: string | null }>(
    `SELECT thread_id, from_addr, from_name FROM mail_store WHERE box_id = $1 AND folder = 'inbox' AND uid = $2 ORDER BY gone ASC, uidvalidity DESC LIMIT 1`,
    [box.id, uid]);
  if (!open) return null;
  const address = (open.from_addr || '').toLowerCase();
  const r = await query<MailRow>(
    `SELECT folder, uid, thread_id, from_addr, body_text, subject, sent_at FROM mail_store
      WHERE box_id = $1 AND NOT gone AND sent_at >= $2
        AND ( ($3::text IS NOT NULL AND thread_id = $3)
           OR (folder = 'inbox' AND from_addr = $4)
           OR (folder = 'sent' AND $4 = ANY(to_addrs)) )
      ORDER BY sent_at DESC LIMIT $5`, [box.id, sinceDate(now), open.thread_id, address, MAX_MAILS]);
  const rows: Row[] = r.rows.slice().reverse()
    .map((m) => ({ id: `${m.folder}:${m.uid}`, sender: m.folder === 'inbox' ? 'visitor' : 'agent', content: ownWords(m.body_text) || (m.folder === 'inbox' ? m.subject : '') }))
    .filter((m) => (m.content || '').trim());
  const ver = box.panelId ? ((await verifiedSenders(box.panelId, [address]))[address] || []) : [];
  let siteId = box.siteId || '';
  if (!siteId && box.panelId) {
    const s = await queryOne<{ id: string }>(`SELECT id FROM sites WHERE tracker_business_id::text = $1::text ORDER BY created_at ASC LIMIT 1`, [box.panelId]);
    siteId = s?.id || '';
  }
  const orderId = ver[0]?.orderId || null;
  return {
    address,
    src: { rows, orderId, name: (open.from_name || '').trim() || null },
    conv: {
      id: `mail:${box.id}:${open.thread_id || address}`, site_id: siteId, tracker_business_id: box.panelId, source: 'email', status: 'agent_handling',
      verified_order_id: orderId, phone_match_order_id: null, case_kind: null,
    },
  };
}
