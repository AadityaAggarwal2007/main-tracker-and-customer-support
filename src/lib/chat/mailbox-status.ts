// ── Is a connected Gmail being read? (owner 2026-10-08, step 2) ───────────────────────────────
// The poller (email.ts, every minute) notes here, per mailbox, when it last signed in and either that it
// worked or why it did not. Kept in memory only (one PM2 process, nothing to migrate): after a restart the
// card says "not checked yet" for up to a minute. No password or mail text is ever kept here.

export interface MailboxStatus {
  checkedAt: number;          // ms, the last attempt
  ok: boolean;
  error: string | null;       // short, safe words for the Settings card
  lastMailAt: number | null;  // ms, the last time the poller took in a new mail
  received: number;           // new mails taken in since the app started
}

const G = globalThis as unknown as { __mailboxStatus?: Map<string, MailboxStatus> };
const store = (): Map<string, MailboxStatus> => (G.__mailboxStatus ??= new Map());

// ImapFlow's own message is often just "Command failed": Gmail's reason sits in responseText / response / code, so the
// words that decide the friendly text are collected from all of them (owner 2026-10-08: a chargeback Gmail said only
// "Could not read this mailbox"). Safe to log: it is what Gmail answered, never a password.
export function mailErrorText(e: unknown): string {
  const x = (e || {}) as { message?: string; responseText?: string; response?: string; code?: string; serverResponseCode?: string; authenticationFailed?: boolean };
  return [x.message, x.responseText, x.response, x.code, x.serverResponseCode, x.authenticationFailed ? 'authentication failed' : ''].filter(Boolean).join(' | ');
}

// Turns an IMAP error into words the owner can act on; never echoes the raw server text.
export function friendlyMailError(message: string | undefined | null): string {
  const t = (message || '').toLowerCase();
  if (t.includes('invalid credentials') || t.includes('authenticationfailed') || t.includes('authentication failed') || t.includes('auth')) {
    return 'Gmail rejected the App Password. Remove the mailbox and connect it again with a new App Password.';
  }
  if (t.includes('too many') || t.includes('simultaneous')) return 'Gmail has too many connections open for this account. It tries again every minute.';
  if (t.includes('web login') || t.includes('application-specific')) return 'Google wants a sign-in or an App Password for this account. Open Gmail once in a browser, then connect it again with a new App Password.';
  if (t.includes('imap') && (t.includes('disabled') || t.includes('not enabled'))) return 'IMAP is switched off in this Gmail. Turn it on in Gmail settings.';
  if (t.includes('timeout') || t.includes('etimedout') || t.includes('econnreset') || t.includes('enotfound')) return 'Gmail did not answer in time. It tries again every minute.';
  return 'Could not read this mailbox. It tries again every minute.';
}

export function noteMailboxCheck(id: string, r: { ok: boolean; error?: string | null; handled?: number; now?: number }): void {
  const now = r.now ?? Date.now();
  const prev = store().get(id);
  const handled = r.handled ?? 0;
  store().set(id, {
    checkedAt: now,
    ok: r.ok,
    error: r.ok ? null : (r.error ?? friendlyMailError(null)),
    lastMailAt: handled > 0 ? now : (prev?.lastMailAt ?? null),
    received: (prev?.received ?? 0) + handled,
  });
}

export function getMailboxStatus(id: string): MailboxStatus | null {
  return store().get(id) ?? null;
}
