'use client';

// Which brand a team member's screen shows (owner 2026-10-14: "dusri brand ki chat dekhna mix mat kar, staff ka lia alag
// alag karde bilkul" + "open on their own brand"): a member (not the Super Admin, not the Manager) always looks at ONE
// panel, never "All panels" mixed; the first page of a browser session opens on the brand they manage. Rules in
// brand-managers-rules.ts brandPanelFor; the admin page and the inbox both call this.
import { useEffect, useRef } from 'react';
import { brandPanelFor } from '@/lib/chat/brand-managers-rules';

const DONE_KEY = 'brand_home_done';

export function useBrandPanel(opts: {
  token: string; separate: boolean; allowed: string[]; current: string; ready: boolean; apply: (panelId: string) => void;
}) {
  const { token, separate, allowed, current, ready, apply } = opts;
  const home = useRef<string[] | null>(null);
  const key = allowed.join(',');
  useEffect(() => {
    if (!token || !ready || !separate || !allowed.length) return;
    let gone = false;
    (async () => {
      if (home.current === null) {
        try {
          const r = await fetch('/api/team/brand-managers', { headers: { Authorization: `Bearer ${token}` } });
          const j = await r.json().catch(() => ({}));
          home.current = Array.isArray(j.mine) ? j.mine : [];
        } catch { home.current = []; }
      }
      if (gone) return;
      let first = false;
      try { first = !sessionStorage.getItem(DONE_KEY); sessionStorage.setItem(DONE_KEY, '1'); } catch { /* no storage: not the first */ }
      const want = brandPanelFor(current, allowed, home.current || [], separate, first);
      if (want && want !== current) apply(want);
    })();
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, ready, separate, key, current]);
}
