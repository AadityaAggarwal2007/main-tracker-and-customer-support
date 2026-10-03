'use client';

import { Fragment, useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2, Check, AlertCircle,
  MessageCircle, Inbox,
  Menu,
} from 'lucide-react';
import { can } from '@/lib/permissions';
import { activeHeaders } from '@/lib/presence-client';
import MyProfile from '@/components/MyProfile';
import OwnerLoginDialog from '@/components/OwnerLogin';
import { type RefundThreadState } from '@/components/RefundFormControl';
import { INBOX_TOPICS } from '@/lib/chat/inbox-topics';
import { type OrderAddress } from '@/lib/chat/order-address';
import { AUTO_MARK_NAME } from '@/lib/chat/tracking-claim';
import {
  MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_TOTAL_BYTES,
  TOO_MANY_MESSAGE, TOTAL_TOO_LARGE_MESSAGE, checkBrowserFile,
} from '@/lib/chat/attachment-rules';
import type { AuthUser, Business, Conversation, EarlierChat, NewerChat, ChatMessage, MessageDetails, PendingFile, TeamMember, TransferTarget, StaffBlock, HotLock, TeamLogEntry, InboxTab, OrderFacts, StaffAddress, StaffOrderItems } from './_lib/types';
import { minutesText, POLL_MS, INBOX_TABS, chatStatusLabel, CASE_LABELS, isVisitorChat, timeAgo, draggingFiles } from './_lib/inbox';
import { TransferDialog } from './_components/TransferDialog';
import { ThreadDivider } from './_components/chips';
import { AddressDialog, ItemsDialog } from './_components/OrderLine';
import { ReshipDialog } from './_components/ReshipDialog';
import { DeleteMessageDialog, MessageDetailsDialog } from './_components/MessageTools';
import InboxSidebar from './_components/InboxSidebar';
import ListHeader from './_components/ListHeader';
import ThreadHeader from './_components/ThreadHeader';
import Composer from './_components/Composer';
import MessageRow from './_components/MessageRow';
import ConversationRow from './_components/ConversationRow';

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
  const [orderInfo, setOrderInfo] = useState<{ id: string; facts: OrderFacts | null; address: StaffAddress | null; editable: boolean; items: StaffOrderItems | null; itemsEditable: boolean } | null>(null);
  const [addrEdit, setAddrEdit] = useState<{ convId: string; busy: boolean; error: string } | null>(null);
  const [itemsEdit, setItemsEdit] = useState<{ convId: string; busy: boolean; error: string } | null>(null);
  const [reshipEdit, setReshipEdit] = useState<{ convId: string; busy: boolean; error: string } | null>(null);
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
      setOrderInfo({ id, facts: data.order_facts ?? null, address: data.order_address ?? null, editable: !!data.address_editable, items: data.order_items ?? null, itemsEditable: !!data.items_editable });
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
  useEffect(() => { setTeamLogOpen(false); setTransferEdit(null); setItemsEdit(null); setReshipEdit(null); }, [activeId]);
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
  const activeItems = orderInfo && activeConv && orderInfo.id === activeConv.id ? orderInfo.items : null;
  const itemsEditable = !!activeItems && !!orderInfo?.itemsEditable && can(user, 'orders.update');
  // Ship again: the new parcel was sent (owner 2026-10-03): PATCH .../reship with the link or AWB.
  const saveReship = async (value: string) => {
    if (!reshipEdit || !token) return;
    const convId = reshipEdit.convId;
    setReshipEdit({ ...reshipEdit, busy: true, error: '' });
    try {
      const res = await fetch(`/api/chat/conversations/${convId}/reship`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ awb_or_link: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setReshipEdit({ convId, busy: false, error: data.error || 'Could not save' }); return; }
      setReshipEdit(null);
      showAlert('success', 'Marked reshipped');
      fetchThread(convId, true);
      fetchConversations(true);
    } catch {
      setReshipEdit({ convId, busy: false, error: 'Could not save' });
    }
  };
  // The order's items, like the address: PATCH .../items, ShipTrack only (owner 2026-10-03).
  const saveItems = async (items: { product_name: string; quantity: number; price: number | null }[]) => {
    if (!itemsEdit || !token) return;
    const convId = itemsEdit.convId;
    setItemsEdit({ ...itemsEdit, busy: true, error: '' });
    try {
      const res = await fetch(`/api/chat/conversations/${convId}/items`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ items }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setItemsEdit({ convId, busy: false, error: data.error || 'Could not save the items' }); return; }
      if (data.items) setOrderInfo(prev => prev && prev.id === convId ? { ...prev, items: data.items } : prev);
      setItemsEdit(null);
      showAlert('success', data.unchanged ? 'Nothing changed' : 'Items updated in ShipTrack');
    } catch {
      setItemsEdit({ convId, busy: false, error: 'Could not save the items' });
    }
  };
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

  return (
    // The inbox is a full-screen app: the page itself never scrolls, each column does. On a
    // short screen the sidebar used to run past the bottom, which made the whole page scroll:
    // the list's header went off the top and a blank strip showed at the bottom (owner, 2026-10-01).
    <div className="admin-layout" style={{ height: '100dvh', minHeight: 0, overflow: 'hidden' }}>
      {/* ── Sidebar ── (a slide-in menu below 1024px, as in the admin panel) */}
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
      <InboxSidebar activePanelId={activePanelId} businesses={businesses} canReply={canReply} caseCounts={caseCounts} logout={logout} myChats={myChats} router={router} setActiveId={setActiveId} setActivePanelId={setActivePanelId} setMeOpen={setMeOpen} setSearchInput={setSearchInput} setSearchQ={setSearchQ} setSidebarOpen={setSidebarOpen} setTab={setTab} setTopicsOpen={setTopicsOpen} sidebarOpen={sidebarOpen} tab={tab} topicCounts={topicCounts} topicsShown={topicsShown} unreadTotal={unreadTotal} user={user} />

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
            <ListHeader activePanelId={activePanelId} businesses={businesses} caseKey={caseKey} caseSummary={caseSummary} conversations={conversations} listTotal={listTotal} mineTab={mineTab} myChats={myChats} release={release} releaseAll={releaseAll} searchActive={searchActive} searchInput={searchInput} setRelease={setRelease} setSearchInput={setSearchInput} setSearchQ={setSearchQ} setUnreadOnly={setUnreadOnly} tab={tab} topicDef={topicDef} unreadOnly={unreadOnly} urgentCount={urgentCount} user={user} />

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
                // globals.css .chat-row: the open one is blue; a left stripe marks a pinned frustrated
                // customer (red) or one waiting too long (amber). The inline display / width / text-align
                // stay: the screenshot script finds rows by them.
                <button
                  key={c.id}
                  onClick={() => openConversation(c.id)}
                  className={`chat-row${isActiveRow(c) ? ' active'
                    : c.health_pinned && !isVisitorChat(c) && c.health_score != null ? ' hot'
                    : (c.waiting_overdue || c.urgent_waiting) && !isVisitorChat(c) ? ' late' : ''}`}
                  style={{ display: 'block', width: '100%', textAlign: 'left' }}
                >
                  <ConversationRow c={c} meKey={meKey} rowUnread={rowUnread} rowWaiting={rowWaiting} searchActive={searchActive} searchTerm={searchTerm} showPanelName={showPanelName} team={team} />
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
                <ThreadHeader activeAddress={activeAddress} activeItems={activeItems} itemsEditable={itemsEditable} setItemsEdit={setItemsEdit} setReshipEdit={setReshipEdit} activeConv={activeConv} activeHealth={activeHealth} activeOrder={activeOrder} activePhoneMatch={activePhoneMatch} activeSubject={activeSubject} activeVerifiedOrder={activeVerifiedOrder} activeVerifiedVia={activeVerifiedVia} activeWaiting={activeWaiting} addressEditable={addressEditable} canCases={canCases} canReply={canReply} changeStatus={changeStatus} closeConversation={closeConversation} fetchThread={fetchThread} forText={forText} holderAway={holderAway} holderIsMe={holderIsMe} hotLock={hotLock} markCase={markCase} readOnlyText={readOnlyText} setAddrEdit={setAddrEdit} setTeamLogOpen={setTeamLogOpen} setTransferEdit={setTransferEdit} showAlert={showAlert} staff={staff} takeLabel={takeLabel} teamLog={teamLog} teamLogOpen={teamLogOpen} threadRefund={threadRefund} token={token} user={user} withText={withText} />

                {/* Messages */}
                <div ref={threadRef} className="chat-msgs">
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
                      {(block.messages || []).map(msg => <MessageRow key={msg.id} msg={msg} readOnly activeConv={activeConv} copyMessage={copyMessage} editing={editing} keepThreadPinned={keepThreadPinned} meKey={meKey} menu={menu} messageText={messageText} openDetails={openDetails} saveEdit={saveEdit} searchTerm={searchTerm} setDeleting={setDeleting} setEditing={setEditing} setMenu={setMenu} staff={staff} startEdit={startEdit} toggleMenu={toggleMenu} user={user} />)}
                    </Fragment>
                  ))}
                  {earlier.length > 0 && <ThreadDivider>{newerChat ? 'This chat' : 'Latest chat'}</ThreadDivider>}
                  {messages.map(msg => <MessageRow key={msg.id} msg={msg} activeConv={activeConv} copyMessage={copyMessage} editing={editing} keepThreadPinned={keepThreadPinned} meKey={meKey} menu={menu} messageText={messageText} openDetails={openDetails} saveEdit={saveEdit} searchTerm={searchTerm} setDeleting={setDeleting} setEditing={setEditing} setMenu={setMenu} staff={staff} startEdit={startEdit} toggleMenu={toggleMenu} user={user} />)}
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
                  <Composer activeConv={activeConv} addFiles={addFiles} composerHint={composerHint} composerNotice={composerNotice} composerRef={composerRef} draft={draft} dragDepthRef={dragDepthRef} dragOver={dragOver} fileInputRef={fileInputRef} othersChat={othersChat} pendingFiles={pendingFiles} readOnlyReply={readOnlyReply} removeFile={removeFile} replyOpen={replyOpen} retryFile={retryFile} sendReply={sendReply} sending={sending} setDraft={setDraft} setDragOver={setDragOver} />
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
        {reshipEdit && activeConv?.id === reshipEdit.convId && (
          <ReshipDialog orderId={activeConv.case_order_id || activeConv.verified_order_id || null} busy={reshipEdit.busy} error={reshipEdit.error}
            onCancel={() => setReshipEdit(null)} onSave={saveReship} />
        )}
        {itemsEdit && activeItems && activeConv?.id === itemsEdit.convId && (
          <ItemsDialog initial={activeItems.items} orderId={activeItems.order_id} busy={itemsEdit.busy} error={itemsEdit.error}
            onCancel={() => setItemsEdit(null)} onSave={saveItems} />
        )}
      </main>
    </div>
  );
}
