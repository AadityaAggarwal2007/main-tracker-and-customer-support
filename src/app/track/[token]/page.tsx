'use client';

import { useState, useEffect } from 'react';
import { Package, Loader2, AlertCircle, ArrowLeft, MapPin, Truck, ClipboardCheck, PackageCheck, CheckCircle } from 'lucide-react';

interface OrderItem { brand: string; product_name: string; quantity: number; price: number; }
interface TrackingOrder {
  order_id: string; customer_name: string; tracking_status: string; tracking_id: string;
  courier_partner: string; estimated_delivery: string; order_total: number; is_cancelled: boolean;
  city: string; state: string; created_at: string; order_items: OrderItem[];
}
interface Business { name: string; logo_url: string; support_email: string; support_phone: string; }
interface TrackingHistory { status: string; created_at: string; notes: string; }

const getDisplayStatus = (s: string, c: boolean) => {
  if (c) return 'Cancelled';
  const m: Record<string, string> = {
    'order placed': 'Order Placed', processing: 'Processing', packed: 'Packed',
    shipped: 'Shipped', 'in transit': 'In Transit', 'out for delivery': 'Out For Delivery',
    delivered: 'Delivered', rto: 'RTO In Transit',
  };
  return m[s.toLowerCase()] || s;
};

const getStatusColor = (status: string, isCancelled: boolean) => {
  if (isCancelled) return '#EF4444';
  const s = status.toLowerCase();
  if (s === 'delivered') return '#10B981';
  return '#F97316';
};

const getSteps = (status: string) => {
  const baseSteps = [
    { label: 'Order\nBooked', key: 'booked', Icon: ClipboardCheck },
    { label: 'Pickup\nCompleted', key: 'pickup', Icon: PackageCheck },
    { label: 'In-Transit', key: 'transit', Icon: Truck },
    { label: 'Out For\nDelivery', key: 'out', Icon: MapPin },
  ];

  const s = status.toLowerCase();
  if (s.includes('undelivered') || s.includes('failed')) {
    return [
      ...baseSteps,
      { label: 'Undelivered', key: 'undelivered', Icon: AlertCircle },
      { label: 'Delivered', key: 'delivered', Icon: CheckCircle },
    ];
  } else if (s.includes('rto')) {
    return [
      ...baseSteps,
      { label: 'RTO In Transit', key: 'rto', Icon: AlertCircle },
      { label: 'Returned', key: 'returned', Icon: Package },
    ];
  } else {
    return [
      ...baseSteps,
      { label: 'Delivered', key: 'delivered', Icon: CheckCircle },
    ];
  }
};

const getStepIndex = (status: string, steps: any[]) => {
  const s = status.toLowerCase();
  if (s === 'order placed' || s === 'processing') return 0;
  if (s === 'packed' || s === 'shipped') return 1;
  if (s === 'in transit') return 2;
  if (s === 'out for delivery') return 3;
  
  if (s.includes('undelivered') || s.includes('failed')) {
    return steps.findIndex(x => x.key === 'undelivered');
  }
  if (s.includes('rto')) {
    return steps.findIndex(x => x.key === 'rto');
  }
  if (s === 'returned') {
    return steps.findIndex(x => x.key === 'returned');
  }
  if (s === 'delivered') {
    return steps.findIndex(x => x.key === 'delivered');
  }
  
  return -1;
};

