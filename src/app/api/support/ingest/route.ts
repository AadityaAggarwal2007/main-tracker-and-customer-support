import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import Imap from 'imap';
import { simpleParser } from 'mailparser';

// POST /api/support/ingest — called by cron every 2 min
// Polls IMAP for each business that has IMAP configured
// Creates support tickets from unseen emails

const CRON_SECRET = process.env.CRON_SECRET || '';

export async function POST(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization');
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Get all businesses with IMAP configured
  const settingsResult = await query<{
    business_id: string; imap_host: string; imap_port: number;
    imap_user: string; imap_password: string; imap_folder: string;
    ai_mode: string; auto_reply_enabled: boolean;
  }>(
    `SELECT business_id, imap_host, imap_port, imap_user, imap_password, imap_folder,
            ai_mode, auto_reply_enabled
     FROM support_settings
     WHERE imap_user IS NOT NULL AND imap_password IS NOT NULL
       AND imap_user != '' AND imap_password != ''`
  );

  const results: Record<string, unknown>[] = [];

  for (const s of settingsResult.rows) {
    try {
      const newTickets = await pollImapInbox(s);
      results.push({ businessId: s.business_id, newTickets });
    } catch (err) {
      results.push({ businessId: s.business_id, error: String(err) });
    }
  }

  return NextResponse.json({ success: true, results });
}

async function pollImapInbox(config: {
  business_id: string; imap_host: string; imap_port: number;
  imap_user: string; imap_password: string; imap_folder: string;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: config.imap_user,
      password: config.imap_password,
      host: config.imap_host,
      port: config.imap_port,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 15000,
      authTimeout: 10000,
    });

    let newTickets = 0;

    imap.once('ready', () => {
      imap.openBox(config.imap_folder || 'INBOX', false, (err, box) => {
        if (err) { imap.end(); reject(err); return; }

        // Search UNSEEN emails from last 7 days
        const since = new Date();
        since.setDate(since.getDate() - 7);

        imap.search(['UNSEEN', ['SINCE', since]], async (searchErr, uids) => {
          if (searchErr || !uids || uids.length === 0) {
            imap.end();
            resolve(0);
            return;
          }

          const fetch = imap.fetch(uids, { bodies: '', markSeen: true });
          const parsePromises: Promise<void>[] = [];

          fetch.on('message', (msg) => {
            parsePromises.push(new Promise<void>((resMsg) => {
              const chunks: Buffer[] = [];
              msg.on('body', (stream) => {
                stream.on('data', (chunk: Buffer) => chunks.push(chunk));
                stream.once('end', async () => {
                  try {
                    const parsed = await simpleParser(Buffer.concat(chunks));
                    const messageId = parsed.messageId || '';
                    const from = parsed.from?.value?.[0];
                    const customerEmail = from?.address || '';
                    const customerName = from?.name || customerEmail;
                    const subject = parsed.subject || '(no subject)';
                    const body = parsed.text || parsed.html?.replace(/<[^>]+>/g, '') || '';

                    if (!customerEmail) { resMsg(); return; }

                    // Detect order ID in subject/body
                    const orderMatch = `${subject} ${body}`.match(/#?([A-Z]{2,4}[-]?\d{4,8})/i);
                    const detectedOrderId = orderMatch ? orderMatch[1] : null;

                    // Check if message already processed
                    if (messageId) {
                      const existing = await queryOne(
                        `SELECT id FROM ticket_messages WHERE raw_email_id = $1`,
                        [messageId]
                      );
                      if (existing) { resMsg(); return; }
                    }

                    // Find existing open ticket for this email
                    let ticketId: string | null = null;
                    const existingTicket = await queryOne<{ id: string }>(
                      `SELECT id FROM support_tickets
                       WHERE customer_email = $1 AND business_id = $2 AND status != 'resolved'
                       ORDER BY created_at DESC LIMIT 1`,
                      [customerEmail, config.business_id]
                    );

                    if (existingTicket) {
                      ticketId = existingTicket.id;
                      await query(
                        `UPDATE support_tickets SET last_message_at = NOW(), status = 'open', updated_at = NOW() WHERE id = $1`,
                        [ticketId]
                      );
                    } else {
                      // Create new ticket
                      const newTicket = await queryOne<{ id: string }>(
                        `INSERT INTO support_tickets (business_id, source, status, subject, customer_email, customer_name, order_id)
                         VALUES ($1, 'email', 'open', $2, $3, $4, $5)
                         RETURNING id`,
                        [config.business_id, subject, customerEmail, customerName, detectedOrderId]
                      );
                      ticketId = newTicket?.id || null;
                      newTickets++;
                    }

                    if (ticketId) {
                      await query(
                        `INSERT INTO ticket_messages (ticket_id, direction, body, raw_email_id, sent_by)
                         VALUES ($1, 'inbound', $2, $3, 'customer')`,
                        [ticketId, body.trim().slice(0, 10000), messageId || null]
                      );
                    }
                  } catch (parseErr) {
                    console.error('IMAP parse error:', parseErr);
                  }
                  resMsg();
                });
              });
            }));
          });

          fetch.once('end', async () => {
            await Promise.all(parsePromises);
            imap.end();
            resolve(newTickets);
          });

          fetch.once('error', (fetchErr: Error) => {
            imap.end();
            reject(fetchErr);
          });
        });
      });
    });

    imap.once('error', (err: Error) => reject(err));
    imap.connect();
  });
}
