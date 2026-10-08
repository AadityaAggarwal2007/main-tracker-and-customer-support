'use client';

import { AlertTriangle } from 'lucide-react';

// "Is this the right panel?" (owner 2026-10-08): shown before a CSV is sent when the file looks like it
// belongs to another panel. Cancel is the default; "Upload anyway" is written into the upload record.
export default function UploadWarningDialog({ panelName, warnings, onAnswer }: {
  panelName: string;
  warnings: { code: string; message: string }[];
  onAnswer: (ok: boolean) => void;
}) {
  return (
    <div className="modal-overlay" onClick={() => onAnswer(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="alertdialog" aria-label="Check the panel">
        <div className="modal-header">
          <h3 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertTriangle size={18} style={{ color: 'var(--warning)' }} /> Check the panel first
          </h3>
        </div>
        <div className="space-y-4">
          <p style={{ fontSize: '0.875rem' }}>You are about to upload this file into <b>{panelName}</b>. This looks wrong:</p>
          <ul style={{ margin: '0 0 0 1.1rem', fontSize: '0.875rem', lineHeight: 1.5 }}>
            {warnings.map((w) => <li key={w.code}>{w.message}</li>)}
          </ul>
          <p style={{ fontSize: '0.8125rem', color: 'var(--fg-secondary)' }}>
            Orders from the wrong file land in the wrong panel and are hard to undo. If you are sure, upload anyway: this is saved in the upload record.
          </p>
          <div className="modal-actions">
            <button className="btn btn-primary" autoFocus onClick={() => onAnswer(false)}>Cancel, I will check</button>
            <button className="btn btn-outline" onClick={() => onAnswer(true)}>Upload anyway</button>
          </div>
        </div>
      </div>
    </div>
  );
}
