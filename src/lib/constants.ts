// Canonical 12-day journey stages (see src/lib/journey.ts).
export const TRACKING_STAGES = [
  'Order Placed',
  'Processing',
  'Packed',
  'Shipped',
  'In Transit',
  'Reached State',
  'Reached City',
  'Local Hub',
  'Out for Delivery',
  'Delivered',
] as const;

export const TRACKING_STAGES_WITH_SPECIAL = [
  ...TRACKING_STAGES,
  'Delivery Failed',
  'Stuck',
  'Cancelled',
  'RTO',
] as const;

export type TrackingStatus = (typeof TRACKING_STAGES_WITH_SPECIAL)[number];

export const STAGE_COLORS: Record<string, string> = {
  'Order Placed': '#6366f1',
  'Processing': '#8b5cf6',
  'Packed': '#a855f7',
  'Shipped': '#3b82f6',
  'In Transit': '#0ea5e9',
  'Reached State': '#06b6d4',
  'Reached City': '#14b8a6',
  'Local Hub': '#10b981',
  'Out for Delivery': '#f59e0b',
  'Delivered': '#22c55e',
  'Delivery Failed': '#ef4444',
  'Stuck': '#eab308',
  'Cancelled': '#ef4444',
  'RTO': '#f97316',
};

export const STAGE_ICONS: Record<string, string> = {
  'Order Placed': '📋',
  'Processing': '⚙️',
  'Packed': '📦',
  'Shipped': '🚚',
  'In Transit': '🛣️',
  'Reached State': '📍',
  'Reached City': '📍',
  'Local Hub': '🏢',
  'Out for Delivery': '🏍️',
  'Delivered': '✅',
  'Delivery Failed': '⚠️',
  'Stuck': '⏳',
  'Cancelled': '❌',
  'RTO': '↩️',
};

export const USER_ROLES = ['admin', 'manager', 'viewer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const ROLE_PERMISSIONS: Record<UserRole, string[]> = {
  admin: ['upload_csv', 'update_status', 'manage_team', 'view_orders', 'cancel_order', 'delete_order', 'manage_businesses'],
  manager: ['upload_csv', 'update_status', 'view_orders', 'cancel_order'],
  viewer: ['view_orders'],
};

// Status color CSS class helper (matches globals.css status classes)
export function getStatusColorClass(status: string): string {
  const map: Record<string, string> = {
    'Order Placed': 'status-pill-placed',
    'Processing': 'status-pill-processing',
    'Packed': 'status-pill-packed',
    'Shipped': 'status-pill-shipped',
    'In Transit': 'status-pill-transit',
    'Reached State': 'status-pill-transit',
    'Reached City': 'status-pill-transit',
    'Local Hub': 'status-pill-transit',
    'Out for Delivery': 'status-pill-out',
    'Delivered': 'status-pill-delivered',
    'Delivery Failed': 'status-pill-cancelled',
    'Stuck': 'status-pill-rto',
    'Cancelled': 'status-pill-cancelled',
    'RTO': 'status-pill-rto',
  };
  return map[status] || 'status-pill-default';
}

// CSV column mapping from Shopify export
export const CSV_COLUMN_MAP = {
  order_id: 'Name',
  shopify_id: 'Id',
  email: 'Email',
  payment_method: 'Payment Method',
  financial_status: 'Financial Status',
  customer_name: 'Billing Name',
  customer_name_fallback: 'Shipping Name',
  phone: 'Phone',
  billing_phone: 'Billing Phone',
  shipping_phone: 'Shipping Phone',
  address_line1: 'Shipping Address1',
  address_line2: 'Shipping Address2',
  address_line3: 'Shipping Company',
  city: 'Shipping City',
  pincode: 'Shipping Zip',
  state: 'Shipping Province Name',
  brand: 'Vendor',
  quantity: 'Lineitem quantity',
  product_name: 'Lineitem name',
  price: 'Lineitem price',
  cancelled_at: 'Cancelled at',
  created_at: 'Created at',
  // ─── FIX: Use Shopify's actual order total (includes discounts/taxes) ───
  order_total: 'Total',
  discount_code: 'Discount Code',
  discount_amount: 'Discount Amount',
} as const;
