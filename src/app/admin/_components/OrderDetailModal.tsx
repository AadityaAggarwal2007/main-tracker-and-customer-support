'use client';

import { TRACKING_STAGES_WITH_SPECIAL, STAGE_ICONS, getStatusColorClass } from '@/lib/constants';
import { X, Truck, MessageCircle, Mail } from 'lucide-react';
import type { Order } from '../_lib/types';

export default function OrderDetailModal({ detailOrder, handleSingleStatusUpdate, hasPermission, sendEmail, sendWhatsApp, setShowDetailModal }: {
  detailOrder: Order | null;
  handleSingleStatusUpdate: (orderId: string, status: string) => Promise<void>;
  hasPermission: (perm: string) => boolean;
  sendEmail: (order: Order) => Promise<void>;
  sendWhatsApp: (order: Order) => void;
  setShowDetailModal: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  return (
        <div className="modal-overlay" onClick={() => setShowDetailModal(false)}>
          <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3 className="modal-title">Order {detailOrder.order_id}</h3>
                <p className="modal-subtitle">Placed on {new Date(detailOrder.created_at).toLocaleDateString()}</p>
              </div>
              <button className="btn-icon" onClick={() => setShowDetailModal(false)}><X size={16} /></button>
            </div>

            <div className="space-y-4">
              {/* Status */}
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <span className={`status-pill ${getStatusColorClass(detailOrder.is_cancelled ? 'Cancelled' : detailOrder.tracking_status)}`}>
                  {detailOrder.is_cancelled ? 'Cancelled' : detailOrder.tracking_status}
                </span>
              </div>

              {/* Details */}
              <div className="detail-grid">
                <div><p className="detail-field-label">Customer</p><p className="detail-field-value">{detailOrder.customer_name}</p></div>
                <div><p className="detail-field-label">Email</p><p className="detail-field-value">{detailOrder.customer_email || '—'}</p></div>
                <div><p className="detail-field-label">Phone</p><p className="detail-field-value">{detailOrder.customer_mobile}</p></div>
                <div><p className="detail-field-label">Total</p><p className="detail-field-value">₹{Number(detailOrder.order_total).toLocaleString()}</p></div>
                <div><p className="detail-field-label">City</p><p className="detail-field-value">{detailOrder.city}, {detailOrder.state}</p></div>
                <div><p className="detail-field-label">Pincode</p><p className="detail-field-value">{detailOrder.pincode}</p></div>
                <div className="detail-field-full">
                  <p className="detail-field-label">Address</p>
                  <p className="detail-field-value">{[detailOrder.address_line1, detailOrder.address_line2].filter(Boolean).join(', ')}</p>
                </div>
              </div>

              {/* Courier */}
              {detailOrder.tracking_id && (
                <div className="alert-band alert-info-band">
                  <Truck size={16} />
                  <span><strong>{detailOrder.tracking_id}</strong> • {detailOrder.courier_partner}</span>
                </div>
              )}

              {/* Status update */}
              {hasPermission('update_status') && (
                <div>
                  <label className="form-label" style={{ fontSize: '0.75rem' }}>Update Status</label>
                  <select
                    className="form-select"
                    style={{ width: '100%' }}
                    defaultValue={detailOrder.is_cancelled ? 'Cancelled' : detailOrder.tracking_status}
                    onChange={(e) => handleSingleStatusUpdate(detailOrder.order_id, e.target.value)}
                  >
                    {TRACKING_STAGES_WITH_SPECIAL.map((s) => (<option key={s} value={s}>{STAGE_ICONS[s]} {s}</option>))}
                  </select>
                </div>
              )}

              {/* Items */}
              {detailOrder.order_items && detailOrder.order_items.length > 0 && (
                <div>
                  <p style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', marginBottom: '0.5rem' }}>Items ({detailOrder.order_items.length})</p>
                  <div className="items-list">
                    {detailOrder.order_items.map((item, i) => (
                      <div key={i} className="item-row">
                        <div className="item-info">
                          <div className="item-name">{item.product_name}</div>
                          <span className="item-brand-tag">{item.brand}</span>
                        </div>
                        <div className="item-pricing">
                          <div className="item-price">₹{Number(item.price).toLocaleString()}</div>
                          <div className="item-qty">×{item.quantity}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Action buttons */}
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button className="btn btn-whatsapp" onClick={() => sendWhatsApp(detailOrder)} style={{ flex: 1, height: '2.5rem' }}>
                  <MessageCircle size={16} /> WhatsApp
                </button>
                <button className="btn btn-email" onClick={() => sendEmail(detailOrder)} style={{ flex: 1, height: '2.5rem' }} disabled={!detailOrder.customer_email}>
                  <Mail size={16} /> Email
                </button>
              </div>
            </div>
          </div>
        </div>
  );
}
