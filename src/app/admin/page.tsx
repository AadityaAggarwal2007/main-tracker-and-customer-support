'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { TRACKING_STAGES_WITH_SPECIAL, STAGE_ICONS, ROLE_PERMISSIONS, getStatusColorClass } from '@/lib/constants';
import {
  Package, Upload, Users, LogOut, Search, Eye, Link2, MessageCircle, Mail,
  ChevronLeft, ChevronRight, X, Check, Truck, AlertCircle, ShoppingBag,
  Loader2, FileUp, Info, UserPlus, Trash2, Building2, Plus, Lock, Unlock,
  Activity, Zap, Calendar, StickyNote, Settings, Timer, ArrowRight, ToggleLeft, ToggleRight
} from 'lucide-react';

/* ═══════════ TYPES ═══════════ */
interface OrderItem { id: string; brand: string; product_name: string; quantity: number; price: number; }
interface Order {
  id: string; order_id: string; shopify_id: string; payment_method: string; financial_status: string;
  customer_name: string; customer_email: string; customer_mobile: string;
  address_line1: string; address_line2: string; address_line3: string;
  city: string; state: string; pincode: string;
  tracking_status: string; tracking_id: string; courier_partner: string;
  tracking_token: string; status_updated_at: string; estimated_delivery: string;
  order_total: number; is_cancelled: boolean; cancelled_at: string;
  notes: string; created_at: string; updated_at: string; order_items: OrderItem[];
  business_id: string;
}
interface AuthUser { username: string; displayName: string; role: 'admin' | 'manager' | 'viewer'; businessIds: string[] | null; }
interface TeamUser { id: string; username: string; display_name: string; role: string; is_active: boolean; last_login: string; created_at: string; business_ids: string[] | null; }
interface Business {
  id: string; name: string; logo_url: string; support_email: string; support_phone: string;
  is_default: boolean; created_at: string; tracking_domain: string | null; primary_color: string | null;
  is_shopify_connected: boolean; shopify_domain: string | null;
}
type TabType = 'orders' | 'upload' | 'team' | 'settings';

