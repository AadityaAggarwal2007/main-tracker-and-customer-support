'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import ChikkiCard from '@/components/ChikkiCard';
import PanelCopyCard from '@/components/PanelCopyCard';
import GmailAccountsOverview from '@/components/GmailAccountsOverview';
import AutoProgressionCard from '@/components/AutoProgressionCard';
import TeamCard from '@/components/TeamCard';
import TeamScoreCard from '@/components/TeamScoreCard';
import RefundRequestsCard from '@/components/RefundRequestsCard';
import MailCard from '@/components/MailCard';
import { clearMailCache } from '@/components/mail/cache';
import ChargebacksCard from '@/components/ChargebacksCard';
import ChargebackSettingsCard from '@/components/ChargebackSettingsCard';
import OwnerLoginDialog from '@/components/OwnerLogin';
import MyProfile from '@/components/MyProfile';
import { can, isSuperAdmin, type Permission } from '@/lib/permissions';
import { activeHeaders } from '@/lib/presence-client';
import { useRouter } from 'next/navigation';
import {
  Package, Upload, Users, Mail,
  Check, AlertCircle, ShoppingBag,
  Loader2, Trash2, Building2, Plus,
  Settings, Trophy, Undo2, ShieldAlert
} from 'lucide-react';
import type { ParseConfig } from 'papaparse';
import type { RecentUpload, Order, AuthUser, Business, PanelEmailAccount, PanelChatSite, PanelImpact, TabType } from './_lib/types';
import { plural, agoText } from './_lib/format';
import AdminSidebar from './_components/AdminSidebar';
import OrdersTab from './_components/OrdersTab';
import PanelBoard from '@/components/PanelBoard';
import UploadTab from './_components/UploadTab';
import UploadWarningDialog from './_components/UploadWarningDialog';
import NewPanelDialog from './_components/NewPanelDialog';
import { cleanCSVData } from '@/lib/csv-cleaner';
import BrandingCard from './_components/BrandingCard';
import ChatWidgetCard from './_components/ChatWidgetCard';
import BulkStatusModal from './_components/BulkStatusModal';
import OrderDetailModal from './_components/OrderDetailModal';
import SelectRangeModal from './_components/SelectRangeModal';
import DeletePanelModal from './_components/DeletePanelModal';
import SettingsPanelList from './_components/SettingsPanelList';
import SettingsJumpBar from './_components/SettingsJumpBar';