export default function TrackingTokenPage({ params }: { params: { token: string } }) {
  const { token } = params;
  const [order, setOrder] = useState<TrackingOrder | null>(null);
  const [business, setBusiness] = useState<Business | null>(null);
  const [history, setHistory] = useState<TrackingHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/track?token=${token}`);
        const d = await r.json();
        if (!r.ok) setError(d.error || 'Order not found');
        else { setOrder(d.order); setBusiness(d.business || null); setHistory(d.history || []); }
      } catch { setError('Something went wrong'); }
      finally { setLoading(false); }
    })();
  }, [token]);

  const brandName = business?.name || 'Order Tracking';
  const logoUrl = (() => {
    const u = business?.logo_url;
    if (!u) return null;
    return u.includes('drive.google.com') ? u.replace(/\/file\/d\/([^/]+).*/, '/uc?export=view&id=$1') : u;
  })();

  const displayStatus = order ? getDisplayStatus(order.tracking_status, order.is_cancelled) : '';
  const statusColor = order ? getStatusColor(order.tracking_status, order.is_cancelled) : '#F97316';

  const fmt = (iso: string) => {
    const d = new Date(iso);
    return {
      date: d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
      time: d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }),
    };
  };

  const steps = order ? getSteps(order.tracking_status) : [];
  const currentStepIndex = order ? getStepIndex(order.tracking_status, steps) : -1;

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: '#EFF3F8', fontFamily: 'Inter, system-ui, -apple-system, sans-serif', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <Loader2 size={36} style={{ animation: 'spin 0.6s linear infinite', color: '#F97316' }} />
        <p style={{ marginTop: '12px', fontSize: '14px', color: '#64748B', fontWeight: 500 }}>Loading Tracking Details...</p>
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (error || !order) {
    return (
      <div style={{ minHeight: '100vh', background: '#EFF3F8', fontFamily: 'Inter, system-ui, -apple-system, sans-serif', color: '#1E293B', display: 'flex', flexDirection: 'column' }}>
        {/* HEADER */}
        <header style={{ background: '#FFFFFF', borderBottom: '1px solid #E2E8F0', padding: '14px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {logoUrl ? (
              <img src={logoUrl} alt={brandName} style={{ height: '36px', width: '36px', borderRadius: '50%', objectFit: 'cover', border: '1px solid #E2E8F0' }} />
            ) : (
              <div style={{ width: '36px', height: '36px', borderRadius: '50%', background: '#1E293B', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#FFFFFF', fontWeight: 700, fontSize: '14px' }}>
                {brandName.charAt(0)}
              </div>
            )}
            <span style={{ fontWeight: 700, fontSize: '18px', color: '#0F172A' }}>{brandName}</span>
          </div>
        </header>

        {/* ERROR CARD */}
        <main style={{ maxWidth: '440px', width: '100%', margin: '80px auto', padding: '0 16px', boxSizing: 'border-box' }}>
          <div style={{ background: '#FFFFFF', borderRadius: '12px', padding: '40px 24px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', border: '1px solid #E2E8F0' }}>
            <AlertCircle size={48} style={{ color: '#EF4444', margin: '0 auto 16px' }} />
            <h2 style={{ fontSize: '20px', fontWeight: 700, color: '#0F172A', margin: '0 0 8px' }}>Tracking Link Invalid</h2>
            <p style={{ fontSize: '14px', color: '#64748B', margin: '0 0 24px', lineHeight: 1.5 }}>This tracking link may have expired or the order could not be found. Please check your link or search by Order ID manually.</p>
            <a href="/track" style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '10px 20px', background: '#F97316', color: '#FFFFFF', borderRadius: '8px', fontSize: '14px', fontWeight: 600, textDecoration: 'none' }}>
              <ArrowLeft size={16} /> Search by Order ID
            </a>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: '#EFF3F8', fontFamily: 'Inter, system-ui, -apple-system, sans-serif', color: '#1E293B', display: 'flex', flexDirection: 'column' }}>
      
      {/* ── ADVISORY BANNER ── */}
      <div style={{ background: '#FFF7ED', borderBottom: '1px solid #FFEDD5', padding: '10px 16px', textAlign: 'center', fontSize: '13px', color: '#C2410C', fontWeight: 500 }}>
        ⚠️ <strong>Advisory:</strong> Beware of fraud calls & messages. Fship never asks for payment/OTP/card details or app downloads for shipping or delivery. Do not pay any extra amount to delivery agents.
      </div>

      {/* ── HEADER ── */}
      <header style={{ background: '#FFFFFF', borderBottom: '1px solid #E2E8F0', padding: '14px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
        {/* Brand logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {logoUrl ? (
            <img src={logoUrl} alt={brandName} style={{ height: '36px', width: '36px', borderRadius: '50%', objectFit: 'cover', border: '1px solid #E2E8F0' }} />
          ) : (
            <div style={{ width: '36px', height: '36px', borderRadius: '50%', background: '#1E293B', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#FFFFFF', fontWeight: 700, fontSize: '14px' }}>
              {brandName.charAt(0)}
            </div>
          )}
          <span style={{ fontWeight: 700, fontSize: '18px', color: '#0F172A' }}>{brandName}</span>
        </div>
        {/* "Powered by" badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#64748B' }}>
          <span>Shipping</span>
          <span style={{ color: '#F97316', fontWeight: 600 }}>Powered</span>
          <span>by</span>
          <div style={{ background: '#1E293B', color: '#FFFFFF', padding: '4px 8px', borderRadius: '4px', fontWeight: 700, fontSize: '11px', letterSpacing: '0.5px' }}>FShip</div>
        </div>
      </header>

      {/* ── BODY ── */}
      <main style={{ maxWidth: '1200px', width: '100%', margin: '0 auto', padding: '24px 16px', flex: 1, boxSizing: 'border-box' }}>
        
        {/* ── TWO-COLUMN GRID ── */}
        <div className="tracking-dashboard-grid">

          {/* LEFT — 3 stacked cards */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

            {/* Order Status */}
            <div className="fship-card">
              <p style={{ margin: '0 0 6px', fontSize: '13px', color: '#64748B', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Order Status</p>
              <p style={{ margin: 0, fontSize: '28px', fontWeight: 800, color: statusColor }}>{displayStatus}</p>
            </div>

            {/* Estimated Delivery */}
            {order.estimated_delivery && (
              <div className="fship-card">
                <p style={{ margin: '0 0 6px', fontSize: '13px', color: '#64748B', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Estimated Delivery by</p>
                <p style={{ margin: 0, fontSize: '22px', fontWeight: 800, color: '#0F172A' }}>
                  {new Date(order.estimated_delivery).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })}
                </p>
              </div>
            )}

            {/* Order Details */}
            <div className="fship-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                <Package size={18} style={{ color: '#F97316' }} />
                <span style={{ fontWeight: 700, fontSize: '16px', color: '#0F172A' }}>Order Details</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #F1F5F9', paddingBottom: '10px' }}>
                  <span style={{ fontSize: '14px', color: '#64748B' }}>Order ID</span>
                  <span style={{ fontSize: '14px', fontWeight: 600, color: '#0F172A' }}>{order.order_id}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #F1F5F9', paddingBottom: '10px' }}>
                  <span style={{ fontSize: '14px', color: '#64748B' }}>Order Shipped On</span>
                  <span style={{ fontSize: '14px', fontWeight: 600, color: '#0F172A' }}>
                    {new Date(order.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}{' '}
                    {new Date(order.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '2px' }}>
                  <span style={{ fontSize: '14px', color: '#64748B' }}>Delivery City</span>
                  <span style={{ fontSize: '14px', fontWeight: 600, color: '#0F172A' }}>{order.city || '—'}</span>
                </div>
                {order.order_items?.length > 0 && (
                  <div style={{ borderTop: '1px solid #F1F5F9', paddingTop: '12px', marginTop: '4px' }}>
                    <span style={{ fontSize: '12px', color: '#64748B', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: '8px' }}>Products</span>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {order.order_items.map((item, i) => (
                        <div key={i} style={{ fontSize: '13px', color: '#334155', background: '#F8FAFC', padding: '8px 12px', borderRadius: '6px', display: 'flex', justifyContent: 'space-between' }}>
                          <span>{item.product_name}</span>
                          <span style={{ fontWeight: 600 }}>Qty: {item.quantity}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* RIGHT — Courier + Recent Activities */}
          <div className="fship-card" style={{ display: 'flex', flexDirection: 'column' }}>
            {/* Courier header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #F1F5F9', paddingBottom: '14px', marginBottom: '16px' }}>
              <div>
                <div style={{ fontSize: '12px', color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Courier Partner</div>
                <div style={{ fontSize: '16px', fontWeight: 700, color: '#0F172A' }}>{order.courier_partner || 'Courier Partner'}</div>
              </div>
              {order.tracking_id && (
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '12px', color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Tracking ID</div>
                  <div style={{ fontSize: '16px', fontWeight: 700, color: '#0F172A' }}>{order.tracking_id}</div>
                </div>
              )}
            </div>

            {/* Recent Activities heading */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
              <Truck size={18} style={{ color: '#F97316' }} />
              <span style={{ fontWeight: 700, fontSize: '16px', color: '#0F172A' }}>Recent Activities</span>
            </div>

            {/* Timeline */}
            <div style={{ flex: 1, overflowY: 'auto', maxHeight: '350px', paddingRight: '4px' }}>
              {history.length > 0 ? history.map((h, i) => {
                const { date, time } = fmt(h.created_at);
                const isLast = i === history.length - 1;
                return (
                  <div key={i} style={{ display: 'flex', gap: '14px' }}>
                    {/* Date/time */}
                    <div style={{ width: '70px', flexShrink: 0, textAlign: 'right', paddingTop: '2px' }}>
                      <div style={{ fontSize: '14px', fontWeight: 700, color: '#0F172A' }}>{date}</div>
                      <div style={{ fontSize: '12px', color: '#64748B', marginTop: '1px' }}>{time}</div>
                    </div>
                    {/* Dot + line */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                      <div style={{
                        width: '10px', height: '10px', borderRadius: '50%',
                        background: isLast ? '#22C55E' : '#1E293B',
                        marginTop: '6px', zIndex: 10,
                        boxShadow: isLast ? '0 0 0 3px rgba(34, 197, 94, 0.2)' : 'none'
                      }} />
                      {!isLast && <div style={{ width: '2px', flex: 1, background: '#E2E8F0', minHeight: '36px', margin: '4px 0' }} />}
                    </div>
                    {/* Activity */}
                    <div style={{ paddingBottom: '20px', flex: 1 }}>
                      <div style={{ fontSize: '14px', fontWeight: 600, color: '#1E293B', lineHeight: 1.4 }}>
                        Activity: {h.status}
                      </div>
                      {h.notes && h.notes.trim() && !h.notes.startsWith('Status updated') && !h.notes.startsWith('CSV import') && (
                        <div style={{ fontSize: '12px', color: '#64748B', marginTop: '2px' }}>
                          Location: {h.notes}
                        </div>
                      )}
                    </div>
                  </div>
                );
              }) : (
                <p style={{ fontSize: '14px', color: '#94A3B8', margin: 0 }}>No activity yet — updates will appear here.</p>
              )}
            </div>
          </div>
        </div>

        {/* ── STEPPER ── */}
        <div className="fship-card" style={{ marginTop: '16px', padding: '32px 24px' }}>
          {/* Desktop Stepper */}
          <div className="fship-stepper-desktop">
            <div className="fship-stepper-desktop-container">
              {steps.map((step, idx) => {
                const isCompleted = idx < currentStepIndex;
                const isCurrent = idx === currentStepIndex;
                const isActive = isCompleted || isCurrent;
                const Icon = step.Icon;
                
                return (
                  <div key={idx} className={`fship-stepper-step ${isCompleted ? 'completed' : ''}`}>
                    <div style={{
                      width: '52px', height: '52px', borderRadius: '50%',
                      background: '#FFFFFF',
                      border: `2px solid ${isActive ? '#1E293B' : '#CBD5E1'}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)',
                      color: isActive ? '#F97316' : '#94A3B8',
                      zIndex: 10
                    }}>
                      <Icon size={22} strokeWidth={1.75} />
                    </div>
                    <div style={{
                      fontSize: '13px', marginTop: '10px', textAlign: 'center',
                      fontWeight: isActive ? 600 : 500,
                      color: isActive ? '#1E293B' : '#94A3B8',
                      lineHeight: 1.4, whiteSpace: 'pre-line'
                    }}>{step.label}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Mobile Stepper */}
          <div className="fship-stepper-mobile">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
              {steps.map((step, idx) => {
                const isCompleted = idx < currentStepIndex;
                const isCurrent = idx === currentStepIndex;
                const isActive = isCompleted || isCurrent;
                const Icon = step.Icon;
                
                return (
                  <div key={idx} className={`fship-stepper-mobile-step ${isCompleted ? 'completed' : ''}`}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                      <div style={{
                        width: '44px', height: '44px', borderRadius: '50%',
                        background: '#FFFFFF',
                        border: `2px solid ${isActive ? '#1E293B' : '#CBD5E1'}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
                        color: isActive ? '#F97316' : '#94A3B8',
                        zIndex: 10
                      }}>
                        <Icon size={18} strokeWidth={1.75} />
                      </div>
                    </div>
                    <div style={{ paddingTop: '10px' }}>
                      <span style={{
                        fontSize: '14px',
                        fontWeight: isActive ? 600 : 500,
                        color: isActive ? '#1E293B' : '#94A3B8',
                        whiteSpace: 'pre-line'
                      }}>{step.label.replace('\n', ' ')}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Home search button */}
        <div style={{ textAlign: 'center', marginTop: '24px' }}>
          <a
            href="/track"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '11px 28px', background: 'transparent', border: '1px solid #CBD5E1', borderRadius: '8px', fontSize: '14px', fontWeight: 600, cursor: 'pointer', color: '#475569', transition: 'all 0.2s', textDecoration: 'none' }}
          >
            ← Track another order
          </a>
        </div>
      </main>

      {/* ── FOOTER ── */}
      {business && (
        <footer style={{ background: '#FFFFFF', borderTop: '1px solid #E2E8F0', padding: '20px 24px', marginTop: '48px' }}>
          <div style={{ maxWidth: '1200px', margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: '#1E293B', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#FFFFFF', fontWeight: 800, fontSize: '10px' }}>FS</div>
              <span style={{ fontSize: '14px', color: '#64748B' }}>
                <strong style={{ color: '#0F172A' }}>Fship</strong> – Shipping that fuels Ecommerce <span style={{ color: '#F97316', fontWeight: 600 }}>Success.</span>
              </span>
            </div>
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              {business.support_phone && (
                <a href={`tel:${business.support_phone}`} style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '8px 16px', borderRadius: '9999px', border: '1px solid #E2E8F0', background: '#FFFFFF', color: '#0F172A', fontSize: '13px', fontWeight: 500 }} className="fship-footer-pill">
                  📞 {business.support_phone}
                </a>
              )}
              {business.support_email && (
                <a href={`mailto:${business.support_email}`} style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '8px 16px', borderRadius: '9999px', border: '1px solid #E2E8F0', background: '#FFFFFF', color: '#0F172A', fontSize: '13px', fontWeight: 500 }} className="fship-footer-pill">
                  ✉️ {business.support_email}
                </a>
              )}
            </div>
          </div>
        </footer>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

        .fship-card {
          background: #FFFFFF;
          border-radius: 12px;
          padding: 24px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.05), 0 1px 2px rgba(0,0,0,0.02);
          border: 1px solid #E2E8F0;
        }

        .tracking-dashboard-grid {
          display: grid;
          grid-template-columns: 4.5fr 7.5fr;
          gap: 20px;
        }

        .fship-stepper-desktop {
          display: block;
        }

        .fship-stepper-mobile {
          display: none;
        }

        .fship-stepper-desktop-container {
          display: flex;
          justify-content: space-between;
          position: relative;
        }

        .fship-stepper-step {
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          flex: 1;
        }

        .fship-stepper-step::after {
          content: '';
          position: absolute;
          top: 26px;
          left: 50%;
          width: 100%;
          height: 4px;
          background: #E2E8F0;
          z-index: 1;
        }

        .fship-stepper-step:last-child::after {
          display: none;
        }

        .fship-stepper-step.completed::after {
          background: #1E293B;
        }

        .fship-stepper-mobile-step {
          display: flex;
          gap: 16px;
          position: relative;
          padding-bottom: 24px;
        }

        .fship-stepper-mobile-step:last-child {
          padding-bottom: 0;
        }

        .fship-stepper-mobile-step::after {
          content: '';
          position: absolute;
          top: 44px;
          left: 21px;
          width: 2px;
          height: calc(100% - 44px);
          background: #CBD5E1;
          z-index: 1;
        }

        .fship-stepper-mobile-step:last-child::after {
          display: none;
        }

        .fship-stepper-mobile-step.completed::after {
          background: #1E293B;
        }

        .fship-footer-pill:hover {
          background: #F8FAFC !important;
          border-color: #CBD5E1 !important;
        }

        @media (max-width: 768px) {
          .tracking-dashboard-grid {
            grid-template-columns: 1fr;
            gap: 16px;
          }
          .fship-stepper-desktop {
            display: none;
          }
          .fship-stepper-mobile {
            display: block;
          }
        }
      `}</style>
    </div>
  );
}
