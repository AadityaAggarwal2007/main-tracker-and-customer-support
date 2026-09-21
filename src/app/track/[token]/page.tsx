'use client';

import { useState, useEffect } from 'react';
import { Package, Loader2, AlertCircle, ArrowLeft, Truck } from 'lucide-react';
import { JourneyStepper, JourneyNoticeBanner, JourneyEta, JourneyActivity, Journey } from '@/components/JourneyView';

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

export default function TrackingTokenPage({ params }: { params: { token: string } }) {
  const { token } = params;
  const [order, setOrder] = useState<TrackingOrder | null>(null);
  const [business, setBusiness] = useState<Business | null>(null);
  const [journey, setJourney] = useState<Journey | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/track?token=${token}`);
        const d = await r.json();
        if (!r.ok) setError(d.error || 'Order not found');
        else { setOrder(d.order); setBusiness(d.business || null); setJourney(d.journey || null); }
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

  const displayStatus = journey ? journey.currentLabel : (order ? getDisplayStatus(order.tracking_status, order.is_cancelled) : '');
  const statusColor = (() => {
    if (order?.is_cancelled || journey?.mode === 'cancelled') return '#EF4444';
    if (journey?.delivered) return '#10B981';
    if (journey?.notice?.level === 'warn' || journey?.mode === 'failed' || journey?.mode === 'rto') return '#F97316';
    return order ? getStatusColor(order.tracking_status, order.is_cancelled) : '#F97316';
  })();

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
        ⚠️ <strong>Advisory:</strong> Beware of fraud calls & messages. ShipTrack never asks for payment/OTP/card details or app downloads for shipping or delivery. Do not pay any extra amount to delivery agents.
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
          <div style={{ background: '#1E293B', color: '#FFFFFF', padding: '4px 8px', borderRadius: '4px', fontWeight: 700, fontSize: '11px', letterSpacing: '0.5px' }}>ShipTrack</div>
        </div>
      </header>

      {/* ── BODY ── */}
      <main style={{ maxWidth: '1200px', width: '100%', margin: '0 auto', padding: '24px 16px', flex: 1, boxSizing: 'border-box' }}>

        {/* ── HONEST STATUS BANNER ── */}
        {journey?.notice && (
          <div style={{ marginBottom: '16px' }}>
            <JourneyNoticeBanner journey={journey} />
          </div>
        )}

        {/* ── TWO-COLUMN GRID ── */}
        <div className="tracking-dashboard-grid">

          {/* LEFT — 3 stacked cards */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

            {/* Order Status */}
            <div className="st-card">
              <p style={{ margin: '0 0 6px', fontSize: '13px', color: '#64748B', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Order Status</p>
              <p style={{ margin: 0, fontSize: '28px', fontWeight: 800, color: statusColor }}>{displayStatus}</p>
            </div>

            {/* Estimated / Expected Delivery */}
            {journey && <JourneyEta journey={journey} />}

            {/* Order Details */}
            <div className="st-card">
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
          <div className="st-card" style={{ display: 'flex', flexDirection: 'column' }}>
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
              {journey
                ? <JourneyActivity journey={journey} />
                : <p style={{ fontSize: '14px', color: '#94A3B8', margin: 0 }}>No activity yet — updates will appear here.</p>}
            </div>
          </div>
        </div>

        {/* ── JOURNEY STEPPER ── */}
        {journey && journey.mode === 'normal' && (
          <div style={{ marginTop: '16px' }}>
            <JourneyStepper journey={journey} />
          </div>
        )}

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
                <strong style={{ color: '#0F172A' }}>ShipTrack</strong> – Shipping that fuels Ecommerce <span style={{ color: '#F97316', fontWeight: 600 }}>Success.</span>
              </span>
            </div>
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              {business.support_phone && (
                <a href={`tel:${business.support_phone}`} style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '8px 16px', borderRadius: '9999px', border: '1px solid #E2E8F0', background: '#FFFFFF', color: '#0F172A', fontSize: '13px', fontWeight: 500 }} className="st-footer-pill">
                  📞 {business.support_phone}
                </a>
              )}
              {business.support_email && (
                <a href={`mailto:${business.support_email}`} style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '8px 16px', borderRadius: '9999px', border: '1px solid #E2E8F0', background: '#FFFFFF', color: '#0F172A', fontSize: '13px', fontWeight: 500 }} className="st-footer-pill">
                  ✉️ {business.support_email}
                </a>
              )}
            </div>
          </div>
        </footer>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

        .st-card {
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

        .st-stepper-desktop {
          display: block;
        }

        .st-stepper-mobile {
          display: none;
        }

        .st-stepper-desktop-container {
          display: flex;
          justify-content: space-between;
          position: relative;
        }

        .st-stepper-step {
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          flex: 1;
        }

        .st-stepper-step::after {
          content: '';
          position: absolute;
          top: 26px;
          left: 50%;
          width: 100%;
          height: 4px;
          background: #E2E8F0;
          z-index: 1;
        }

        .st-stepper-step:last-child::after {
          display: none;
        }

        .st-stepper-step.completed::after {
          background: #1E293B;
        }

        .st-stepper-mobile-step {
          display: flex;
          gap: 16px;
          position: relative;
          padding-bottom: 24px;
        }

        .st-stepper-mobile-step:last-child {
          padding-bottom: 0;
        }

        .st-stepper-mobile-step::after {
          content: '';
          position: absolute;
          top: 44px;
          left: 21px;
          width: 2px;
          height: calc(100% - 44px);
          background: #CBD5E1;
          z-index: 1;
        }

        .st-stepper-mobile-step:last-child::after {
          display: none;
        }

        .st-stepper-mobile-step.completed::after {
          background: #1E293B;
        }

        .st-footer-pill:hover {
          background: #F8FAFC !important;
          border-color: #CBD5E1 !important;
        }

        @media (max-width: 768px) {
          .tracking-dashboard-grid {
            grid-template-columns: 1fr;
            gap: 16px;
          }
          .st-stepper-desktop {
            display: none;
          }
          .st-stepper-mobile {
            display: block;
          }
        }
      `}</style>
    </div>
  );
}
