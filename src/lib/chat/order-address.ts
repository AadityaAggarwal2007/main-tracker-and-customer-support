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
  // The customer's mobile, its last 10 digits (owner 2026-10-14: "number edit karne wala option bhi chaia email aur chat
  // support ma"). Missing = not read / not changed.
  phone?: string;
}

// A mobile number as the team types it (+91 98765 43210, 098765..., 9876543210) -> its 10 digits, or null.
export function mobileDigits(x: unknown): string | null {
  let d = String(x ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9][0-9]{9}$/.test(d) ? d : null;
}
// The last 10 digits of a stored number (stored in many shapes), '' when none.
export const last10 = (x: unknown) => String(x ?? '').replace(/\D/g, '').slice(-10);
// The new number written in the old one's shape ("+91..." stays "+91...", "91..." stays "91..."), so every reader that
// already copes with the order's own format keeps working.
export function storedMobile(digits: string, oldStored: string | null | undefined): string {
  const old = String(oldStored ?? '').trim();
  if (old.startsWith('+91')) return `+91${digits}`;
  const od = old.replace(/\D/g, '');
  if (od.length === 12 && od.startsWith('91')) return `91${digits}`;
  return digits;
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
  // The phone is optional in the body: missing or empty = unchanged; else a valid 10-digit Indian mobile.
  let phone: string | undefined;
  if (r.phone != null && String(r.phone).trim() !== '') {
    const d = mobileDigits(r.phone);
    if (!d) return { error: 'Phone: a 10-digit mobile number' };
    phone = d;
  }
  return { address: { line1, line2, city, state, pincode, ...(phone ? { phone } : {}) } };
}

// b.phone missing = the phone is not being changed.
export function sameAddress(a: OrderAddress, b: OrderAddress): boolean {
  return a.line1 === b.line1 && a.line2 === b.line2 && a.city === b.city && a.state === b.state && a.pincode === b.pincode
    && (b.phone == null || last10(a.phone) === last10(b.phone));
}

// One line for the inbox: "12 MG Road, Near Park, Pune, Maharashtra 411001".
export function addressText(a: OrderAddress): string {
  const place = [a.city, [a.state, a.pincode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [a.line1, a.line2, place].filter(Boolean).join(', ');
}
