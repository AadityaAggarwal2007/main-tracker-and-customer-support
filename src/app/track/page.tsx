'use client';

import { useState, FormEvent, useEffect } from 'react';
import { Search, Loader2, AlertCircle, Truck, ClipboardCheck, PackageCheck, CheckCircle, Package, MapPin, Phone, Mail } from 'lucide-react';

interface OrderItem { brand: string; product_name: string; quantity: number; price: number; }
interface TrackingOrder {
  order_id: string; customer_name: string; tracking_status: string; tracking_id: string;
  courier_partner: string; estimated_delivery: string; order_total: number; is_cancelled: boolean;
  city: string; state: string; created_at: string; order_items: OrderItem[];
}
interface Business { name: string; logo_url: string; support_email: string; support_phone: string; }
interface TrackingHistory { status: string; created_at: string; notes: string; }

const STEPS = [
  { label: 'Order\nBooked',       key: 'booked',    Icon: ClipboardCheck },
  { label: 'Pickup\nCompleted',   key: 'pickup',    Icon: PackageCheck   },
  { label: 'In-Transit',          key: 'transit',   Icon: Truck          },
  { label: 'Out For\nDelivery',   key: 'out',       Icon: MapPin         },
  { label: 'Delivered',           key: 'delivered', Icon: CheckCircle    },
];

const statusToStep: Record<string, number> = {
  'order placed': 0, processing: 0, packed: 1, shipped: 1,
  'in transit': 2, 'out for delivery': 3, delivered: 4,
};

const getDisplayStatus = (s: string, c: boolean) => {
  if (c) return 'Cancelled';
  const m: Record<string, string> = {
    'order placed': 'Order Placed', processing: 'Processing', packed: 'Packed',
    shipped: 'Shipped', 'in transit': 'In Transit', 'out for delivery': 'Out For Delivery',
    delivered: 'Delivered', rto: 'RTO In Transit',
  };
  return m[s.toLowerCase()] || s;
};

