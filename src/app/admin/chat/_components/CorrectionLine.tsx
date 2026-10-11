'use client';

import { useState } from 'react';
import { ChevronDown, Wrench } from 'lucide-react';
import { correctionLine, isOverdue } from '@/lib/chat/corrections-rules';
import type { CorrectionRow } from '../_lib/types';

// The open chat's corrections (owner 2026-10-11): one line per pending one at the top of the chat ("Correction
// pending · Size, Colour · by Rahul · 3 h", red once over a day) and the done ones folded under "N done". Staff only;
// the note itself stays in Chat Support > Corrections (it can hold an address or a phone number).
export default function CorrectionLine({ rows }: { rows: CorrectionRow[] }) {
  const [open, setOpen] = useState(false);
  if (!rows || rows.length === 0) return null;
  const pending = rows.filter((r) => r.status === 'pending');
  const closed = rows.filter((r) => r.status !== 'pending');
  return (
    <div className="corr-line meta" role="note" aria-label="Corrections on this chat">
      {pending.map((r) => (
        <div key={r.id} className={`corr-item${isOverdue(r) ? ' corr-late' : ''}`} title={r.note}>
          <Wrench size={12} /> {correctionLine(r)}
        </div>
      ))}
      {closed.length > 0 && (
        <div>
          <button type="button" className="meta-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {closed.length} correction{closed.length === 1 ? '' : 's'} done <ChevronDown />
          </button>
          {open && closed.map((r) => <div key={r.id} className="corr-item corr-done" title={r.done_note || r.note}>{correctionLine(r)}</div>)}
        </div>
      )}
    </div>
  );
}
