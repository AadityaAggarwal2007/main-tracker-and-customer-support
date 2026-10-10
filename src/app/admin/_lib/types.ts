/* ═══════════ TYPES ═══════════ */
export interface OrderItem { id: string; brand: string; product_name: string; quantity: number; price: number; }
export interface Order {
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
export interface AuthUser { username: string; displayName: string; role: string; businessIds: string[] | null; permissions?: string[] }
// One CSV upload in the record (upload-logs-panel.sql, owner 2026-10-08).
export interface RecentUpload {
  id: string; filename: string; total_rows: number; new_orders: number; updated_orders: number;
  uploaded_by: string | null; created_at: string; business_id: string | null; panel_name: string | null;
  first_order: string | null; last_order: string | null; warning_text: string | null;
}
export interface Business {
  id: string; name: string; logo_url: string; support_email: string; support_phone: string;
  is_default: boolean; created_at: string; tracking_domain: string | null; primary_color: string | null; origin_city: string | null;
  is_shopify_connected: boolean; shopify_domain: string | null;
}
// A mailbox this panel answers from. The app password is write-only — it is
// sent when connecting and never returned.
// status = the poller's last look at this Gmail (memory only: null right after a restart)
export interface PanelEmailAccount {
  id: string; email: string; created_at: string;
  status?: { checkedAt: number; ok: boolean; error: string | null; lastMailAt: number | null; received: number } | null;
}
// The chat site behind a panel — one row, created the first time chat is used
export interface PanelChatSite {
  id: string; widgetKey: string; aiEnabled: boolean;
  systemPrompt: string | null; codAvailable: boolean | null; codStates: string | null; domain: string; conversations: number;
}
// What deleting a panel would destroy — Tracker rows plus the chat-support site
export interface PanelImpact {
  id: string; name: string; isDefault: boolean;
  isShopifyConnected: boolean; shopifyDomain: string | null;
  orders: number; tickets: number;
  chatSites: number; chatConversations: number; chatMessages: number;
  teamMembers: number; teamMembersLosingAccess: number;
}
export type TabType = 'today' | 'orders' | 'upload' | 'team' | 'settings' | 'score' | 'refunds' | 'mail' | 'chargebacks' | 'whatsapp';