export default function AdminDashboard() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState('');
  // Login & security (the owner's own login), opened from the sidebar's Super Admin; My profile for a
  // team member (their name, role, panels), opened from their name in the sidebar.
  const [securityOpen, setSecurityOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const openMe = () => (user?.role === 'admin' ? setSecurityOpen(true) : setProfileOpen(true));
  const [activeTab, setActiveTab] = useState<TabType>('orders');
  // A chat's "Emails" link (/admin?tab=mail&box=&uid=) opens that mail once (owner 2026-10-08).
  const [mailLink, setMailLink] = useState<{ box: string; uid: number } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Refund requests (owner, 2026-10-02; Super Admin only): the red pill = New requests he has not
  // opened yet, and the request a chat's "Open request" link asks to open (/admin?tab=refunds&open=<id>).
  const [refundUnseen, setRefundUnseen] = useState(0);
  const [chargebackNew, setChargebackNew] = useState(0);
  const [refundOpenId, setRefundOpenId] = useState<string | null>(null);

  // Orders
  const [orders, setOrders] = useState<Order[]>([]);
  const [totalOrders, setTotalOrders] = useState(0);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
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
  const [uploadPanelId, setUploadPanelId] = useState<string>(''); // REQUIRED: panel for CSV
  // "Is this the right panel?" (owner 2026-10-08): the answer is awaited before any chunk is sent.
  const [uploadWarn, setUploadWarn] = useState<{ warnings: { code: string; message: string }[]; resolve: (ok: boolean) => void } | null>(null);
  const [recentUploads, setRecentUploads] = useState<RecentUpload[]>([]);
  const [newPanelOpen, setNewPanelOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0, percent: 0 });

  // Draft queue
  const [queueStats, setQueueStats] = useState<{ pending: number; sent?: number; processing: number; done: number; failed: number; total: number } | null>(null);
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

  // Panel switcher
  const [activePanelId, setActivePanelId] = useState<string>('');

  // Businesses / Brand Settings
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [activeBusiness, setActiveBusiness] = useState<Business | null>(null);
  const [brandForm, setBrandForm] = useState({ name: '', logoUrl: '', supportEmail: '', supportPhone: '', trackingDomain: '', primaryColor: '#4F46E5', originCity: '' });
  const [savingBrand, setSavingBrand] = useState(false);

  // Chat widget settings for this panel
  const [chatSite, setChatSite] = useState<PanelChatSite | null>(null);
  const [promptDraft, setPromptDraft] = useState('');
  const [savingChat, setSavingChat] = useState(false);
  // "COD only in some states": the states being typed, and whether the box is open.
  const [codStatesDraft, setCodStatesDraft] = useState('');
  const [codStatesOpen, setCodStatesOpen] = useState(false);
  // Conversations parked for a person. Polled for the sidebar badge: an
  // escalated EMAIL reply is never auto-sent, so this queue going unwatched
  // means those customers sit in silence.
  // Saved answers (Q&A) the agent must reuse verbatim.
  const [faqs, setFaqs] = useState<{ id: string; question: string; answer: string; is_enabled: boolean }[]>([]);
  const [faqDraft, setFaqDraft] = useState({ question: '', answer: '' });
  const [faqBusy, setFaqBusy] = useState(false);
  const [humanNeeded, setHumanNeeded] = useState(0);
  const [emailWaiting, setEmailWaiting] = useState(0);
  const [copiedSnippet, setCopiedSnippet] = useState(false);

  // Delete panel (Tracker + chat support)
  const [deletePanelTarget, setDeletePanelTarget] = useState<Business | null>(null);
  const [deleteImpact, setDeleteImpact] = useState<PanelImpact | null>(null);
  const [deleteImpactLoading, setDeleteImpactLoading] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deletingPanel, setDeletingPanel] = useState(false);

  // Shopify connect
  const [shopifyForm, setShopifyForm] = useState({ domain: '', apiToken: '' });
  const [connectingShopify, setConnectingShopify] = useState(false);

  // Email support — mailboxes the AI answers for this panel
  const [panelEmails, setPanelEmails] = useState<PanelEmailAccount[]>([]);
  // Email replies: ON = Chikki writes a draft and the team sends (the default), OFF = she answers routine mails herself.
  const [panelEmailDraftOnly, setPanelEmailDraftOnly] = useState(true);
  const [loadingPanelEmails, setLoadingPanelEmails] = useState(false);
  const [newPanelEmail, setNewPanelEmail] = useState({ email: '', appPassword: '' });
  const [addingPanelEmail, setAddingPanelEmail] = useState(false);



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
    // An expired token, or one from before tokens were signed, is refused by
    // every API — send the person to log in again instead of showing nothing.
    // The session answer also carries the login's current role, panels and permissions (the
    // owner may have changed them in Team since this login), so the screens follow it.
    fetch('/api/auth/session', { headers: { Authorization: `Bearer ${savedToken}` } })
      .then(async (res) => {
        if (res.status === 401) {
          localStorage.removeItem('auth_token');
          localStorage.removeItem('auth_user');
          router.push('/login');
          return;
        }
        const d = await res.json().catch(() => null);
        if (d?.user) { setUser(d.user); localStorage.setItem('auth_user', JSON.stringify(d.user)); }
      })
      .catch(() => { /* offline: leave the page as it is */ });
  }, [router]);

  // The owner changed his login in another tab (Team), or someone signed in there: this tab takes
  // the new login (the old owner login is dead).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'auth_token' && e.newValue) setToken(e.newValue);
      if (e.key === 'auth_user' && e.newValue) { try { setUser(JSON.parse(e.newValue)); } catch { /* ignore */ } }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // The screens' old permission names, now answered by src/lib/permissions.ts (the API routes
  // check the same rules for real). Team = the super admin only.
  const LEGACY_PERMS: Record<string, Permission | 'super' | 'settings'> = {
    upload_csv: 'orders.upload', update_status: 'orders.update', cancel_order: 'orders.cancel', delete_order: 'orders.delete',
    view_orders: 'orders.view', manage_team: 'super', manage_businesses: 'settings',
  };
  const hasPermission = (perm: string) => {
    if (!user) return false;
    const m = LEGACY_PERMS[perm];
    if (m === 'super') return isSuperAdmin(user);
    if (m === 'settings') return isSuperAdmin(user) || can(user, 'settings.panel') || can(user, 'chikki.edit');
    return m ? can(user, m) : false;
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
      const res = await fetch(`/api/orders?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      const data = await res.json();
      if (res.ok) { setOrders(data.orders); setTotalOrders(data.total); if (data.statusCounts) setStatusCounts(data.statusCounts); }
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

  const fetchBusinesses = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch('/api/businesses', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (res.ok) setBusinesses(data.businesses || []);
    } catch { /* ignore */ }
  }, [token]);

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

  useEffect(() => { if (token) { fetchOrders(); fetchBrands(); fetchBusinesses(); fetchEmailStats(); } }, [token, fetchOrders, fetchBrands, fetchBusinesses, fetchEmailStats]);
  useEffect(() => { if (activeTab === 'upload' && token) fetchQueueStats(); }, [activeTab, token, fetchQueueStats]);
  const fetchUploads = useCallback(async () => {
    try {
      const res = await fetch('/api/upload', { headers: { Authorization: `Bearer ${token}` } });
      const d = await res.json();
      if (res.ok && Array.isArray(d.uploads)) setRecentUploads(d.uploads);
    } catch { /* the list is only a record */ }
  }, [token]);
  useEffect(() => { if (activeTab === 'upload' && token) fetchUploads(); }, [activeTab, token, fetchUploads]);

  // Sidebar badge: refresh on load, on panel switch, and every 30s. activeHeaders(): while the
  // person is really using this tab, the poll also says they are in ShipTrack (chat team presence,
  // src/lib/presence-client.ts), so working on Orders counts as "seen", not only the chat inbox.
  useEffect(() => {
    if (!token) return;
    let alive = true;
    const load = async () => {
      try {
        const qs = activePanelId ? `?businessId=${activePanelId}` : '';
        const r = await fetch(`/api/chat/pending${qs}`, { headers: { Authorization: `Bearer ${token}`, ...activeHeaders() } });
        if (!r.ok) return;
        const d = await r.json();
        if (!alive) return;
        setHumanNeeded(d.humanNeeded || 0);
        setEmailWaiting(d.emailWaiting || 0);
      } catch { /* badge is advisory; a failed poll just leaves the last count */ }
    };
    load();
    const t = setInterval(load, 30000);
    return () => { alive = false; clearInterval(t); };
  }, [token, activePanelId]);
  useEffect(() => { fetchEmailedOrders(); }, [fetchEmailedOrders]);

  // Refund requests badge (Super Admin only): every 60 s and when the window gets focus. Advisory: a
  // failed poll keeps the last number. Counts only, never a request's details.
  const superAdmin = isSuperAdmin(user);
  const refreshRefundCounts = useCallback(async () => {
    if (!token || !superAdmin) return;
    try {
      const r = await fetch('/api/refunds/counts', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      setRefundUnseen(Number(d?.unseen) || 0);
    } catch { /* the badge is advisory */ }
  }, [token, superAdmin]);
  // Chargeback badge (owner 2026-10-08), Super Admin only: new = chargeback mails not opened yet. Same rhythm as the
  // refund badge: every 60 s and on window focus; advisory, a failed poll keeps the last number.
  const refreshChargebackCounts = useCallback(async () => {
    if (!token || !superAdmin) return;
    try {
      const r = await fetch('/api/chargebacks?counts=1', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      setChargebackNew(Number(d?.new) || 0);
    } catch { /* the badge is advisory */ }
  }, [token, superAdmin]);
  useEffect(() => {
    if (!token || !superAdmin) return;
    void refreshChargebackCounts();
    const t = setInterval(() => { void refreshChargebackCounts(); }, 60000);
    const onFocus = () => { void refreshChargebackCounts(); };
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [token, superAdmin, refreshChargebackCounts]);
  useEffect(() => {
    if (!token || !superAdmin) return;
    void refreshRefundCounts();
    const t = setInterval(() => { void refreshRefundCounts(); }, 60000);
    const onFocus = () => { void refreshRefundCounts(); };
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [token, superAdmin, refreshRefundCounts]);
  // Deep link from a Refund chat ("Open request"): /admin?tab=refunds&open=<request id>. Read once, then
  // the address bar goes back to /admin (same pattern as the inbox's ?open=).
  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      if (sp.get('tab') !== 'refunds') return;
      setActiveTab('refunds');
      const open = sp.get('open') || '';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(open)) setRefundOpenId(open);
      window.history.replaceState(window.history.state, '', '/admin');
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      if (sp.get('tab') !== 'mail') return;
      setActiveTab('mail');
      const box = sp.get('box') || '', uid = Number(sp.get('uid'));
      if (/^[\w-]{6,80}$/.test(box) && Number.isInteger(uid) && uid > 0) setMailLink({ box, uid });
      window.history.replaceState(window.history.state, '', '/admin');
    } catch { /* ignore */ }
  }, []);
  // Anyone else who lands on that link gets the normal start tab.
  useEffect(() => { if (user && activeTab === 'refunds' && !superAdmin) setActiveTab('orders'); }, [user, activeTab, superAdmin]);
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
        trackingDomain: biz.tracking_domain || '', primaryColor: biz.primary_color || '#4F46E5', originCity: biz.origin_city || '',
      });
    }
  }, [businesses, activePanelId]);

  // Sync activePanelId to localStorage and restrict to accessible panels
  const switchPanel = (panelId: string) => {
    setActivePanelId(panelId);
    localStorage.setItem('active_panel_id', panelId);
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

  /* ═══ CSV UPLOAD (chunked — VPS-safe, handles multiline quoted fields) ═══ */
  const CHUNK_SIZE = 500; // rows per chunk

  const handleFileUpload = async (file: File) => {
    if (!file || !file.name.endsWith('.csv')) { showAlert('error', 'Please upload a CSV file'); return; }
    if (!uploadPanelId) { showAlert('error', '⚠️ Please select a panel first before uploading'); return; }
    setUploading(true);
    setUploadResult(null);
    setUploadProgress({ current: 0, total: 0, percent: 0 });

    try {
      // 1. Read CSV text
      const csvText = await file.text();

      // 2. Parse CLIENT-SIDE with PapaParse — correctly handles multiline quoted fields
      //    (e.g. Notes field with embedded newlines from payment gateways)
      const Papa = (await import('papaparse')).default;
      const parsed = Papa.parse<Record<string, string>>(csvText, {
        header: true,
        skipEmptyLines: 'greedy',
        relaxQuotes: true,
        relaxColumnCount: true,
      } as ParseConfig<Record<string, string>>);

      if (!parsed.data || parsed.data.length === 0) {
        showAlert('error', 'CSV is empty or could not be parsed'); return;
      }

      const allRows = parsed.data;
      const totalRows = allRows.length;
      const headers = parsed.meta?.fields || [];

      // 3. Chunk by ROWS (not by raw lines) — each chunk is re-serialized to clean CSV
      const chunks: string[] = [];
      for (let i = 0; i < allRows.length; i += CHUNK_SIZE) {
        const chunkRows = allRows.slice(i, i + CHUNK_SIZE);
        // Re-serialize to CSV with PapaParse (quotes handled correctly)
        chunks.push(Papa.unparse(chunkRows, { columns: headers }));
      }

      // 3b. Is this the right panel? (owner 2026-10-08: a wrong file once put an order into Kurtiya.)
      // The server compares the file's brand and order numbers with the panels; a warning needs a yes.
      const uploadId = (typeof crypto !== 'undefined' && 'randomUUID' in crypto) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let warningText = '';
      try {
        const cleaned = cleanCSVData(allRows);
        const brands = Array.from(new Set(cleaned.orders.flatMap((o) => o.items.map((it) => it.brand)).filter(Boolean)));
        const chk = await fetch('/api/upload/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ panelId: uploadPanelId, orderIds: cleaned.orders.map((o) => o.order_id), brands }),
        });
        const cd = await chk.json().catch(() => ({}));
        if (chk.ok && Array.isArray(cd.warnings) && cd.warnings.length > 0) {
          const ok = await new Promise<boolean>((resolve) => setUploadWarn({ warnings: cd.warnings, resolve }));
          setUploadWarn(null);
          if (!ok) { showAlert('error', 'Upload cancelled: nothing was imported.'); return; }
          warningText = cd.warnings.map((w: { message: string }) => w.message).join(' | ');
        }
      } catch { /* a check that cannot run never blocks an upload */ }

      setUploadProgress({ current: 0, total: chunks.length, percent: 0 });

      // 4. Send chunks sequentially
      let totalNew = 0, totalUpdated = 0, totalBrands = 0;
      const allNewOrderIds: string[] = [];

      for (let i = 0; i < chunks.length; i++) {
        const blob = new Blob([chunks[i]], { type: 'text/csv' });
        const chunkFile = new File([blob], file.name, { type: 'text/csv' });

        const formData = new FormData();
        formData.append('file', chunkFile);
        formData.append('chunkIndex', i.toString());
        formData.append('totalChunks', chunks.length.toString());
        formData.append('businessId', uploadPanelId); // PANEL LOCK — every chunk locked to selected panel
        formData.append('uploadId', uploadId);
        if (warningText) formData.append('warning', warningText);

        const res = await fetch('/api/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData });
        const data = await res.json();

        if (!res.ok || data.success === false) {
          // If column mismatch — show what columns were found vs expected
          if (data.detectedColumns) {
            showAlert('error',
              `❌ CSV column mismatch — detected: [${data.detectedColumns.slice(0,5).join(', ')}…]. ` +
              `Expected Shopify export format (Name, Billing Name, Total, etc.). ` +
              `${data.hint || ''}`
            );
          } else {
            showAlert('error', `Chunk ${i + 1}/${chunks.length} failed: ${data.error}`);
          }
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
      fetchOrders(); fetchBrands(); fetchBusinesses(); fetchQueueStats(); fetchUploads();
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

  /* ═══ EMAIL SUPPORT (per panel) ═══ */
  const fetchPanelEmails = useCallback(async () => {
    if (!token || !activePanelId) { setPanelEmails([]); return; }
    setLoadingPanelEmails(true);
    try {
      const res = await fetch(`/api/panel-email?businessId=${activePanelId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setPanelEmails(res.ok ? (data.accounts || []) : []);
      setPanelEmailDraftOnly(res.ok ? data.draftOnly !== false : true);
    } catch { setPanelEmails([]); }
    finally { setLoadingPanelEmails(false); }
  }, [token, activePanelId]);

  useEffect(() => { fetchPanelEmails(); }, [fetchPanelEmails]);

  const handleAddPanelEmail = async () => {
    if (!activePanelId) { showAlert('error', 'Select a panel first'); return; }
    setAddingPanelEmail(true);
    try {
      const res = await fetch('/api/panel-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          businessId: activePanelId,
          email: newPanelEmail.email,
          appPassword: newPanelEmail.appPassword,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        showAlert('success', `${data.account.email} connected — incoming email will be answered`);
        setNewPanelEmail({ email: '', appPassword: '' });
        fetchPanelEmails();
      } else {
        showAlert('error', data.error || 'Could not connect that mailbox');
      }
    } catch { showAlert('error', 'Could not connect that mailbox'); }
    finally { setAddingPanelEmail(false); }
  };

  const saveEmailDraftOnly = async (on: boolean) => {
    if (!activePanelId) return;
    if (!on && !confirm('Let Chikki answer incoming emails by herself? Routine answers (order status, tracking) will be emailed to customers without your team seeing them first.')) return;
    const before = panelEmailDraftOnly;
    setPanelEmailDraftOnly(on);
    try {
      const res = await fetch('/api/panel-email', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ businessId: activePanelId, draftOnly: on }),
      });
      if (res.ok) showAlert('success', on ? 'Chikki will write drafts, your team sends them' : 'Chikki will answer routine emails by herself');
      else { setPanelEmailDraftOnly(before); showAlert('error', 'Could not save that setting'); }
    } catch { setPanelEmailDraftOnly(before); showAlert('error', 'Could not save that setting'); }
  };

  const handleRemovePanelEmail = async (acc: PanelEmailAccount) => {
    if (!confirm(`Disconnect the CUSTOMER SUPPORT Gmail ${acc.email}?\n\nCustomers' emails to it will no longer be read or answered. (The chargeback Gmail is a different account and is not touched.)`)) return;
    try {
      const res = await fetch(`/api/panel-email?businessId=${activePanelId}&id=${acc.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) { showAlert('success', `${acc.email} disconnected`); fetchPanelEmails(); }
      else showAlert('error', 'Could not disconnect that mailbox');
    } catch { showAlert('error', 'Could not disconnect that mailbox'); }
  };

  /* ═══ CHAT WIDGET (per panel) ═══ */
  const fetchChatSite = useCallback(async () => {
    if (!token || !activePanelId) { setChatSite(null); setPromptDraft(''); return; }
    try {
      const res = await fetch(`/api/panel-chat?businessId=${activePanelId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (res.ok) {
        setChatSite(data.site);
        setPromptDraft(data.site?.systemPrompt || '');
        setCodStatesDraft(data.site?.codStates || '');
        setCodStatesOpen(false);
      }
    } catch { /* leave the card as it was */ }
  }, [token, activePanelId]);

  useEffect(() => { fetchChatSite(); }, [fetchChatSite]);

  const fetchFaqs = useCallback(async () => {
    if (!token || !activePanelId) { setFaqs([]); return; }
    try {
      const r = await fetch(`/api/panel-faq?businessId=${activePanelId}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return;
      const d = await r.json();
      setFaqs(d.faqs || []);
    } catch { /* leave the last list on screen */ }
  }, [token, activePanelId]);

  useEffect(() => { fetchFaqs(); }, [fetchFaqs]);

  const faqRequest = async (method: string, body?: unknown, qs = '') => {
    setFaqBusy(true);
    try {
      const r = await fetch(`/api/panel-faq${qs}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { showAlert('error', d.error || 'Could not save'); return false; }
      await fetchFaqs();
      return true;
    } catch { showAlert('error', 'Could not save'); return false; }
    finally { setFaqBusy(false); }
  };

  const addFaq = async () => {
    if (!faqDraft.question.trim() || !faqDraft.answer.trim()) { showAlert('error', 'Write both the question and the answer'); return; }
    if (await faqRequest('POST', { businessId: activePanelId, ...faqDraft })) {
      setFaqDraft({ question: '', answer: '' });
      showAlert('success', 'Saved — Chikki uses it from the next message');
    }
  };

  const saveChatSettings = async (patch: Record<string, unknown>) => {
    if (!activePanelId) { showAlert('error', 'Select a panel first'); return; }
    setSavingChat(true);
    try {
      const res = await fetch('/api/panel-chat', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ businessId: activePanelId, ...patch }),
      });
      const data = await res.json();
      if (res.ok) { showAlert('success', 'Chat settings saved'); fetchChatSite(); }
      else showAlert('error', data.error || 'Could not save those settings');
    } catch { showAlert('error', 'Could not save those settings'); }
    finally { setSavingChat(false); }
  };

  // Existing storefront snippets point at the support subdomain, so new ones
  // must match — otherwise the same widget would be served from two origins.
  const widgetOrigin = process.env.NEXT_PUBLIC_WIDGET_ORIGIN
    || (typeof window !== 'undefined' ? window.location.origin : '');
  const embedSnippet = chatSite
    ? `<script src="${widgetOrigin}/widget.js" data-site-key="${chatSite.widgetKey}" data-title="Chat with us" defer></script>`
    : '';

  /* ═══ DELETE PANEL (Tracker + chat support) ═══ */
  const openDeletePanel = async (biz: Business) => {
    setDeletePanelTarget(biz);
    setDeleteImpact(null);
    setDeleteConfirmText('');
    setDeleteImpactLoading(true);
    try {
      const res = await fetch(`/api/businesses?impactId=${biz.id}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (res.ok) setDeleteImpact(data.impact);
      else showAlert('error', data.error || 'Could not load panel details');
    } catch { showAlert('error', 'Could not load panel details'); }
    finally { setDeleteImpactLoading(false); }
  };

  const handleDeletePanel = async () => {
    if (!deletePanelTarget) return;
    setDeletingPanel(true);
    try {
      const res = await fetch(
        `/api/businesses?id=${deletePanelTarget.id}&confirmName=${encodeURIComponent(deletePanelTarget.name)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await res.json();
      if (!res.ok) { showAlert('error', data.error || 'Delete failed'); return; }

      const d = data.deleted;
      const parts = [`Panel "${data.panel}" deleted`];
      if (d.orders) parts.push(plural(d.orders, 'order'));
      if (d.tickets) parts.push(plural(d.tickets, 'ticket'));
      if (d.chatSites) parts.push(`chat site (${plural(d.chatConversations, 'conversation')})`);
      if (d.newDefault) parts.push(`"${d.newDefault}" is now the default panel`);
      if (d.deactivatedUsers?.length) parts.push(`deactivated ${d.deactivatedUsers.join(', ')} — no panels left`);
      showAlert('success', parts.join(' · '));

      // Leaving the active panel pointed at a deleted id would filter every list to nothing
      if (activePanelId === deletePanelTarget.id) {
        setActivePanelId('');
        localStorage.removeItem('active_panel_id');
      }
      setDeletePanelTarget(null);
      setDeleteImpact(null);
      setDeleteConfirmText('');
      fetchBusinesses();
      fetchOrders();
    } catch { showAlert('error', 'Delete failed'); }
    finally { setDeletingPanel(false); }
  };

  /* ═══ HELPERS ═══ */
  const copyTrackingLink = (trackingToken: string) => {
    const link = `${window.location.origin}/track/${trackingToken}`;
    navigator.clipboard.writeText(link);
    showAlert('success', 'Tracking link copied!');
  };

  const getTrackingLink = (trackingToken: string) => `${window.location.origin}/track/${trackingToken}`;

  const sendWhatsApp = (order: Order) => {
    const digits = order.customer_mobile.replace(/\D/g, '');
    // Indian numbers: always 91 + 10 digits. If already 12 digits starting with 91, use as-is.
    const phone = (digits.length === 12 && digits.startsWith('91')) ? digits : '91' + digits.slice(-10);
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
    clearMailCache();   // what the Mail tab kept in memory goes with the session
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
    { id: 'orders' as TabType, label: 'Orders', icon: ShoppingBag, show: hasPermission('view_orders') },
    { id: 'upload' as TabType, label: 'Upload CSV', icon: Upload, show: hasPermission('upload_csv') },
    { id: 'settings' as TabType, label: 'Settings', icon: Settings, show: hasPermission('manage_businesses') },
    { id: 'team' as TabType, label: 'Team', icon: Users, show: hasPermission('manage_team') },
    { id: 'score' as TabType, label: isSuperAdmin(user) ? 'Team score' : 'My score', icon: Trophy, show: isSuperAdmin(user) || can(user, 'chat.reply') },
    { id: 'refunds' as TabType, label: 'Refund requests', icon: Undo2, show: isSuperAdmin(user) },
    // Owner 2026-10-08: the real Gmail inbox. The Super Admin always; a member only with the Mail tick.
    { id: 'mail' as TabType, label: 'Mail', icon: Mail, show: can(user, 'mail.view') },
    // Owner 2026-10-08: chargeback mails from every panel's chargeback Gmail, with a red badge. Super Admin only.
    { id: 'chargebacks' as TabType, label: 'Chargebacks', icon: ShieldAlert, show: isSuperAdmin(user) },
  ].filter((i) => i.show);

  return (
    <div className="admin-layout">
      {/* Mobile overlay */}
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}

      {/* Sidebar */}
      <AdminSidebar activeBusiness={activeBusiness} activePanelId={activePanelId} activeTab={activeTab} businesses={businesses} chargebackNew={chargebackNew} emailWaiting={emailWaiting} humanNeeded={humanNeeded} logout={logout} navItems={navItems} openMe={openMe} refundUnseen={refundUnseen} router={router} setActiveTab={setActiveTab} setProfileOpen={setProfileOpen} setSecurityOpen={setSecurityOpen} setSidebarOpen={setSidebarOpen} sidebarOpen={sidebarOpen} switchPanel={switchPanel} user={user} />

      {/* Main */}
      <main className="main-content">
        {/* Mobile header */}
        <div className="mobile-header">
          <button className="btn-icon" onClick={() => setSidebarOpen(true)}><Package size={20} /></button>
          <span className="mobile-header-title">{activeTab === 'score' ? (isSuperAdmin(user) ? 'Team score' : 'My score') : activeTab === 'refunds' ? 'Refund requests' : activeTab === 'mail' ? 'Mail' : activeTab === 'chargebacks' ? 'Chargebacks' : activeTab}</span>
        </div>

        {uploadWarn && (
          <UploadWarningDialog panelName={businesses.find(b => b.id === uploadPanelId)?.name || 'this panel'} warnings={uploadWarn.warnings} onAnswer={uploadWarn.resolve} />
        )}
        {newPanelOpen && (
          <NewPanelDialog
            onClose={() => setNewPanelOpen(false)}
            panels={businesses.map(b => ({ id: b.id, name: b.name }))}
            onCreate={async (name, password, startFrom) => {
              const res = await fetch('/api/businesses', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ name, password }),
              });
              const data = await res.json().catch(() => ({}));
              if (res.ok) {
                // "Start from": the new panel gets the same AI setup as the chosen panel (owner 2026-10-08)
                if (startFrom && data?.business?.id) {
                  const cp = await fetch('/api/panel-copy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ source: startFrom, target: data.business.id }),
                  }).catch(() => null);
                  showAlert(cp && cp.ok ? 'success' : 'error', cp && cp.ok ? `Panel "${name.trim()}" created with the same setup` : `Panel "${name.trim()}" created, but the setup could not be copied: use Copy setup in its Settings`);
                } else showAlert('success', `Panel "${name.trim()}" created`);
                fetchBusinesses(); return null;
              }
              return data?.error || 'Failed to create panel';
            }}
          />
        )}

        {/* Mail uses the whole width (owner 2026-10-08: "right side extra gap"): the other tabs keep their 80rem column */}
        <div className={`main-inner${activeTab === 'mail' ? ' main-inner-wide' : ''}`}>
          {/* Toast */}
          {alert && (
            <div className={`toast toast-${alert.type}`}>
              {alert.type === 'success' ? <Check size={16} /> : <AlertCircle size={16} />}
              {alert.message}
            </div>
          )}

          {/* ════════ ORDERS TAB ════════ */}
          {activeTab === 'orders' && token && (
            // The panel board (owner 2026-10-09): every panel's "what to do today" above the orders. A line switches to
            // that panel and opens the screen it names; the chat inbox reads the active panel from localStorage.
            <PanelBoard token={token} activePanelId={activePanelId} goTo={(panelId, where) => {
              switchPanel(panelId);
              if (where === 'chats') { router.push('/admin/chat'); return; }
              if (where === 'chargebacks' || where === 'refunds' || where === 'settings') setActiveTab(where);
            }} />
          )}
          {activeTab === 'orders' && (
            <OrdersTab GMAIL_DAILY_LIMIT={GMAIL_DAILY_LIMIT} brandFilter={brandFilter} brands={brands} copyTrackingLink={copyTrackingLink} dateFrom={dateFrom} dateTo={dateTo} emailFilter={emailFilter} emailedOrderIds={emailedOrderIds} emailsSentToday={emailsSentToday} handleDeleteOrder={handleDeleteOrder} handleSearchChange={handleSearchChange} hasPermission={hasPermission} limit={limit} loading={loading} orders={orders} page={page} searchInput={searchInput} selectFirst={selectFirst} selectedOrders={selectedOrders} sendEmail={sendEmail} sendWhatsApp={sendWhatsApp} setBrandFilter={setBrandFilter} setDateFrom={setDateFrom} setDateTo={setDateTo} setDetailOrder={setDetailOrder} setEmailFilter={setEmailFilter} setLimit={setLimit} setPage={setPage} setSelectedOrders={setSelectedOrders} setShowDetailModal={setShowDetailModal} setShowRangeModal={setShowRangeModal} setShowStatusModal={setShowStatusModal} setStatusFilter={setStatusFilter} setStoreFilter={setStoreFilter} statusCounts={statusCounts} statusFilter={statusFilter} storeFilter={storeFilter} toggleSelectAll={toggleSelectAll} toggleSelectOrder={toggleSelectOrder} totalOrders={totalOrders} totalPages={totalPages} />
          )}

          {/* ════════ UPLOAD TAB ════════ */}
          {activeTab === 'upload' && hasPermission('upload_csv') && (
            <UploadTab recentUploads={recentUploads} businesses={businesses} dragOver={dragOver} fetchQueueStats={fetchQueueStats} handleFileUpload={handleFileUpload} loadingQueue={loadingQueue} queueStats={queueStats} setDragOver={setDragOver} setUploadPanelId={setUploadPanelId} uploadPanelId={uploadPanelId} uploadProgress={uploadProgress} uploadResult={uploadResult} uploading={uploading} />
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
                  <button className="btn btn-primary btn-sm" onClick={() => setNewPanelOpen(true)}>
                    <Plus size={14} /> New Panel
                  </button>
                )}
              </div>

              {/* Panel list */}
              {businesses.length > 0 && (
                <SettingsPanelList activePanelId={activePanelId} businesses={businesses} openDeletePanel={openDeletePanel} switchPanel={switchPanel} user={user} />
              )}

              {/* Jump to a section (owner, 2026-10-01: a cleaner Settings page) */}
              {activeBusiness && (
                <SettingsJumpBar activeBusiness={activeBusiness} chatSite={chatSite} user={user} />
              )}

              {activeBusiness && (
                <>
                  <div id="set-chikki" style={{ scrollMarginTop: 76 }} />
                  {/* ── CHIKKI: the panel's AI in one card (saved answers, notes, lessons, team examples, rules, settings) ── */}
                  {chatSite && (
                    <ChikkiCard
                      token={token} businessId={activePanelId} panelName={activeBusiness?.name} onAlert={showAlert}
                      faqs={faqs} faqBusy={faqBusy} faqRequest={faqRequest} faqDraft={faqDraft} setFaqDraft={setFaqDraft} onAddFaq={addFaq}
                      aiEnabled={chatSite.aiEnabled} aiBusy={savingChat} onToggleAi={() => saveChatSettings({ aiEnabled: !chatSite.aiEnabled })}
                      canSettings={!!user && can(user, 'settings.panel')}
                      settings={(
                        <>
                          <div className="form-group">
                            <label className="form-label">Cash on Delivery</label>
                            <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginBottom: '0.5rem' }}>
                              Customers ask this constantly and the answer differs per store. Until you pick one,
                              the agent will not answer COD questions at all — it offers to have the team confirm instead.
                            </div>
                            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                              {([
                                { v: true,  label: 'COD available' },
                                { v: false, label: 'No COD' },
                                { v: null,  label: "Don't answer" },
                              ] as { v: boolean | null; label: string }[]).map((opt) => {
                                const on = !chatSite.codStates && chatSite.codAvailable === opt.v;
                                return (
                                  <button
                                    key={String(opt.v)}
                                    className="btn btn-sm"
                                    disabled={savingChat}
                                    // Picking one of these three replaces "only in some states".
                                    onClick={() => { setCodStatesOpen(false); saveChatSettings({ codAvailable: opt.v, codStates: null }); }}
                                    style={{
                                      background: on ? 'var(--accent)' : 'transparent',
                                      color: on ? '#fff' : 'var(--fg-muted)',
                                      border: '1px solid var(--border)',
                                    }}
                                  >
                                    {opt.label}
                                  </button>
                                );
                              })}
                              <button
                                className="btn btn-sm"
                                disabled={savingChat}
                                onClick={() => setCodStatesOpen(true)}
                                style={{
                                  background: chatSite.codStates ? 'var(--accent)' : 'transparent',
                                  color: chatSite.codStates ? '#fff' : 'var(--fg-muted)',
                                  border: '1px solid var(--border)',
                                }}
                              >
                                Only in some states
                              </button>
                            </div>
                            {(codStatesOpen || chatSite.codStates) && (
                              <div style={{ marginTop: '0.5rem' }}>
                                <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginBottom: '0.375rem' }}>
                                  COD works only for addresses in these states. The agent brings it up only when a customer asks,
                                  says so once in one short line, and never tells a customer in these states that COD is unavailable.
                                </div>
                                <div style={{ display: 'flex', gap: '0.5rem' }}>
                                  <input
                                    className="form-input"
                                    style={{ flex: 1 }}
                                    placeholder="State names, e.g. Gujarat"
                                    maxLength={100}
                                    value={codStatesDraft}
                                    onChange={(e) => setCodStatesDraft(e.target.value)}
                                  />
                                  <button
                                    className="btn btn-primary btn-sm"
                                    disabled={savingChat || !codStatesDraft.trim()}
                                    onClick={() => saveChatSettings({ codStates: codStatesDraft })}
                                  >
                                    Save states
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>

                          <div className="form-group">
                            <label className="form-label">Custom instructions (optional)</label>
                            <textarea
                              className="form-input"
                              rows={3}
                              placeholder="Leave blank to use the standard support prompt, which already refuses to invent policy, shipping times or stock."
                              value={promptDraft}
                              onChange={(e) => setPromptDraft(e.target.value)}
                              style={{ height: 'auto', resize: 'vertical' }}
                            />
                            <p style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginTop: '0.25rem' }}>
                              This replaces the standard prompt entirely — anything you leave out, the AI no longer knows to avoid.
                            </p>
                          </div>

                          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                            <button
                              className="btn btn-primary"
                              disabled={savingChat || promptDraft === (chatSite.systemPrompt || '')}
                              onClick={() => saveChatSettings({ systemPrompt: promptDraft })}
                            >
                              {savingChat
                                ? <><Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> Saving…</>
                                : <><Check size={14} /> Save instructions</>}
                            </button>
                          </div>
                        </>
                      )}
                    />
                  )}

              {/* Copy the AI setup from another panel (owner 2026-10-08): every panel gets the same setup */}
              {isSuperAdmin(user) && businesses.length > 1 && (
                <div id="set-copy" style={{ scrollMarginTop: 76 }}>
                  <PanelCopyCard key={activeBusiness.id} token={token} businessId={activeBusiness.id} panelName={activeBusiness.name}
                    others={businesses.filter(b => b.id !== activeBusiness.id).map(b => ({ id: b.id, name: b.name }))} onAlert={showAlert} />
                </div>
              )}

                  <div id="set-branding" style={{ scrollMarginTop: 76 }} />
                  {/* Brand settings card */}
                  {user && can(user, 'settings.panel') && (
                  <BrandingCard activeBusiness={activeBusiness} brandForm={brandForm} fetchBusinesses={fetchBusinesses} savingBrand={savingBrand} setBrandForm={setBrandForm} setSavingBrand={setSavingBrand} showAlert={showAlert} token={token} />
                  )}

                  <div id="set-widget" style={{ scrollMarginTop: 76 }} />
                  {/* ── Chat widget ── */}
                  {user && can(user, 'settings.panel') && (
                  <ChatWidgetCard chatSite={chatSite} copiedSnippet={copiedSnippet} embedSnippet={embedSnippet} saveChatSettings={saveChatSettings} savingChat={savingChat} setCopiedSnippet={setCopiedSnippet} showAlert={showAlert} user={user} />
                  )}

                  <div id="set-schedule" style={{ scrollMarginTop: 76 }} />
                  {/* ── Auto-Progression: the real schedule (src/lib/journey.ts), read only ── */}
                  <AutoProgressionCard />

                  <div id="set-connections" style={{ scrollMarginTop: 76 }} />
                  {isSuperAdmin(user) && (
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', margin: '0.75rem 0 -0.25rem' }}>
                      <span style={{ fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>Connections</span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>The two Gmail accounts and Shopify, only you see these</span>
                    </div>
                  )}
                  {/* Shopify, the API connection and the mailboxes: the super admin only (team logins
                      do not see them; the routes check it too). Their own content is unchanged. */}
                  {isSuperAdmin(user) && (<>
                  {/* ── Gmail accounts (owner 2026-10-08: "support wali ya chargeback wali email, hum confuse ho rahe hain") ── */}
                  <div id="set-gmail" style={{ scrollMarginTop: 76 }} />
                  <GmailAccountsOverview token={token} businessId={activePanelId} panelName={activeBusiness.name} support={panelEmails.map(a => ({ email: a.email, status: a.status ?? null }))} />
                  <div id="set-gmail-support" style={{ scrollMarginTop: 76 }} />
                  {/* ── Email Support ── */}
                  <div className="tf-card" style={{ padding: '1.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                      <Mail size={16} style={{ color: 'var(--primary)' }} />
                      <span style={{ fontWeight: 700 }}>Gmail 1 · Customer support</span>
                      <span className="badge" style={{ background: 'var(--primary-light)', color: 'var(--primary)', fontSize: '0.625rem', padding: '0.125rem 0.375rem', borderRadius: 4 }}>
                        {panelEmailDraftOnly ? 'AI drafts, team sends' : 'Answered by AI'}
                      </span>
                    </div>
                    <p style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', marginBottom: '0.75rem', lineHeight: 1.5 }}>
                      Connect the mailbox customers write to. Every incoming email is read the same way the chat
                      is. Who sends the reply is your choice below. A verified customer who calls the store a fraud or asks
                      for a refund or payment help still gets the short &ldquo;a person has your case&rdquo; reply on its own. A
                      threat (chargeback, police, court) gets no automatic reply at all: it goes straight to your team.
                      This works whether or not the panel is connected to Shopify.
                    </p>
                    <div className="seg" role="group" aria-label="Who sends the email reply" style={{ marginTop: 0, marginBottom: '1rem' }}>
                      <button type="button" className="seg-btn" aria-pressed={panelEmailDraftOnly} onClick={() => { if (!panelEmailDraftOnly) saveEmailDraftOnly(true); }}
                        title="Chikki writes the reply as a draft, your team reads it and sends it">
                        Chikki writes a draft, my team sends (recommended)
                      </button>
                      <button type="button" className="seg-btn" aria-pressed={!panelEmailDraftOnly} onClick={() => { if (panelEmailDraftOnly) saveEmailDraftOnly(false); }}
                        title="Chikki emails routine answers by herself; anything about refunds or policy is held for a person">
                        Chikki answers by herself
                      </button>
                    </div>

                    {/* Connected mailboxes */}
                    {panelEmails.length > 0 && (
                      <div style={{ display: 'grid', gap: '0.5rem', marginBottom: '1rem' }}>
                        {panelEmails.map(acc => (
                          <div key={acc.id} style={{
                            display: 'flex', alignItems: 'center', gap: '0.5rem',
                            padding: '0.5rem 0.75rem', border: '1px solid var(--border)', borderRadius: '0.5rem',
                          }}>
                            <span title={acc.status ? (acc.status.ok ? 'Gmail is being read' : 'Gmail cannot be read') : 'Not checked since the last restart'}
                              style={{ color: !acc.status ? 'var(--fg-muted)' : acc.status.ok ? 'var(--success)' : 'var(--danger)', fontSize: '0.5rem' }}>●</span>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: '0.8125rem', fontWeight: 500 }}>{acc.email}</div>
                              {/* Step 2 (owner 2026-10-08): is the Gmail really being read? */}
                              <div className="meta" style={{ color: acc.status && !acc.status.ok ? 'var(--danger)' : undefined }}>
                                {!acc.status ? 'Not checked yet. It is checked every minute.'
                                  : !acc.status.ok ? `${acc.status.error || 'Could not read this Gmail.'} Last tried ${agoText(acc.status.checkedAt)}.`
                                  : `Working. Checked ${agoText(acc.status.checkedAt)}.${acc.status.lastMailAt ? ` Last new mail ${agoText(acc.status.lastMailAt)}.` : ''}`}
                              </div>
                            </div>
                            <button
                              className="btn btn-outline btn-sm"
                              style={{ marginLeft: 'auto', color: 'var(--danger)' }}
                              title={`Disconnect the customer support Gmail ${acc.email}`}
                              onClick={() => handleRemovePanelEmail(acc)}
                            >
                              <Trash2 size={13} /> Disconnect
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {panelEmails.length === 0 && !loadingPanelEmails && (
                      <p style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', fontStyle: 'italic', marginBottom: '1rem' }}>
                        No mailbox connected yet — email to this panel is not being answered.
                      </p>
                    )}

                    {/* How to get an app password */}
                    <div style={{ background: 'var(--primary-light)', borderRadius: '0.5rem', padding: '0.75rem', marginBottom: '1rem' }}>
                      <p style={{ fontSize: '0.6875rem', fontWeight: 700, marginBottom: '0.375rem' }}>
                        Gmail needs an App Password — your normal password will not work
                      </p>
                      <ol style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', paddingLeft: '1rem', lineHeight: 1.7, margin: 0 }}>
                        <li>Turn on 2-Step Verification for that Google account</li>
                        <li>Open <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary)' }}>myaccount.google.com/apppasswords</a></li>
                        <li>Create one named e.g. &ldquo;ShipTrack&rdquo; and copy the 16 characters</li>
                        <li>Paste it below — spaces are fine</li>
                      </ol>
                    </div>

                    {/* Add form */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '0.5rem', alignItems: 'end' }}>
                      <div className="form-group" style={{ margin: 0 }}>
                        <label className="form-label">Email address</label>
                        {/* Not a login form: stop browsers filling the owner's ShipTrack login in here (it did, 2026-10-01). */}
                        <input
                          className="form-input"
                          type="email"
                          name="mailbox-address"
                          autoComplete="off"
                          data-lpignore="true"
                          data-1p-ignore="true"
                          placeholder="support@yourstore.com"
                          value={newPanelEmail.email}
                          onChange={(e) => setNewPanelEmail({ ...newPanelEmail, email: e.target.value })}
                        />
                      </div>
                      <div className="form-group" style={{ margin: 0 }}>
                        <label className="form-label">App password</label>
                        <input
                          className="form-input"
                          type="password"
                          name="mailbox-app-password"
                          autoComplete="new-password"
                          data-lpignore="true"
                          data-1p-ignore="true"
                          placeholder="abcd efgh ijkl mnop"
                          value={newPanelEmail.appPassword}
                          onChange={(e) => setNewPanelEmail({ ...newPanelEmail, appPassword: e.target.value })}
                        />
                      </div>
                      <button
                        className="btn btn-primary"
                        disabled={addingPanelEmail || !newPanelEmail.email.trim() || !newPanelEmail.appPassword.trim()}
                        onClick={handleAddPanelEmail}
                      >
                        {addingPanelEmail
                          ? <><Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> Checking…</>
                          : <><Plus size={14} /> Connect</>}
                      </button>
                    </div>
                    <p style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginTop: '0.5rem' }}>
                      We sign in once to check the password before saving it. Replies are sent from this
                      same address, and the conversations appear in the chat dashboard inbox.
                      <strong> Mail already in the inbox is left alone</strong> — answering starts with the
                      next email that arrives.
                    </p>
                  </div>
                  <div id="set-gmail-chargeback" style={{ scrollMarginTop: 76 }} />
              {/* Chargeback protection (owner 2026-10-08): the panel's chargeback Gmail, WhatsApp number, gateway checklist */}
              {(
                <div>
                  <ChargebackSettingsCard key={activeBusiness.id} token={token} businessId={activeBusiness.id} panelName={activeBusiness.name} onAlert={showAlert} />
                </div>
              )}


                  <div id="set-shopify" style={{ scrollMarginTop: 76 }} />
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', margin: '0.75rem 0 -0.25rem' }}>
                    <span style={{ fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>Shopify</span>
                    <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>Only if this panel sells through Shopify</span>
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

                  {/* Shopify API Connect card — OAuth flow */}
                  <div className="tf-card" style={{ padding: '1.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                      <ShoppingBag size={16} style={{ color: '#96bf48' }} />
                      <span style={{ fontWeight: 700 }}>Connect Shopify API</span>
                      <span style={{ fontSize: '0.625rem', padding: '0.125rem 0.5rem', borderRadius: '9999px', background: 'rgba(150,191,72,0.1)', color: '#96bf48', fontWeight: 600 }}>Optional</span>
                      {activeBusiness?.is_shopify_connected && (
                        <span style={{ fontSize: '0.625rem', padding: '0.125rem 0.5rem', borderRadius: '9999px', background: 'rgba(34,197,94,0.15)', color: '#22c55e', fontWeight: 600 }}>✅ Connected</span>
                      )}
                    </div>
                    <p style={{ fontSize: '0.8125rem', color: 'var(--fg-muted)', marginBottom: '1.25rem' }}>
                      Enables syncing order data into Support Inbox. Orders via webhook work fine without this.
                    </p>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.25rem' }}>
                      {([
                        {
                          step: 1,
                          title: 'Open Shopify Partners Dashboard',
                          desc: 'Go to Partners Dashboard → Apps → your Tracker app → Versions → tracker-2 → edit Configuration',
                          link: 'https://partners.shopify.com',
                          linkText: 'Open Partners Dashboard →',
                          code: null,
                        },
                        {
                          step: 2,
                          title: 'Add Redirect URL',
                          desc: 'In the Redirect URLs field, paste this exact URL, then Save:',
                          link: null, linkText: null,
                          code: `${process.env.NEXT_PUBLIC_BASE_URL || 'https://shiptrack.store'}/api/shopify/oauth/callback`,
                        },
                        {
                          step: 3,
                          title: 'Copy Client ID & Secret',
                          desc: 'Go to app Settings tab → copy the Client ID and the Secret (starts with shpss_)',
                          link: null, linkText: null, code: null,
                        },
                        {
                          step: 4,
                          title: 'Set env vars on VPS (SSH in and run)',
                          desc: 'Replace YOUR_CLIENT_ID and YOUR_SECRET with the values you copied:',
                          link: null, linkText: null,
                          code: `echo "SHOPIFY_CLIENT_ID=YOUR_CLIENT_ID" >> /var/www/tracker/.env.local\necho "SHOPIFY_CLIENT_SECRET=YOUR_SECRET" >> /var/www/tracker/.env.local\npm2 reload tracker --update-env`,
                        },
                        {
                          step: 5,
                          title: 'Enter store domain & click Connect below',
                          desc: "You'll be redirected to Shopify to approve → automatically returns here connected.",
                          link: null, linkText: null, code: null,
                        },
                      ] as { step: number; title: string; desc: string; link: string | null; linkText: string | null; code: string | null }[]).map(({ step, title, desc, link, linkText, code }) => (
                        <div key={step} style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start', padding: '0.75rem', background: 'var(--bg-secondary)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
                          <div style={{ width: 24, height: 24, borderRadius: '50%', background: 'rgba(150,191,72,0.2)', color: '#96bf48', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '0.75rem', flexShrink: 0 }}>
                            {step}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: '0.8125rem', marginBottom: '0.125rem' }}>{title}</div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', marginBottom: code ? '0.375rem' : 0 }}>{desc}</div>
                            {code && (
                              <code style={{ display: 'block', fontSize: '0.6875rem', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.5rem 0.625rem', color: 'var(--primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.6 }}>
                                {code}
                              </code>
                            )}
                            {link && (
                              <a href={link} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.75rem', color: '#96bf48', fontWeight: 600, display: 'inline-block', marginTop: '0.25rem' }}>
                                {linkText}
                              </a>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>

                    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end' }}>
                      <div style={{ flex: 1 }}>
                        <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--fg-muted)', display: 'block', marginBottom: '0.375rem' }}>Shopify Store Domain</label>
                        <input
                          id="shopify-domain-input"
                          className="tf-input"
                          placeholder="rzqjxj-qq.myshopify.com"
                          defaultValue={activeBusiness?.shopify_domain || ''}
                          style={{ width: '100%' }}
                        />
                      </div>
                      <button
                        className="btn btn-sm"
                        style={{ background: '#96bf48', color: '#fff', border: 'none', whiteSpace: 'nowrap', flexShrink: 0 }}
                        id="shopify-oauth-btn"
                        onClick={() => {
                          const domain = (document.getElementById('shopify-domain-input') as HTMLInputElement)?.value?.trim();
                          if (!domain) { showAlert('error', 'Enter your Shopify store domain first'); return; }
                          if (!activePanelId) { showAlert('error', 'Select a panel first'); return; }
                          const authToken = localStorage.getItem('auth_token') || '';
                          window.location.href = `/api/shopify/oauth/start?shop=${encodeURIComponent(domain)}&businessId=${activePanelId}&token=${encodeURIComponent(authToken)}`;
                        }}
                      >
                        {activeBusiness?.is_shopify_connected ? '🔄 Reconnect Shopify' : '🔗 Connect via Shopify OAuth'}
                      </button>
                    </div>
                    <p style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginTop: '0.5rem' }}>
                      ⚡ Complete Steps 1–4 before clicking Connect, or it will fail.
                    </p>
                  </div>

                  </>)}

                </>
              )}

              {!activeBusiness && businesses.length === 0 && (
                <div className="tf-card" style={{ padding: '2rem', textAlign: 'center' }}>
                  <Building2 size={40} style={{ opacity: 0.2, marginBottom: '0.75rem' }} />
                  <p style={{ color: 'var(--fg-muted)' }}>No panels yet. Click <strong>New Panel</strong> to create your first store panel.</p>
                </div>
              )}


              {/* Danger Zone */}
              <div id="set-danger" style={{ scrollMarginTop: 76 }} />
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

          {profileOpen && user && user.role !== 'admin' && (
            <MyProfile token={token} onAlert={showAlert} onClose={() => setProfileOpen(false)}
              onUserChanged={(name) => setUser((u) => (u ? { ...u, displayName: name } : u))} />
          )}
          {securityOpen && user?.role === 'admin' && (
            <OwnerLoginDialog token={token} onAlert={showAlert} onClose={() => setSecurityOpen(false)}
              onLoginChanged={(t, u) => { setToken(t); setUser(u as AuthUser); }} />
          )}

          {/* ════════ TEAM TAB ════════ */}
          {activeTab === 'team' && hasPermission('manage_team') && (
            <div className="animate-fade-in-up">
              <TeamCard token={token} panels={businesses} onAlert={showAlert}
                onLoginChanged={(t, u) => { setToken(t); setUser(u as AuthUser); }} />
            </div>
          )}
          {activeTab === 'score' && (isSuperAdmin(user) || can(user, 'chat.reply')) && (
            <div className="animate-fade-in-up"><TeamScoreCard token={token} onAlert={showAlert} mine={!isSuperAdmin(user)} /></div>
          )}
          {/* ════════ MAIL (Super Admin, or a member with the Mail tick) ════════ */}
          {activeTab === 'mail' && can(user, 'mail.view') && (
            <div className="animate-fade-in-up"><MailCard token={token} onAlert={showAlert} activePanelId={activePanelId} initialBox={mailLink?.box ?? null} initialUid={mailLink?.uid ?? null} /></div>
          )}
          {/* ════════ CHARGEBACKS (Super Admin only) ════════ */}
          {activeTab === 'chargebacks' && isSuperAdmin(user) && (
            <div className="animate-fade-in-up"><ChargebacksCard token={token} onAlert={showAlert} onChanged={() => { void refreshChargebackCounts(); }} /></div>
          )}
          {/* ════════ REFUND REQUESTS (Super Admin only) ════════ */}
          {activeTab === 'refunds' && isSuperAdmin(user) && (
            <div className="animate-fade-in-up">
              <RefundRequestsCard token={token} onAlert={showAlert} openId={refundOpenId} onSeen={() => { void refreshRefundCounts(); }} />
            </div>
          )}
        </div>
      </main>

      {/* ════════ MODALS ════════ */}

      {/* Bulk Status Modal */}
      {showStatusModal && (
        <BulkStatusModal bulkCourier={bulkCourier} bulkEstDelivery={bulkEstDelivery} bulkNotes={bulkNotes} bulkStatus={bulkStatus} bulkTrackingId={bulkTrackingId} handleBulkUpdate={handleBulkUpdate} selectedOrders={selectedOrders} setBulkCourier={setBulkCourier} setBulkEstDelivery={setBulkEstDelivery} setBulkNotes={setBulkNotes} setBulkStatus={setBulkStatus} setBulkTrackingId={setBulkTrackingId} setShowStatusModal={setShowStatusModal} />
      )}

      {/* Order Detail Modal */}
      {showDetailModal && detailOrder && (
        <OrderDetailModal detailOrder={detailOrder} handleSingleStatusUpdate={handleSingleStatusUpdate} hasPermission={hasPermission} sendEmail={sendEmail} sendWhatsApp={sendWhatsApp} setShowDetailModal={setShowDetailModal} />
      )}






      {/* Select Range Modal */}
      {showRangeModal && (
        <SelectRangeModal orders={orders} rangeFrom={rangeFrom} rangeMode={rangeMode} rangeTo={rangeTo} selectRange={selectRange} selectedOrders={selectedOrders} setRangeFrom={setRangeFrom} setRangeMode={setRangeMode} setRangeTo={setRangeTo} setSelectedOrders={setSelectedOrders} setShowRangeModal={setShowRangeModal} showAlert={showAlert} />
      )}
      {/* Delete Panel Modal — removes the panel from the Tracker and from chat support */}
      {deletePanelTarget && (
        <DeletePanelModal deleteConfirmText={deleteConfirmText} deleteImpact={deleteImpact} deleteImpactLoading={deleteImpactLoading} deletePanelTarget={deletePanelTarget} deletingPanel={deletingPanel} handleDeletePanel={handleDeletePanel} setDeleteConfirmText={setDeleteConfirmText} setDeleteImpact={setDeleteImpact} setDeletePanelTarget={setDeletePanelTarget} />
      )}
    </div>
  );
}
