import nodemailer from 'nodemailer';

// Direct Gmail SMTP — no Apps Script, no queue, no drafts
// Requires env vars: GMAIL_USER, GMAIL_APP_PASSWORD

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER || '',
    pass: process.env.GMAIL_APP_PASSWORD || '',
  },
});

const DAILY_LIMIT = 2000;        // Google Workspace limit
const DELAY_MS = 120;            // 120ms between emails = ~8/sec (safe for Gmail)

interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  fromName?: string;  // per-panel brand name e.g. "Roopvastra"
}

export async function sendEmailDirect(
  emails: EmailPayload[]
): Promise<{ sent: number; failed: number; errors: string[]; cappedAt?: number }> {
  const gmailUser = process.env.GMAIL_USER || '';
  const gmailPass = process.env.GMAIL_APP_PASSWORD || '';

  if (!gmailUser || !gmailPass) {
    return {
      sent: 0,
      failed: emails.length,
      errors: ['GMAIL_USER or GMAIL_APP_PASSWORD not set in environment variables'],
    };
  }

  // Enforce daily cap — never send more than 2000 in one call
  const toSend = emails.slice(0, DAILY_LIMIT);
  const capped = emails.length > DAILY_LIMIT;

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const email of toSend) {
    try {
      const fromName = email.fromName || 'ShipTrack';
      await transporter.sendMail({
        from: `"${fromName}" <${gmailUser}>`,
        to: email.to,
        subject: email.subject,
        html: email.html,
      });
      sent++;
      // Small delay to respect Gmail per-second rate limits
      await new Promise(r => setTimeout(r, DELAY_MS));
    } catch (err) {
      failed++;
      errors.push(`${email.to}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { sent, failed, errors, ...(capped ? { cappedAt: DAILY_LIMIT } : {}) };
}