export default function AdminDashboard() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState('');
  const [activeTab, setActiveTab] = useState<TabType>('orders');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Orders
  const [orders, setOrders] = useState<Order[]>([]);
  const [totalOrders, setTotalOrders] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [brandFilter, setBrandFilter] = useState('');
  const [storeFilter, setStoreFilter] = useState('');
  const [brands, setBrands] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set());
  const [emailFilter, setEmailFilter] = useState('');
  const [sendingEmail, setSendingEmail] = useState(false);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailStatus, setEmailStatus] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [emailsSentToday, setEmailsSentToday] = useState(0);
  const [emailedOrderIds, setEmailedOrderIds] = useState<Set<string>>(new Set());
  const [showRangeModal, setShowRangeModal] = useState(false);
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');
  const [rangeMode, setRangeMode] = useState<'row' | 'order'>('order');

  // Upload
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<Record<string, unknown> | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0, percent: 0 });
  const [showUploadEmailPrompt, setShowUploadEmailPrompt] = useState(false);
  const [uploadNewOrderIds, setUploadNewOrderIds] = useState<string[]>([]);
  const [sendingUploadEmails, setSendingUploadEmails] = useState(false);

  // Draft queue
  const [queueStats, setQueueStats] = useState<{ pending: number; processing: number; done: number; failed: number; total: number } | null>(null);
  const [loadingQueue, setLoadingQueue] = useState(false);

  // Bulk status modal
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [bulkStatus, setBulkStatus] = useState('');
  const [bulkTrackingId, setBulkTrackingId] = useState('');
  const [bulkCourier, setBulkCourier] = useState('');
  const [bulkNotes, setBulkNotes] = useState('');
  const [bulkEstDelivery, setBulkEstDelivery] = useState('');

  // Detail modal
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [detailOrder, setDetailOrder] = useState<Order | null>(null);

  // Team
  const [teamUsers, setTeamUsers] = useState<TeamUser[]>([]);
  const [showTeamModal, setShowTeamModal] = useState(false);
  const [newTeamUser, setNewTeamUser] = useState({ username: '', password: '', displayName: '', role: 'viewer', businessIds: [] as string[] });
  const [editingUserPanels, setEditingUserPanels] = useState<string | null>(null);
  const [editUserPanelIds, setEditUserPanelIds] = useState<string[]>([]);

  // Panel switcher
  const [activePanelId, setActivePanelId] = useState<string>('');
  const [showPanelDropdown, setShowPanelDropdown] = useState(false);

  // Businesses / Brand Settings
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [activeBusiness, setActiveBusiness] = useState<Business | null>(null);
  const [brandForm, setBrandForm] = useState({ name: '', logoUrl: '', supportEmail: '', supportPhone: '', trackingDomain: '', primaryColor: '#4F46E5' });
  const [savingBrand, setSavingBrand] = useState(false);

  // Shopify connect
  const [shopifyForm, setShopifyForm] = useState({ domain: '', apiToken: '' });
  const [connectingShopify, setConnectingShopify] = useState(false);


  // Auto-Progression
  interface ProgressionStep { id: string; step_from: string; step_to: string; step_order: number; delay_minutes: number; is_enabled: boolean; }
  const [progressionSteps, setProgressionSteps] = useState<ProgressionStep[]>([]);
  const [progressionDirty, setProgressionDirty] = useState(false);
  const [savingProgression, setSavingProgression] = useState(false);

  // Alert
  const [alert, setAlert] = useState<{ type: string; message: string } | null>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [limit, setLimit] = useState(50);
  const GMAIL_DAILY_LIMIT = 2000;

  useEffect(() => {
    const savedToken = localStorage.getItem('auth_token');
    const savedUser = localStorage.getItem('auth_user');
    if (!savedToken || !savedUser) { router.push('/login'); return; }
    setToken(savedToken);
    const parsedUser = JSON.parse(savedUser);
    setUser(parsedUser);
    // Restore last active panel
    const savedPanel = localStorage.getItem('active_panel_id') || '';
    setActivePanelId(savedPanel);
  }, [router]);

  const hasPermission = (perm: string) => {
    if (!user) return false;
    return ROLE_PERMISSIONS[user.role]?.includes(perm) ?? false;
  };

  const showAlert = (type: string, message: string) => {
    setAlert({ type, message });
    setTimeout(() => setAlert(null), 4000);
  };

  /* ═══ FETCH FUNCTIONS ═══ */
  const fetchOrders = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: page.toString(), limit: limit.toString() });
      if (search) params.set('search', search);
      if (statusFilter) params.set('status', statusFilter);
      if (brandFilter) params.set('brand', brandFilter);
      if (storeFilter) params.set('store', storeFilter);
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
      if (activePanelId) params.set('businessId', activePanelId); // Panel filter
      const res = await fetch(`/api/orders?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (res.ok) { setOrders(data.orders); setTotalOrders(data.total); }
    } catch { showAlert('error', 'Failed to load orders'); }
    finally { setLoading(false); }
  }, [token, page, limit, search, statusFilter, brandFilter, storeFilter, dateFrom, dateTo, activePanelId]);

  // Fetch email stats
  const fetchEmailStats = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch('/api/send-email', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (res.ok) setEmailsSentToday(data.sentToday || 0);
    } catch { /* ignore */ }
  }, [token]);

  // Fetch which orders on current page have been emailed
  const fetchEmailedOrders = useCallback(async () => {
    if (!token || orders.length === 0) return;
    try {
      const ids = orders.map(o => o.order_id);
      const res = await fetch('/api/send-email/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orderIds: ids }),
      });
      if (res.ok) {
        const data = await res.json();
        setEmailedOrderIds(new Set(data.emailedIds || []));
      }
    } catch { /* ignore */ }
  }, [token, orders]);

  const fetchBrands = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch('/api/brands', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (res.ok) setBrands(data.brands);
    } catch { /* ignore */ }
  }, [token]);

  const fetchTeamUsers = useCallback(async () => {
    if (!token || user?.role !== 'admin') return;
    try {
      const res = await fetch('/api/team', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (res.ok) setTeamUsers(data.users);
    } catch { /* ignore */ }
  }, [token, user]);

  const fetchBusinesses = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch('/api/businesses', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (res.ok) setBusinesses(data.businesses || []);
    } catch { /* ignore */ }
  }, [token]);

  const fetchProgressionSteps = useCallback(async () => {
    try {
      const res = await fetch(`/api/progression-settings?t=${Date.now()}`, { cache: 'no-store' });
      const data = await res.json();
      if (res.ok) {
        setProgressionSteps(data.steps || []);
        setProgressionDirty(false);
      }
    } catch { /* ignore */ }
  }, []);

  const fetchQueueStats = useCallback(async () => {
    if (!token) return;
    setLoadingQueue(true);
    try {
      const res = await fetch('/api/send-email', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (res.ok) setQueueStats(data?.queue || data);
    } catch { /* ignore */ }
    finally { setLoadingQueue(false); }
  }, [token]);

  useEffect(() => { if (token) { fetchOrders(); fetchBrands(); fetchBusinesses(); fetchEmailStats(); fetchProgressionSteps(); } }, [token, fetchOrders, fetchBrands, fetchBusinesses, fetchEmailStats, fetchProgressionSteps]);
  useEffect(() => { if (activeTab === 'upload' && token) fetchQueueStats(); }, [activeTab, token, fetchQueueStats]);
  useEffect(() => { if (activeTab === 'team') fetchTeamUsers(); }, [activeTab, fetchTeamUsers]);
  useEffect(() => { if (activeTab === 'settings') fetchProgressionSteps(); }, [activeTab, fetchProgressionSteps]);
  useEffect(() => { fetchEmailedOrders(); }, [fetchEmailedOrders]);
  // Auto-refresh email stats every 30 seconds
  useEffect(() => {
    if (!token) return;
    const interval = setInterval(fetchEmailStats, 30000);
    return () => clearInterval(interval);
  }, [token, fetchEmailStats]);
  // Load brand form from active panel's business
  useEffect(() => {
    const biz = activePanelId
      ? businesses.find(b => b.id === activePanelId)
      : (businesses.find(b => b.is_default) || businesses[0]);
    setActiveBusiness(biz || null);
    if (biz) {
      setBrandForm({
        name: biz.name, logoUrl: biz.logo_url || '',
        supportEmail: biz.support_email || '', supportPhone: biz.support_phone || '',
        trackingDomain: biz.tracking_domain || '', primaryColor: biz.primary_color || '#4F46E5',
      });
    }
  }, [businesses, activePanelId]);

  // Sync activePanelId to localStorage and restrict to accessible panels
  const switchPanel = (panelId: string) => {
    setActivePanelId(panelId);
    localStorage.setItem('active_panel_id', panelId);
    setShowPanelDropdown(false);
    setPage(1);
    setSelectedOrders(new Set());
  };

  const handleSearchChange = (val: string) => {
    setSearchInput(val);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setSearch(val);
      setPage(1);
    }, 400);
  };

  /* ═══ CSV UPLOAD (chunked — works on Vercel Hobby 10s limit) ═══ */
  const CHUNK_SIZE = 500; // rows per chunk

  const handleFileUpload = async (file: File) => {
    if (!file || !file.name.endsWith('.csv')) { showAlert('error', 'Please upload a CSV file'); return; }
    setUploading(true);
    setUploadResult(null);
    setUploadProgress({ current: 0, total: 0, percent: 0 });

    try {
      // 1. Read and parse CSV on the client
      const csvText = await file.text();
      const lines = csvText.split('\n');
      const header = lines[0];
      const dataLines = lines.slice(1).filter(l => l.trim().length > 0);
      const totalRows = dataLines.length;

      // 2. Split into chunks
      const chunks: string[] = [];
      for (let i = 0; i < dataLines.length; i += CHUNK_SIZE) {
        const chunkLines = dataLines.slice(i, i + CHUNK_SIZE);
        chunks.push(header + '\n' + chunkLines.join('\n'));
      }

      setUploadProgress({ current: 0, total: chunks.length, percent: 0 });

      // 3. Send chunks sequentially
      let totalNew = 0, totalUpdated = 0, totalBrands = 0;
      const allNewOrderIds: string[] = [];

      for (let i = 0; i < chunks.length; i++) {
        const blob = new Blob([chunks[i]], { type: 'text/csv' });
        const chunkFile = new File([blob], file.name, { type: 'text/csv' });

        const formData = new FormData();
        formData.append('file', chunkFile);
        formData.append('chunkIndex', i.toString());
        formData.append('totalChunks', chunks.length.toString());

        const res = await fetch('/api/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData });
        const data = await res.json();

        if (!res.ok) {
          showAlert('error', `Chunk ${i + 1}/${chunks.length} failed: ${data.error}`);
          break;
        }

        totalNew += data.stats?.newOrders || 0;
        totalUpdated += data.stats?.updatedOrders || 0;
        totalBrands = Math.max(totalBrands, data.stats?.brandsDetected || 0);
        if (data.newOrderIds) allNewOrderIds.push(...data.newOrderIds);

        setUploadProgress({ current: i + 1, total: chunks.length, percent: Math.round(((i + 1) / chunks.length) * 100) });
      }

      setUploadResult({ total: totalRows, unique: totalNew + totalUpdated, newOrders: totalNew, updatedOrders: totalUpdated });
      // Emails are auto-queued in the upload API — cron sends 1/min automatically
      const hoursEst = Math.ceil(totalNew / 60);
      showAlert('success', `✅ ${totalNew} new orders imported! Emails sending automatically (1/min) — done in ~${hoursEst} hours.`);
      fetchOrders(); fetchBrands(); fetchBusinesses(); fetchQueueStats();
    } catch { showAlert('error', 'Upload failed'); }
    finally { setUploading(false); }
  };

  /* ═══ BULK STATUS ═══ */
  const handleBulkUpdate = async () => {
    if (!bulkStatus || selectedOrders.size === 0) return;
    try {
      const res = await fetch('/api/orders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          orderIds: Array.from(selectedOrders),
          status: bulkStatus,
          trackingId: bulkTrackingId || undefined,
          courierPartner: bulkCourier || undefined,
          notes: bulkNotes || undefined,
          estimatedDelivery: bulkEstDelivery || undefined,
        }),
      });
      if (res.ok) {
        showAlert('success', `Updated ${selectedOrders.size} orders to "${bulkStatus}"`);
        setSelectedOrders(new Set()); setShowStatusModal(false);
        setBulkStatus(''); setBulkTrackingId(''); setBulkCourier(''); setBulkNotes(''); setBulkEstDelivery('');
        fetchOrders();
      } else { showAlert('error', 'Update failed'); }
    } catch { showAlert('error', 'Update failed'); }
  };

  /* ═══ DELETE ORDER ═══ */
  const handleDeleteOrder = async (orderId: string) => {
    if (!confirm(`Delete order ${orderId}? This cannot be undone.`)) return;
    try {
      const res = await fetch('/api/orders', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orderId }),
      });
      if (res.ok) {
        showAlert('success', `Order ${orderId} deleted`);
        if (showDetailModal) setShowDetailModal(false);
        fetchOrders();
      } else { showAlert('error', 'Delete failed'); }
    } catch { showAlert('error', 'Delete failed'); }
  };

  const handleSingleStatusUpdate = async (orderId: string, status: string) => {
    try {
      const res = await fetch('/api/orders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orderIds: [orderId], status }),
      });
      if (res.ok) {
        showAlert('success', `Order ${orderId} → ${status}`);
        fetchOrders();
        if (detailOrder && detailOrder.order_id === orderId) {
          setDetailOrder({ ...detailOrder, tracking_status: status, is_cancelled: status === 'Cancelled' });
        }
      }
    } catch { showAlert('error', 'Update failed'); }
  };

  /* ═══ TEAM ═══ */
  const handleCreateTeamUser = async () => {
    try {
      const res = await fetch('/api/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(newTeamUser),
      });
      const data = await res.json();
      if (res.ok) {
        showAlert('success', `User ${newTeamUser.username} created`);
        setShowTeamModal(false);
        setNewTeamUser({ username: '', password: '', displayName: '', role: 'viewer', businessIds: [] });
        fetchTeamUsers();
      } else { showAlert('error', data.error || 'Failed'); }
    } catch { showAlert('error', 'Failed'); }
  };

  /* ═══ SHOPIFY CONNECT ═══ */
  const handleShopifyConnect = async () => {
    if (!activePanelId) { showAlert('error', 'Select a panel first'); return; }
    if (!shopifyForm.domain || !shopifyForm.apiToken) { showAlert('error', 'Enter Shopify domain and API token'); return; }
    setConnectingShopify(true);
    try {
      const res = await fetch('/api/shopify/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          businessId: activePanelId,
          shopifyDomain: shopifyForm.domain,
          apiToken: shopifyForm.apiToken,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        showAlert('success', data.message || 'Shopify connected!');
        setShopifyForm({ domain: '', apiToken: '' });
        fetchBusinesses();
      } else { showAlert('error', data.error || 'Connection failed'); }
    } catch { showAlert('error', 'Connection failed'); }
    finally { setConnectingShopify(false); }
  };

  const handleShopifyDisconnect = async () => {
    if (!activePanelId || !confirm('Disconnect Shopify? Webhook will be deleted.')) return;
    try {
      const res = await fetch(`/api/shopify/connect?businessId=${activePanelId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) { showAlert('success', 'Shopify disconnected'); fetchBusinesses(); }
      else { showAlert('error', 'Disconnect failed'); }
    } catch { showAlert('error', 'Disconnect failed'); }
  };

  /* ═══ PANEL ACCESS ═══ */
  const handleUpdateUserPanels = async (userId: string) => {
    try {
      await fetch('/api/team', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: userId, businessIds: editUserPanelIds }),
      });
      showAlert('success', 'Panel access updated');
      setEditingUserPanels(null);
      fetchTeamUsers();
    } catch { showAlert('error', 'Failed'); }
  };

  const handleToggleTeamUser = async (userId: string, isActive: boolean) => {
    try {
      await fetch('/api/team', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ id: userId, isActive }) });
      fetchTeamUsers();
    } catch { /* ignore */ }
  };

  const handleDeleteTeamUser = async (userId: string) => {
    if (!confirm('Delete this team member?')) return;
    try {
      await fetch(`/api/team?id=${userId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      fetchTeamUsers(); showAlert('success', 'User deleted');
    } catch { /* ignore */ }
  };

  /* ═══ HELPERS ═══ */
  const copyTrackingLink = (trackingToken: string) => {
    const link = `${window.location.origin}/track/${trackingToken}`;
    navigator.clipboard.writeText(link);
    showAlert('success', 'Tracking link copied!');
  };

  const getTrackingLink = (trackingToken: string) => `${window.location.origin}/track/${trackingToken}`;

  const sendWhatsApp = (order: Order) => {
    const phone = order.customer_mobile.startsWith('91') ? order.customer_mobile : '91' + order.customer_mobile;
    const link = getTrackingLink(order.tracking_token);
    const status = order.is_cancelled ? 'Cancelled' : order.tracking_status;
    const message = `Hi ${order.customer_name},\n\nYour order *${order.order_id}* is now: *${status}*\n\n📦 Track your order here:\n${link}\n\nThank you for shopping with us! 🙏`;
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, '_blank');
  };

  const sendEmail = async (order: Order) => {
    if (!order.customer_email) { showAlert('error', 'No email address for this order'); return; }
    try {
      const res = await fetch('/api/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orderIds: [order.order_id], status: order.tracking_status || 'Order Placed' }),
      });
      const data = await res.json();
      if (res.ok) {
        showAlert('success', data.message || 'Email queued — will send within 1 minute');
      } else {
        showAlert('error', data.error || 'Failed to queue email');
      }
    } catch { showAlert('error', 'Failed to queue email'); }
  };

  const toggleSelectAll = () => {
    const filteredOrders = orders.filter((o) => {
      if (emailFilter === 'has_email') return o.customer_email && o.customer_email.includes('@');
      if (emailFilter === 'no_email') return !o.customer_email || !o.customer_email.includes('@');
      return true;
    });
    setSelectedOrders(selectedOrders.size === filteredOrders.length ? new Set() : new Set(filteredOrders.map((o) => o.order_id)));
  };

  const selectRange = (from: number, to: number) => {
    const filteredOrders = orders.filter((o) => {
      if (emailFilter === 'has_email') return o.customer_email && o.customer_email.includes('@');
      if (emailFilter === 'no_email') return !o.customer_email || !o.customer_email.includes('@');
      return true;
    });
    const rangeOrders = filteredOrders.slice(Math.max(0, from - 1), Math.min(to, filteredOrders.length));
    const next = new Set(selectedOrders);
    rangeOrders.forEach((o) => next.add(o.order_id));
    setSelectedOrders(next);
  };

  const selectFirst = (count: number) => {
    const filteredOrders = orders.filter((o) => {
      if (emailFilter === 'has_email') return o.customer_email && o.customer_email.includes('@');
      if (emailFilter === 'no_email') return !o.customer_email || !o.customer_email.includes('@');
      return true;
    });
    const next = new Set(selectedOrders);
    filteredOrders.slice(0, count).forEach((o) => next.add(o.order_id));
    setSelectedOrders(next);
  };

  const toggleSelectOrder = (orderId: string) => {
    const next = new Set(selectedOrders);
    next.has(orderId) ? next.delete(orderId) : next.add(orderId);
    setSelectedOrders(next);
  };

  const handleDeleteAllOrders = async () => {
    const confirmed = window.prompt('This will permanently delete ALL orders. Type CONFIRM to proceed:');
    if (confirmed !== 'CONFIRM') { showAlert('error', 'Cancelled — you must type CONFIRM exactly'); return; }
    try {
      const res = await fetch('/api/orders', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ deleteAll: true }),
      });
      if (res.ok) {
        showAlert('success', 'All orders deleted successfully');
        fetchOrders();
      } else {
        const d = await res.json();
        showAlert('error', d.error || 'Delete failed');
      }
    } catch { showAlert('error', 'Delete failed'); }
  };

  const logout = () => {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
    router.push('/login');
  };

  const totalPages = Math.ceil(totalOrders / limit);

  if (!user) {
    return (
      <div className="loading-center" style={{ minHeight: '100vh' }}>
        <div className="spinner spinner-lg" />
      </div>
    );
  }

  /* ═══════════════════════════════════════ */
  /*              RENDER                     */
  /* ═══════════════════════════════════════ */

  const navItems = [
    { id: 'orders' as TabType, label: 'Orders', icon: ShoppingBag, show: true },
    { id: 'upload' as TabType, label: 'Upload CSV', icon: Upload, show: hasPermission('upload_csv') },
    { id: 'settings' as TabType, label: 'Settings', icon: Settings, show: hasPermission('manage_businesses') },
    { id: 'team' as TabType, label: 'Team', icon: Users, show: hasPermission('manage_team') },
  ].filter((i) => i.show);

  return (
    <div className="admin-layout">
      {/* Mobile overlay */}
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}

      {/* Sidebar */}
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        {/* Panel Switcher */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setShowPanelDropdown(!showPanelDropdown)}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.625rem', width: '100%',
              padding: '0.875rem 1rem', background: 'var(--primary-light)',
              border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            {activeBusiness?.logo_url ? (
              <img src={activeBusiness.logo_url} alt="" style={{ width: 32, height: 32, borderRadius: 6, objectFit: 'contain', background: '#fff' }} />
            ) : (
              <div style={{ width: 32, height: 32, borderRadius: 6, background: activeBusiness?.primary_color || 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: '0.875rem' }}>
                {(activeBusiness?.name || 'T').charAt(0).toUpperCase()}
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--fg)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {activeBusiness?.name || 'All Panels'}
              </div>
              <div style={{ fontSize: '0.625rem', color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                {activeBusiness?.is_shopify_connected
                  ? <><span style={{ color: 'var(--success)' }}>●</span> Shopify connected</>
                  : <><span style={{ color: 'var(--fg-muted)' }}>○</span> Switch panel</>}
              </div>
            </div>
            <ChevronRight size={14} style={{ color: 'var(--fg-muted)', transform: showPanelDropdown ? 'rotate(90deg)' : 'none', transition: '0.15s' }} />
          </button>

          {showPanelDropdown && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
              background: 'var(--card-bg)', border: '1px solid var(--border)',
              borderRadius: '0 0 var(--radius-lg) var(--radius-lg)', boxShadow: 'var(--shadow-lg)',
              maxHeight: 260, overflowY: 'auto',
            }}>
              {/* All Panels option */}
              <button
                onClick={() => switchPanel('')}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%',
                  padding: '0.625rem 1rem', border: 'none', background: !activePanelId ? 'var(--primary-light)' : 'transparent',
                  cursor: 'pointer', fontSize: '0.8125rem', fontWeight: !activePanelId ? 700 : 400,
                  color: !activePanelId ? 'var(--primary)' : 'var(--fg)',
                }}
              >
                <div style={{ width: 24, height: 24, borderRadius: 4, background: 'var(--bg-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.625rem' }}>🏪</div>
                All Panels
                {!activePanelId && <Check size={12} style={{ marginLeft: 'auto', color: 'var(--primary)' }} />}
              </button>
              {/* Each accessible panel */}
              {businesses
                .filter(b => !user?.businessIds || user.businessIds.includes(b.id))
                .map(biz => (
                  <button
                    key={biz.id}
                    onClick={() => switchPanel(biz.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%',
                      padding: '0.625rem 1rem', border: 'none',
                      background: activePanelId === biz.id ? 'var(--primary-light)' : 'transparent',
                      cursor: 'pointer', fontSize: '0.8125rem',
                      fontWeight: activePanelId === biz.id ? 700 : 400,
                      color: activePanelId === biz.id ? 'var(--primary)' : 'var(--fg)',
                    }}
                  >
                    {biz.logo_url ? (
                      <img src={biz.logo_url} alt="" style={{ width: 24, height: 24, borderRadius: 4, objectFit: 'contain', background: '#fff' }} />
                    ) : (
                      <div style={{ width: 24, height: 24, borderRadius: 4, background: biz.primary_color || 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: '0.625rem' }}>
                        {biz.name.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <span style={{ flex: 1, textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{biz.name}</span>
                    {biz.is_shopify_connected && <span style={{ fontSize: '0.625rem', color: 'var(--success)' }}>●</span>}
                    {activePanelId === biz.id && <Check size={12} style={{ color: 'var(--primary)' }} />}
                  </button>
                ))}
            </div>
          )}
        </div>

        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={`nav-btn ${activeTab === item.id ? 'active' : ''}`}
              onClick={() => { setActiveTab(item.id); setSidebarOpen(false); }}
            >
              <item.icon size={18} />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-user">
            <div className="sidebar-avatar">{user.displayName.charAt(0).toUpperCase()}</div>
            <div className="sidebar-user-info">
              <div className="sidebar-user-name">{user.displayName}</div>
              <span className="role-pill">{user.role}</span>
            </div>
          </div>
          <button className="nav-btn" onClick={logout} style={{ marginTop: '0.5rem' }}>
            <LogOut size={18} /> Sign out
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="main-content">
        {/* Mobile header */}
        <div className="mobile-header">
          <button className="btn-icon" onClick={() => setSidebarOpen(true)}><Package size={20} /></button>
          <span className="mobile-header-title">{activeTab}</span>
        </div>

        <div className="main-inner">
          {/* Toast */}
          {alert && (
            <div className={`toast toast-${alert.type}`}>
              {alert.type === 'success' ? <Check size={16} /> : <AlertCircle size={16} />}
              {alert.message}
            </div>
          )}

          {/* ════════ ORDERS TAB ════════ */}
          {activeTab === 'orders' && (
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
                  const count = stage === 'Cancelled'
                    ? orders.filter((o) => o.is_cancelled).length
                    : orders.filter((o) => o.tracking_status === stage && !o.is_cancelled).length;
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
          )}

          {/* ════════ UPLOAD TAB ════════ */}
          {activeTab === 'upload' && hasPermission('upload_csv') && (
            <div className="space-y-6 animate-fade-in-up max-w-2xl">
              <div>
                <h2 className="page-title">Upload CSV</h2>
                <p className="page-subtitle">Import orders from Shopify CSV export</p>
              </div>

              {/* Brands auto-detected from CSV */}

              {/* Drop zone */}
              <div
                className={`upload-zone ${dragOver ? 'dragging' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); const file = e.dataTransfer.files[0]; if (file) handleFileUpload(file); }}
              >
                {uploading ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem', width: '100%', padding: '0 2rem' }}>
                    <Loader2 size={40} style={{ animation: 'spin 0.6s linear infinite', color: 'var(--primary)' }} />
                    <p style={{ fontSize: '0.875rem', fontWeight: 500 }}>
                      {uploadProgress.total > 0
                        ? `Chunk ${uploadProgress.current}/${uploadProgress.total} — ${uploadProgress.percent}%`
                        : 'Parsing CSV...'}
                    </p>
                    {uploadProgress.total > 0 && (
                      <div style={{ width: '100%', height: '6px', background: 'var(--muted)', borderRadius: '3px', overflow: 'hidden' }}>
                        <div style={{ width: `${uploadProgress.percent}%`, height: '100%', background: 'var(--primary)', borderRadius: '3px', transition: 'width 0.3s ease' }} />
                      </div>
                    )}
                    <p style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>Each chunk ~500 rows • fits within 10s timeout</p>
                  </div>
                ) : (
                  <>
                    <div className="upload-icon"><FileUp /></div>
                    <p className="upload-title">Drop your CSV file here</p>
                    <p className="upload-hint">or click to browse • .csv only</p>
                    <input type="file" accept=".csv" onChange={(e) => { const file = e.target.files?.[0]; if (file) handleFileUpload(file); }} />
                  </>
                )}
              </div>

              {/* Results */}
              {uploadResult && (
                <div className="upload-results">
                  {[
                    { label: 'CSV Rows', value: (uploadResult as Record<string, number>).total },
                    { label: 'Unique Orders', value: (uploadResult as Record<string, number>).unique },
                    { label: 'New', value: (uploadResult as Record<string, number>).newOrders },
                    { label: 'Updated', value: (uploadResult as Record<string, number>).updatedOrders },
                  ].map((r) => (
                    <div key={r.label} className="upload-result-card">
                      <p className="upload-result-value">{r.value}</p>
                      <p className="upload-result-label">{r.label}</p>
                    </div>
                  ))}
                </div>
              )}

              {/* Email Queue Status */}
              <div className="tf-card" style={{ padding: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                  <Mail size={15} style={{ color: 'var(--primary)' }} />
                  <span style={{ fontSize: '0.8125rem', fontWeight: 600 }}>Email Queue</span>
                  <span style={{ marginLeft: 'auto', fontSize: '0.625rem', padding: '0.125rem 0.5rem', borderRadius: '9999px', background: 'var(--primary-light)', color: 'var(--primary)', fontWeight: 600 }}>
                    1 email / min
                  </span>
                  <button
                    className="btn-icon"
                    onClick={fetchQueueStats}
                    title="Refresh queue stats"
                    style={{ marginLeft: '0.25rem' }}
                    disabled={loadingQueue}
                  >
                    {loadingQueue
                      ? <Loader2 size={13} style={{ animation: 'spin 0.6s linear infinite' }} />
                      : <Activity size={13} />}
                  </button>
                </div>

                {queueStats ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem' }}>
                    {[
                      { label: 'Pending', value: queueStats.pending ?? 0, color: 'var(--warning)' },
                      { label: 'Sent', value: queueStats.sent ?? 0, color: 'var(--success)' },
                      { label: 'Failed', value: queueStats.failed ?? 0, color: 'var(--danger)' },
                    ].map((s) => (
                      <div key={s.label} style={{ padding: '0.625rem', background: 'var(--bg-subtle)', borderRadius: 'var(--radius-lg)', textAlign: 'center' }}>
                        <div style={{ fontSize: '1.25rem', fontWeight: 700, color: s.value > 0 ? s.color : 'var(--fg-muted)' }}>{s.value.toLocaleString()}</div>
                        <div style={{ fontSize: '0.625rem', color: 'var(--fg-muted)', marginTop: '2px', fontWeight: 500 }}>{s.label}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{ fontSize: '0.8125rem', color: 'var(--fg-muted)', textAlign: 'center', padding: '0.5rem 0' }}>
                    Upload a CSV to see queue status
                  </p>
                )}

                {queueStats && (queueStats.pending ?? 0) > 0 && (
                  <p style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', marginTop: '0.75rem', textAlign: 'center' }}>
                    ⏱️ ~{Math.ceil((queueStats.pending ?? 0) / 60)} hours left &nbsp;·&nbsp; Sending automatically in background
                  </p>
                )}
              </div>

              <div className="info-box">
                <Info size={16} />
                <div>
                  <p className="info-box-title">How it works</p>
                  <p className="info-box-text">
                    Export your orders from Shopify as CSV, then upload here. Brands are <strong>auto-detected</strong> from the Vendor column and panels are created automatically. Re-uploading updates existing orders without duplicates. Emails are <strong>queued automatically</strong> on upload and sent 1 per minute in the background — no clicking needed.
                  </p>
                </div>
              </div>

            </div>
          )}

          {/* ════════ BUSINESSES TAB ════════ */}
          {/* ════════ SETTINGS TAB ════════ */}
          {activeTab === 'settings' && hasPermission('manage_businesses') && (
            <div className="space-y-6 animate-fade-in-up">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <h2 className="page-title">Panel Settings</h2>
                  <p className="page-subtitle">
                    {activeBusiness ? `Editing: ${activeBusiness.name}` : 'Select a panel from the top-left or manage all panels below'}
                  </p>
                </div>
                {/* New Panel button */}
                {user?.role === 'admin' && (
                  <button className="btn btn-primary btn-sm" onClick={async () => {
                    const name = prompt('New panel name (e.g. Store Name):');
                    if (!name) return;
                    const res = await fetch('/api/businesses', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                      body: JSON.stringify({ name }),
                    });
                    if (res.ok) { showAlert('success', `Panel "${name}" created`); fetchBusinesses(); }
                    else showAlert('error', 'Failed to create panel');
                  }}>
                    <Plus size={14} /> New Panel
                  </button>
                )}
              </div>

              {/* Panel list */}
              {businesses.length > 0 && (
                <div className="tf-card" style={{ padding: '1rem' }}>
                  <div style={{ fontSize: '0.8125rem', fontWeight: 600, marginBottom: '0.75rem', color: 'var(--fg-muted)' }}>All Panels</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                    {businesses.map(biz => (
                      <button key={biz.id} onClick={() => switchPanel(biz.id)} style={{
                        display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.375rem 0.75rem',
                        borderRadius: '9999px', border: activePanelId === biz.id ? '2px solid var(--primary)' : '1px solid var(--border)',
                        background: activePanelId === biz.id ? 'var(--primary-light)' : 'var(--card-bg)',
                        fontSize: '0.75rem', fontWeight: 500, cursor: 'pointer',
                        color: activePanelId === biz.id ? 'var(--primary)' : 'var(--fg)',
                      }}>
                        {biz.is_shopify_connected && <span style={{ color: 'var(--success)', fontSize: '0.5rem' }}>●</span>}
                        {biz.name}
                        {activePanelId === biz.id && <Check size={10} />}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {activeBusiness && (
                <>
                  {/* Brand settings card */}
                  <div className="tf-card" style={{ padding: '1.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.25rem' }}>
                      <Building2 size={16} style={{ color: 'var(--primary)' }} />
                      <span style={{ fontWeight: 700 }}>Branding</span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.25rem' }}>
                      {brandForm.logoUrl ? (
                        <img src={brandForm.logoUrl.includes('drive.google.com') ? brandForm.logoUrl.replace(/\/file\/d\/([^/]+).*/, '/uc?export=view&id=$1') : brandForm.logoUrl} alt="Logo" style={{ width: '4rem', height: '4rem', borderRadius: '0.75rem', objectFit: 'cover', border: '2px solid var(--border)' }} />
                      ) : (
                        <div style={{ width: '4rem', height: '4rem', borderRadius: '0.75rem', background: brandForm.primaryColor || 'var(--primary-light)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.5rem', fontWeight: 700, color: '#fff' }}>
                          {brandForm.name ? brandForm.name.charAt(0).toUpperCase() : '?'}
                        </div>
                      )}
                      <div>
                        <p style={{ fontWeight: 700, fontSize: '1.125rem' }}>{brandForm.name || 'Panel Name'}</p>
                        <p style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>Customers see this on tracking pages &amp; emails</p>
                      </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                      <div className="form-group">
                        <label className="form-label">Panel / Brand Name *</label>
                        <input className="form-input" value={brandForm.name} onChange={(e) => setBrandForm({ ...brandForm, name: e.target.value })} placeholder="e.g. My Store" />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Brand Color</label>
                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                          <input type="color" value={brandForm.primaryColor} onChange={(e) => setBrandForm({ ...brandForm, primaryColor: e.target.value })} style={{ width: 36, height: 36, border: 'none', borderRadius: 6, cursor: 'pointer', padding: 2 }} />
                          <input className="form-input" value={brandForm.primaryColor} onChange={(e) => setBrandForm({ ...brandForm, primaryColor: e.target.value })} style={{ flex: 1 }} />
                        </div>
                      </div>
                      <div className="form-group">
                        <label className="form-label">Logo URL / Upload</label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <label className="btn btn-outline btn-sm" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.375rem' }}>
                            <Upload size={14} /> Upload
                            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              if (file.size > 500 * 1024) { showAlert('error', 'Logo must be under 500KB'); return; }
                              const reader = new FileReader();
                              reader.onload = () => setBrandForm({ ...brandForm, logoUrl: reader.result as string });
                              reader.readAsDataURL(file);
                            }} />
                          </label>
                          {brandForm.logoUrl && <button className="btn-icon" onClick={() => setBrandForm({ ...brandForm, logoUrl: '' })} style={{ color: 'var(--danger)' }}><X size={14} /></button>}
                        </div>
                      </div>
                      <div className="form-group">
                        <label className="form-label">Support Email</label>
                        <input className="form-input" type="email" value={brandForm.supportEmail} onChange={(e) => setBrandForm({ ...brandForm, supportEmail: e.target.value })} placeholder="support@yourbrand.com" />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Support Phone</label>
                        <input className="form-input" value={brandForm.supportPhone} onChange={(e) => setBrandForm({ ...brandForm, supportPhone: e.target.value })} placeholder="+91 98765 43210" />
                      </div>
                      <div className="form-group">
                        <label className="form-label">📧 Tracking Domain (fixes IP bug)</label>
                        <input className="form-input" value={brandForm.trackingDomain} onChange={(e) => setBrandForm({ ...brandForm, trackingDomain: e.target.value })} placeholder="https://track.yourbrand.com" />
                        <p style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginTop: '0.25rem' }}>
                          Email tracking links use this domain. Leave blank to use server default.
                        </p>
                      </div>
                    </div>

                    <div style={{ marginTop: '1.25rem' }}>
                      <button className="btn btn-primary" disabled={!brandForm.name || savingBrand} onClick={async () => {
                        setSavingBrand(true);
                        try {
                          const body = {
                            id: activeBusiness.id, name: brandForm.name,
                            logoUrl: brandForm.logoUrl || null,
                            supportEmail: brandForm.supportEmail || null,
                            supportPhone: brandForm.supportPhone || null,
                            trackingDomain: brandForm.trackingDomain || null,
                            primaryColor: brandForm.primaryColor || '#4F46E5',
                          };
                          const res = await fetch('/api/businesses', {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                            body: JSON.stringify(body),
                          });
                          if (res.ok) { showAlert('success', 'Panel settings saved!'); fetchBusinesses(); }
                          else showAlert('error', 'Failed to save');
                        } catch { showAlert('error', 'Failed to save'); }
                        finally { setSavingBrand(false); }
                      }}>
                        {savingBrand ? <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> : <Check size={14} />}
                        {savingBrand ? 'Saving...' : 'Save Branding'}
                      </button>
                    </div>
                  </div>

                  {/* Shopify Connect card */}
                  <div className="tf-card" style={{ padding: '1.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
                      <ShoppingBag size={16} style={{ color: '#96bf48' }} />
                      <span style={{ fontWeight: 700 }}>Shopify Webhook Setup</span>
                      <span style={{ fontSize: '0.625rem', padding: '0.125rem 0.5rem', borderRadius: '9999px', background: 'rgba(150,191,72,0.15)', color: '#96bf48', fontWeight: 600 }}>2 min setup</span>
                    </div>

                    <p style={{ fontSize: '0.8125rem', color: 'var(--fg-muted)', marginBottom: '1.25rem' }}>
                      Copy your unique webhook URL below and add it to Shopify. New orders will automatically flow into this panel.
                    </p>

                    {/* Webhook URL box */}
                    <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '0.875rem 1rem', marginBottom: '1.5rem' }}>
                      <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginBottom: '0.375rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Your Webhook URL</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <code style={{ flex: 1, fontSize: '0.8125rem', color: 'var(--primary)', wordBreak: 'break-all' }}>
                          {`${process.env.NEXT_PUBLIC_BASE_URL || 'https://shiptrack.store'}/api/shopify/webhook?b=${activePanelId}`}
                        </code>
                        <button
                          className="btn btn-sm btn-outline"
                          style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                          onClick={() => {
                            navigator.clipboard.writeText(`${process.env.NEXT_PUBLIC_BASE_URL || 'https://shiptrack.store'}/api/shopify/webhook?b=${activePanelId}`);
                            const btn = document.getElementById('copy-webhook-btn');
                            if (btn) { btn.textContent = '✅ Copied!'; setTimeout(() => { btn.textContent = 'Copy URL'; }, 2000); }
                          }}
                          id="copy-webhook-btn"
                        >
                          Copy URL
                        </button>
                      </div>
                    </div>

                    {/* Step by step guide */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                      {[
                        {
                          step: 1,
                          title: 'Open Shopify Notifications',
                          desc: 'Go to your Shopify Admin → Settings → Notifications',
                          link: 'https://admin.shopify.com/settings/notifications',
                          linkText: 'Open Shopify Settings →',
                        },
                        {
                          step: 2,
                          title: 'Create Webhook',
                          desc: 'Scroll to the bottom of the page → click "Webhooks" → click "Create webhook"',
                          link: null,
                          linkText: null,
                        },
                        {
                          step: 3,
                          title: 'Configure the Webhook',
                          desc: 'Event: Order creation  |  Format: JSON  |  URL: paste your webhook URL above',
                          link: null,
                          linkText: null,
                        },
                        {
                          step: 4,
                          title: 'Save & Done',
                          desc: 'Click Save. Every new order from this store will automatically appear in this panel.',
                          link: null,
                          linkText: null,
                        },
                      ].map(({ step, title, desc, link, linkText }) => (
                        <div key={step} style={{ display: 'flex', gap: '0.875rem', alignItems: 'flex-start', padding: '0.875rem', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)' }}>
                          <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--primary)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '0.8125rem', flexShrink: 0 }}>
                            {step}
                          </div>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 600, fontSize: '0.875rem', marginBottom: '0.25rem' }}>{title}</div>
                            <div style={{ fontSize: '0.8125rem', color: 'var(--fg-muted)' }}>{desc}</div>
                            {link && (
                              <a href={link} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.8125rem', color: 'var(--primary)', fontWeight: 600, display: 'inline-block', marginTop: '0.375rem' }}>
                                {linkText}
                              </a>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>

                    <p style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginTop: '1rem' }}>
                      ℹ️ Share this panel's webhook URL with your team member. They add it to their Shopify store once and orders start flowing in automatically — no login, no API tokens needed.
                    </p>
                  </div>

                </>
              )}

              {!activeBusiness && businesses.length === 0 && (
                <div className="tf-card" style={{ padding: '2rem', textAlign: 'center' }}>
                  <Building2 size={40} style={{ opacity: 0.2, marginBottom: '0.75rem' }} />
                  <p style={{ color: 'var(--fg-muted)' }}>No panels yet. Click <strong>New Panel</strong> to create your first store panel.</p>
                </div>
              )}


              {/* ── Auto-Progression Settings ── */}
              <div className="tf-card" style={{ padding: '1.5rem', marginTop: '0.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Timer size={18} style={{ color: 'var(--primary)' }} />
                    <span style={{ fontWeight: 700, fontSize: '1rem' }}>Auto-Progression</span>
                  </div>
                  <button
                    className="btn btn-sm btn-outline"
                    style={{ fontSize: '0.75rem' }}
                    onClick={fetchProgressionSteps}
                  >
                    Refresh
                  </button>
                </div>
                <p style={{ fontSize: '0.8125rem', color: 'var(--fg-muted)', marginBottom: '1.25rem' }}>
                  Orders automatically move through stages after the set time. Customer tracking pages update in real-time.
                </p>

                {progressionSteps.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--fg-muted)' }}>
                    <Timer size={32} style={{ opacity: 0.3, marginBottom: '0.5rem' }} />
                    <p style={{ fontSize: '0.875rem' }}>Loading progression settings...</p>
                    <button className="btn btn-sm btn-primary" style={{ marginTop: '0.75rem' }} onClick={fetchProgressionSteps}>Load Settings</button>
                  </div>
                ) : (
                  <>
                    {/* Visual Timeline */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                      {/* Order Placed (start) */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.625rem 0' }}>
                        <div style={{ width: '2.25rem', height: '2.25rem', borderRadius: '50%', background: 'var(--success)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: '0.75rem', fontWeight: 700, flexShrink: 0 }}>1</div>
                        <span style={{ fontWeight: 600, fontSize: '0.875rem', minWidth: '10rem' }}>Order Placed</span>
                      </div>

                      {progressionSteps.map((step, idx) => (
                        <div key={step.id}>
                          {/* Delay connector */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.375rem 0', paddingLeft: '0.875rem' }}>
                            <div style={{ width: '2px', height: '2rem', background: step.is_enabled ? 'var(--primary)' : 'var(--border)', marginLeft: '0', flexShrink: 0 }} />
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1 }}>
                              <ArrowRight size={12} style={{ color: 'var(--fg-muted)' }} />
                              <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>after</span>
                              <input
                                type="number"
                                min="1"
                                value={step.delay_minutes}
                                onChange={(e) => {
                                  const val = parseInt(e.target.value) || 1;
                                  setProgressionSteps(prev => prev.map(s => s.id === step.id ? { ...s, delay_minutes: val } : s));
                                  setProgressionDirty(true);
                                }}
                                style={{ width: '5rem', padding: '0.25rem 0.5rem', borderRadius: '0.375rem', border: '1.5px solid var(--border)', background: 'var(--bg)', fontSize: '0.8125rem', fontWeight: 600, textAlign: 'center' }}
                              />
                              <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>
                                min {step.delay_minutes >= 60 && <span style={{ color: 'var(--primary)', fontWeight: 600 }}>({step.delay_minutes >= 1440 ? `${(step.delay_minutes / 1440).toFixed(1)} days` : `${(step.delay_minutes / 60).toFixed(1)} hrs`})</span>}
                              </span>
                              <button
                                onClick={() => {
                                  setProgressionSteps(prev => prev.map(s => s.id === step.id ? { ...s, is_enabled: !s.is_enabled } : s));
                                  setProgressionDirty(true);
                                }}
                                title={step.is_enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
                                style={{ cursor: 'pointer', background: 'none', border: 'none', padding: '0.125rem', display: 'flex' }}
                              >
                                {step.is_enabled
                                  ? <ToggleRight size={20} style={{ color: 'var(--success)' }} />
                                  : <ToggleLeft size={20} style={{ color: 'var(--fg-muted)' }} />
                                }
                              </button>
                            </div>
                          </div>

                          {/* Step destination */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.625rem 0', opacity: step.is_enabled ? 1 : 0.4 }}>
                            <div style={{
                              width: '2.25rem', height: '2.25rem', borderRadius: '50%',
                              background: idx === progressionSteps.length - 1 ? 'var(--success)' : 'var(--primary)',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              color: 'white', fontSize: '0.75rem', fontWeight: 700, flexShrink: 0
                            }}>{idx + 2}</div>
                            <span style={{ fontWeight: 600, fontSize: '0.875rem' }}>{step.step_to}</span>
                            {idx === progressionSteps.length - 1 && <Check size={16} style={{ color: 'var(--success)' }} />}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Total time */}
                    <div style={{ marginTop: '1rem', padding: '0.75rem 1rem', background: 'var(--primary-light)', borderRadius: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <Timer size={14} style={{ color: 'var(--primary)' }} />
                      <span style={{ fontSize: '0.8125rem', color: 'var(--primary)', fontWeight: 600 }}>
                        Total estimated delivery: ~{(() => {
                          const totalMin = progressionSteps.filter(s => s.is_enabled).reduce((sum, s) => sum + s.delay_minutes, 0);
                          if (totalMin >= 1440) return `${(totalMin / 1440).toFixed(1)} days`;
                          if (totalMin >= 60) return `${(totalMin / 60).toFixed(1)} hours`;
                          return `${totalMin} minutes`;
                        })()}
                      </span>
                    </div>

                    {/* Save button */}
                    <div style={{ marginTop: '1rem' }}>
                      <button
                        className="btn btn-primary"
                        disabled={!progressionDirty || savingProgression}
                        onClick={async () => {
                          setSavingProgression(true);
                          try {
                            const res = await fetch('/api/progression-settings', {
                              method: 'PUT',
                              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                              body: JSON.stringify({ steps: progressionSteps }),
                            });
                            if (res.ok) {
                              showAlert('success', 'Auto-progression settings saved!');
                              setProgressionDirty(false);
                              fetchProgressionSteps();
                            } else { showAlert('error', 'Failed to save progression settings'); }
                          } catch { showAlert('error', 'Failed to save'); }
                          finally { setSavingProgression(false); }
                        }}
                      >
                        {savingProgression ? <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> : <Check size={14} />}
                        {savingProgression ? 'Saving...' : 'Save Progression Settings'}
                      </button>
                    </div>
                  </>
                )}
              </div>

              {/* Danger Zone */}
              {user?.role === 'admin' && (
                <div className="tf-card" style={{ padding: '1.5rem', border: '1.5px solid var(--danger)', marginTop: '0.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                    <Trash2 size={16} style={{ color: 'var(--danger)' }} />
                    <span style={{ fontWeight: 700, fontSize: '0.9375rem', color: 'var(--danger)' }}>Danger Zone</span>
                  </div>
                  <p style={{ fontSize: '0.8125rem', color: 'var(--fg-muted)', marginBottom: '1rem' }}>
                    Permanently deletes <strong>all orders</strong>, order items, tracking history, and email logs from the database. This action <strong>cannot be undone</strong>.
                  </p>
                  <button
                    className="btn"
                    style={{ background: 'var(--danger)', color: 'white', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                    onClick={handleDeleteAllOrders}
                  >
                    <Trash2 size={14} /> Delete All Orders
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ════════ TEAM TAB ════════ */}
          {activeTab === 'team' && hasPermission('manage_team') && (
            <div className="space-y-6 animate-fade-in-up">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <h2 className="page-title">Team</h2>
                  <p className="page-subtitle">Manage team members, roles, and panel access</p>
                </div>
                <button className="btn btn-primary" onClick={() => setShowTeamModal(true)}>
                  <UserPlus size={16} /> Add Member
                </button>
              </div>

              <div className="info-box">
                <Info size={16} />
                <div>
                  <p className="info-box-text">
                    <strong>Admin</strong> — Full access to all panels &nbsp;|&nbsp;
                    <strong>Manager</strong> — Upload, update, cancel &nbsp;|&nbsp;
                    <strong>Viewer</strong> — View only
                  </p>
                </div>
              </div>

              <div className="table-card">
                <table className="tf-table">
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th className="col-hide-sm">Role</th>
                      <th>Panel Access</th>
                      <th className="col-hide-lg">Last Login</th>
                      <th style={{ textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* Super admin */}
                    <tr>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                          <div className="sidebar-avatar" style={{ width: '2rem', height: '2rem', fontSize: '0.75rem' }}>S</div>
                          <div>
                            <p style={{ fontWeight: 500 }}>Super Admin</p>
                            <p style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>env credentials</p>
                          </div>
                        </div>
                      </td>
                      <td className="col-hide-sm"><span className="role-pill">admin</span></td>
                      <td><span style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)' }}>All panels</span></td>
                      <td className="col-hide-lg" style={{ color: 'var(--fg-muted)' }}>—</td>
                      <td style={{ textAlign: 'right', fontSize: '0.75rem', color: 'var(--fg-muted)' }}>System account</td>
                    </tr>
                    {teamUsers.map((tu) => (
                      <>
                        <tr key={tu.id}>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                              <div className="sidebar-avatar" style={{ width: '2rem', height: '2rem', fontSize: '0.75rem' }}>{tu.display_name.charAt(0)}</div>
                              <div>
                                <p style={{ fontWeight: 500 }}>{tu.display_name}</p>
                                <p style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>@{tu.username}</p>
                              </div>
                            </div>
                          </td>
                          <td className="col-hide-sm"><span className="role-pill">{tu.role}</span></td>
                          <td>
                            {editingUserPanels === tu.id ? (
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', alignItems: 'center' }}>
                                {businesses.map(biz => (
                                  <label key={biz.id} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.6875rem', cursor: 'pointer', padding: '0.125rem 0.375rem', borderRadius: '9999px', border: '1px solid var(--border)', background: editUserPanelIds.includes(biz.id) ? 'var(--primary-light)' : 'transparent', color: editUserPanelIds.includes(biz.id) ? 'var(--primary)' : 'var(--fg-muted)' }}>
                                    <input type="checkbox" style={{ display: 'none' }} checked={editUserPanelIds.includes(biz.id)} onChange={(e) => {
                                      if (e.target.checked) setEditUserPanelIds([...editUserPanelIds, biz.id]);
                                      else setEditUserPanelIds(editUserPanelIds.filter(id => id !== biz.id));
                                    }} />
                                    {biz.name}
                                  </label>
                                ))}
                                <button className="btn btn-primary btn-sm" style={{ fontSize: '0.625rem', padding: '0.125rem 0.5rem' }} onClick={() => handleUpdateUserPanels(tu.id)}>Save</button>
                                <button className="btn btn-outline btn-sm" style={{ fontSize: '0.625rem', padding: '0.125rem 0.5rem' }} onClick={() => setEditingUserPanels(null)}>Cancel</button>
                              </div>
                            ) : (
                              <button onClick={() => { setEditingUserPanels(tu.id); setEditUserPanelIds(tu.business_ids || []); }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.6875rem', color: 'var(--primary)', textDecoration: 'underline' }}>
                                {tu.business_ids && tu.business_ids.length > 0
                                  ? businesses.filter(b => tu.business_ids!.includes(b.id)).map(b => b.name).join(', ') || 'Set panels'
                                  : 'All panels'}
                              </button>
                            )}
                          </td>
                          <td className="col-hide-lg" style={{ color: 'var(--fg-muted)' }}>
                            {tu.last_login ? new Date(tu.last_login).toLocaleDateString() : 'Never'}
                          </td>
                          <td>
                            <div className="table-actions">
                              <button className="btn-icon" onClick={() => handleToggleTeamUser(tu.id, !tu.is_active)} title={tu.is_active ? 'Disable' : 'Enable'}>
                                {tu.is_active ? <Lock size={16} /> : <Unlock size={16} />}
                              </button>
                              <button className="btn-icon" onClick={() => handleDeleteTeamUser(tu.id)} title="Delete" style={{ color: 'var(--danger)' }}>
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      </>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* ════════ MODALS ════════ */}

      {/* Bulk Status Modal */}
      {showStatusModal && (
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
      )}

      {/* Order Detail Modal */}
      {showDetailModal && detailOrder && (
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
                  <p className="detail-field-value">{[detailOrder.address_line1, detailOrder.address_line2, detailOrder.address_line3].filter(Boolean).join(', ')}</p>
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
      )}

      {/* Add Team Member Modal */}
      {showTeamModal && (
        <div className="modal-overlay" onClick={() => setShowTeamModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Add Team Member</h3>
              <button className="btn-icon" onClick={() => setShowTeamModal(false)}><X size={16} /></button>
            </div>
            <div className="space-y-4">
              <div className="form-group"><label className="form-label">Display Name</label><input type="text" className="form-input" placeholder="John Doe" value={newTeamUser.displayName} onChange={(e) => setNewTeamUser({ ...newTeamUser, displayName: e.target.value })} /></div>
              <div className="form-group"><label className="form-label">Username</label><input type="text" className="form-input" placeholder="johndoe" value={newTeamUser.username} onChange={(e) => setNewTeamUser({ ...newTeamUser, username: e.target.value })} /></div>
              <div className="form-group"><label className="form-label">Password</label><input type="password" className="form-input" placeholder="Secure password" value={newTeamUser.password} onChange={(e) => setNewTeamUser({ ...newTeamUser, password: e.target.value })} /></div>
              <div className="form-group">
                <label className="form-label">Role</label>
                <select className="form-select" style={{ width: '100%' }} value={newTeamUser.role} onChange={(e) => setNewTeamUser({ ...newTeamUser, role: e.target.value })}>
                  <option value="viewer">Viewer (read-only)</option>
                  <option value="manager">Manager (upload + update)</option>
                  <option value="admin">Admin (full access)</option>
                </select>
              </div>
              <div className="modal-actions">
                <button className="btn btn-outline" onClick={() => setShowTeamModal(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={handleCreateTeamUser} disabled={!newTeamUser.username || !newTeamUser.password || !newTeamUser.displayName}>Create User</button>
              </div>
            </div>
          </div>
        </div>
      )}





      {/* Select Range Modal */}
      {showRangeModal && (
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
      )}
    </div>
  );
}

/* ═══ STAT CARD COMPONENT ═══ */
function StatCard({ icon: Icon, label, value, color }: { icon: typeof ShoppingBag; label: string; value: number; color: string }) {
  return (
    <div className="stat-card">
      <div className="stat-card-header">
        <span className="stat-card-label">{label}</span>
        <Icon size={18} className="stat-card-icon" style={{ color }} />
      </div>
      <p className="stat-card-value">{value}</p>
    </div>
  );
}
