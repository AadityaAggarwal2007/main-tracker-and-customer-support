// ── The delivery address, changed by the team from Chat Support ─
// Owner, 2026-10-01: "chat support me address edit karne ka option ... sirf admin panel me",
// because an address the customer changed reached ShipTrack only through a Shopify CSV
// re-upload (the Shopify webhook sends new orders only). STAFF ONLY: read by
// GET /api/chat/conversations/[id] and changed by PATCH .../[id]/address, both behind login and
// panel scope; never by the widget, and the AI never reads or states an address (ai.ts).
// It changes ShipTrack's copy only (order details, the city on the tracking page), not Shopify
// and not the courier. order-address-edit.sql keeps the team's address when Shopify, a CSV or a
// resync later sends the old one, and logs every change in order_address_changes.
// Pure helpers (no imports), so the tests can load them.

export interface OrderAddress {
  line1: string;
  line2: string;
  city: string;
  state: string;
  pincode: string;
}

// The states and union territories, written as the orders already have them (Shopify's names).
export const INDIAN_STATES = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh',
  'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry',
  'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand',
  'West Bengal',
];

const MAX_LINE = 250;
const oneLine = (x: unknown) => String(x ?? '').replace(/\s+/g, ' ').trim();

// What the team typed, tidied, or the first thing wrong with it. currentState: the order's own state,
// accepted as it is even when it is not on the list (an old order with an odd spelling).
export function cleanAddress(raw: unknown, currentState?: string | null): { address: OrderAddress } | { error: string } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const line1 = oneLine(r.line1);
  const line2 = oneLine(r.line2);
  const city = oneLine(r.city);
  const stateIn = oneLine(r.state);
  const pincode = String(r.pincode ?? '').replace(/\s+/g, '');
  if (line1.length < 3) return { error: 'Write the house / street line' };
  if (line1.length > MAX_LINE || line2.length > MAX_LINE) return { error: 'An address line is too long' };
  if (city.length < 2 || city.length > 60) return { error: 'Write the city' };
  const state = INDIAN_STATES.find((s) => s.toLowerCase() === stateIn.toLowerCase())
    ?? (currentState && stateIn === oneLine(currentState) ? stateIn : null);
  if (!state) return { error: 'Pick the state' };
  if (!/^[1-9][0-9]{5}$/.test(pincode)) return { error: 'Pincode: 6 digits' };
  return { address: { line1, line2, city, state, pincode } };
}

export function sameAddress(a: OrderAddress, b: OrderAddress): boolean {
  return a.line1 === b.line1 && a.line2 === b.line2 && a.city === b.city && a.state === b.state && a.pincode === b.pincode;
}

// One line for the inbox: "12 MG Road, Near Park, Pune, Maharashtra 411001".
export function addressText(a: OrderAddress): string {
  const place = [a.city, [a.state, a.pincode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [a.line1, a.line2, place].filter(Boolean).join(', ');
}
