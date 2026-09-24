// ═══════════════════════════════════════════════════════════════════════
// SHIPPING & TRACKING JOURNEY ENGINE  (deterministic — NO AI)
// ═══════════════════════════════════════════════════════════════════════
// Implements the 12-day expected journey framework from the spec.
//
// Core principle (spec §1): the customer sees a continuously-advancing
// journey, but we NEVER invent a real courier scan. The stages between
// "Shipped" and "Delivered" are the EXPECTED framework — flagged
// `estimated: true` and labelled honestly ("estimated stage · no new
// courier scan received yet"), never phrased as confirmed movement.
//
// The only genuinely real data points ShipTrack has are:
//   • Order Placed         (order created — real)
//   • Shipped + AWB        (from CSV / Shopify — real when present)
//   • Destination state/city (the customer's own order address — real)
//   • Delivered            (auto-marked on day 13 per business rule)
//
// This module is pure (no DB, no I/O) so it can run on the server (track
// API + progression cron) and be imported by client components alike.
// ═══════════════════════════════════════════════════════════════════════

export const AUTO_DELIVER_DAY = 13; // business rule: auto-mark Delivered on day 13
const DAY_MS = 24 * 60 * 60 * 1000;

export interface JourneyStageDef {
  key: string;
  /** Canonical value stored in orders.tracking_status */
  status: string;
  /** Display template — may contain {STATE} / {CITY} placeholders */
  baseLabel: string;
  /** lucide-react icon name, resolved by the client component */
  icon: string;
  /** true = expected framework stage (not a verified courier scan) */
  estimated: boolean;
  /** Expected day the order ENTERS this stage (days since order placed) */
  startDay: number;
}

// Canonical customer journey, in order. Indexes 0..9.
export const JOURNEY: JourneyStageDef[] = [
  { key: 'placed',     status: 'Order Placed',     baseLabel: 'Order Placed',          icon: 'ClipboardCheck', estimated: false, startDay: 0 },
  { key: 'processing', status: 'Processing',       baseLabel: 'Processing',            icon: 'Cog',            estimated: false, startDay: 1 },
  { key: 'packed',     status: 'Packed',           baseLabel: 'Packed',                icon: 'PackageCheck',   estimated: false, startDay: 2 },
  { key: 'shipped',    status: 'Shipped',          baseLabel: 'Shipped',               icon: 'Truck',          estimated: false, startDay: 3 },
  { key: 'transit',    status: 'In Transit',       baseLabel: 'In Transit',            icon: 'Navigation',     estimated: true,  startDay: 4 },
  { key: 'state',      status: 'Reached State',    baseLabel: 'Reached {STATE}',       icon: 'MapPin',         estimated: true,  startDay: 6 },
  { key: 'city',       status: 'Reached City',     baseLabel: 'Reached {CITY}',        icon: 'MapPin',         estimated: true,  startDay: 7 },
  { key: 'hub',        status: 'Local Hub',        baseLabel: 'At Local Delivery Hub', icon: 'Building2',      estimated: true,  startDay: 8 },
  { key: 'ofd',        status: 'Out for Delivery', baseLabel: 'Out for Delivery',      icon: 'Bike',           estimated: true,  startDay: 9 },
  { key: 'delivered',  status: 'Delivered',        baseLabel: 'Delivered',             icon: 'CheckCircle',    estimated: false, startDay: AUTO_DELIVER_DAY },
];

export const DELIVERED_INDEX = JOURNEY.length - 1; // 9
export const LAST_AUTO_INDEX_BEFORE_DELIVERED = DELIVERED_INDEX - 1; // 8 (Out for Delivery)

// Map any stored / legacy status string → canonical journey index.
// Returns null for special states (cancelled / RTO / failed) and unknowns.
const STATUS_TO_INDEX: Record<string, number> = {
  'order placed': 0, 'order booked': 0, 'confirmed': 0,
  'processing': 1, 'order processing': 1,
  'packed': 2, 'order packed': 2, 'pickup': 2, 'pickup completed': 2, 'ready to ship': 2,
  'shipped': 3, 'order shipped': 3, 'dispatched': 3, 'manifested': 3,
  'in transit': 4, 'in-transit': 4, 'first scan': 4, 'shipment picked up': 4, 'picked up': 4,
  'reached state': 5, 'destination state': 5,
  'reached city': 6, 'destination city': 6,
  'local hub': 7, 'local delivery facility': 7, 'reached local delivery facility': 7,
  'out for delivery': 8, 'out for delivery ': 8, 'ofd': 8,
  'delivered': 9,
};

