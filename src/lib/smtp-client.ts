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

interface EmailPayload {
  to: string;
  subject: string;
  html: string;
}

export async function sendEmailDirect(
  emails: EmailPayload[]
): Promise<{ sent: number; failed: number; errors: string[] }> {
  const gmailUser = process.env.GMAIL_USER || '';
  const gmailPass = process.env.GMAIL_APP_PASSWORD || '';

  if (!gmailUser || !gmailPass) {
    return {
      sent: 0,
      failed: emails.length,
      errors: ['GMAIL_USER or GMAIL_APP_PASSWORD not set in environment variables'],
    };
  }

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const email of emails) {
    try {
      await transporter.sendMail({
        from: `"ShipTrack" <${gmailUser}>`,
        to: email.to,
        subject: email.subject,
        html: email.html,
      });
      sent++;
    } catch (err) {
      failed++;
      errors.push(`${email.to}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { sent, failed, errors };
}
