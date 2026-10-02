'use client';

import { Fragment, useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2, Check, AlertCircle, ShoppingBag, LogOut, Send, Mail,
  MessageCircle, Phone, Inbox, Paperclip, X, FileText,
  RotateCw,
  Menu, ChevronLeft, UserCheck, Search, Undo2, Truck,
  BadgeCheck, ChevronDown, ArrowRightLeft, Lock, Hand, UsersRound,
} from 'lucide-react';
import { canChangeMessage } from '@/lib/chat/message-rules';
import { ROLE_INFO, can, isSuperAdmin, type Role } from '@/lib/permissions';
import { activeHeaders } from '@/lib/presence-client';
import MyProfile from '@/components/MyProfile';
import OwnerLoginDialog from '@/components/OwnerLogin';
import RefundFormControl, { type RefundThreadState } from '@/components/RefundFormControl';
import { HEALTH_PIN_MIN, healthLevel } from '@/lib/chat/health-rules';
import { INBOX_TOPICS, displaySubjectLabel } from '@/lib/chat/inbox-topics';
import { WAITING_OVERDUE_HOURS } from '@/lib/chat/waiting';
import { type OrderAddress } from '@/lib/chat/order-address';
import { AUTO_MARK_NAME } from '@/lib/chat/tracking-claim';
import {
  ATTACHMENT_ACCEPT, MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_TOTAL_BYTES,
  TOO_MANY_MESSAGE, TOTAL_TOO_LARGE_MESSAGE, checkBrowserFile, formatFileSize,
} from '@/lib/chat/attachment-rules';
import type { AuthUser, Business, Conversation, EarlierChat, NewerChat, ChatMessage, MessageDetails, PendingFile, TeamMember, TransferTarget, StaffBlock, HotLock, TeamLogEntry, InboxTab, OrderFacts, StaffAddress } from './_lib/types';
import { minutesText, logTime, teamLogLine, supportLabel, STATUS_LABELS, STATUS_STYLE, CATEGORY_LABELS, subjectStyle, WITHHELD_LABELS, POLL_MS, TOPIC_ICONS, INBOX_TABS, chatStatusLabel, convName, nameFromOrder, nameNote, closedInfo, CASE_LABELS, isVisitorChat, timeAgo, matchedText, draggingFiles, fullDate } from './_lib/inbox';
import { highlightText, renderWithLinks } from './_lib/text';
import { TransferDialog } from './_components/TransferDialog';
import { PhoneMatchBadge, WaitingChip, CameBackChip, CaseChip, HealthBadge, HealthBar, VerifiedBadge, ThreadDivider } from './_components/chips';
import { OrderLine, AddressLine, AddressDialog } from './_components/OrderLine';
import { MessageActions, MessageEditor, DeleteMessageDialog, MessageDetailsDialog, MessageAttachments } from './_components/MessageTools';