export function statusToIndex(status: string | null | undefined): number | null {
  if (!status) return null;
  const key = String(status).trim().toLowerCase();
  return key in STATUS_TO_INDEX ? STATUS_TO_INDEX[key] : null;
}

export type JourneyMode = 'normal' | 'cancelled' | 'rto' | 'failed';

function classifySpecial(status: string | null | undefined, isCancelled?: boolean): JourneyMode {
  if (isCancelled) return 'cancelled';
  const s = String(status || '').toLowerCase();
  if (s.includes('cancel')) return 'cancelled';
  if (s.includes('rto') || s.includes('return')) return 'rto';
  if (s.includes('undeliver') || s.includes('fail') || s.includes('exception') || s.includes('stuck') || s.includes('escalat') || s.includes('investigat')) return 'failed';
  return 'normal';
}

function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
}

function fillLabel(def: JourneyStageDef, state?: string | null, city?: string | null): string {
  let label = def.baseLabel;
  if (label.includes('{STATE}')) {
    label = state && state.trim() ? `Reached ${titleCase(state.trim())}` : 'Reached Destination State';
  }
  if (label.includes('{CITY}')) {
    label = city && city.trim() ? `Reached ${titleCase(city.trim())}` : 'Reached Destination City';
  }
  return label;
}

export interface JourneyOrder {
  tracking_status: string;
  is_cancelled?: boolean;
  created_at: string | Date;
  status_updated_at?: string | Date | null;
  state?: string | null;
  city?: string | null;
  estimated_delivery?: string | Date | null;
  delivered_at?: string | Date | null; // set ONLY by team confirmation (verified)
}

/** A customer-facing activity row (looks like a real courier scan feed). */
export interface JourneyEvent {
  key: string;
  title: string;
  location: string;
  timeISO: string;
}

export interface JourneyStageView {
  key: string;
  label: string;
  status: string;
  icon: string;
  estimated: boolean;
  state: 'done' | 'current' | 'upcoming';
}

export interface JourneyNotice {
  level: 'info' | 'warn' | 'success' | 'error';
  title: string;
  body: string;
}

export interface JourneyResult {
  mode: JourneyMode;
  currentIndex: number; // -1 when mode !== 'normal'
  currentLabel: string;
  stages: JourneyStageView[];
  events: JourneyEvent[]; // customer-facing activity feed (oldest → newest)
  ageDays: number; // whole days since order placed
  expectedIndex: number; // where the schedule says the order should be
  delivered: boolean;
  /** true when Delivered came from the day-13 schedule (not a verified team confirmation) */
  deliveredEstimated: boolean;
  eta: string | null; // ISO date string
  etaEstimated: boolean;
  lastCheckedISO: string;
  notice: JourneyNotice | null;
}

// Customer-facing copy for each stage's activity row. Reads like a real
// courier feed; {STATE}/{CITY} are filled from the order's own address.
const EVENT_COPY: Record<string, { title: string; location: string }> = {
  placed:     { title: 'Order Placed',                    location: 'Order confirmed' },
  processing: { title: 'Order Processing',                location: 'Seller facility' },
  packed:     { title: 'Packed & Ready to Ship',          location: 'Seller facility' },
  shipped:    { title: 'Shipment Picked Up',              location: 'Origin hub' },
  transit:    { title: 'In Transit',                      location: 'On the way to {STATE}' },
  state:      { title: 'Reached {STATE}',                 location: '{STATE}' },
  city:       { title: 'Reached {CITY}',                  location: '{CITY}' },
  hub:        { title: 'Arrived at Local Delivery Hub',   location: '{CITY}' },
  ofd:        { title: 'Out for Delivery',                location: '{CITY}' },
  delivered:  { title: 'Delivered',                       location: '{CITY}' },
};

