'use client';

import { metaHint } from '@/lib/chat/whatsapp-errors';

// Meta's error as it came, with what it means and what to do under it (whatsapp-errors.ts).
export default function MetaError({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  const hint = metaHint(error);
  return (
    <div style={{ display: 'grid', gap: 6, margin: '0.25rem 0 0.75rem' }}>
      <p className="wa-err">{error}</p>
      {hint && <div className="wa-hint"><strong>What it means:</strong> {hint.what}<strong style={{ marginTop: 4 }}>What to do:</strong> {hint.fix}</div>}
    </div>
  );
}