export default function ChatSupportPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState('');

  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [activePanelId, setActivePanelId] = useState('');
  const [tab, setTab] = useState<InboxTab>('all');
  // The Problem type list in the sidebar: folded or open, remembered per browser.
  const [topicsOpen, setTopicsOpenState] = useState(true);
  useEffect(() => { try { if (localStorage.getItem('chat.topicsOpen') === '0') setTopicsOpenState(false); } catch { /* private window */ } }, []);
  const setTopicsOpen = (v: boolean) => { setTopicsOpenState(v); try { localStorage.setItem('chat.topicsOpen', v ? '1' : '0'); } catch { /* ignore */ } };
  const topicsShown = topicsOpen || tab.startsWith('topic:');
  const topicKey = tab.startsWith('topic:') ? tab.slice(6) : '';
  const topicDef = INBOX_TOPICS.find(t => t.key === topicKey) || null;
  // A problem tab has no status or segment of its own: it lists the open chats about it.
  const tabDef = topicKey ? { ...INBOX_TABS[0], status: '', segment: '' as const } : (INBOX_TABS.find(t => t.v === tab) || INBOX_TABS[0]);
  const statusFilter = tabDef.status;
  const segment = tabDef.segment;
  // Open customers per problem tab, from the list's own answer.
  const [topicCounts, setTopicCounts] = useState<Record<string, number>>({});
  // The Refund / Ship again sections: how many chats each holds (and unread), and, for the open one,
  // who marked how many per day.
  const caseKey = tab.startsWith('case:') ? tab.slice(5) : '';
  // My chats: the list asks for ?mine=1 (this login's own chats in Needs you and With team).
  const mineTab = tab === 'mine';
  const [caseCounts, setCaseCounts] = useState<Record<string, { total: number; unread: number }>>({});
  const [caseSummary, setCaseSummary] = useState<{ marked_by: string; day: string; n: number }[]>([]);

  // The search box. searchQ trails what is typed by a moment, so the list is
  // not asked for on every key. A search looks at ALL chats of the chosen
  // panel (Closed ones and visitors too), whatever tab is open.
  const [searchInput, setSearchInput] = useState('');
  // The "Unread" filter under the search box: only chats whose customer still waits for an answer
  // (owner, 2026-10-01: "jawab baaki wali"; chats the AI already answered are not unread).
  const [unreadOnly, setUnreadOnly] = useState(false);
  // The list comes 200 at a time; "Show more" asks for 200 more. listTotal = how many there are in all,
  // unansweredTotal = open chats waiting for an answer in all tabs (the number beside Chat Support).
  const [listLimit, setListLimit] = useState(200);
  const [listTotal, setListTotal] = useState<number | null>(null);
  const [unansweredTotal, setUnansweredTotal] = useState<number | null>(null);
  const [searchQ, setSearchQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearchQ(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);
  const searchActive = searchQ.length >= 2;
  // Another tab, filter, panel or search starts again at the first 200. Done while rendering, so the
  // first request for the new list already asks for 200 (an effect would ask twice).
  const listKey = `${tab}|${unreadOnly}|${activePanelId}|${searchQ}`;
  const [limitKey, setLimitKey] = useState(listKey);
  if (limitKey !== listKey) { setLimitKey(listKey); setListLimit(200); }
  const searchActiveRef = useRef(false);
  searchActiveRef.current = searchActive;
  // "#1234" highlights the 1234 in "#1234" and in "1234" alike.
  const searchTerm = searchActive ? (searchQ.replace(/^[#\s]+/, '') || searchQ) : '';
  const listSeqRef = useRef(0);
  const scrolledToHitRef = useRef('');

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeConv, setActiveConv] = useState<Conversation | null>(null);
  // The open chat's order line; tied to its chat so a fast switch never shows the last one's.
  // My profile / Login & security, opened from the name at the bottom of the sidebar.
  const [meOpen, setMeOpen] = useState(false);
  const [orderInfo, setOrderInfo] = useState<{ id: string; facts: OrderFacts | null; address: StaffAddress | null; editable: boolean } | null>(null);
  const [addrEdit, setAddrEdit] = useState<{ convId: string; busy: boolean; error: string } | null>(null);
  // Chat team (owner, 2026-10-01). From the list's answer: who is on the team (names on rows, the
  // transfer list), this login's key ('owner' for the Super Admin) and its own open chats (My chats).
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [meKey, setMeKey] = useState<string | null>(null);
  // held: the Super Admin's open chats one by one, exactly what "Give all N to the team" frees.
  const [myChats, setMyChats] = useState<{ open: number; waiting: number; held: number }>({ open: 0, waiting: 0, held: 0 });
  // From the thread's answer: what this login may do on the open chat and its team history, tied to
  // their chat like the order line, so a fast switch never shows the last chat's buttons.
  const [threadTeam, setThreadTeam] = useState<{ id: string; staff: StaffBlock | null; log: TeamLogEntry[]; hotLock: HotLock | null } | null>(null);
  // Refund form (owner 2026-10-02): the thread answer's refund_form (Super Admin + Refund chats only).
  const [threadRefund, setThreadRefund] = useState<{ id: string; state: RefundThreadState | null } | null>(null);
  const [teamLogOpen, setTeamLogOpen] = useState(false);
  const [transferEdit, setTransferEdit] = useState<{ convId: string; busy: boolean; error: string } | null>(null);
  // "Give all N to the team" (Super Admin, My chats): 'ask' = the inline confirm is showing.
  const [release, setRelease] = useState<'ask' | 'busy' | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // The same customer's older chats on this site (read-only, oldest first),
  // how many older chats they have in all, and their newer chat if any.
  const [earlier, setEarlier] = useState<EarlierChat[]>([]);
  const [earlierTotal, setEarlierTotal] = useState(0);
  const [newerChat, setNewerChat] = useState<NewerChat | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [alert, setAlert] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [menu, setMenu] = useState<{ id: string; up: boolean } | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string; saving: boolean; error: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; busy: boolean; error: string } | null>(null);
  const [details, setDetails] = useState<{ id: string; data: MessageDetails | null; error: string } | null>(null);

  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [fileError, setFileError] = useState('');
  const [sendBlocked, setSendBlocked] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const pendingRef = useRef<PendingFile[]>([]);
  pendingRef.current = pendingFiles;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadsRef = useRef(new Map<string, XMLHttpRequest>());
  const dragDepthRef = useRef(0);
  const composerRef = useRef<HTMLDivElement>(null);
  const fileKeyRef = useRef(0);

  // What this login may do on the open chat, as the server said (never guessed here).
  const staff = activeConv && threadTeam?.id === activeConv.id ? threadTeam.staff : null;
  const teamLog = activeConv && threadTeam?.id === activeConv.id ? threadTeam.log : [];
  // Close / Hand to AI on a hot chat (server's hot_lock). Missing (an older server): nothing is off here,
  // and the server still refuses with its own message.
  const hotLock = activeConv && threadTeam?.id === activeConv.id ? threadTeam.hotLock : null;
  // Someone else holds the open chat and this login may only read it (the Super Admin may act on any).
  const othersChat = !!staff?.holder && !staff.can_act;
  // The composer works only on a chat with the team (agent_handling) that this login may act on: its
  // own, one nobody holds, or any chat for the Super Admin.
  const replyOpen = !!activeConv && activeConv.status === 'agent_handling' && !!staff?.can_act;
  // "Rahul's chat. Only Rahul or Super Admin can reply." (or the Super Admin's own chat).
  const readOnlyReply = !othersChat || !staff?.holder ? ''
    : staff.holder.owner ? "Super Admin's chat. Only Super Admin can reply."
    : `${staff.holder.name}'s chat. Only ${staff.holder.name} or Super Admin can reply.`;

  const showAlert = (type: 'success' | 'error', message: string) => {
    setAlert({ type, message });
    setTimeout(() => setAlert(null), 4000);
  };

  /* ═══ AUTH ═══ */
  useEffect(() => {
    const t = localStorage.getItem('auth_token');
    const u = localStorage.getItem('auth_user');
    if (!t || !u) { router.push('/login'); return; }
    setToken(t);
    setUser(JSON.parse(u));
    setActivePanelId(localStorage.getItem('active_panel_id') || '');
    // An expired token, or one from before tokens were signed, is refused by
    // every API — send the person to log in again instead of showing nothing.
    fetch('/api/auth/session', { headers: { Authorization: `Bearer ${t}` } })
      .then(async (res) => {
        if (res.status === 401) {
          localStorage.removeItem('auth_token');
          localStorage.removeItem('auth_user');
          router.push('/login');
          return;
        }
        // The login's current role, panels and permissions (they can change in Team).
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

  /* ═══ PANELS ═══ */
  useEffect(() => {
    if (!token) return;
    fetch('/api/businesses', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setBusinesses(d.businesses || []))
      .catch(() => {});
  }, [token]);

  /* ═══ CONVERSATION LIST ═══ */
  const fetchConversations = useCallback(async (quiet = false) => {
    if (!token) return;
    // Only the newest answer is used: a slow answer for what was typed a
    // moment ago must not replace the list for what is typed now.
    const seq = ++listSeqRef.current;
    if (!quiet) setLoadingList(true);
    try {
      const params = new URLSearchParams();
      if (activePanelId) params.set('businessId', activePanelId);
      params.set('limit', String(listLimit));
      if (searchActive) {
        params.set('q', searchQ);
      } else {
        if (statusFilter) params.set('status', statusFilter);
        if (segment) params.set('segment', segment);
        if (topicKey) params.set('topic', topicKey);
        if (caseKey) params.set('case', caseKey);
        // Closed chats never wait for an answer: Unread does not apply there.
        if (unreadOnly && statusFilter !== 'resolved') params.set('unread', '1');
        if (mineTab) params.set('mine', '1');
      }
      // activeHeaders(): this poll also says the person is here, only while they really use the tab
      // (src/lib/presence-client.ts), so a screen left open does not keep them "around".
      const res = await fetch(`/api/chat/conversations?${params}`, {
        headers: { Authorization: `Bearer ${token}`, ...activeHeaders() },
      });
      const data = await res.json();
      if (res.ok && Array.isArray(data.team)) setTeam(data.team);
      if (res.ok && data.me !== undefined) setMeKey(data.me ?? null);
      if (res.ok && data.mine) setMyChats({ open: data.mine.open ?? 0, waiting: data.mine.waiting ?? 0, held: data.mine.held ?? 0 });
      if (res.ok && seq === listSeqRef.current) {
        setConversations(data.conversations || []);
        setListTotal(typeof data.total === 'number' ? data.total : null);
        if (typeof data.unanswered_total === 'number') setUnansweredTotal(data.unanswered_total);
        if (data.topic_counts) setTopicCounts(data.topic_counts);
        if (data.case_counts) setCaseCounts(data.case_counts);
        setCaseSummary(Array.isArray(data.case_summary) ? data.case_summary : []);
      }
    } catch { /* keep the last good list */ }
    finally { if (!quiet) setLoadingList(false); }
  }, [token, activePanelId, statusFilter, segment, topicKey, caseKey, mineTab, unreadOnly, searchActive, searchQ, listLimit]);

  useEffect(() => { fetchConversations(); }, [fetchConversations]);

  /* ═══ OPEN THREAD ═══ */
  const fetchThread = useCallback(async (id: string, quiet = false) => {
    if (!token) return;
    try {
      const res = await fetch(`/api/chat/conversations/${id}`, {
        headers: { Authorization: `Bearer ${token}`, ...activeHeaders() },
      });
      const data = await res.json();
      if (!res.ok) { if (!quiet) showAlert('error', data.error || 'Could not open that conversation'); return; }
      setActiveConv(data.conversation);
      setThreadTeam({ id, staff: data.staff ?? null, log: Array.isArray(data.team_log) ? data.team_log : [], hotLock: data.hot_lock ?? null });
      setOrderInfo({ id, facts: data.order_facts ?? null, address: data.order_address ?? null, editable: !!data.address_editable });
      setThreadRefund({ id, state: data.refund_form ?? null });
      setMessages(data.messages || []);
      const older = data.earlier ?? data.conversation?.earlier;
      setEarlier(Array.isArray(older) ? older : []);
      setEarlierTotal(typeof data.earlier_total === 'number' ? data.earlier_total : 0);
      setNewerChat(data.newer_chat && data.newer_chat.conversation_id !== id ? data.newer_chat : null);
    } catch { /* keep what is on screen */ }
  }, [token]);

  useEffect(() => {
    if (activeId) fetchThread(activeId);
    else { setActiveConv(null); setOrderInfo(null); setThreadTeam(null); setThreadRefund(null); setMessages([]); setEarlier([]); setEarlierTotal(0); setNewerChat(null); }
  }, [activeId, fetchThread]);

  // The team history and the transfer dialog belong to the chat they were opened on; the release
  // question to the tab it was asked on.
  useEffect(() => { setTeamLogOpen(false); setTransferEdit(null); }, [activeId]);
  useEffect(() => { setRelease(null); }, [tab]);

  /* ═══ POLLING ═══ */
  // There is no websocket in ShipTrack — the inbox asks again every few
  // seconds instead, and stops entirely while the tab is in the background.
  useEffect(() => {
    if (!token) return;
    let n = 0;
    const tick = () => {
      if (document.hidden) return;
      n++;
      // A search is not re-run every few seconds; the open chat still is. After "Show more" (up to
      // 1000 rows) the list is asked for every 15 s instead of every 3 s, so the poll stays light.
      if (!searchActiveRef.current && (listLimit <= 200 || n % 5 === 0)) fetchConversations(true);
      if (activeIdRef.current) fetchThread(activeIdRef.current, true);
    };
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [token, fetchConversations, fetchThread, listLimit]);

  const pinUntilRef = useRef(0);
  const earlierCount = earlier.reduce((n, e) => n + (e.messages?.length || 0), 0);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    pinUntilRef.current = Date.now() + 2000;
  }, [messages.length, earlierCount]);

  // Opened from a search: go to the newest place the search text appears,
  // once per chat and search (the poll must not pull the thread back to it).
  useEffect(() => {
    if (!searchActive || !activeId) { scrolledToHitRef.current = ''; return; }
    const key = `${activeId}|${searchQ}`;
    if (scrolledToHitRef.current === key) return;
    if (!threadRef.current?.querySelector('mark[data-search]')) return;
    scrolledToHitRef.current = key;
    pinUntilRef.current = 0;
    // After the scroll to the bottom above has settled.
    setTimeout(() => {
      const hits = threadRef.current?.querySelectorAll('mark[data-search]');
      hits?.[hits.length - 1]?.scrollIntoView({ block: 'center' });
    }, 600);
  }, [messages, earlier, activeId, searchActive, searchQ]);

  // An image has no height until it loads, so the scroll above stops short of
  // it. Follow it down while that scroll is still settling, or if the agent is
  // at the bottom anyway — not when they have scrolled up to read.
  const keepThreadPinned = (img: HTMLImageElement) => {
    const box = threadRef.current;
    if (!box) return;
    const gap = box.scrollHeight - box.scrollTop - box.clientHeight;
    if (Date.now() < pinUntilRef.current || gap <= img.offsetHeight + 80) {
      bottomRef.current?.scrollIntoView();
    }
  };

  /* ═══ PHONE LAYOUT ═══ */
  // On a phone the open conversation replaces the list (see .chat-shell in
  // globals.css). Opening one adds a history entry, so the phone's own back
  // gesture returns to the list instead of leaving the inbox. Next.js copies
  // its router state into entries added this way, so going back does not
  // reload the page.
  const openConversation = (id: string) => {
    if (!activeIdRef.current && window.matchMedia('(max-width: 767px)').matches) {
      window.history.pushState({ chatThread: true }, '');
    }
    setActiveId(id);
  };

  const closeConversation = () => {
    if (window.history.state?.chatThread) window.history.back();
    else setActiveId(null);
  };

  useEffect(() => {
    const onBack = () => { if (activeIdRef.current) setActiveId(null); };
    window.addEventListener('popstate', onBack);
    return () => window.removeEventListener('popstate', onBack);
  }, []);

  // Team score's "Open chat" link (/admin/chat?open=<id>): open that chat once, then drop the query.
  useEffect(() => {
    try {
      const id = new URLSearchParams(window.location.search).get('open');
      if (id && /^[\w-]{6,80}$/.test(id)) { setActiveId(id); window.history.replaceState(window.history.state, '', '/admin/chat'); }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ═══ ACTIONS ═══ */
  // Take over / Hand to AI / Close; take = "Take from X" (the chat becomes this login's).
  const changeStatus = async (status: string, take = false) => {
    if (!activeId) return;
    const id = activeId;
    try {
      const res = await fetch(`/api/chat/conversations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(take ? { status, take: true } : { status }),
      });
      if (res.ok) {
        // The closer and the holder as the server recorded them, not a guess made here.
        const d = await res.json().catch(() => ({} as Record<string, unknown>));
        setActiveConv(c => (c && c.id === id ? {
          ...c,
          status: status as Conversation['status'],
          auto_closed_at: (d.auto_closed_at as string | null | undefined) ?? null,
          ...(d.assigned_to !== undefined ? { assigned_to: (d.assigned_to as string | null) ?? null } : {}),
          ...(status === 'resolved' ? { closed_by_name: (d.closed_by_name as string | null | undefined) ?? null, closed_at: (d.closed_at as string | null | undefined) ?? null } : {}),
        } : c));
        // What this login may do now (a take or a claim opens the composer).
        fetchThread(id, true);
        fetchConversations(true);
      } else {
        const d = await res.json().catch(() => ({} as Record<string, unknown>));
        showAlert('error', (d.error as string) || 'Could not update that conversation');
        // Someone else has the chat now (409), or ShipTrack was starting (503): show what is true.
        fetchThread(id, true);
        fetchConversations(true);
      }
    } catch { showAlert('error', 'Could not update that conversation'); }
  };

  // Transfer (the dialog): to a member who can reply in this panel or the Super Admin ("Nobody" for
  // the Super Admin), with a one-line note only the team sees.
  const sendTransfer = async (to: TransferTarget, note: string) => {
    if (!transferEdit || !token) return;
    const convId = transferEdit.convId;
    setTransferEdit({ convId, busy: true, error: '' });
    try {
      const res = await fetch(`/api/chat/conversations/${convId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ transferTo: to.key, note }),
      });
      const d = await res.json().catch(() => ({} as Record<string, unknown>));
      if (!res.ok) {
        const why = (d.error as string) || 'Could not transfer this chat';
        // 409: the chat is no longer this login's to give, so the list in the dialog is out of date.
        // Anything else (a note or a pick the server refused, ShipTrack starting) stays in the dialog.
        if (res.status === 409) { setTransferEdit(null); showAlert('error', why); }
        else setTransferEdit({ convId, busy: false, error: why });
        fetchThread(convId, true);
        fetchConversations(true);
        return;
      }
      setTransferEdit(null);
      setActiveConv(c => (c && c.id === convId ? {
        ...c,
        status: ((d.status as Conversation['status'] | undefined) || c.status),
        assigned_to: (d.assigned_to as string | null | undefined) ?? null,
        auto_closed_at: null,
      } : c));
      showAlert('success', to.key === null ? 'Back in the open pool: the next person to reply gets it'
        : to.key === staff?.me ? 'This chat is yours now'
        : `Transferred to ${(d.holder_name as string | null | undefined) || to.name}`);
      fetchThread(convId, true);
      fetchConversations(true);
    } catch {
      setTransferEdit({ convId, busy: false, error: 'Could not transfer this chat' });
    }
  };

  // "Give all N to the team" (Super Admin only, owner answer 3): every open chat he holds goes back
  // to the open pool in one step, status unchanged. Asked inline first (no browser pop-up).
  const releaseAll = async () => {
    if (!token || release === 'busy') return;
    setRelease('busy');
    try {
      const res = await fetch('/api/chat/team/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: '{}',
      });
      const d = await res.json().catch(() => ({} as Record<string, unknown>));
      if (!res.ok) { showAlert('error', (d.error as string) || 'Could not give the chats back. Try again.'); return; }
      const n = typeof d.released === 'number' ? d.released : 0;
      showAlert('success', n === 0 ? 'You hold no open chats' : `${n} chat${n === 1 ? ' is' : 's are'} open to the team again`);
      fetchConversations(true);
      if (activeIdRef.current) fetchThread(activeIdRef.current, true);
    } catch {
      showAlert('error', 'Could not give the chats back. Try again.');
    } finally {
      setRelease(null);
    }
  };

  // Refund / Ship again (chat-cases.sql). Internal only: nothing is sent to the customer.
  const markCase = async (kind: 'refund' | 'reship' | null) => {
    if (!activeId || !activeConv) return;
    const label = kind ? CASE_LABELS[kind] : CASE_LABELS[activeConv.case_kind || 'refund'];
    const ok = kind
      ? confirm(`Mark this chat for ${label}?\n\nIt moves to the ${label} list (and out of every other list), the AI stops replying here, and the customer is NOT told anything.`)
      : activeConv.case_kind === 'reship' && activeConv.case_marked_by === AUTO_MARK_NAME
        // Chikki's own mark (owner 2026-10-02): Remove sends it to Needs you (a chat a team member had
        // taken goes back to them), and Chikki never marks it again. The one-time move sent no message.
        ? confirm(`Take this chat out of ${label}?\n\n${activeConv.case_mark_role === 'backfill'
          ? 'Chikki moved it here in the one-time move of 2 Oct; the move sent the customer no message.'
          : 'The customer was promised a new tracking link.'} The chat goes to Needs you (or back to the team member who had taken it), and Chikki will not move it here again by itself.`)
        : activeConv.case_kind === 'refund' && activeConv.case_marked_by === AUTO_MARK_NAME
          // Chikki's own Refund mark (owner 2026-10-02): the customer is waiting for a refund form.
          ? confirm(`Take this chat out of ${label}?\n\nChikki told the customer their refund is being processed and that a refund form will come in this chat. It goes back to where it was. The history keeps who marked and who removed it.`)
          : confirm(`Take this chat out of ${label}?\n\nIt goes back to where it was. The history keeps who marked and who removed it.`);
    if (!ok) return;
    try {
      const res = await fetch(`/api/chat/conversations/${activeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ caseKind: kind }),
      });
      const d = await res.json().catch(() => ({} as Record<string, unknown>));
      if (!res.ok) {
        showAlert('error', (d.error as string) || 'Could not update that conversation');
        // A senior came back (403), or the chat changed: show what is true now.
        fetchThread(activeId, true);
        fetchConversations(true);
        return;
      }
      setActiveConv(c => (c ? {
        ...c,
        case_kind: (d.case_kind as Conversation['case_kind']) ?? null,
        case_marked_by: (d.case_marked_by as string | null | undefined) ?? null,
        case_marked_at: (d.case_marked_at as string | null | undefined) ?? null,
        case_order_id: (d.case_order_id as string | null | undefined) ?? null,
        case_mark_role: null,   // a person's mark now, or none
        status: ((d.status as Conversation['status'] | undefined) || c.status),
      } : c));
      showAlert('success', kind ? `Moved to ${label}` : `Taken out of ${label}`);
      fetchConversations(true);
    } catch { showAlert('error', 'Could not update that conversation'); }
  };

  /* ═══ ATTACHMENTS ═══ */
  const updateFile = (key: string, patch: Partial<PendingFile>) =>
    setPendingFiles(list => list.map(p => (p.key === key ? { ...p, ...patch } : p)));

  // XMLHttpRequest rather than fetch, because only it reports upload progress.
  const uploadFile = useCallback((key: string, file: File, conversationId: string) => {
    const xhr = new XMLHttpRequest();
    uploadsRef.current.set(key, xhr);

    const form = new FormData();
    form.append('conversationId', conversationId);
    form.append('file', file);

    xhr.upload.onprogress = e => {
      if (e.lengthComputable) updateFile(key, { progress: Math.round((e.loaded / e.total) * 100) });
    };
    xhr.onload = () => {
      uploadsRef.current.delete(key);
      let data: { attachment?: { id: string; name: string }; error?: string } | null = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON, e.g. a proxy error page */ }
      if (xhr.status >= 200 && xhr.status < 300 && data?.attachment?.id) {
        updateFile(key, { status: 'ready', progress: 100, id: data.attachment.id, name: data.attachment.name, error: undefined });
      } else {
        updateFile(key, {
          status: 'failed',
          error: data?.error || (xhr.status === 413 ? 'File size exceeds the allowed limit.' : 'Upload failed'),
        });
      }
    };
    xhr.onerror = () => {
      uploadsRef.current.delete(key);
      updateFile(key, { status: 'failed', error: 'Upload failed — check your connection' });
    };
    xhr.onabort = () => { uploadsRef.current.delete(key); };

    xhr.open('POST', '/api/chat/attachments');
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.send(form);
  }, [token]);

  const forgetFile = (p: PendingFile, deleteUpload: boolean) => {
    uploadsRef.current.get(p.key)?.abort();
    if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    if (deleteUpload && p.id) {
      fetch(`/api/chat/attachments/${p.id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      }).catch(() => { /* an unsent upload is cleared after a day anyway */ });
    }
  };

  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    if (!activeId || !replyOpen) {
      setFileError(readOnlyReply || 'Take over the conversation to attach files.');
      return;
    }
    if (sending) {
      setFileError('Wait for the reply to finish sending.');
      return;
    }

    const problems: string[] = [];
    const added: PendingFile[] = [];
    let count = pendingRef.current.length;
    let total = pendingRef.current.reduce((n, p) => n + p.size, 0);

    for (const file of files) {
      const problem = checkBrowserFile(file)
        ?? (count >= MAX_ATTACHMENTS_PER_MESSAGE ? TOO_MANY_MESSAGE : null)
        ?? (total + file.size > MAX_ATTACHMENT_TOTAL_BYTES ? TOTAL_TOO_LARGE_MESSAGE : null);
      if (problem) { problems.push(`${file.name}: ${problem}`); continue; }

      count += 1;
      total += file.size;
      added.push({
        key: `f${++fileKeyRef.current}`,
        file,
        name: file.name,
        size: file.size,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
        status: 'uploading',
        progress: 0,
      });
    }

    setFileError(problems.join(' · '));
    if (added.length > 0) {
      setPendingFiles(list => [...list, ...added]);
      added.forEach(p => uploadFile(p.key, p.file, activeId));
    }
  };

  const removeFile = (key: string) => {
    const p = pendingRef.current.find(x => x.key === key);
    if (p) forgetFile(p, true);
    setPendingFiles(list => list.filter(x => x.key !== key));
    setFileError('');
  };

  const retryFile = (key: string) => {
    const p = pendingRef.current.find(x => x.key === key);
    if (!p || p.status !== 'failed' || !activeId) return;
    updateFile(key, { status: 'uploading', progress: 0, error: undefined });
    uploadFile(key, p.file, activeId);
  };

  // Files are uploaded against one conversation, so they do not follow the
  // agent to another one.
  useEffect(() => {
    pendingRef.current.forEach(p => forgetFile(p, true));
    setPendingFiles([]);
    setFileError('');
    setSendBlocked(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  useEffect(() => () => {
    pendingRef.current.forEach(p => forgetFile(p, false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A file dropped anywhere else on the page would make the browser open it
  // and leave the inbox.
  useEffect(() => {
    const keepPage = (e: DragEvent) => {
      if (!draggingFiles(e)) return;
      e.preventDefault();
      // Only the composer takes files; everywhere else shows a no-drop cursor.
      if (e.type === 'dragover' && e.dataTransfer && !composerRef.current?.contains(e.target as Node)) {
        e.dataTransfer.dropEffect = 'none';
      }
      if (e.type === 'drop') { dragDepthRef.current = 0; setDragOver(false); }
    };
    window.addEventListener('dragover', keepPage);
    window.addEventListener('drop', keepPage);
    return () => {
      window.removeEventListener('dragover', keepPage);
      window.removeEventListener('drop', keepPage);
    };
  }, []);

  const sendReply = async () => {
    if (!activeId || sending) return;
    const text = draft.trim();
    const files = pendingRef.current;
    // Enter still works while a file is not ready; it explains instead of sending.
    if (files.some(p => p.status !== 'ready')) { setSendBlocked(true); return; }
    if (!text && files.length === 0) return;

    setSending(true);
    try {
      const res = await fetch('/api/chat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          conversationId: activeId,
          content: text,
          ...(files.length > 0 ? { attachmentIds: files.map(p => p.id) } : {}),
        }),
      });
      const data = await res.json();
      // On failure the text and files stay in the composer, ready to send again. Someone else may
      // have the chat now (409 naming them) or ShipTrack was starting (503): show what is true.
      if (!res.ok) {
        showAlert('error', data.error || 'Could not send that reply');
        fetchThread(activeId, true);
        fetchConversations(true);
        return;
      }

      setDraft('');
      const sentKeys = new Set(files.map(p => p.key));
      files.forEach(p => forgetFile(p, false));
      setPendingFiles(list => list.filter(p => !sentKeys.has(p.key)));
      setFileError('');
      setSendBlocked(false);
      if (data.emailed === false) {
        showAlert('error', 'Saved, but the email did not go out — check the mailbox settings');
      }
      await fetchThread(activeId, true);
      fetchConversations(true);
    } catch { showAlert('error', 'Could not send that reply'); }
    finally { setSending(false); }
  };

  /* ═══ MANAGING A SENT MESSAGE ═══ */
  // Open message tools belong to the conversation they were opened in.
  useEffect(() => {
    setMenu(null);
    setEditing(null);
    setDeleting(null);
    setDetails(null);
  }, [activeId]);

  // The ⋯ menu closes on a click anywhere else or on Escape.
  useEffect(() => {
    if (!menu) return;
    const onPointer = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.(`[data-menu="${menu.id}"]`)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const toggleMenu = (id: string, button: HTMLButtonElement) => {
    if (menu?.id === id) { setMenu(null); return; }
    // Near the bottom of the thread the menu opens upwards, so it is not cut off.
    const box = threadRef.current?.getBoundingClientRect();
    const up = !!box && box.bottom - button.getBoundingClientRect().bottom < 190;
    setMenu({ id, up });
  };

  const replaceMessage = (updated: ChatMessage) =>
    setMessages(list => list.map(m => (m.id === updated.id ? { ...m, ...updated } : m)));

  const messageText = (msg: ChatMessage) => {
    const files = Array.isArray(msg.metadata?.attachments) ? msg.metadata!.attachments! : [];
    return files.length > 0 && msg.metadata?.captionless ? '' : msg.content;
  };

  const startEdit = (msg: ChatMessage) => {
    setMenu(null);
    setEditing({ id: msg.id, text: messageText(msg), saving: false, error: '' });
  };

  const saveEdit = async () => {
    if (!editing || editing.saving) return;
    const { id, text } = editing;
    setEditing(e => (e && e.id === id ? { ...e, saving: true, error: '' } : e));
    const failed = (reason?: string) =>
      setEditing(e => (e && e.id === id ? { ...e, saving: false, error: reason || 'Unable to update message. Please try again.' } : e));
    try {
      const res = await fetch(`/api/chat/messages/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content: text }),
      });
      const data = await res.json().catch(() => ({}));
      // The typed text stays in the editor on any failure.
      if (!res.ok) { failed(res.status < 500 && data.error ? `Unable to update message: ${data.error}` : undefined); return; }
      replaceMessage(data.message);
      // Only this message's editor closes; another one opened meanwhile stays.
      setEditing(e => (e && e.id === id ? null : e));
      showAlert('success', 'Message updated');
      fetchConversations(true);
    } catch { failed(); }
  };

  const confirmDelete = async () => {
    if (!deleting || deleting.busy) return;
    const { id } = deleting;
    setDeleting(d => (d ? { ...d, busy: true, error: '' } : d));
    try {
      const res = await fetch(`/api/chat/messages/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDeleting(d => (d ? {
          ...d, busy: false,
          error: res.status < 500 && data.error ? `Unable to delete message: ${data.error}` : 'Unable to delete message. Please try again.',
        } : d));
        return;
      }
      replaceMessage(data.message);
      if (editing?.id === id) setEditing(null);
      setDeleting(null);
      showAlert('success', 'Message deleted');
      fetchConversations(true);
    } catch {
      setDeleting(d => (d ? { ...d, busy: false, error: 'Unable to delete message. Please try again.' } : d));
    }
  };

  const copyMessage = async (msg: ChatMessage) => {
    setMenu(null);
    const files = Array.isArray(msg.metadata?.attachments) ? msg.metadata!.attachments! : [];
    const text = messageText(msg) || files.map(f => `${f.name} ${window.location.origin}${f.url}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      showAlert('success', 'Message copied');
    } catch {
      showAlert('error', 'Could not copy — select the text and copy it instead');
    }
  };

  const openDetails = async (id: string) => {
    setMenu(null);
    setDetails({ id, data: null, error: '' });
    try {
      const res = await fetch(`/api/chat/messages/${id}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => ({}));
      setDetails(d => (d && d.id === id
        ? (res.ok ? { ...d, data } : { ...d, error: data.error || 'Could not load the details' })
        : d));
    } catch {
      setDetails(d => (d && d.id === id ? { ...d, error: 'Could not load the details' } : d));
    }
  };

  const logout = () => {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
    router.push('/login');
  };

  if (!user) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <Loader2 size={32} style={{ animation: 'spin 0.6s linear infinite' }} />
      </div>
    );
  }

  // What this login may do here (src/lib/permissions.ts; the API checks the same).
  const canReply = can(user, 'chat.reply');
  const canCases = can(user, 'chat.cases');
  // The panel's name on each row only when this login has more than one panel.
  const showPanelName = businesses.length > 1;
  // A grouped row (one customer's chats) carries the unread count of all of them.
  const rowUnread = (c: Conversation) => c.group_unread ?? c.unread_count ?? 0;
  // Open chats waiting for an answer, in all tabs (the server counts them; it used to be the unread
  // messages of the 200 rows on screen, AI replies included).
  const unreadTotal = unansweredTotal ?? 0;
  // A row whose customer still waits for an answer gets a red count; one the AI already answered a grey one.
  const rowWaiting = (c: Conversation) => !!(c.group_waiting ?? c.waiting_since);
  // The open chat's row: its own, or its customer's grouped row, which moves
  // to the customer's newest chat when they write in a new one.
  const isActiveRow = (c: Conversation) => activeId === c.id || (
    !!activeConv?.customer_key && activeConv.source === 'chat' && c.source === 'chat'
    && c.customer_key === activeConv.customer_key && c.site_id === activeConv.site_id
  );
  const hiddenEarlier = Math.max(0, earlierTotal - earlier.length);
  // The thread's own answer carries the verified fields, so the header stays
  // right after the chat drops out of the Visitors list; the list row is the
  // fallback while the thread is still loading.
  const activeVerifiedSrc = !activeConv ? null
    : activeConv.verified_order_id !== undefined ? activeConv
    : conversations.find(c => c.id === activeConv.id) ?? null;
  const activeVerifiedOrder = activeVerifiedSrc?.verified_order_id ?? null;
  const activeVerifiedVia = activeVerifiedSrc?.verified_via ?? null;
  const activePhoneMatch = activeVerifiedSrc?.phone_match_order_id ?? null;
  // The subject bar reads the thread's own answer the same way, with the
  // list row as the fallback.
  const activeSubjectSrc = !activeConv ? null
    : activeConv.subject_label !== undefined ? activeConv
    : conversations.find(c => c.id === activeConv.id) ?? null;
  const activeSubject = activeSubjectSrc?.subject_label ? {
    label: activeSubjectSrc.subject_label,
    summary: activeSubjectSrc.subject_summary || '',
    updatedAt: activeSubjectSrc.subject_updated_at ?? null,
  } : null;
  // The frustration bar reads the thread's own answer, with the list row as
  // the fallback while it loads.
  const activeHealthSrc = !activeConv ? null
    : activeConv.health_score !== undefined ? activeConv
    : conversations.find(c => c.id === activeConv.id) ?? null;
  const activeHealth = activeHealthSrc && activeHealthSrc.health_score != null
    && !(activeVerifiedSrc && isVisitorChat(activeVerifiedSrc)) ? {
    score: activeHealthSrc.health_score,
    reason: activeHealthSrc.health_reason ?? null,
    updatedAt: activeHealthSrc.health_updated_at ?? null,
  } : null;
  const activeOrder = orderInfo && activeConv && orderInfo.id === activeConv.id ? orderInfo.facts : null;
  const activeAddress = orderInfo && activeConv && orderInfo.id === activeConv.id ? orderInfo.address : null;
  const addressEditable = !!activeAddress && !!orderInfo?.editable && can(user, 'orders.update');
  const saveAddress = async (a: OrderAddress) => {
    if (!addrEdit || !token) return;
    const convId = addrEdit.convId;
    setAddrEdit({ ...addrEdit, busy: true, error: '' });
    try {
      const res = await fetch(`/api/chat/conversations/${convId}/address`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(a),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setAddrEdit({ convId, busy: false, error: data.error || 'Could not save the address' }); return; }
      if (data.address) setOrderInfo(prev => prev && prev.id === convId ? { ...prev, address: data.address } : prev);
      setAddrEdit(null);
      showAlert('success', data.unchanged ? 'Nothing changed' : 'Address updated in ShipTrack');
    } catch {
      setAddrEdit({ convId, busy: false, error: 'Could not save the address' });
    }
  };
  const urgentCount = searchActive ? 0 : conversations.filter(c => (c.health_pinned && !isVisitorChat(c)) || ((c.waiting_overdue || c.urgent_waiting) && !isVisitorChat(c)) || c.returned).length;
  // The open chat's row, for its waiting time (the thread's own answer does not carry it).
  // The Waiting timer is for customers only (owner, 2026-09-30): a visitor shows none.
  const activeWaitingRow = activeConv ? conversations.find(c => c.id === activeConv.id) : null;
  const activeWaiting = activeWaitingRow && !isVisitorChat(activeWaitingRow) ? (activeWaitingRow.waiting_since ?? null) : null;
  // Worked out from the files each time, so it goes away as soon as they are ready.
  const sendHint = !sendBlocked ? ''
    : pendingFiles.some(p => p.status === 'uploading') ? 'Wait for the files to finish uploading.'
    : pendingFiles.some(p => p.status === 'failed') ? 'Retry or remove the file that failed before sending.'
    : '';
  const composerNotice = [fileError, sendHint].filter(Boolean).join(' · ');

  // Chat team, for the open chat (all from the server's staff block). The header says who has it:
  // "With you" / "With Rahul" / "With team" on a chat with the team, "For you" / "For Rahul" beside
  // any other status (a Closed chat goes back to them if the customer writes again).
  const holderIsMe = !!staff?.holder && staff.holder.key === staff.me;
  const withText = holderIsMe ? 'With you' : staff?.holder ? `With ${staff.holder.name}` : 'With team';
  const forText = !staff?.holder || activeConv?.status === 'agent_handling' ? null
    : holderIsMe ? 'For you' : `For ${staff.holder.name}`;
  const holderAway = staff?.holder?.away_min != null ? ` · away ${minutesText(staff.holder.away_min)}` : '';
  // In place of the action buttons when this login may only read the chat.
  const readOnlyText = activeConv?.merged_into ? "Merged into the customer's other chat · read only"
    : staff?.holder ? `${staff.holder.name}'s chat · read only${holderAway}`
    : 'Read only';
  // The line above the composer when it is closed: why, and what to press.
  const takeLabel = !staff?.take || !staff.holder ? ''
    : staff.take === 'holder_away' ? `Take (${staff.holder.name} away${staff.holder.away_min != null ? ` ${minutesText(staff.holder.away_min)}` : ''})`
    : `Take from ${staff.holder.name}`;
  const composerHint = !activeConv || replyOpen ? ''
    : othersChat && staff?.holder
      ? `${staff.holder.name} has this chat. You can read it; ${takeLabel ? `press "${takeLabel}" above to answer`
        : staff.holder.owner ? 'ask Super Admin to transfer it to you' : `ask ${staff.holder.name} or Super Admin to transfer it to you`}.`
    : activeConv.merged_into ? "This chat was merged into the customer's other chat. Open that one to reply."
    : activeConv.status === 'human_needed' ? 'This one is waiting on a person — take over to reply.'
    : activeConv.status === 'ai_handling' ? 'The AI is handling this — take over to reply yourself.'
    : '';

  // One message in the thread. readOnly = a message from an older chat of the
  // same customer: shown as it was, without the edit/delete menu.
  const renderMessage = (msg: ChatMessage, readOnly = false) => {
    const mine = msg.sender !== 'visitor';
    const deleted = !!msg.deleted_at;
    const withheld = msg.metadata?.withheld;
    const attached = msg.metadata?.attachments;
    const files = Array.isArray(attached) ? attached : [];
    // A files-only reply carries a text stand-in for older views; the files say it here.
    const showText = !(files.length > 0 && msg.metadata?.captionless);
    const isEditing = !readOnly && mine && !deleted && editing?.id === msg.id;

    // A deleted message stays in the inbox as a marker, so the team can
    // see something was removed; its text is under View details.
    const bubble = (
      <div style={{
        padding: '0.625rem 0.875rem', borderRadius: 12, fontSize: '0.8125rem', lineHeight: 1.5,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', minWidth: 0,
        background: msg.sender === 'visitor' ? 'var(--primary)' : 'var(--card-bg)',
        color: msg.sender === 'visitor' ? '#fff' : 'var(--fg)',
        border: withheld ? '1px dashed #f59e0b' : '1px solid var(--border)',
        opacity: withheld ? 0.65 : 1,
        ...(deleted ? { background: 'transparent', color: 'var(--fg-muted)', fontStyle: 'italic', border: '1px dashed var(--border)', opacity: 1 } : {}),
      }}>
        {deleted ? 'This message was deleted' : (
          <>
            {files.length > 0 && <MessageAttachments files={files} onImageLoad={keepThreadPinned} />}
            {files.length > 0 && showText && <div style={{ height: '0.5rem' }} />}
            {showText && renderWithLinks(msg.content, searchTerm)}
          </>
        )}
      </div>
    );

    return (
      <div key={msg.id} className={mine ? 'msg-row chat-msg' : 'chat-msg'} style={{
        alignSelf: mine ? 'flex-start' : 'flex-end',
        display: 'flex', flexDirection: 'column',
        alignItems: mine ? 'flex-start' : 'flex-end',
      }}>
        {/* A team reply: "You" when this login wrote it, else the writer's name today ("Team" when the
            server could not tell). The customer only ever sees the brand. */}
        <span style={{ fontSize: '0.625rem', color: 'var(--fg-muted)', marginBottom: '0.25rem' }}>
          {msg.sender === 'visitor' ? 'Customer'
            : msg.sender === 'agent' ? ((msg.author_key ? msg.author_key === (staff?.me ?? meKey) : (msg.metadata?.agent && msg.metadata.agent === user.username)) ? 'You' : (msg.author || 'Team'))
            : msg.sender === 'system' ? `${supportLabel(activeConv?.site_name || activeConv?.panel_name)} · System`
            : supportLabel(activeConv?.site_name || activeConv?.panel_name)}
        </span>
        {!mine || readOnly ? bubble : (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.25rem', maxWidth: '100%' }}>
            {isEditing && editing ? (
              <MessageEditor
                value={editing.text}
                original={messageText(msg)}
                hasFiles={files.length > 0}
                channel={activeConv?.source === 'email' ? 'email' : 'chat'}
                saving={editing.saving}
                error={editing.error}
                onChange={text => setEditing(e => (e ? { ...e, text } : e))}
                onCancel={() => setEditing(null)}
                onSave={saveEdit}
              />
            ) : (
              <>
                {bubble}
                <MessageActions
                  msg={msg}
                  open={menu?.id === msg.id}
                  up={!!menu?.up}
                  canChange={canChangeMessage(user, msg)}
                  onToggle={button => toggleMenu(msg.id, button)}
                  onEdit={() => startEdit(msg)}
                  onDelete={() => { setMenu(null); setDeleting({ id: msg.id, busy: false, error: '' }); }}
                  onCopy={() => copyMessage(msg)}
                  onDetails={() => openDetails(msg.id)}
                />
              </>
            )}
          </div>
        )}
        {withheld && !deleted && (
          <span style={{
            fontSize: '0.625rem', color: '#b45309', background: '#fffbeb',
            border: '1px solid #fde68a', borderRadius: 4, padding: '1px 6px', marginTop: '0.25rem',
          }}>
            Not sent — {WITHHELD_LABELS[withheld] ?? 'held for you'}
          </span>
        )}
        {!deleted && msg.sender === 'ai' && Array.isArray(msg.brain) && msg.brain.length > 0 && (
          // Which of Chikki's notes the reply used: one small chip, the list opens on a click
          // (it was a long line under every AI reply; owner, 2026-10-01).
          <details style={{ fontSize: '0.625rem', color: 'var(--fg-muted)', marginTop: '0.25rem', maxWidth: '32rem' }}>
            <summary title="Chikki's notes used for this reply" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px', borderRadius: 999, background: 'var(--muted)' }}>
              🤖 Chikki · {msg.brain.length} note{msg.brain.length === 1 ? '' : 's'}
            </summary>
            <div style={{ marginTop: 4, lineHeight: 1.5 }}>{msg.brain.map((n) => n.title).join(' · ')}</div>
          </details>
        )}
        <span style={{ fontSize: '0.625rem', color: 'var(--fg-muted)', marginTop: '0.25rem' }}>
          {new Date(msg.created_at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
          {msg.edited_at && !deleted && (
            <span title={`Edited by ${msg.edited_by || 'unknown'}, ${fullDate(msg.edited_at)}`}> · Edited</span>
          )}
          {deleted && ` · Deleted${msg.deleted_by ? ` by ${msg.deleted_by}` : ''}`}
        </span>
      </div>
    );
  };

  return (
    // The inbox is a full-screen app: the page itself never scrolls, each column does. On a
    // short screen the sidebar used to run past the bottom, which made the whole page scroll:
    // the list's header went off the top and a blank strip showed at the bottom (owner, 2026-10-01).
    <div className="admin-layout" style={{ height: '100dvh', minHeight: 0, overflow: 'hidden' }}>
      {/* ── Sidebar ── (a slide-in menu below 1024px, as in the admin panel) */}
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar chat-side ${sidebarOpen ? 'open' : ''}`}>
        <div style={{ padding: '1rem', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--primary)', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
            <MessageCircle size={15} /> Chat Support
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--fg-muted)', marginTop: '0.25rem' }}>
            {unreadTotal > 0 ? `${unreadTotal} waiting for an answer` : 'Chat and email in one place'}
          </div>
        </div>

        {/* Panel selector */}
        <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)' }}>
          <label style={{ fontSize: '0.7rem', color: 'var(--fg-muted)', fontWeight: 600 }}>PANEL</label>
          <select
            value={activePanelId}
            onChange={e => {
              setActivePanelId(e.target.value);
              localStorage.setItem('active_panel_id', e.target.value);
              setActiveId(null);
              setSidebarOpen(false);
            }}
            style={{ width: '100%', marginTop: '0.25rem', padding: '0.375rem', borderRadius: 6, border: '1px solid var(--border)', fontSize: '0.8125rem', background: 'var(--card-bg)', color: 'var(--fg)' }}
          >
            <option value="">All panels</option>
            {businesses
              .filter(b => !user.businessIds || user.businessIds.includes(b.id))
              .map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>

        {/* Status filters: they scroll inside the sidebar when the screen is short, so the
            panel picker stays on top and Back to Orders / Sign out stay at the bottom. */}
        <nav style={{ padding: '0.5rem', flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {INBOX_TABS.filter(s => s.v !== 'mine' || canReply).map(s => (
            <button
              key={s.v}
              onClick={() => { setTab(s.v); setSearchInput(''); setSearchQ(''); setActiveId(null); setSidebarOpen(false); }}
              className={`nav-btn ${tab === s.v ? 'active' : ''}`}
              style={{ width: '100%' }}
            >
              <s.icon size={16} />
              <span style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>{s.label}</span>
              {s.v.startsWith('case:') && (caseCounts[s.v.slice(5)]?.total ?? 0) > 0 && (() => {
                const c = caseCounts[s.v.slice(5)];
                return (
                  <span title={`${c.total} chat${c.total === 1 ? '' : 's'}${c.unread ? `, ${c.unread} waiting for an answer` : ''}`} style={{
                    fontSize: '0.625rem', fontWeight: 700, padding: '1px 6px', borderRadius: 9999, flexShrink: 0,
                    background: c.unread ? '#fee2e2' : 'var(--bg-subtle, rgba(0,0,0,0.06))', color: c.unread ? '#b91c1c' : 'var(--fg-muted)',
                  }}>{c.unread ? `${c.unread} waiting` : c.total}</span>
                );
              })()}
              {s.v === 'mine' && myChats.open > 0 && (
                // My chats: how many open chats this login holds; red while any customer waits.
                <span title={`${myChats.open} open chat${myChats.open === 1 ? '' : 's'} you hold${myChats.waiting ? `, ${myChats.waiting} waiting for an answer` : ''}`} style={{
                  fontSize: '0.625rem', fontWeight: 700, padding: '1px 6px', borderRadius: 9999, flexShrink: 0,
                  background: myChats.waiting ? '#fee2e2' : 'var(--bg-subtle, rgba(0,0,0,0.06))', color: myChats.waiting ? '#b91c1c' : 'var(--fg-muted)',
                }}>{myChats.open}</span>
              )}
            </button>
          ))}

          {/* What the customers are upset about: open chats only, so each queue stays short. The
              list folds away (remembered) so the menu stays short; At risk shows even folded. */}
          <button type="button" onClick={() => setTopicsOpen(!topicsShown)} aria-expanded={topicsShown}
            style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 6, padding: '0.75rem 0.75rem 0.25rem', border: 'none', background: 'none', cursor: 'pointer',
              fontSize: '0.625rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>
            <span style={{ flex: 1, textAlign: 'left' }}>Problem type</span>
            {!topicsShown && (topicCounts.risk ?? 0) > 0 && (
              <span style={{ fontSize: '0.625rem', fontWeight: 700, padding: '1px 6px', borderRadius: 9999, background: '#fee2e2', color: '#b91c1c', letterSpacing: 0, textTransform: 'none' }}>{topicCounts.risk} at risk</span>
            )}
            <ChevronDown size={13} style={{ transition: 'transform .15s', transform: topicsShown ? 'rotate(180deg)' : 'none' }} />
          </button>
          {topicsShown && INBOX_TOPICS.map(t => {
            const Icon = TOPIC_ICONS[t.key] || Inbox;
            const n = topicCounts[t.key] ?? 0;
            const id = `topic:${t.key}` as InboxTab;
            return (
              <button
                key={id}
                title={t.hint}
                onClick={() => { setTab(id); setSearchInput(''); setSearchQ(''); setActiveId(null); setSidebarOpen(false); }}
                className={`nav-btn ${tab === id ? 'active' : ''}`}
                style={{ width: '100%' }}
              >
                <Icon size={16} style={t.key === 'risk' && n > 0 ? { color: '#dc2626' } : undefined} />
                <span style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>{t.label}</span>
                {n > 0 && (
                  <span style={{
                    fontSize: '0.625rem', fontWeight: 700, padding: '1px 6px', borderRadius: 9999, flexShrink: 0,
                    background: t.key === 'risk' ? '#fee2e2' : 'var(--bg-subtle, rgba(0,0,0,0.06))',
                    color: t.key === 'risk' ? '#b91c1c' : 'var(--fg-muted)',
                  }}>{n}</span>
                )}
              </button>
            );
          })}
        </nav>

        <div style={{ marginTop: 'auto', padding: '0.75rem', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
          {/* Who is signed in: their name and role; opens My profile (Login & security for the owner). */}
          {user && (
            <button type="button" className="nav-btn" onClick={() => setMeOpen(true)} style={{ width: '100%', marginBottom: '0.25rem' }}
              title={user.role === 'admin' ? 'Login & security' : 'My profile'}>
              <UserCheck size={16} />
              <span style={{ flex: 1, minWidth: 0, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.displayName}</span>
              <span style={{ fontSize: '0.625rem', fontWeight: 700, color: 'var(--fg-muted)' }}>
                {user.role === 'admin' ? 'Owner' : (ROLE_INFO[user.role as Exclude<Role, 'admin'>]?.label ?? user.role)}
              </span>
            </button>
          )}
          <button className="nav-btn" onClick={() => router.push('/admin')} style={{ width: '100%' }}>
            <ShoppingBag size={16} /> Back to Orders
          </button>
          <button className="nav-btn" onClick={logout} style={{ width: '100%', marginTop: '0.25rem' }}>
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="main-content chat-main">
        {alert && (
          <div className={`toast toast-${alert.type}`} style={{ position: 'fixed', top: '1rem', right: '1rem', zIndex: 9999 }}>
            {alert.type === 'success' ? <Check size={16} /> : <AlertCircle size={16} />}
            {alert.message}
          </div>
        )}

        {/* Top bar below 1024px, where the sidebar is a slide-in menu */}
        <div className="mobile-header">
          <button type="button" className="btn-icon" aria-label="Open menu" onClick={() => setSidebarOpen(true)}>
            <Menu size={20} />
          </button>
          <span className="mobile-header-title">Chat Support</span>
          {unreadTotal > 0 && (
            <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--fg-muted)' }}>{unreadTotal} waiting</span>
          )}
        </div>

        <div className={`chat-shell${activeId ? ' thread-open' : ''}`}>
          {/* Conversation list */}
          <div className="chat-list">
            <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 700, fontSize: '0.875rem' }}>
                {searchActive ? 'Search results' : topicDef ? topicDef.label : mineTab ? 'My chats' : 'Conversations'}
                <span style={{ color: 'var(--fg-muted)', fontWeight: 400, marginLeft: '0.375rem', fontSize: '0.75rem' }}>
                  {listTotal ?? conversations.length}
                </span>
                {urgentCount > 0 && (
                  <span title={`Frustrated customers (${HEALTH_PIN_MIN}%+) and customers waiting ${WAITING_OVERDUE_HOURS} hours or more for an answer, kept at the top until they are answered or Closed`} style={{
                    marginLeft: '0.5rem', fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 700,
                    background: '#fee2e2', color: '#b91c1c',
                  }}>
                    {urgentCount} need attention
                  </span>
                )}
              </div>
              <div style={{ position: 'relative', marginTop: '0.5rem' }}>
                <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--fg-muted)', pointerEvents: 'none' }} />
                <input
                  className="chat-search"
                  type="search"
                  value={searchInput}
                  onChange={e => setSearchInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Escape') { setSearchInput(''); setSearchQ(''); } }}
                  placeholder="Search name, phone, order ID or message"
                  aria-label="Search chats"
                  maxLength={80}
                  autoComplete="off"
                  style={{
                    width: '100%', padding: '0.4375rem 1.875rem 0.4375rem 1.875rem', borderRadius: 8,
                    border: '1px solid var(--border)', background: 'var(--card-bg)', color: 'var(--fg)',
                  }}
                />
                {searchInput && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => { setSearchInput(''); setSearchQ(''); }}
                    style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--fg-muted)', display: 'flex', padding: 4 }}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              {!searchActive && tab !== 'resolved' && (
                <div style={{ display: 'flex', gap: 6, marginTop: '0.5rem' }} role="group" aria-label="Show chats">
                  {([false, true] as const).map((only) => (
                    <button
                      key={only ? 'unread' : 'all'}
                      type="button"
                      aria-pressed={unreadOnly === only}
                      onClick={() => setUnreadOnly(only)}
                      title={only ? 'Chats whose customer still waits for an answer. Chats the AI already answered are not here.' : undefined}
                      style={{
                        padding: '0.25rem 0.75rem', borderRadius: 999, fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer',
                        border: `1px solid ${unreadOnly === only ? 'var(--primary)' : 'var(--border)'}`,
                        background: unreadOnly === only ? 'var(--primary-light)' : 'transparent',
                        color: unreadOnly === only ? 'var(--primary)' : 'var(--fg-muted)',
                      }}
                    >
                      {only ? `Unread${unreadOnly ? ` (${listTotal ?? conversations.length})` : ''}` : 'All'}
                    </button>
                  ))}
                </div>
              )}
              {mineTab && !searchActive && (
                // My chats. The Super Admin's own replies make chats his (owner answer Q2), so the team
                // can only read them; "Give all N to the team" lets go of every one at once (owner answer 3).
                <div style={{ marginTop: '0.5rem', fontSize: '0.6875rem', color: 'var(--fg-muted)' }}>
                  <div>Chats you hold in Needs you and With team{myChats.waiting > 0 ? ` · ${myChats.waiting} waiting for an answer` : ''}</div>
                  {/* N = what the release frees (every open chat he holds, AI handling and Refund / Ship
                      again too), not the customers counted above; shown while he has chats here (owner answer 3). */}
                  {isSuperAdmin(user) && myChats.open > 0 && myChats.held > 0 && (release === null ? (
                    <button type="button" className="btn btn-outline btn-sm" onClick={() => setRelease('ask')}
                      title="Every open chat you hold goes back to the open pool: the next team member to reply or press Take over gets it"
                      style={{ marginTop: '0.375rem', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <UsersRound size={13} /> Give all {myChats.held} to the team
                    </button>
                  ) : (
                    <div role="group" aria-label="Give all your chats to the team" style={{
                      marginTop: '0.375rem', border: '1px solid var(--border)', borderRadius: 8, padding: '0.5rem 0.625rem',
                      background: 'var(--bg-subtle, rgba(0,0,0,0.03))',
                    }}>
                      <div style={{ color: 'var(--fg)', fontSize: '0.75rem', marginBottom: '0.375rem' }}>
                        Give every open chat you hold back to the team? Each one stays in its list with nobody holding it,
                        and the next team member to reply or press Take over gets it. Customers are not told anything.
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button type="button" className="btn btn-primary btn-sm" disabled={release === 'busy'} onClick={releaseAll}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          {release === 'busy' ? <><Loader2 size={13} style={{ animation: 'spin 0.6s linear infinite' }} /> Giving them back…</> : 'Yes, give them to the team'}
                        </button>
                        <button type="button" className="btn btn-outline btn-sm" disabled={release === 'busy'} onClick={() => setRelease(null)}>Cancel</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {caseKey && !searchActive && (() => {
                // Who marked how many, per day (India time), last 14 days: for the owner's experts.
                const days = Array.from(new Set(caseSummary.map((r) => r.day)));
                const total = caseSummary.reduce((n, r) => n + r.n, 0);
                const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
                const fmt = (d: string) => d === today ? 'Today' : new Date(`${d}T00:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
                return (
                  <div style={{ marginTop: '0.5rem', border: '1px solid var(--border)', borderRadius: 8, padding: '0.5rem 0.625rem', fontSize: '0.75rem', maxHeight: 180, overflowY: 'auto' }}>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>
                      Marked for {CASE_LABELS[caseKey]} · last 14 days: {total}
                    </div>
                    {!days.length && <div style={{ color: 'var(--fg-muted)' }}>Nothing marked yet.</div>}
                    {days.map((d) => (
                      <div key={d} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '2px 0' }}>
                        <span style={{ minWidth: 52, color: 'var(--fg-muted)' }}>{fmt(d)}</span>
                        {caseSummary.filter((r) => r.day === d).map((r) => (
                          <span key={r.marked_by} style={{ fontWeight: 600 }}>{r.marked_by} {r.n}</span>
                        ))}
                      </div>
                    ))}
                    <div style={{ color: 'var(--fg-muted)', marginTop: 4, fontSize: '0.6875rem' }}>
                      {caseKey === 'reship'
                        // Owner 2026-10-02: Chikki marks Ship again by itself for a fake / invalid tracking claim.
                        ? `Marked by your team: internal only, the customer is not told, the AI does not reply. Marked by ${AUTO_MARK_NAME}: the customer was promised a new tracking link within 24-48 hours, and Chikki only reminds them once (a chat moved in the one-time move of 2 Oct got no message: its customer's next question about the link gets that line). A red one also shows in Needs you.`
                        // Owner 2026-10-02: Chikki marks Refund by itself for a threat after the delivery date.
                        : `Marked by your team: internal only, customers are never told; these chats show only here and the AI does not reply in them. Marked by ${AUTO_MARK_NAME}: the customer was told their refund is being processed and that a refund form will come in this chat; only the Super Admin sends it (Send refund form) and closes the chat.`}
                    </div>
                  </div>
                );
              })()}
              {searchActive && (
                <div style={{ marginTop: '0.375rem', fontSize: '0.6875rem', color: 'var(--fg-muted)' }}>
                  In all chats{activePanelId ? ` of ${businesses.find(b => b.id === activePanelId)?.name || 'this panel'}` : ''}, including Closed ones and visitors.
                </div>
              )}
            </div>

            <div style={{ flex: 1, overflowY: 'auto' }}>
              {loadingList && conversations.length === 0 && (
                <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--fg-muted)' }}>
                  <Loader2 size={20} style={{ animation: 'spin 0.6s linear infinite' }} />
                </div>
              )}

              {!loadingList && conversations.length === 0 && (
                <div style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--fg-muted)', fontSize: '0.8125rem' }}>
                  <Inbox size={28} style={{ opacity: 0.25, marginBottom: '0.5rem' }} />
                  {caseKey && !searchActive ? (
                    <>
                      <p>No chats marked for {CASE_LABELS[caseKey]}{unreadOnly ? ' waiting for an answer' : ''}.</p>
                      <p style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                        Open a verified customer&apos;s chat and press {CASE_LABELS[caseKey]} at the top. It moves here and leaves every other list.
                      </p>
                    </>
                  ) : unreadOnly && statusFilter !== 'resolved' && !searchActive ? (
                    <p>Nobody here is waiting for an answer.</p>
                  ) : mineTab && !searchActive ? (
                    <>
                      <p>No chats are yours right now.</p>
                      <p style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                        A chat becomes yours when you reply or press Take over on one nobody has, or when someone transfers it to you.
                      </p>
                    </>
                  ) : topicDef && !searchActive ? (
                    <>
                      <p>No open chats under “{topicDef.label}”.</p>
                      <p style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                        {topicDef.hint}. Closed chats are under Closed, or find them with the search box.
                      </p>
                    </>
                  ) : searchActive ? (
                    <>
                      <p>No chats found for “{searchQ}”.</p>
                      <p style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                        Try the order ID, the phone number or the customer&apos;s name. Closed chats and visitors are searched too.
                      </p>
                    </>
                  ) : segment === 'customers' ? (
                    <>
                      <p>No customers here yet.</p>
                      <p style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                        Chats from people who have not proved an order, and whose number is on no order, are under Visitors.
                      </p>
                    </>
                  ) : (
                    <>
                      <p>Nothing here yet.</p>
                      <p style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                        Chats from the widget and email to a connected mailbox both land here.
                      </p>
                    </>
                  )}
                </div>
              )}

              {conversations.map(c => (
                <button
                  key={c.id}
                  onClick={() => openConversation(c.id)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                    padding: '0.75rem 1rem', border: 'none',
                    borderBottom: '1px solid var(--border)',
                    borderLeft: isActiveRow(c) ? '3px solid var(--primary)'
                      : c.health_pinned && !isVisitorChat(c) && c.health_score != null ? `3px solid ${healthLevel(c.health_score).bar}`
                      : (c.waiting_overdue || c.urgent_waiting) && !isVisitorChat(c) ? '3px solid #f59e0b' : '3px solid transparent',
                    background: isActiveRow(c) ? 'var(--primary-light)' : 'transparent',
                  }}
                >
                  {(() => {
                    // One row, fewer badges (owner, 2026-10-01): who and when; what it is about and ONE
                    // status; the last message; and only when something needs attention, a short line
                    // of chips. Verified / phone match is a small icon (the Customers tab says it too).
                    const customer = !isVisitorChat(c);
                    const open = c.status !== 'resolved';
                    const upset = customer && open && c.health_score != null && c.health_score >= 50;
                    const elsewhere = !!c.group_needs_human && c.status !== 'human_needed';
                    // Who holds it (chat team): "You", their name, or "Team" when nobody does (a key no
                    // longer on the team counts as nobody, as on the server).
                    const holderKey = c.assigned_to || null;
                    const rowHolderIsMe = !!holderKey && holderKey === meKey;
                    const rowHolderName = rowHolderIsMe || !holderKey ? null : team.find(t => t.key === holderKey)?.name ?? null;
                    const pill = elsewhere
                      ? { text: STATUS_LABELS.human_needed, bg: STATUS_STYLE.human_needed.bg, fg: STATUS_STYLE.human_needed.fg, title: 'An older chat of this customer is waiting for a person' }
                      : c.status === 'agent_handling'
                        ? {
                          text: rowHolderIsMe ? 'You' : rowHolderName || 'Team', bg: STATUS_STYLE.agent_handling.bg, fg: STATUS_STYLE.agent_handling.fg,
                          title: rowHolderIsMe ? 'With you' : rowHolderName ? `With ${rowHolderName}` : 'With the team; nobody holds it yet (the next reply makes it theirs)',
                        }
                        : { text: closedInfo(c)?.short ?? STATUS_LABELS[c.status], bg: STATUS_STYLE[c.status]?.bg, fg: STATUS_STYLE[c.status]?.fg, title: undefined };
                    // Any other status: who it is for ("For you" / "For Rahul"); a Closed one goes back
                    // to them if the customer writes again.
                    const forChip = (rowHolderIsMe || rowHolderName) && (c.status !== 'agent_handling' || elsewhere)
                      ? (rowHolderIsMe ? 'For you' : `For ${rowHolderName}`) : null;
                    const about = c.subject_label ? displaySubjectLabel(c.subject_label) : (CATEGORY_LABELS[c.category] || '');
                    const aboutColor = c.subject_label ? subjectStyle(c.subject_label).fg : 'var(--fg-muted)';
                    const threat = customer && open && c.health_threat;
                    const accuse = customer && open && !c.health_threat && c.health_accuse;
                    const attention = !!c.case_kind || threat || accuse || upset || (customer && !!c.waiting_since) || !!c.returned;
                    return (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginBottom: 2 }}>
                          {c.source === 'email' ? <Mail size={12} style={{ color: 'var(--fg-muted)', flexShrink: 0 }} /> : <MessageCircle size={12} style={{ color: 'var(--fg-muted)', flexShrink: 0 }} />}
                          <span title={nameNote(c)} style={{ fontWeight: rowUnread(c) > 0 ? 700 : 600, fontSize: '0.8125rem', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontStyle: nameFromOrder(c) ? 'italic' : undefined }}>
                            {convName(c)}
                          </span>
                          {c.verified_order_id
                            ? <span title={`Verified${c.verified_via === 'legacy' ? ' (old check)' : ''}${c.verified_order_id ? ` · order ${c.verified_order_id}` : ''}`} style={{ display: 'inline-flex', flexShrink: 0 }}><BadgeCheck size={13} style={{ color: c.verified_via === 'legacy' ? '#d97706' : 'var(--success)' }} /></span>
                            : c.phone_match_order_id ? <span title={`Phone match · order ${c.phone_match_order_id} (not proof)`} style={{ display: 'inline-flex', flexShrink: 0 }}><Phone size={11} style={{ color: '#2563eb' }} /></span> : null}
                          <span style={{ marginLeft: 'auto', fontSize: '0.625rem', color: 'var(--fg-muted)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                            {timeAgo(c.last_message_at)}{searchActive ? matchedText(c) : ''}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginBottom: 2, minWidth: 0 }}>
                          <span title={c.subject_summary || about} style={{ flex: 1, minWidth: 0, fontSize: '0.6875rem', fontWeight: 600, color: aboutColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {showPanelName ? `${c.panel_name || c.site_name} · ` : ''}{about}{(c.thread_count ?? 0) > 1 ? ` · ${c.thread_count} chats` : ''}
                          </span>
                          <span title={pill.title} style={{ fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600, flexShrink: 0, background: pill.bg, color: pill.fg, maxWidth: '9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pill.text}</span>
                          {forChip && (
                            <span title={c.status === 'resolved' ? (holderKey === 'owner' ? 'If the customer writes again, it goes to the open pool' : `If the customer writes again, it goes to ${rowHolderIsMe ? 'you' : rowHolderName}`) : `${rowHolderIsMe ? 'You have' : `${rowHolderName} has`} this chat`} style={{
                              fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600, flexShrink: 0, maxWidth: '8rem',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              background: rowHolderIsMe ? 'var(--primary-light)' : 'var(--bg-subtle, rgba(0,0,0,0.05))', color: rowHolderIsMe ? 'var(--primary)' : 'var(--fg-muted)',
                            }}>{forChip}</span>
                          )}
                          {rowUnread(c) > 0 && (
                            <span title={rowWaiting(c) ? `${rowUnread(c)} new message${rowUnread(c) === 1 ? '' : 's'}; the customer is waiting for an answer` : `${rowUnread(c)} new message${rowUnread(c) === 1 ? '' : 's'}, already answered`}
                              style={{ background: rowWaiting(c) ? 'var(--danger)' : 'var(--muted, #e5e7eb)', color: rowWaiting(c) ? '#fff' : 'var(--fg-muted)', borderRadius: 9999, fontSize: '0.625rem', padding: '1px 6px', fontWeight: 700, flexShrink: 0 }}>
                              {rowUnread(c)}
                            </span>
                          )}
                        </div>
                        {searchActive && c.match_snippet ? (
                          <div style={{
                            fontSize: '0.75rem', color: 'var(--fg-muted)', overflow: 'hidden', wordBreak: 'break-word',
                            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                          }}>
                            {highlightText(c.match_snippet.replace(/\s+/g, ' '), searchTerm, `r${c.id}`)}
                          </div>
                        ) : (
                          <div style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {c.last_message || '—'}
                          </div>
                        )}
                        {attention && (
                          <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.3125rem' }}>
                            {c.case_kind && <CaseChip kind={c.case_kind} by={c.case_marked_by} at={c.case_marked_at} status={c.status} role={c.case_mark_role} />}
                            {threat && (
                              <span title="This customer has threatened a chargeback, police, court or bad reviews" style={{ fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 700, background: '#fee2e2', color: '#b91c1c', whiteSpace: 'nowrap' }}>Threat</span>
                            )}
                            {accuse && (
                              <span title="This customer has called the store a fraud, scam or fake" style={{ fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 700, background: '#fee2e2', color: '#b91c1c', whiteSpace: 'nowrap' }}>Fraud claim</span>
                            )}
                            {upset && !threat && !accuse && <HealthBadge score={c.health_score} reason={c.health_reason} />}
                            {customer && c.waiting_since && <WaitingChip since={c.waiting_since} />}
                            {c.returned && <CameBackChip closedAt={c.auto_closed_at} />}
                          </div>
                        )}
                      </>
                    );
                  })()}
                </button>
              ))}
              {listTotal !== null && conversations.length > 0 && conversations.length < listTotal && (
                <div style={{ padding: '0.75rem 1rem', textAlign: 'center', fontSize: '0.75rem', color: 'var(--fg-muted)' }}>
                  Showing {conversations.length} of {listTotal}
                  {listLimit < 1000 ? (
                    <button type="button" className="btn btn-outline btn-sm" style={{ marginLeft: '0.5rem' }} disabled={loadingList}
                      onClick={() => setListLimit((l) => Math.min(l + 200, 1000))}>
                      Show {Math.min(200, listTotal - conversations.length)} more
                    </button>
                  ) : (
                    <span> · the newest 1000 are shown; search by name, phone or order for older ones</span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Thread */}
          <div className="chat-thread">
            {!activeConv && !activeId && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-muted)' }}>
                <MessageCircle size={40} style={{ opacity: 0.2, marginBottom: '0.75rem' }} />
                <p style={{ fontWeight: 600 }}>Pick a conversation</p>
                <p style={{ fontSize: '0.8125rem' }}>Chats and emails both appear on the left.</p>
              </div>
            )}

            {!activeConv && activeId && (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-muted)' }}>
                <Loader2 size={20} style={{ animation: 'spin 0.6s linear infinite' }} />
              </div>
            )}

            {activeConv && (
              <>
                {/* Thread header */}
                <div style={{ padding: '0.875rem 1.25rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                  <button type="button" className="btn-icon chat-back" aria-label="Back to conversations" onClick={closeConversation}>
                    <ChevronLeft size={20} />
                  </button>
                  {/* Counts as 7rem when the header decides what fits on its first line: on a phone a
                      wide actions group (the read-only label, Take / Transfer) then wraps to its own
                      line instead of squeezing the customer's name to a few pixels. */}
                  <div style={{ minWidth: 0, flex: '1 1 7rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <span title={nameNote(activeConv)} style={{ fontWeight: 700, fontStyle: nameFromOrder(activeConv) ? 'italic' : undefined }}>{convName(activeConv)}</span>
                      {nameFromOrder(activeConv) && (
                        <span style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)' }}>(from order)</span>
                      )}
                      <span style={{
                        fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600,
                        display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
                        background: 'var(--primary-light)', color: 'var(--primary)',
                      }}>
                        {activeConv.source === 'email' ? <><Mail size={10} /> Email</> : <><MessageCircle size={10} /> Chat</>}
                      </span>
                      <span title={staff?.holder && holderAway ? `${staff.holder.name} has not been in ShipTrack for ${minutesText(staff.holder.away_min ?? 0)}` : undefined} style={{
                        fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600,
                        background: STATUS_STYLE[activeConv.status]?.bg, color: STATUS_STYLE[activeConv.status]?.fg,
                      }}>
                        {activeConv.status === 'agent_handling' ? withText : STATUS_LABELS[activeConv.status]}
                      </span>
                      {forText && (
                        <span title={activeConv.status === 'resolved' ? (staff?.holder?.key === 'owner' ? 'If the customer writes again, it goes to the open pool' : 'If the customer writes again, it goes to them') : undefined} style={{
                          fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600,
                          background: holderIsMe ? 'var(--primary-light)' : 'var(--bg-subtle, rgba(0,0,0,0.05))', color: holderIsMe ? 'var(--primary)' : 'var(--fg-muted)',
                        }}>
                          {forText}
                        </span>
                      )}
                      {activeVerifiedOrder ? <VerifiedBadge orderId={activeVerifiedOrder} via={activeVerifiedVia} />
                        : activePhoneMatch ? <PhoneMatchBadge orderId={activePhoneMatch} /> : null}
                      {activeWaiting && <WaitingChip since={activeWaiting} big />}
                      {activeConv.auto_closed_at && activeConv.status !== 'resolved' && <CameBackChip closedAt={activeConv.auto_closed_at} big />}
                      {closedInfo(activeConv) && (
                        <span title={closedInfo(activeConv)!.title} style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)' }}>
                          {closedInfo(activeConv)!.long}
                        </span>
                      )}
                    </div>
                    {activeOrder && <OrderLine facts={activeOrder} />}
                    {activeAddress && activeConv && (
                      <AddressLine address={activeAddress} editable={addressEditable}
                        onEdit={() => setAddrEdit({ convId: activeConv.id, busy: false, error: '' })} />
                    )}
                    <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginTop: '0.125rem', display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
                      <span>{activeConv.panel_name || activeConv.site_name}</span>
                      {activeConv.visitor_phone && (
                        <>
                          <span>·</span>
                          <a href={`tel:${activeConv.visitor_phone}`} style={{ color: 'var(--primary)', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                            <Phone size={10} /> {activeConv.visitor_phone}
                          </a>
                        </>
                      )}
                    </div>
                  </div>

                  {canReply && (
                    // May shrink (minWidth 0) so that, with Take from X and Transfer added, a narrow
                    // thread wraps the buttons onto a second row instead of pushing them off screen.
                    <div style={{ display: 'flex', gap: '0.375rem', flexShrink: 1, minWidth: 0, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center' }}>
                      {/* Refund / Ship again: verified customers only; internal, the customer is told nothing */}
                      {canCases && !isVisitorChat(activeConv) && (activeConv.case_kind ? (
                        <>
                          <CaseChip kind={activeConv.case_kind} by={activeConv.case_marked_by} at={activeConv.case_marked_at} status={activeConv.status} role={activeConv.case_mark_role} big />
                          <button className="btn btn-outline btn-sm" title="Take it out of this list: the chat goes back to where it was" onClick={() => markCase(null)}>Remove</button>
                          {activeConv.case_kind === 'refund' && isSuperAdmin(user) && threadRefund?.id === activeConv.id && threadRefund.state && (
                            <RefundFormControl token={token} conversationId={activeConv.id} state={threadRefund.state} onChanged={() => fetchThread(activeConv.id, true)} onAlert={showAlert}
                              label={supportLabel(activeConv.site_name || activeConv.panel_name)} />
                          )}
                        </>
                      ) : (
                        <>
                          {/* Who may mark is the server's call (staff.can_mark_case: a senior or Super Admin;
                              a junior only while every senior is away). Off: the reason on hover. */}
                          {staff?.mark_override && staff.mark_note && (
                            <span style={{ fontSize: '0.6875rem', fontWeight: 600, padding: '2px 8px', borderRadius: 9999, background: '#fef3c7', color: '#b45309' }}>
                              {staff.mark_note}
                            </span>
                          )}
                          <button className="btn btn-outline btn-sm" disabled={!staff?.can_mark_case}
                            title={staff?.can_mark_case ? 'Mark this customer for a refund. Internal only: the customer is not told.' : (staff?.mark_note || undefined)}
                            onClick={() => markCase('refund')}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Undo2 size={13} /> Refund</button>
                          <button className="btn btn-outline btn-sm" disabled={!staff?.can_mark_case}
                            title={staff?.can_mark_case ? 'Mark this order to be shipped again. Internal only: the customer is not told.' : (staff?.mark_note || undefined)}
                            onClick={() => markCase('reship')}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Truck size={13} /> Ship again</button>
                        </>
                      ))}
                      {/* Take over, Take from X, Transfer, Hand to AI, Close: only what the server says this
                          login may do on this chat (staff). Someone else's chat: read only, with their name. */}
                      {staff && (staff.can_act || staff.take) ? (
                        <>
                          {activeConv.status !== 'agent_handling' && staff.can_act && (
                            <button className="btn btn-primary btn-sm" onClick={() => changeStatus('agent_handling')}
                              title={staff.claims ? 'This chat becomes yours' : undefined}>Take over</button>
                          )}
                          {staff.take && staff.holder && (
                            <button className={`btn btn-sm ${staff.can_act ? 'btn-outline' : 'btn-primary'}`} onClick={() => changeStatus('agent_handling', true)}
                              title={staff.take === 'holder_away'
                                ? `${staff.holder.name} has not been in ShipTrack for a while and the customer is waiting: this chat becomes yours`
                                : `This chat becomes yours (${staff.holder.name} has it now)`}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <Hand size={13} /> {takeLabel}
                            </button>
                          )}
                          {staff.transfer_to.length > 0 && activeConv.status !== 'resolved' && (
                            <button className="btn btn-outline btn-sm" onClick={() => setTransferEdit({ convId: activeConv.id, busy: false, error: '' })}
                              title="Give this chat to someone else, with a one-line note for the team"
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><ArrowRightLeft size={13} /> Transfer</button>
                          )}
                          {/* Hot chat (hot_lock, owner 2026-10-02): a member sees both off; why is the line below. */}
                          {activeConv.status === 'agent_handling' && !activeConv.case_kind && staff.can_act && (
                            <button className="btn btn-outline btn-sm" disabled={!!hotLock && !hotLock.can_hand_to_ai}
                              title={hotLock && !hotLock.can_hand_to_ai && hotLock.lock_reason ? hotLock.lock_reason : undefined}
                              onClick={() => changeStatus('ai_handling')}>Hand to AI</button>
                          )}
                          {activeConv.status !== 'resolved' && staff.can_act && (
                            <button className="btn btn-outline btn-sm" disabled={!!hotLock && !hotLock.can_close}
                              title={hotLock && !hotLock.can_close && hotLock.lock_reason ? hotLock.lock_reason : undefined}
                              onClick={() => changeStatus('resolved')}>Close</button>
                          )}
                        </>
                      ) : staff ? (
                        <span title={staff.holder ? `Ask ${staff.holder.owner ? 'Super Admin' : `${staff.holder.name} or Super Admin`} to transfer it to you` : undefined}
                          style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
                          <Lock size={12} /> {readOnlyText}
                        </span>
                      ) : null}
                    </div>
                  )}

                  {/* Why Refund / Ship again is off (the server's staff.mark_note), as a small line of its own on
                      every screen size: a phone has no hover (owner answer A6, 2026-10-02). */}
                  {canReply && canCases && !isVisitorChat(activeConv) && !activeConv.case_kind && staff && !staff.can_mark_case && staff.mark_note && (
                    <div style={{ flexBasis: '100%', minWidth: 0, marginTop: '-0.5rem', fontSize: '0.6875rem', color: 'var(--fg-muted)', textAlign: 'right', wordBreak: 'break-word' }}>
                      Refund / Ship again: {staff.mark_note}
                    </div>
                  )}

                  {/* Why Close / Hand to AI are off on a hot chat (the server's hot_lock.lock_reason), the same
                      kind of line, on every screen size: a phone has no hover (owner 2026-10-02). */}
                  {canReply && staff?.can_act && activeConv.status !== 'resolved' && hotLock?.lock_reason && (
                    <div style={{ flexBasis: '100%', minWidth: 0, marginTop: '-0.5rem', fontSize: '0.6875rem', color: 'var(--fg-muted)', textAlign: 'right', wordBreak: 'break-word' }}>
                      <Lock size={10} style={{ verticalAlign: '-1px', marginRight: 3 }} />Close / Hand to AI: {hotLock.lock_reason}
                    </div>
                  )}

                  {/* Chikki's own Refund mark (owner 2026-10-02): the customer was told a refund form will come
                      in this chat, and only the Super Admin sends it. Until a form link or a request exists. */}
                  {canReply && canCases && isSuperAdmin(user) && activeConv.case_kind === 'refund' && activeConv.case_marked_by === AUTO_MARK_NAME
                    && threadRefund?.id === activeConv.id && threadRefund.state && !threadRefund.state.link && !threadRefund.state.request && (
                    <div style={{ flexBasis: '100%', minWidth: 0, marginTop: '-0.5rem', fontSize: '0.6875rem', fontWeight: 600, color: '#b45309', textAlign: 'right', wordBreak: 'break-word' }}>
                      Chikki promised a refund form - press Send refund form
                    </div>
                  )}

                  {/* Subject: the customer's current concern, on its own line across the header */}
                  {activeSubject && (
                    <div title={activeSubject.summary ? `${activeSubject.label}: ${activeSubject.summary}` : activeSubject.label} style={{
                      flexBasis: '100%', minWidth: 0, display: 'flex', alignItems: 'center', gap: '0.5rem',
                      padding: '0.375rem 0.625rem', borderRadius: 8,
                      background: 'var(--bg-subtle, rgba(0,0,0,0.04))', border: '1px solid var(--border)',
                    }}>
                      <span style={{
                        fontSize: '0.6875rem', padding: '2px 8px', borderRadius: 9999, fontWeight: 700,
                        flexShrink: 0, whiteSpace: 'nowrap',
                        background: subjectStyle(activeSubject.label).bg, color: subjectStyle(activeSubject.label).fg,
                      }}>
                        {displaySubjectLabel(activeSubject.label)}
                      </span>
                      {activeSubject.summary && (
                        <span style={{
                          flex: 1, minWidth: 0, fontSize: '0.8125rem', fontWeight: 500, color: 'var(--fg)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {activeSubject.summary}
                        </span>
                      )}
                      {activeSubject.updatedAt && (
                        <span style={{ marginLeft: 'auto', fontSize: '0.625rem', color: 'var(--fg-muted)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                          updated {timeAgo(activeSubject.updatedAt)}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Team only: the last transfer (who to whom, when, the note) and the History of who held
                      the chat. STAFF ONLY and outside the message list, and it cannot be selected, so a
                      note never ends up pasted into a reply: the customer and the AI never see it. */}
                  {(() => {
                    const lastTransfer = teamLog.find(e => e.kind === 'transfer');
                    if (!lastTransfer) return null;
                    const me = staff?.me ?? null;
                    const side = (key: string | null, name: string | null) => (!key ? 'open pool' : me && key === me ? 'You' : name || 'a former member');
                    const line = `${side(lastTransfer.from_owner, lastTransfer.from_name)} → ${side(lastTransfer.to_owner, lastTransfer.to_name)} · ${logTime(lastTransfer.created_at)}${lastTransfer.note ? ` · ${lastTransfer.note}` : ''}`;
                    return (
                      <div style={{
                        flexBasis: '100%', minWidth: 0, fontSize: '0.75rem', padding: '0.375rem 0.625rem', borderRadius: 8,
                        background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', userSelect: 'none', WebkitUserSelect: 'none',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', minWidth: 0 }}>
                          <Lock size={12} style={{ flexShrink: 0 }} />
                          <span title={`Team only: ${line}`} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            <b>Team only</b> · {line}
                          </span>
                          <button type="button" onClick={() => setTeamLogOpen(o => !o)} aria-expanded={teamLogOpen}
                            style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 2, border: 'none', background: 'none', padding: 0, cursor: 'pointer', font: 'inherit', fontWeight: 600, color: 'inherit' }}>
                            History <ChevronDown size={12} style={{ transition: 'transform .15s', transform: teamLogOpen ? 'rotate(180deg)' : 'none' }} />
                          </button>
                        </div>
                        {teamLogOpen && (
                          <ol style={{ listStyle: 'none', margin: '0.375rem 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {teamLog.map(e => (
                              <li key={e.id} style={{ wordBreak: 'break-word' }}>
                                <span style={{ fontVariantNumeric: 'tabular-nums', marginRight: '0.375rem', opacity: 0.8 }}>{logTime(e.created_at)}</span>
                                {teamLogLine(e, me)}{e.note ? ` · “${e.note}”` : ''}
                              </li>
                            ))}
                          </ol>
                        )}
                      </div>
                    );
                  })()}

                  {/* How upset the customer is, right beside Take over / Close */}
                  {activeHealth && (
                    <HealthBar score={activeHealth.score} reason={activeHealth.reason} updatedAt={activeHealth.updatedAt} />
                  )}
                </div>

                {/* Messages */}
                <div ref={threadRef} style={{ flex: 1, overflowY: 'auto', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {hiddenEarlier > 0 && (
                    <div style={{ textAlign: 'center', fontSize: '0.6875rem', color: 'var(--fg-muted)' }}>
                      {hiddenEarlier} older {hiddenEarlier === 1 ? 'chat' : 'chats'} not shown (empty, or before the last 5)
                    </div>
                  )}
                  {earlier.map(block => (
                    <Fragment key={block.conversation_id}>
                      <ThreadDivider>
                        Earlier chat · {new Date(block.created_at).toLocaleDateString([], { day: 'numeric', month: 'short' })}
                        {chatStatusLabel(block.status) ? ` · ${chatStatusLabel(block.status)}` : ''}
                        {' · '}
                        <button type="button" onClick={() => openConversation(block.conversation_id)} style={{
                          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                          font: 'inherit', color: 'var(--primary)',
                        }}>
                          Open
                        </button>
                      </ThreadDivider>
                      {(block.messages || []).map(msg => renderMessage(msg, true))}
                    </Fragment>
                  ))}
                  {earlier.length > 0 && <ThreadDivider>{newerChat ? 'This chat' : 'Latest chat'}</ThreadDivider>}
                  {messages.map(msg => renderMessage(msg))}
                  <div ref={bottomRef} />
                </div>

                {/* The customer wrote in a newer chat: replies here would go to this one. */}
                {newerChat && (
                  <div role="status" style={{
                    borderTop: '1px solid var(--border)', padding: '0.5rem 1rem',
                    display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap',
                    fontSize: '0.75rem', background: 'var(--primary-light)', color: 'var(--fg)',
                  }}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      This customer has a newer chat
                      {(() => {
                        const bits = [chatStatusLabel(newerChat.status), timeAgo(newerChat.last_message_at)].filter(Boolean);
                        return bits.length ? ` (${bits.join(', ')})` : '';
                      })()}. Replies here go to this older chat.
                    </span>
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => openConversation(newerChat.conversation_id)}>
                      Open newer chat
                    </button>
                  </div>
                )}

                {/* Composer */}
                {activeConv.status !== 'resolved' && canReply && (
                  <div
                    ref={composerRef}
                    style={{ borderTop: '1px solid var(--border)', padding: '0.75rem 1rem', position: 'relative' }}
                    onDragEnter={e => {
                      if (!draggingFiles(e)) return;
                      e.preventDefault();
                      dragDepthRef.current += 1;
                      setDragOver(true);
                    }}
                    onDragOver={e => {
                      if (!draggingFiles(e)) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'copy';
                    }}
                    onDragLeave={e => {
                      if (!draggingFiles(e)) return;
                      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
                      if (dragDepthRef.current === 0) setDragOver(false);
                    }}
                    onDrop={e => {
                      if (!draggingFiles(e)) return;
                      e.preventDefault();
                      dragDepthRef.current = 0;
                      setDragOver(false);
                      addFiles(Array.from(e.dataTransfer.files));
                    }}
                  >
                    {dragOver && (
                      <div style={{
                        position: 'absolute', inset: '0.375rem', zIndex: 2, pointerEvents: 'none',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem',
                        border: '1.5px dashed var(--primary)', borderRadius: 'var(--radius-lg)',
                        background: 'var(--primary-light)', color: 'var(--primary)',
                        fontSize: '0.8125rem', fontWeight: 600,
                      }}>
                        <Paperclip size={15} />
                        {replyOpen ? 'Drop file here' : othersChat ? 'Read only: this is not your chat' : 'Take over to attach files'}
                      </div>
                    )}
                    {composerHint && (
                      <p style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginBottom: '0.5rem' }}>
                        {composerHint}
                      </p>
                    )}
                    {pendingFiles.length > 0 && (
                      <div style={{ display: 'flex', gap: '0.5rem', overflowX: 'auto', paddingBottom: '0.5rem', scrollbarWidth: 'thin' }}>
                        {pendingFiles.map(p => (
                          <div key={p.key} style={{
                            position: 'relative', flex: '0 0 auto', width: 210, maxWidth: '100%', overflow: 'hidden',
                            display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.375rem 0.375rem 0.375rem 0.5rem',
                            borderRadius: 'var(--radius)',
                            border: `1px solid ${p.status === 'failed' ? 'var(--danger)' : 'var(--border)'}`,
                            background: p.status === 'failed' ? 'var(--danger-light)' : 'var(--bg-subtle)',
                          }}>
                            {p.previewUrl ? (
                              <img src={p.previewUrl} alt="" style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />
                            ) : (
                              <div style={{
                                width: 36, height: 36, borderRadius: 6, flexShrink: 0,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                background: 'var(--primary-light)', color: 'var(--primary)',
                              }}>
                                <FileText size={18} />
                              </div>
                            )}
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div title={p.name} style={{ fontSize: '0.75rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {p.name}
                              </div>
                              <div title={p.error} style={{
                                fontSize: '0.6875rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                color: p.status === 'failed' ? 'var(--danger)' : 'var(--fg-muted)',
                              }}>
                                {p.status === 'uploading' ? `Uploading… ${p.progress}%`
                                  : p.status === 'failed' ? p.error
                                  : formatFileSize(p.size)}
                              </div>
                            </div>
                            {p.status === 'failed' && (
                              <button type="button" className="btn-icon" title="Try again" aria-label={`Retry ${p.name}`}
                                onClick={() => retryFile(p.key)} style={{ width: 24, height: 24, flexShrink: 0 }}>
                                <RotateCw size={14} />
                              </button>
                            )}
                            <button type="button" className="btn-icon" title="Remove" aria-label={`Remove ${p.name}`}
                              onClick={() => removeFile(p.key)} disabled={sending} style={{ width: 24, height: 24, flexShrink: 0 }}>
                              <X size={14} />
                            </button>
                            {p.status === 'uploading' && (
                              <div style={{
                                position: 'absolute', left: 0, bottom: 0, height: 2,
                                width: `${p.progress}%`, background: 'var(--primary)', transition: 'width 0.2s',
                              }} />
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {composerNotice && (
                      <p role="alert" style={{ fontSize: '0.6875rem', color: 'var(--danger)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <AlertCircle size={12} style={{ flexShrink: 0 }} /> {composerNotice}
                      </p>
                    )}
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        accept={ATTACHMENT_ACCEPT}
                        style={{ display: 'none' }}
                        onChange={e => {
                          addFiles(Array.from(e.target.files || []));
                          e.target.value = '';
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn-outline"
                        title="Attach files — JPG, PNG, WEBP, GIF or PDF, up to 10 MB each"
                        aria-label="Attach files"
                        disabled={!replyOpen || sending || pendingFiles.length >= MAX_ATTACHMENTS_PER_MESSAGE}
                        onClick={() => fileInputRef.current?.click()}
                        style={{ padding: 0, width: '2.5rem', flexShrink: 0 }}
                      >
                        <Paperclip size={16} />
                      </button>
                      <textarea
                        className="form-input"
                        rows={2}
                        placeholder={replyOpen
                          ? (activeConv.source === 'email' ? 'Type your reply — it goes out by email…' : 'Type your reply…')
                          : readOnlyReply || 'Take over to reply…'}
                        value={draft}
                        disabled={!replyOpen || sending}
                        onChange={e => setDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); }
                        }}
                        style={{ flex: 1, height: 'auto', resize: 'vertical', minHeight: 44 }}
                      />
                      <button
                        className="btn btn-primary"
                        disabled={
                          sending || !replyOpen
                          || pendingFiles.some(p => p.status !== 'ready')
                          || (!draft.trim() && pendingFiles.length === 0)
                        }
                        onClick={sendReply}
                      >
                        {sending
                          ? <Loader2 size={16} style={{ animation: 'spin 0.6s linear infinite' }} />
                          : <Send size={16} />}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {deleting && (
          <DeleteMessageDialog
            channel={activeConv?.source === 'email' ? 'email' : 'chat'}
            busy={deleting.busy}
            error={deleting.error}
            onCancel={() => setDeleting(null)}
            onConfirm={confirmDelete}
          />
        )}
        {details && (
          <MessageDetailsDialog details={details.data} error={details.error} onClose={() => setDetails(null)} />
        )}
        {meOpen && user && (user.role === 'admin' ? (
          <OwnerLoginDialog token={token} onAlert={(t, m) => showAlert(t === 'success' ? 'success' : 'error', m)} onClose={() => setMeOpen(false)}
            onLoginChanged={(t, u) => { setToken(t); setUser(u as AuthUser); }} />
        ) : (
          <MyProfile token={token} onAlert={showAlert} onClose={() => setMeOpen(false)}
            onUserChanged={(name) => setUser((u) => (u ? { ...u, displayName: name } : u))} />
        ))}
        {transferEdit && staff && activeConv?.id === transferEdit.convId && (
          <TransferDialog targets={staff.transfer_to} team={team} me={staff.me} busy={transferEdit.busy} error={transferEdit.error}
            onCancel={() => setTransferEdit(null)} onSend={sendTransfer} />
        )}
        {addrEdit && activeAddress && activeConv?.id === addrEdit.convId && (
          <AddressDialog initial={activeAddress} orderId={activeAddress.order_id} busy={addrEdit.busy} error={addrEdit.error}
            onCancel={() => setAddrEdit(null)} onSave={saveAddress} />
        )}
      </main>
    </div>
  );
}