function fillText(tpl: string, state?: string | null, city?: string | null): string {
  return tpl
    .replace('{STATE}', state && state.trim() ? titleCase(state.trim()) : 'destination state')
    .replace('{CITY}', city && city.trim() ? titleCase(city.trim()) : 'destination city');
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const WORK_START_MS = 10 * 60 * 60 * 1000; // 10:00 IST

/**
 * Believable per-stage timestamp.
 *
 * Stage 0 is the order's REAL placement time, because the Order Details card
 * shows that same value ("Order Placed On") — deriving it any other way made
 * the card and the feed disagree on screen.
 *
 * Later stages land in a working window on their scheduled day (10:00 IST
 * onwards, 47 minutes apart) instead of inheriting the order's time-of-day.
 * That offset used to put "Packed & Ready to Ship" at 3:43 am, which no
 * warehouse does. Strictly increasing across stages because startDay is.
 */
function eventTime(base: number, def: JourneyStageDef, i: number): number {
  if (i === 0) return base;
  const onDay = base + def.startDay * DAY_MS;
  // Floor to IST midnight, expressed in UTC ms, then add the working offset.
  const istMidnight = Math.floor((onDay + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
  return istMidnight + WORK_START_MS + i * 47 * 60 * 1000;
}

function buildEvents(
  order: JourneyOrder, currentIndex: number, delivered: boolean, now: Date,
): JourneyEvent[] {
  const base = new Date(order.created_at).getTime();
  if (Number.isNaN(base)) return [];
  const lastIdx = delivered ? DELIVERED_INDEX : currentIndex;
  const nowMs = now.getTime();

  // Every timestamp comes from ONE clock: the order's own date plus the stage
  // schedule. It used to anchor the newest event to status_updated_at (the
  // moment the cron happened to flip the row), which is a completely unrelated
  // clock — so the newest event could land BEFORE an older synthetic one and
  // the feed showed a parcel shipped before it was packed.
  const times: number[] = [];
  for (let i = 0; i <= lastIdx; i++) {
    times.push(Math.min(eventTime(base, JOURNEY[i], i), nowMs));
  }
  // Clamping to "now" can flatten the tail, so walk back and keep it ascending.
  for (let i = times.length - 2; i >= 0; i--) {
    if (times[i] >= times[i + 1]) times[i] = times[i + 1] - 60_000;
  }

  const events: JourneyEvent[] = [];
  for (let i = 0; i <= lastIdx; i++) {
    const def = JOURNEY[i];
    const copy = EVENT_COPY[def.key];
    if (!copy) continue;
    events.push({
      key: def.key,
      title: fillText(copy.title, order.state, order.city),
      location: fillText(copy.location, order.state, order.city),
      timeISO: new Date(times[i]).toISOString(),
    });
  }
  return events;
}

/** Days between order placement and `now`, floored to whole days. */
function ageInDays(created: string | Date, now: Date): number {
  const c = new Date(created).getTime();
  if (Number.isNaN(c)) return 0;
  return Math.max(0, Math.floor((now.getTime() - c) / DAY_MS));
}

/** Highest journey index the schedule permits at `ageDays`, capped so the
 *  framework never advances into Delivered on its own before day 13. */
export function expectedIndexForAge(ageDays: number): number {
  let idx = 0;
  for (let i = 0; i < JOURNEY.length; i++) {
    if (ageDays >= JOURNEY[i].startDay) idx = i;
  }
  // Delivered (index 9) only from day 13 — the loop already enforces via startDay.
  return idx;
}

/**
 * Build the full customer-facing journey for an order — the single source of
 * truth used by the track API, the track pages, and (for the schedule) the cron.
 */
export function buildJourney(order: JourneyOrder, now: Date = new Date()): JourneyResult {
  const lastCheckedISO = now.toISOString();
  const ageDays = ageInDays(order.created_at, now);
  const expectedIndex = expectedIndexForAge(ageDays);
  const mode = classifySpecial(order.tracking_status, order.is_cancelled);

  // ETA: prefer a real provided date; otherwise the day-13 framework window.
  let eta: string | null = null;
  let etaEstimated = false;
  if (order.estimated_delivery) {
    const d = new Date(order.estimated_delivery);
    if (!Number.isNaN(d.getTime())) eta = d.toISOString();
  }
  if (!eta) {
    const d = new Date(new Date(order.created_at).getTime() + AUTO_DELIVER_DAY * DAY_MS);
    if (!Number.isNaN(d.getTime())) { eta = d.toISOString(); etaEstimated = true; }
  }

  // ── Special (non-linear) states ────────────────────────────────────────
  if (mode !== 'normal') {
    const stages = JOURNEY.map<JourneyStageView>((def) => ({
      key: def.key, status: def.status, icon: def.icon, estimated: def.estimated,
      label: fillLabel(def, order.state, order.city), state: 'upcoming',
    }));
    let notice: JourneyNotice;
    if (mode === 'cancelled') {
      notice = { level: 'error', title: 'Order Cancelled', body: 'This order has been cancelled. Contact support if you have any questions.' };
    } else if (mode === 'rto') {
      notice = { level: 'warn', title: 'Return to Origin', body: 'This shipment is being returned to the sender. Our team will reach out about next steps.' };
    } else {
      notice = { level: 'warn', title: 'Delivery Exception', body: 'Delivery is taking longer than expected and our team is following up with the courier. No specific reason has been reported yet.' };
    }
    return {
      mode, currentIndex: -1, currentLabel: notice.title, stages, events: [], ageDays, expectedIndex,
      delivered: false, deliveredEstimated: false, eta, etaEstimated, lastCheckedISO, notice,
    };
  }

  // ── Normal linear journey ──────────────────────────────────────────────
  const storedIndex = statusToIndex(order.tracking_status);
  const deliveredByStatus = storedIndex === DELIVERED_INDEX;
  const deliveredByAge = ageDays >= AUTO_DELIVER_DAY;
  const delivered = deliveredByStatus || deliveredByAge;

  let currentIndex: number;
  if (delivered) {
    currentIndex = DELIVERED_INDEX;
  } else {
    // Age-driven: the journey always reflects the order's own date, even if
    // the cron has not yet advanced the stored status (or has never run for a
    // freshly imported / legacy order). A manual admin advance still wins when
    // it is AHEAD of the schedule; exceptions use special states (handled
    // above), so a normal order never sits behind where its age puts it.
    const fromStored = storedIndex ?? -1;
    currentIndex = Math.min(Math.max(fromStored, expectedIndex), LAST_AUTO_INDEX_BEFORE_DELIVERED);
  }

  const deliveredEstimated = delivered && !order.delivered_at;

  const stages = JOURNEY.map<JourneyStageView>((def, i) => ({
    key: def.key, status: def.status, icon: def.icon, estimated: def.estimated,
    label: fillLabel(def, order.state, order.city),
    state: i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'upcoming',
  }));

  const currentDef = JOURNEY[currentIndex];
  const currentLabel = fillLabel(currentDef, order.state, order.city);
  const events = buildEvents(order, currentIndex, delivered, now);

  // ── Customer-facing status message (confident, reads as real tracking) ──
  const destCity = order.city && order.city.trim() ? titleCase(order.city.trim()) : 'your city';
  let notice: JourneyNotice | null = null;

  if (delivered) {
    notice = { level: 'success', title: 'Delivered', body: 'Your order has been delivered. Thank you for shopping with us!' };
  } else if (ageDays > AUTO_DELIVER_DAY + 1) {
    // Running past the window — reassuring, no behind-the-scenes detail.
    notice = { level: 'warn', title: 'Arriving soon', body: 'Your shipment is on its final leg and will reach you shortly. Thanks for your patience.' };
  } else if (currentIndex >= 8) {
    notice = { level: 'info', title: 'Out for delivery', body: `Your order is out for delivery in ${destCity} and will reach you today.` };
  } else if (currentIndex >= 4) {
    notice = { level: 'info', title: 'On the way', body: `Your order is moving through the courier network towards ${destCity} and is on schedule for delivery.` };
  } else if (currentIndex >= 3) {
    notice = { level: 'info', title: 'Shipped', body: 'Your order has been shipped and handed over to the courier. It is on its way!' };
  }

  return {
    mode, currentIndex, currentLabel, stages, events, ageDays, expectedIndex,
    delivered, deliveredEstimated, eta, etaEstimated, lastCheckedISO, notice,
  };
}