export default function TrackingPage() {
  const [orderId, setOrderId]     = useState('');
  const [phone, setPhone]         = useState('');
  const [order, setOrder]         = useState<TrackingOrder | null>(null);
  const [business, setBusiness]   = useState<Business | null>(null);
  const [history, setHistory]     = useState<TrackingHistory[]>([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');

  // Load brand info on mount so header shows correct logo/name immediately
  useEffect(() => {
    fetch('/api/brand')
      .then(r => r.json())
      .then(d => { if (d.business) setBusiness(d.business); })
      .catch(() => {});
  }, []);

  const handleSearch = async (e: FormEvent) => {
    e.preventDefault();
    setError(''); setOrder(null); setBusiness(null); setLoading(true);
    try {
      let sid = orderId.trim();
      if (!sid.startsWith('#')) sid = '#' + sid;
      const r = await fetch(`/api/track?orderId=${encodeURIComponent(sid)}&phone=${phone}`);
      const d = await r.json();
      if (!r.ok) setError(d.error || 'Order not found');
      else { setOrder(d.order); if (d.business) setBusiness(d.business); setHistory(d.history || []); }
    } catch { setError('Something went wrong.'); }
    finally { setLoading(false); }
  };

  const currentStep   = order ? (order.is_cancelled ? -1 : (statusToStep[order.tracking_status.toLowerCase()] ?? -1)) : -1;
  const displayStatus = order ? getDisplayStatus(order.tracking_status, order.is_cancelled) : '';

  const logoUrl = (() => {
    const u = business?.logo_url;
    if (!u) return null;
    return u.includes('drive.google.com') ? u.replace(/\/file\/d\/([^/]+).*/, '/uc?export=view&id=$1') : u;
  })();

  const brandName = business?.name || 'Order Tracking';

  const fmt = (iso: string) => {
    const d = new Date(iso);
    return {
      date: d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
      time: d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }),
    };
  };

  /* ─── ORANGE = #e8712e  DARK = #1a1d23  BG = #eef1f7 ─── */
  const ORANGE = '#e8712e';
  const DARK   = '#1a1d23';
  const BG     = '#eef1f7';
  const CARD   = { background: '#fff', borderRadius: '12px', padding: '20px 24px', boxShadow: '0 1px 6px rgba(0,0,0,0.07)' };

  return (
    <div style={{ minHeight: '100vh', background: BG, fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif', color: DARK }}>

      {/* ── HEADER ── */}
      <header style={{ background: '#fff', borderBottom: '1px solid #e5e7eb', padding: '10px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {/* Brand logo */}
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {logoUrl
            ? <img src={logoUrl} alt={brandName} style={{ height: '54px', maxWidth: '180px', objectFit: 'contain' }} />
            : <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ width: '46px', height: '46px', borderRadius: '50%', background: DARK, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: '18px' }}>
                  {brandName.charAt(0)}
                </div>
                <span style={{ fontWeight: 700, fontSize: '18px' }}>{brandName}</span>
              </div>
          }
        </div>
        {/* "Powered by" badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: '#6b7280' }}>
          <div style={{ textAlign: 'right', lineHeight: 1.4 }}>
            <div>Shipping</div>
            <div><span style={{ color: ORANGE, fontWeight: 600 }}>Powered</span> by</div>
          </div>
          <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: DARK, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Package size={22} color="#fff" />
          </div>
        </div>
      </header>

      {/* ── BODY ── */}
      <main style={{ maxWidth: '1100px', margin: '0 auto', padding: '24px 16px' }}>

        {/* Search form */}
        {!order && (
          <div style={{ maxWidth: '440px', margin: '48px auto 0' }}>
            <form onSubmit={handleSearch} style={{ ...CARD, padding: '28px' }}>
              <h2 style={{ margin: '0 0 4px', fontSize: '20px', fontWeight: 700 }}>Track Your Order</h2>
              <p style={{ margin: '0 0 20px', fontSize: '13px', color: '#6b7280' }}>Enter your order ID and phone number</p>
              <input
                type="text" placeholder="Order ID (e.g. 1744)" value={orderId}
                onChange={e => setOrderId(e.target.value)} required
                style={{ width: '100%', padding: '11px 14px', borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: '14px', marginBottom: '12px', boxSizing: 'border-box', outline: 'none' }}
              />
              <div style={{ display: 'flex', gap: '10px' }}>
                <input
                  type="text" placeholder="Last 4 digits of phone" value={phone}
                  onChange={e => setPhone(e.target.value)} maxLength={4} required
                  style={{ flex: 1, padding: '11px 14px', borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: '14px', outline: 'none' }}
                />
                <button type="submit" disabled={loading} style={{ padding: '11px 22px', background: ORANGE, color: '#fff', border: 'none', borderRadius: '8px', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '14px', flexShrink: 0 }}>
                  {loading ? <Loader2 size={16} style={{ animation: 'spin 0.6s linear infinite' }} /> : <Search size={16} />} Track
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{ maxWidth: '440px', margin: '12px auto', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '8px', color: '#dc2626', fontSize: '14px' }}>
            <AlertCircle size={16} /> {error}
          </div>
        )}

        {order && (
          <>
            {/* ── TWO-COLUMN GRID ── */}
            <div className="track-grid">

              {/* LEFT — 3 stacked cards */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

                {/* Order Status */}
                <div style={CARD}>
                  <p style={{ margin: '0 0 8px', fontSize: '13px', color: '#6b7280', fontWeight: 500 }}>Order Status</p>
                  <p style={{ margin: 0, fontSize: '28px', fontWeight: 700, color: order.is_cancelled ? '#dc2626' : DARK }}>{displayStatus}</p>
                </div>

                {/* Estimated Delivery */}
                {order.estimated_delivery && (
                  <div style={CARD}>
                    <p style={{ margin: '0 0 8px', fontSize: '13px', color: '#6b7280', fontWeight: 500 }}>Estimated Delivery by</p>
                    <p style={{ margin: 0, fontSize: '22px', fontWeight: 700, color: DARK }}>
                      {new Date(order.estimated_delivery).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })}
                    </p>
                  </div>
                )}

                {/* Order Details */}
                <div style={CARD}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
                    <Package size={18} />
                    <span style={{ fontWeight: 700, fontSize: '16px' }}>Order Details</span>
                  </div>
                  <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: '14px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: '13px', color: '#6b7280' }}>Order ID</span>
                      <span style={{ fontSize: '14px', fontWeight: 600 }}>{order.order_id}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '4px' }}>
                      <span style={{ fontSize: '13px', color: '#6b7280' }}>Order Shipped On</span>
                      <span style={{ fontSize: '13px', fontWeight: 600 }}>
                        {new Date(order.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })}{' '}
                        {new Date(order.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    {order.order_items?.length > 0 && (
                      <div>
                        <span style={{ fontSize: '12px', color: '#9ca3af', display: 'block', marginBottom: '4px' }}>Products</span>
                        {order.order_items.map((item, i) => (
                          <div key={i} style={{ fontSize: '13px', color: DARK, padding: '4px 0', borderTop: i > 0 ? '1px solid #f9fafb' : 'none' }}>
                            {item.product_name}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* RIGHT — Courier + Recent Activities */}
              <div style={{ ...CARD, display: 'flex', flexDirection: 'column' }}>
                {/* Courier header */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', paddingBottom: '16px', borderBottom: '1px solid #f3f4f6' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{ width: '54px', height: '54px', borderRadius: '50%', background: DARK, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: '13px', flexShrink: 0 }}>
                      {(order.courier_partner || 'CP').substring(0, 3).toUpperCase()}
                    </div>
                    <span style={{ fontWeight: 700, fontSize: '16px' }}>{order.courier_partner || 'Courier Partner'}</span>
                  </div>
                  {order.tracking_id && (
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '2px' }}>Tracking ID :</div>
                      <div style={{ fontSize: '14px', fontWeight: 700 }}>{order.tracking_id}</div>
                    </div>
                  )}
                </div>

                {/* Recent Activities heading */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
                  <Truck size={18} />
                  <span style={{ fontWeight: 700, fontSize: '16px' }}>Recent Activities</span>
                </div>

                {/* Timeline */}
                <div style={{ flex: 1, overflowY: 'auto', maxHeight: '300px', paddingRight: '4px' }}>
                  {history.length > 0 ? history.map((h, i) => {
                    const { date, time } = fmt(h.created_at);
                    const isLast = i === history.length - 1;
                    return (
                      <div key={i} style={{ display: 'flex', gap: '10px' }}>
                        {/* Date/time */}
                        <div style={{ width: '68px', flexShrink: 0, paddingTop: '2px' }}>
                          <div style={{ fontSize: '13px', fontWeight: 700, lineHeight: 1.3 }}>{date}</div>
                          <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '2px' }}>{time}</div>
                        </div>
                        {/* Dot + line */}
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                          <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: DARK, marginTop: '4px', flexShrink: 0, zIndex: 1 }} />
                          {!isLast && <div style={{ width: '1px', flex: 1, borderLeft: '2px dashed #d1d5db', minHeight: '30px' }} />}
                        </div>
                        {/* Activity */}
                        <div style={{ paddingBottom: '20px', flex: 1 }}>
                          <div style={{ fontSize: '13px', lineHeight: 1.5 }}>
                            Activity : {h.status}
                          </div>
                          {h.notes && h.notes.trim() && !h.notes.startsWith('Status updated') && !h.notes.startsWith('CSV import') && (
                            <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '2px' }}>
                              Location : {h.notes}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  }) : (
                    <p style={{ fontSize: '13px', color: '#9ca3af', margin: 0 }}>No activity yet — updates will appear here.</p>
                  )}
                </div>
              </div>
            </div>

            {/* ── STEPPER ── */}
            <div style={{ ...CARD, marginTop: '16px', padding: '28px 32px' }}>
              {/* Desktop horizontal stepper */}
              <div className="stepper-desktop">
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', position: 'relative' }}>
                  {/* Background line */}
                  <div style={{ position: 'absolute', top: '27px', left: '28px', right: '28px', height: '2px', background: '#e5e7eb', zIndex: 0 }} />
                  {/* Progress line */}
                  {currentStep > 0 && (
                    <div style={{
                      position: 'absolute', top: '27px', left: '28px',
                      width: `calc(${(currentStep / (STEPS.length - 1)) * 100}% * (1 - 56px / 100%) )`,
                      maxWidth: `calc(100% - 56px)`,
                      height: '2px', background: DARK, zIndex: 1,
                      // simpler: use % of (total - 2*radius)
                    }} />
                  )}

                  {STEPS.map((step, i) => {
                    const done = !order.is_cancelled && i <= currentStep;
                    const Icon = step.Icon;
                    return (
                      <div key={step.key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative', zIndex: 10, flex: 1 }}>
                        <div style={{
                          width: '56px', height: '56px', borderRadius: '50%',
                          background: '#fff',
                          border: `2px solid ${done ? DARK : '#e5e7eb'}`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                        }}>
                          <Icon size={24} style={{ color: done ? ORANGE : '#9ca3af' }} strokeWidth={1.5} />
                        </div>
                        <span style={{
                          fontSize: '12px', marginTop: '10px', textAlign: 'center',
                          whiteSpace: 'pre-line', lineHeight: 1.4,
                          fontWeight: done ? 600 : 400,
                          color: done ? DARK : '#9ca3af',
                        }}>{step.label}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Mobile vertical stepper */}
              <div className="stepper-mobile">
                {STEPS.map((step, i) => {
                  const done = !order.is_cancelled && i <= currentStep;
                  const Icon = step.Icon;
                  const isLast = i === STEPS.length - 1;
                  return (
                    <div key={step.key} style={{ display: 'flex', alignItems: 'flex-start', gap: '16px' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                        <div style={{
                          width: '52px', height: '52px', borderRadius: '50%', background: '#fff',
                          border: `2px solid ${done ? DARK : '#e5e7eb'}`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                        }}>
                          <Icon size={22} style={{ color: done ? ORANGE : '#9ca3af' }} strokeWidth={1.5} />
                        </div>
                        {!isLast && <div style={{ width: '2px', height: '32px', background: done && i < currentStep ? DARK : '#e5e7eb' }} />}
                      </div>
                      <div style={{ paddingTop: '14px', paddingBottom: isLast ? 0 : '8px' }}>
                        <span style={{ fontSize: '14px', fontWeight: done ? 600 : 400, color: done ? DARK : '#9ca3af', whiteSpace: 'pre-line' }}>
                          {step.label.replace('\n', ' ')}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Back button */}
            <div style={{ textAlign: 'center', marginTop: '16px' }}>
              <button
                onClick={() => { setOrder(null); setError(''); setOrderId(''); setPhone(''); }}
                style={{ padding: '10px 28px', background: 'transparent', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '14px', cursor: 'pointer', color: '#374151' }}
              >
                ← Track another order
              </button>
            </div>
          </>
        )}
      </main>

      {/* ── FOOTER ── */}
      {business && (
        <footer style={{ background: '#fff', borderTop: '1px solid #e5e7eb', padding: '16px 24px', marginTop: '24px' }}>
          <div style={{ maxWidth: '1100px', margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ width: '36px', height: '36px', borderRadius: '50%', background: DARK, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Package size={18} color="#fff" />
              </div>
              <span style={{ fontSize: '14px' }}>
                <span style={{ color: ORANGE, fontWeight: 600 }}>Shipping </span>
                that fuels Ecommerce
                <span style={{ color: ORANGE, fontWeight: 600 }}> Success.</span>
              </span>
            </div>
            <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
              {business.support_phone && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#374151' }}>
                  <Phone size={14} /> {business.support_phone}
                </div>
              )}
              {business.support_email && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#374151' }}>
                  <Mail size={14} /> {business.support_email}
                </div>
              )}
            </div>
          </div>
        </footer>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

        .track-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
          margin-bottom: 0;
        }
        .stepper-desktop { display: block; }
        .stepper-mobile  { display: none; }

        @media (max-width: 768px) {
          .track-grid {
            grid-template-columns: 1fr;
          }
          .stepper-desktop { display: none; }
          .stepper-mobile  { display: flex; flex-direction: column; gap: 0; }
        }
      `}</style>
    </div>
  );
}
