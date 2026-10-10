// Pure side of each brand's own words in a WhatsApp template (no database: the screens import this file; the server
// side is whatsapp-brands.ts). See that file's header for the why.

export const BRAND_PREFIX = 'wa_brand:';
export const brandKey = (businessId: string) => `${BRAND_PREFIX}${businessId}`;

// The order-placed confirmation (owner's text: brand name, the order is placed, tracking in 1-2 days, thank you,
// for any confusion email). Variables, in this order: {{1}} customer, {{2}} order, {{3}} brand, {{4}} support email.
export const ORDER_PLACED_PRESET = {
  name: 'order_placed',
  language: 'en_US',
  category: 'UTILITY',
  header: '',
  body: 'Hi {{1}}, your order {{2}} with {{3}} has been placed successfully. Thank you for shopping with us! Your tracking details will be shared with you within 1-2 days. For any confusion, please email us at {{4}} and our team will help you.',
  footer: '',
  examples: ['Rahul', '#1042', 'Your Brand', 'help@yourbrand.com'],
};
// Which variable of an order-placed template is which (0-based), used by the Send screen to fill them per brand.
export const ORDER_PLACED_SLOTS = { customer: 0, order: 1, brand: 2, email: 3 };
export const isOrderPlaced = (templateName: string) => templateName.startsWith('order_placed');

export interface Brand { id: string; panel: string; name: string; email: string; savedName: string | null; savedEmail: string | null; supportGmail: string | null }

export function cleanBrand(input: { name?: unknown; email?: unknown }): { ok: true; name: string; email: string } | { ok: false; error: string } {
  const name = String(input.name ?? '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 40) return { ok: false, error: 'Brand name: 2 to 40 characters' };
  if (/\{\{|\}\}|[<>]/.test(name)) return { ok: false, error: 'Brand name cannot have {{ }} or < >' };
  const email = String(input.email ?? '').trim();
  if (email && (email.length > 128 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return { ok: false, error: 'That email address does not look right' };
  return { ok: true, name, email };
}

export function parseBrand(value: string | null | undefined): { name: string | null; email: string | null } {
  try {
    const j = JSON.parse(value || '');
    return { name: typeof j?.name === 'string' && j.name ? j.name : null, email: typeof j?.email === 'string' && j.email ? j.email : null };
  } catch { return { name: null, email: null }; }
}
