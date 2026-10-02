'use client';

import { TRACKING_STAGES_WITH_SPECIAL, STAGE_ICONS } from '@/lib/constants';
import { X, Calendar, StickyNote } from 'lucide-react';

export default function BulkStatusModal({ bulkCourier, bulkEstDelivery, bulkNotes, bulkStatus, bulkTrackingId, handleBulkUpdate, selectedOrders, setBulkCourier, setBulkEstDelivery, setBulkNotes, setBulkStatus, setBulkTrackingId, setShowStatusModal }: {
  bulkCourier: string;
  bulkEstDelivery: string;
  bulkNotes: string;
  bulkStatus: string;
  bulkTrackingId: string;
  handleBulkUpdate: () => Promise<void>;
  selectedOrders: Set<string>;
  setBulkCourier: React.Dispatch<React.SetStateAction<string>>;
  setBulkEstDelivery: React.Dispatch<React.SetStateAction<string>>;
  setBulkNotes: React.Dispatch<React.SetStateAction<string>>;
  setBulkStatus: React.Dispatch<React.SetStateAction<string>>;
  setBulkTrackingId: React.Dispatch<React.SetStateAction<string>>;
  setShowStatusModal: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  return (
        <div className="modal-overlay" onClick={() => setShowStatusModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3 className="modal-title">Update {selectedOrders.size} Orders</h3>
              </div>
              <button className="btn-icon" onClick={() => setShowStatusModal(false)}><X size={16} /></button>
            </div>
            <div className="space-y-4">
              <div className="form-group">
                <label className="form-label">New Status</label>
                <select className="form-select" style={{ width: '100%' }} value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)}>
                  <option value="">Select status...</option>
                  {TRACKING_STAGES_WITH_SPECIAL.map((s) => (<option key={s} value={s}>{STAGE_ICONS[s]} {s}</option>))}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Tracking ID (optional)</label>
                <input type="text" className="form-input" placeholder="TRK..." value={bulkTrackingId} onChange={(e) => setBulkTrackingId(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Courier Partner (optional)</label>
                <input type="text" className="form-input" placeholder="e.g., Delhivery" value={bulkCourier} onChange={(e) => setBulkCourier(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label"><Calendar size={12} style={{ display: 'inline', marginRight: '0.25rem' }} />Estimated Delivery (optional)</label>
                <input type="date" className="form-input" value={bulkEstDelivery} onChange={(e) => setBulkEstDelivery(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label"><StickyNote size={12} style={{ display: 'inline', marginRight: '0.25rem' }} />Note (optional)</label>
                <textarea className="form-input" rows={2} placeholder="e.g., Dispatched via express" value={bulkNotes} onChange={(e) => setBulkNotes(e.target.value)} style={{ height: 'auto', resize: 'vertical' }} />
              </div>
              <div className="modal-actions">
                <button className="btn btn-outline" onClick={() => setShowStatusModal(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={handleBulkUpdate} disabled={!bulkStatus}>Apply</button>
              </div>
            </div>
          </div>
        </div>
  );
}
