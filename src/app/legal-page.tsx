// Public legal pages (/privacy, /terms, /data-deletion): plain server-rendered text, no login, no script.
// Meta needs a privacy policy URL, terms URL and data-deletion instructions to switch the WhatsApp app
// to Live (owner 2026-10-10). Keep them factual about what ShipTrack actually does.
import type { ReactNode } from 'react';
import type { CSSProperties } from 'react';

export const LEGAL_UPDATED = '10 October 2026';

const wrap: CSSProperties = { maxWidth: 760, margin: '0 auto', padding: '2.5rem 1rem 4rem', color: 'var(--fg, #1f1f2e)', lineHeight: 1.6, fontSize: '1rem' };
const h1: CSSProperties = { fontSize: '1.75rem', margin: '0 0 0.25rem' };
const h2: CSSProperties = { fontSize: '1.15rem', margin: '1.75rem 0 0.5rem' };
const muted: CSSProperties = { color: 'var(--fg-muted, #5b5b6e)', fontSize: '0.9rem', margin: '0 0 1.5rem' };

export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main style={wrap}>
      <p style={{ margin: '0 0 1.5rem' }}><a href="/" style={{ color: 'var(--primary, #5b21b6)', textDecoration: 'none', fontWeight: 600 }}>ShipTrack</a></p>
      <h1 style={h1}>{title}</h1>
      <p style={muted}>Last updated {LEGAL_UPDATED}</p>
      {children}
      <p style={{ ...muted, marginTop: '2.5rem' }}>
        <a href="/privacy" style={{ color: 'inherit' }}>Privacy policy</a> · <a href="/terms" style={{ color: 'inherit' }}>Terms of service</a> · <a href="/data-deletion" style={{ color: 'inherit' }}>Data deletion</a>
      </p>
    </main>
  );
}

export const H2 = ({ children }: { children: ReactNode }) => <h2 style={h2}>{children}</h2>;
