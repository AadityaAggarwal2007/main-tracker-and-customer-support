import type { Metadata } from 'next';

// ── The customer's refund form, /refund (owner, 2026-10-02) ─────
// Only the Super Admin sends it, from a Refund chat; the link's key is in the URL fragment (#...),
// which the browser never sends to the server, and the page removes it from the address bar at once.
// Not indexed, no referrer, never framed (next.config.js headers), never cached: every visit asks
// /api/refund/open again. Spec refund_form_spec.md 5.1.
export const metadata: Metadata = {
  title: 'Refund request',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

// Rendered per request, so Next.js answers it with no-store instead of a cached static page.
export const dynamic = 'force-dynamic';

export default function RefundLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
