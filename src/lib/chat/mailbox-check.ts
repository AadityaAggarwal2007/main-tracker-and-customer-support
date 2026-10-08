import Imap from 'imap';

// ── Checking a Gmail before it is saved (shared by the support mailbox and the chargeback mailbox) ──
// Moved out of /api/panel-email unchanged (owner 2026-10-08) so the chargeback mailbox signs in the same way.

// Google shows app passwords as "abcd efgh ijkl mnop". The spaces are for
// reading; IMAP and SMTP want the 16 characters.
export function normalizeAppPassword(raw: string): string {
  return raw.replace(/\s+/g, '');
}

export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// Sign in once before saving, for two reasons. A wrong app password fails
// silently otherwise — the poller logs an IMAP error every 60s and the
// customer's mail sits unread. And the mailbox's current high-water mark has
// to be recorded: the poller answers everything above last_uid, so starting at
// zero would auto-reply to every email already sitting in the inbox, years-old
// threads included. Whatever is in there now is left alone.
export type MailboxCheck = { error: string } | { lastUid: number };

export function checkMailbox(user: string, password: string): Promise<MailboxCheck> {
  return new Promise((resolve) => {
    let settled = false;
    const imap = new Imap({
      user,
      password,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 15000,
      authTimeout: 12000,
    });

    const done = (result: MailboxCheck) => {
      if (settled) return;
      settled = true;
      try { imap.end(); } catch { /* already closed */ }
      resolve(result);
    };

    imap.once('ready', () => {
      // Read-only: opening the inbox must not mark anything as seen.
      imap.openBox('INBOX', true, (err: Error | null, box: { uidnext?: number }) => {
        if (err) {
          done({ error: 'Signed in, but could not open the inbox. Check that IMAP is enabled in Gmail.' });
          return;
        }

        // uidnext is the id the next arriving message will get, so everything
        // already in the mailbox sits below it.
        if (typeof box?.uidnext === 'number' && box.uidnext > 0) {
          done({ lastUid: box.uidnext - 1 });
          return;
        }

        // No uidnext — fall back to the highest id actually present. Failing
        // closed here matters: guessing zero would answer the whole mailbox.
        imap.search(['ALL'], (searchErr: Error | null, uids: number[]) => {
          if (searchErr || !Array.isArray(uids)) {
            done({ error: 'Could not read the mailbox state. Try connecting again in a moment.' });
            return;
          }
          done({ lastUid: uids.length ? Math.max(...uids) : 0 });
        });
      });
    });

    imap.once('error', (err: Error & { textCode?: string }) => {
      const text = `${err?.textCode || ''} ${err?.message || ''}`.toLowerCase();
      if (text.includes('invalid credentials') || text.includes('authenticationfailed')) {
        done({ error: 'Gmail rejected that address and app password. Use a 16-character App Password, not the normal account password.' });
      } else if (text.includes('imap access is disabled') || text.includes('not enabled')) {
        done({ error: 'IMAP is switched off for this mailbox. Turn it on in Gmail settings, then try again.' });
      } else if (text.includes('timeout') || text.includes('etimedout')) {
        done({ error: 'Gmail did not answer in time. Try again in a moment.' });
      } else {
        done({ error: err?.message || 'Could not sign in to that mailbox.' });
      }
    });
    imap.once('end', () => done({ error: 'The connection closed before sign-in finished.' }));

    try {
      imap.connect();
    } catch {
      done({ error: 'Could not reach Gmail.' });
    }
  });
}

