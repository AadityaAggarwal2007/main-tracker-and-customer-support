'use client';

import { TRACKING_STAGES_WITH_SPECIAL, STAGE_ICONS, getStatusColorClass } from '@/lib/constants';
import { Activity, Zap, Package, Check, Mail, Search, Calendar, Eye, Link2, MessageCircle, Trash2, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Order } from '../_lib/types';

export default function OrdersTab({ GMAIL_DAILY_LIMIT, brandFilter, brands, copyTrackingLink, dateFrom, dateTo, emailFilter, emailedOrderIds, emailsSentToday, handleDeleteOrder, handleSearchChange, hasPermission, limit, loading, orders, page, searchInput, selectFirst, selectedOrders, sendEmail, sendWhatsApp, setBrandFilter, setDateFrom, setDateTo, setDetailOrder, setEmailFilter, setLimit, setPage, setSelectedOrders, setShowDetailModal, setShowRangeModal, setShowStatusModal, setStatusFilter, setStoreFilter, statusCounts, statusFilter, storeFilter, toggleSelectAll, toggleSelectOrder, totalOrders, totalPages }: {
  GMAIL_DAILY_LIMIT: number;
  brandFilter: string;
  brands: string[];
  copyTrackingLink: (trackingToken: string) => void;
  dateFrom: string;
  dateTo: string;
  emailFilter: string;
  emailedOrderIds: Set<string>;
  emailsSentToday: number;
  handleDeleteOrder: (orderId: string) => Promise<void>;
  handleSearchChange: (val: string) => void;
  hasPermission: (perm: string) => boolean;
  limit: number;
  loading: boolean;
  orders: Order[];
  page: number;
  searchInput: string;
  selectFirst: (count: number) => void;
  selectedOrders: Set<string>;
  sendEmail: (order: Order) => Promise<void>;
  sendWhatsApp: (order: Order) => void;
  setBrandFilter: React.Dispatch<React.SetStateAction<string>>;
  setDateFrom: React.Dispatch<React.SetStateAction<string>>;
  setDateTo: React.Dispatch<React.SetStateAction<string>>;
  setDetailOrder: React.Dispatch<React.SetStateAction<Order | null>>;
  setEmailFilter: React.Dispatch<React.SetStateAction<string>>;
  setLimit: React.Dispatch<React.SetStateAction<number>>;
  setPage: React.Dispatch<React.SetStateAction<number>>;
  setSelectedOrders: React.Dispatch<React.SetStateAction<Set<string>>>;
  setShowDetailModal: React.Dispatch<React.SetStateAction<boolean>>;
  setShowRangeModal: React.Dispatch<React.SetStateAction<boolean>>;
  setShowStatusModal: React.Dispatch<React.SetStateAction<boolean>>;
  setStatusFilter: React.Dispatch<React.SetStateAction<string>>;
  setStoreFilter: React.Dispatch<React.SetStateAction<string>>;
  statusCounts: Record<string, number>;
  statusFilter: string;
  storeFilter: string;
  toggleSelectAll: () => void;
  toggleSelectOrder: (orderId: string) => void;
  totalOrders: number;
  totalPages: number;
}) {
  return (
            <div className="space-y-6 animate-fade-in-up">
              <div>
                <h2 className="page-title">Orders</h2>
                <p className="page-subtitle">Manage and track all customer orders</p>
              </div>

              {/* Stage KPIs */}
              <div style={{ display: 'flex', gap: '0.625rem', overflowX: 'auto', paddingBottom: '0.25rem', WebkitOverflowScrolling: 'touch' }}>
                <button onClick={() => { setStatusFilter(''); setPage(1); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 0.875rem',
                    borderRadius: '9999px', border: !statusFilter ? '1.5px solid var(--primary)' : '1px solid var(--border)',
                    background: !statusFilter ? 'var(--primary-light)' : 'var(--card-bg)',
                    fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                    color: !statusFilter ? 'var(--primary)' : 'var(--fg-muted)',
                  }}>
                  📊 All <span style={{ fontWeight: 700, color: 'var(--fg)' }}>{totalOrders}</span>
                </button>
                {TRACKING_STAGES_WITH_SPECIAL.map((stage) => {
                  const count = statusCounts[stage] || 0;
                  return (
                    <button key={stage} onClick={() => { setStatusFilter(statusFilter === stage ? '' : stage); setPage(1); }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 0.875rem',
                        borderRadius: '9999px', border: statusFilter === stage ? '1.5px solid var(--primary)' : '1px solid var(--border)',
                        background: statusFilter === stage ? 'var(--primary-light)' : 'var(--card-bg)',
                        fontSize: '0.75rem', fontWeight: 500, cursor: 'pointer', transition: 'all 0.15s',
                        color: statusFilter === stage ? 'var(--primary)' : 'var(--fg-muted)',
                        whiteSpace: 'nowrap', flexShrink: 0,
                      }}>
                      <span>{STAGE_ICONS[stage]}</span>
                      <span>{stage}</span>
                      <span style={{ fontWeight: 700, color: count > 0 ? 'var(--fg)' : 'var(--fg-muted)' }}>{count}</span>
                    </button>
                  );
                })}
              </div>

              {/* System Insights */}
              <div className="tf-card" style={{ padding: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                  <Activity size={16} style={{ color: 'var(--primary)' }} />
                  <span style={{ fontSize: '0.8125rem', fontWeight: 600 }}>System Insights</span>
                  <span style={{ marginLeft: 'auto', fontSize: '0.625rem', padding: '0.125rem 0.5rem', borderRadius: '9999px', background: 'var(--success-light)', color: 'var(--success)', fontWeight: 500 }}>Live</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem' }}>
                  <div style={{ padding: '0.625rem', background: 'var(--bg-subtle)', borderRadius: 'var(--radius-lg)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', marginBottom: '0.125rem' }}>
                      <Zap size={10} style={{ color: 'var(--primary)' }} />
                      <span style={{ fontSize: '0.625rem', color: 'var(--fg-muted)' }}>Queries/View</span>
                    </div>
                    <span style={{ fontSize: '1.125rem', fontWeight: 700 }}>2</span>
                    <span style={{ fontSize: '0.625rem', color: 'var(--success)', marginLeft: '0.25rem' }}>↓3</span>
                  </div>
                  <div style={{ padding: '0.625rem', background: 'var(--bg-subtle)', borderRadius: 'var(--radius-lg)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', marginBottom: '0.125rem' }}>
                      <Activity size={10} style={{ color: 'var(--info)' }} />
                      <span style={{ fontSize: '0.625rem', color: 'var(--fg-muted)' }}>Monthly Cap.</span>
                    </div>
                    <span style={{ fontSize: '1.125rem', fontWeight: 700 }}>250K</span>
                  </div>
                  <div style={{ padding: '0.625rem', background: 'var(--bg-subtle)', borderRadius: 'var(--radius-lg)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', marginBottom: '0.125rem' }}>
                      <Package size={10} style={{ color: 'var(--warning)' }} />
                      <span style={{ fontSize: '0.625rem', color: 'var(--fg-muted)' }}>DB Size</span>
                    </div>
                    <span style={{ fontSize: '1.125rem', fontWeight: 700 }}>{(totalOrders * 1.25 / 1024).toFixed(1)}</span>
                    <span style={{ fontSize: '0.625rem', color: 'var(--fg-muted)' }}> / 500 MB</span>
                  </div>
                  <div style={{ padding: '0.625rem', background: 'var(--bg-subtle)', borderRadius: 'var(--radius-lg)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', marginBottom: '0.125rem' }}>
                      <Check size={10} style={{ color: 'var(--success)' }} />
                      <span style={{ fontSize: '0.625rem', color: 'var(--fg-muted)' }}>Upload</span>
                    </div>
                    <span style={{ fontSize: '1.125rem', fontWeight: 700 }}>Chunked</span>
                  </div>
                </div>
              </div>

              {/* Email Stats Bar */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.75rem', marginBottom: '0.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.375rem 0.75rem', borderRadius: '9999px', background: emailsSentToday >= GMAIL_DAILY_LIMIT ? 'var(--danger-light)' : 'var(--primary-light)', fontSize: '0.75rem', fontWeight: 600 }}>
                  <Mail size={12} />
                  <span style={{ color: emailsSentToday >= GMAIL_DAILY_LIMIT ? 'var(--danger)' : 'var(--primary)' }}>
                    {emailsSentToday.toLocaleString()} / {GMAIL_DAILY_LIMIT.toLocaleString()} emails today
                  </span>
                </div>
              </div>

              {/* Toolbar */}
              <div className="toolbar" style={{ flexWrap: 'wrap' }}>
                <div className="toolbar-search">
                  <Search />
                  <input type="text" className="form-input" placeholder="Search by order ID, name, phone, email..." value={searchInput} onChange={(e) => handleSearchChange(e.target.value)} />
                </div>
                <select className="form-select" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}>
                  <option value="">All Statuses</option>
                  {TRACKING_STAGES_WITH_SPECIAL.map((s) => (<option key={s} value={s}>{STAGE_ICONS[s]} {s}</option>))}
                </select>
                <select className="form-select" value={brandFilter} onChange={(e) => { setBrandFilter(e.target.value); setPage(1); }}>
                  <option value="">All Brands</option>
                  {brands.map((b) => (<option key={b} value={b}>{b}</option>))}
                </select>
                <select className="form-select" value={storeFilter} onChange={(e) => { setStoreFilter(e.target.value); setPage(1); }}>
                  <option value="">🏪 All Stores</option>
                  <option value="ruhani.myshopify.com">Ruhani Store</option>
                  <option value="unknown">Other / CSV</option>
                </select>
                <select className="form-select" value={emailFilter} onChange={(e) => { setEmailFilter(e.target.value); setPage(1); }}>
                  <option value="">📧 All</option>
                  <option value="has_email">✅ Has Email</option>
                  <option value="no_email">📵 No Email (WhatsApp)</option>
                </select>
                <select className="form-select" value={limit} onChange={(e) => { setLimit(parseInt(e.target.value)); setPage(1); }}>
                  <option value="50">50 / page</option>
                  <option value="100">100 / page</option>
                  <option value="500">500 / page</option>
                </select>
              </div>

              {/* Date Filter */}
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <Calendar size={14} style={{ color: 'var(--fg-muted)' }} />
                <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', fontWeight: 500 }}>Date:</span>
                <input type="date" className="form-input" style={{ width: 'auto', fontSize: '0.75rem', padding: '0.25rem 0.5rem' }} value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} />
                <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>to</span>
                <input type="date" className="form-input" style={{ width: 'auto', fontSize: '0.75rem', padding: '0.25rem 0.5rem' }} value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} />
                {(dateFrom || dateTo) && (
                  <button className="btn btn-outline btn-sm" style={{ fontSize: '0.625rem', padding: '0.125rem 0.5rem' }} onClick={() => { setDateFrom(''); setDateTo(''); setPage(1); }}>
                    Clear dates
                  </button>
                )}
              </div>

              {/* Batch Selection Bar */}
              <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <button className="btn btn-outline btn-sm" style={{ fontSize: '0.6875rem' }} onClick={() => selectFirst(100)}>+ Select 100</button>
                <button className="btn btn-outline btn-sm" style={{ fontSize: '0.6875rem' }} onClick={() => selectFirst(500)}>+ Select 500</button>
                <button className="btn btn-outline btn-sm" style={{ fontSize: '0.6875rem' }} onClick={() => setShowRangeModal(true)}>📏 Select Range</button>
                <button className="btn btn-outline btn-sm" style={{ fontSize: '0.6875rem' }} onClick={toggleSelectAll}>{selectedOrders.size > 0 ? '☐ Deselect All' : '☑ Select All'}</button>
              </div>

              {/* Bulk bar */}
              {selectedOrders.size > 0 && hasPermission('update_status') && (
                <div className="bulk-bar">
                  <span className="bulk-count">{selectedOrders.size}</span>
                  <span style={{ fontSize: '0.875rem', color: 'var(--fg-muted)' }}>selected</span>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
                    <button className="btn btn-primary btn-sm" onClick={() => setShowStatusModal(true)}>Update Status</button>
                    <button className="btn btn-outline btn-sm" onClick={() => setSelectedOrders(new Set())}>Clear</button>
                  </div>
                </div>
              )}

              {/* Table */}
              <div className="table-card">
                {loading ? (
                  <div className="loading-center"><div className="spinner spinner-lg" /><p>Loading orders...</p></div>
                ) : orders.length === 0 ? (
                  <div className="empty-state">
                    <Package size={40} />
                    <div className="empty-state-title">No orders found</div>
                    <div className="empty-state-text">Upload a CSV to get started</div>
                  </div>
                ) : (
                  <>
                    <div className="table-scroll">
                      <table className="tf-table">
                        <thead>
                          <tr>
                            {hasPermission('update_status') && (<th style={{ width: 48 }}><input type="checkbox" className="tf-checkbox" onChange={toggleSelectAll} checked={selectedOrders.size === orders.length && orders.length > 0} /></th>)}
                            <th>Order</th>
                            <th>Customer</th>
                            <th>City</th>
                            <th>Total</th>
                            <th>Tracking ID</th>
                            <th>Status</th>
                            <th style={{ textAlign: 'right' }}>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {orders
                            .filter((o) => {
                              if (emailFilter === 'has_email') return o.customer_email && o.customer_email.includes('@');
                              if (emailFilter === 'no_email') return !o.customer_email || !o.customer_email.includes('@');
                              return true;
                            })
                            .map((order) => (
                            <tr key={order.id}>
                              {hasPermission('update_status') && (
                                <td><input type="checkbox" className="tf-checkbox" checked={selectedOrders.has(order.order_id)} onChange={() => toggleSelectOrder(order.order_id)} /></td>
                              )}
                              <td><span style={{ fontWeight: 600, color: 'var(--primary)' }}>{order.order_id}</span></td>
                              <td>
                                <div>
                                  <p style={{ fontWeight: 500, display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                                    {order.customer_name}
                                    {order.customer_email && order.customer_email.includes('@')
                                      ? <span title="Has email" style={{ fontSize: '0.625rem', color: 'var(--success)' }}>📧</span>
                                      : <span title="No email — WhatsApp only" style={{ fontSize: '0.625rem', color: 'var(--warning)' }}>📵</span>}
                                  {emailedOrderIds.has(order.order_id) && <span title="Email already sent" style={{ fontSize: '0.625rem', color: 'var(--info)' }}>✉️</span>}
                                  </p>
                                  {order.customer_email && <p style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>{order.customer_email}</p>}
                                  {order.customer_mobile && <p style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>{order.customer_mobile}</p>}
                                </div>
                              </td>
                              <td>
                                <div>
                                  <p>{order.city}</p>
                                  <p style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>{order.state}</p>
                                </div>
                              </td>
                              <td style={{ fontWeight: 500 }}>₹{Number(order.order_total).toLocaleString()}</td>
                              <td>
                                {order.tracking_id
                                  ? <div>
                                      <span style={{ fontWeight: 600, fontSize: '0.8125rem', fontFamily: 'monospace' }}>{order.tracking_id}</span>
                                      {order.courier_partner && <p style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginTop: '1px' }}>{order.courier_partner}</p>}
                                    </div>
                                  : <span style={{ color: 'var(--fg-muted)', fontSize: '0.75rem' }}>—</span>
                                }
                              </td>
                              <td>
                                <span className={`status-pill ${getStatusColorClass(order.is_cancelled ? 'Cancelled' : order.tracking_status)}`}>
                                  {order.is_cancelled ? 'Cancelled' : order.tracking_status}
                                </span>
                              </td>
                              <td>
                                <div className="table-actions">
                                  <button className="btn-icon" onClick={() => { setDetailOrder(order); setShowDetailModal(true); }} title="View"><Eye size={16} /></button>
                                  <button className="btn-icon" onClick={() => copyTrackingLink(order.tracking_token)} title="Copy Link"><Link2 size={16} /></button>
                                  <button className="btn-icon" onClick={() => sendWhatsApp(order)} title="WhatsApp" style={{ color: '#25D366' }}><MessageCircle size={16} /></button>
                                  <button className="btn-icon" onClick={() => sendEmail(order)} title="Email" style={{ color: 'var(--info)' }}><Mail size={16} /></button>
                                  {hasPermission('delete_order') && <button className="btn-icon" onClick={() => handleDeleteOrder(order.order_id)} title="Delete" style={{ color: 'var(--danger)' }}><Trash2 size={16} /></button>}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {totalPages > 1 && (
                      <div className="pagination">
                        <button className="pagination-btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                          <ChevronLeft size={16} /> Prev
                        </button>
                        <span className="pagination-info">Page {page} of {totalPages}</span>
                        <button className="pagination-btn" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                          Next <ChevronRight size={16} />
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
  );
}
