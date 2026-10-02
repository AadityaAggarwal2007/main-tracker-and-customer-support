'use client';

import type { ReactNode } from 'react';
import type { PersonRow } from '@/lib/team-score/types';
import { HEAD, RANK_COL, RANK_W, small, td } from './TeamScoreShared';

export default function TeamScoreTable({ board, owner, row }: {
  board: PersonRow[]; owner: PersonRow | null; row: (p: PersonRow, owner?: boolean) => ReactNode;
}) {
  return (
            <div className="tf-card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
                <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', minWidth: 1240, fontSize: '0.8125rem' }}>
                  <thead>
                    <tr>
                      {[{ label: '#', hint: '' }, { label: 'Person', hint: '' }, ...HEAD].map((h, i) => (
                        <th key={h.label} scope="col" style={{
                          padding: '0.625rem 0.75rem', borderBottom: '1px solid var(--border)', background: 'var(--bg-subtle)',
                          verticalAlign: 'bottom', whiteSpace: 'nowrap', fontWeight: 600, color: 'var(--fg)', textAlign: i < 2 || h.label === 'Sent to' ? 'left' : 'right',
                          ...(i === 0 ? { position: 'sticky', left: 0, zIndex: 2, ...RANK_COL } : {}),
                          ...(i === 1 ? { position: 'sticky', left: RANK_W, zIndex: 2, boxShadow: 'inset -1px 0 0 var(--border)' } : {}),
                        }}>
                          {h.label}
                          {h.hint && <div style={{ ...small, fontWeight: 400, fontStyle: 'italic' }}>{h.hint}</div>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {board.map((p) => row(p))}
                    {!board.length && (
                      <tr><td colSpan={HEAD.length + 2} style={{ ...td, textAlign: 'left', color: 'var(--fg-muted)' }}>No team member has a number in this period yet.</td></tr>
                    )}
                    {owner && (
                      <>
                        <tr aria-hidden="true"><td colSpan={HEAD.length + 2} style={{ padding: 0, height: 6, background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }} /></tr>
                        {row(owner, true)}
                      </>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
  );
}
