'use client';

import { X } from 'lucide-react';
import type { Order } from '../_lib/types';

export default function SelectRangeModal({ orders, rangeFrom, rangeMode, rangeTo, selectRange, selectedOrders, setRangeFrom, setRangeMode, setRangeTo, setSelectedOrders, setShowRangeModal, showAlert }: {
  orders: Order[];
  rangeFrom: string;
  rangeMode: 'row' | 'order';
  rangeTo: string;
  selectRange: (from: number, to: number) => void;
  selectedOrders: Set<string>;
  setRangeFrom: React.Dispatch<React.SetStateAction<string>>;
  setRangeMode: React.Dispatch<React.SetStateAction<'row' | 'order'>>;
  setRangeTo: React.Dispatch<React.SetStateAction<string>>;
  setSelectedOrders: React.Dispatch<React.SetStateAction<Set<string>>>;
  setShowRangeModal: React.Dispatch<React.SetStateAction<boolean>>;
  showAlert: (type: string, message: string) => void;
}) {
  return (
        <div className="modal-overlay" onClick={() => setShowRangeModal(false)}>
          <div className="modal" style={{ maxWidth: '400px' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3 className="modal-title">📏 Select Range</h3>
                <p className="modal-subtitle">Select orders by {rangeMode === 'order' ? 'Order ID' : 'row number'}</p>
              </div>
              <button className="btn-icon" onClick={() => setShowRangeModal(false)}><X size={16} /></button>
            </div>
            <div className="space-y-4">
              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <button className={`btn btn-sm ${rangeMode === 'order' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setRangeMode('order')}>By Order ID</button>
                <button className={`btn btn-sm ${rangeMode === 'row' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setRangeMode('row')}>By Row #</button>
              </div>
              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">From {rangeMode === 'order' ? 'Order ID' : 'row'}</label>
                  <input type="text" className="form-input" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} placeholder={rangeMode === 'order' ? '#1800' : '1'} />
                </div>
                <span style={{ paddingTop: '1.5rem', color: 'var(--fg-muted)' }}>to</span>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">To {rangeMode === 'order' ? 'Order ID' : 'row'}</label>
                  <input type="text" className="form-input" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} placeholder={rangeMode === 'order' ? '#1900' : orders.length.toString()} />
                </div>
              </div>
              <div className="modal-actions">
                <button className="btn btn-outline" onClick={() => setShowRangeModal(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={() => {
                  if (rangeMode === 'order') {
                    // Select by Order ID range
                    const fromId = rangeFrom.replace('#', '').trim();
                    const toId = rangeTo.replace('#', '').trim();
                    const fromNum = parseInt(fromId) || 0;
                    const toNum = parseInt(toId) || 99999;
                    const next = new Set(selectedOrders);
                    let count = 0;
                    orders.forEach((o) => {
                      const num = parseInt(o.order_id.replace('#', '').replace(/\D/g, ''));
                      if (num >= fromNum && num <= toNum) {
                        next.add(o.order_id);
                        count++;
                      }
                    });
                    setSelectedOrders(next);
                    showAlert('success', `Selected ${count} orders from #${fromId} to #${toId}`);
                  } else {
                    // Select by row number
                    const from = parseInt(rangeFrom) || 1;
                    const to = parseInt(rangeTo) || orders.length;
                    selectRange(from, to);
                    showAlert('success', `Selected rows ${from} to ${to}`);
                  }
                  setShowRangeModal(false);
                  setRangeFrom('');
                  setRangeTo('');
                }}>
                  Select
                </button>
              </div>
            </div>
          </div>
        </div>
  );
}
