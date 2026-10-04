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
//   • Delivered            (marked ONLY by the team; the schedule stops at Out for Delivery)
//
// This module is pure (no DB, no I/O) so it can run on the server (track
// API + progression cron) and be imported by client components alike.
// ═══════════════════════════════════════════════════════════════════════

export const AUTO_DELIVER_DAY = 13; // the end of the usual delivery window (ETA); it does NOT mark anything Delivered
const DAY_MS = 24 * 60 * 60 * 1000;

// The last four stages hang off the order's OWN estimated delivery date, so that
// Out for Delivery always starts 1 day before it (owner, 2026-10-01: customers
// asked why an order had been "Out for Delivery" for days while its estimated date
// was still 3-4 days away). The window is the days from placing to the estimated
// date: 13 by default, or the order's own date when it carries a believable one.
export const MIN_WINDOW_DAYS = AUTO_DELIVER_DAY;
export const MAX_WINDOW_DAYS = 20;
// Days before the estimated date on which State / City / Hub / Out for Delivery start.
const DAYS_BEFORE_ETA = [6, 4, 2, 1];

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
  /** Expected day the order ENTERS this stage (days since order placed) in the
   *  default 13-day window; stageStartDay() gives it for any window. */
  startDay: number;
}

// Canonical customer journey, in order. Indexes 0..9.
export const JOURNEY: JourneyStageDef[] = [
  { key: 'placed',     status: 'Order Placed',        baseLabel: 'Order Placed',          icon: 'ClipboardCheck', estimated: false, startDay: 0 },
  { key: 'processing', status: 'Processing',          baseLabel: 'Processing',            icon: 'Cog',            estimated: false, startDay: 1 },
  { key: 'packed',     status: 'Packed',              baseLabel: 'Packed',                icon: 'PackageCheck',   estimated: false, startDay: 2 },
  { key: 'shipped',    status: 'Shipped',             baseLabel: 'Shipped',               icon: 'Truck',          estimated: false, startDay: 3 },
  { key: 'firstscan',  status: 'Shipment Picked Up',  baseLabel: 'Picked Up',             icon: 'PackageCheck',   estimated: true,  startDay: 4 },
  { key: 'transit',    status: 'In Transit',          baseLabel: 'In Transit',            icon: 'Navigation',     estimated: true,  startDay: 5 },
  { key: 'state',      status: 'Reached State',       baseLabel: 'Reached {STATE}',       icon: 'MapPin',         estimated: true,  startDay: 7 },
  { key: 'city',       status: 'Reached City',        baseLabel: 'Reached {CITY}',        icon: 'MapPin',         estimated: true,  startDay: 9 },
  { key: 'hub',        status: 'Local Hub',           baseLabel: 'At Local Delivery Hub', icon: 'Building2',      estimated: true,  startDay: 11 },
  { key: 'ofd',        status: 'Out for Delivery',    baseLabel: 'Out for Delivery',      icon: 'Bike',           estimated: true,  startDay: 12 },
  { key: 'delivered',  status: 'Delivered',           baseLabel: 'Delivered',             icon: 'CheckCircle',    estimated: false, startDay: AUTO_DELIVER_DAY },
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
  'shipment picked up': 4, 'first scan': 4, 'picked up': 4,
  'in transit': 5, 'in-transit': 5,
  'reached state': 6, 'destination state': 6,
  'reached city': 7, 'destination city': 7,
  'local hub': 8, 'local delivery facility': 8, 'reached local delivery facility': 8,
  'out for delivery': 9, 'ofd': 9,
  'delivered': 10,
};

export function statusToIndex(status: string | null | undefined): number | null {
  if (!status) return null;
  const key = String(status).trim().toLowerCase();
  return key in STATUS_TO_INDEX ? STATUS_TO_INDEX[key] : null;
}

/** Day (since the order was placed) on which stage `i` starts when the order's
 *  estimated delivery is `windowDays` days after it was placed. The first six stages
 *  do not move; State, City, Hub and Out for Delivery come 6, 4, 2 and 1 days before
 *  the estimated date. */
export function stageStartDay(i: number, windowDays: number = AUTO_DELIVER_DAY): number {
  if (i <= 5) return JOURNEY[i].startDay;
  if (i >= DELIVERED_INDEX) return windowDays;
  return windowDays - DAYS_BEFORE_ETA[i - 6];
}

const IST_MS = 5.5 * 60 * 60 * 1000;

/** Days from placing the order to its estimated delivery date, as the schedule uses
 *  them: the order's own date when it is believable (13 to 20 days after it was
 *  placed), otherwise the default 13. Whole IST calendar days, so a date stored at
 *  midnight UTC or IST comes out the same. */
export function windowDaysFor(
  created: string | Date | null | undefined,
  estimatedDelivery: string | Date | null | undefined,
): number {
  if (!created || !estimatedDelivery) return AUTO_DELIVER_DAY;
  const c = new Date(created).getTime();
  const e = new Date(estimatedDelivery).getTime();
  if (Number.isNaN(c) || Number.isNaN(e)) return AUTO_DELIVER_DAY;
  const days = Math.floor((e + IST_MS) / DAY_MS) - Math.floor((c + IST_MS) / DAY_MS);
  return days >= MIN_WINDOW_DAYS && days <= MAX_WINDOW_DAYS ? days : AUTO_DELIVER_DAY;
}

// ── Late orders (owner, 2026-10-04: "1 Oct pe hi atka hua hai, 4 aa gaya, customer ko kuch
// toh dikhe") ──────────────────────────────────────────────────────────────────────────
// Once the estimated date is over and the order still sits at Out for Delivery with no team
// confirmation, the page used to freeze on the day of the estimated date. Now, for such an
// order: (1) one new activity line a day at 10:00 IST for LATE_EVENT_DAYS days, honest lines
// (a rescheduled slot, the team connecting with the courier, the network load), never a
// courier scan that did not happen; (2) the banner gives the reason from the chat's delay
// ladder (same sentences and same day steps as delay-ladder.ts, checked by unit.js, so the
// customer reads one story on the page and in the chat); (3) the date card shows a revised
// date, +3 days for the first two late days, +6 for days 3-5, and from day 6 no date (the
// team confirms it). The day starts at 10:00 IST so nothing changes at midnight. Not for a
// cancelled / returned / failed / Delivered order, and only at Out for Delivery.
export const LATE_EVENT_DAYS = 5;
export const LATE_REVISIONS: { untilDay: number; plusDays: number }[] = [
  { untilDay: 2, plusDays: 3 },
  { untilDay: 5, plusDays: 6 },
];
export type LateStage = 1 | 2 | 3;
// Identical to DELAY_REASONS in src/lib/chat/delay-ladder.ts (that file has no imports and
// the chat tests load it alone), so the two can never drift: unit.js compares them.
export const LATE_REASONS: Record<LateStage, string> = {
  1: 'Because of the festive season, courier volume is very high right now, so some deliveries are taking a little longer than usual.',
  2: 'The courier network is under very heavy load right now, so parcels are waiting longer at the hubs before they move on.',
  3: 'We have not been able to connect with the delivery agent for your area yet. Our team is following it up, and the tracking link shows any movement.',
};
const LATE_TITLES: Record<LateStage, string> = {
  1: 'Delivery delayed: festive season rush',
  2: 'Delivery delayed: courier network under heavy load',
  3: 'Our team is following up with the courier',
};
// One line per late day, oldest first. {CITY} is the order's own city.
const LATE_EVENTS: { title: string; location: string }[] = [
  { title: 'Delivery rescheduled',             location: 'Festive season rush at the {CITY} delivery hub, queued for the next slot' },
  { title: 'Connecting with courier partner',  location: 'Our team is coordinating your delivery with the courier partner' },
  { title: 'Held at local delivery hub',       location: 'Heavy load on the courier network, {CITY}' },
  { title: 'Courier follow-up in progress',    location: 'Our team is following up with the courier partner, {CITY}' },
  { title: 'Delivery update',                  location: 'Parcel still at the local hub in {CITY}, our team is tracking it daily' },
];

/** Which reason a late order gets by its late days: day 1 festive volume, days 2-4 the
 *  network load, day 5 and after the delivery agent / the team following up. */
export function lateStage(daysPast: number): LateStage {
  return daysPast <= 1 ? 1 : daysPast <= 4 ? 2 : 3;
}

/** IST calendar day index of an instant. */
function istDayOf(ms: number): number {
  return Math.floor((ms + IST_MS) / DAY_MS);
}

/** Late days of an order: how many 10:00 IST ticks have passed since the estimated date's
 *  own day ended. 0 on the estimated day and until 10:00 the next morning, 1 from then. */
export function lateDays(etaISO: string, now: Date): number {
  const eta = new Date(etaISO).getTime();
  if (Number.isNaN(eta)) return 0;
  const nowDay = Math.floor((now.getTime() + IST_MS - WORK_START_MS) / DAY_MS);
  return Math.max(0, nowDay - istDayOf(eta));
}

/** 10:00 IST on the k-th day after the estimated date, in UTC ms. */
function lateEventTime(etaISO: string, k: number): number {
  return (istDayOf(new Date(etaISO).getTime()) + k) * DAY_MS - IST_MS + WORK_START_MS;
}

/** The revised date shown for a late order, or null once the revisions are used up. */
export function revisedEta(etaISO: string, daysPast: number): string | null {
  const step = LATE_REVISIONS.find((r) => daysPast <= r.untilDay);
  if (!step) return null;
  return new Date(new Date(etaISO).getTime() + step.plusDays * DAY_MS).toISOString();
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
  /** City the panel ships FROM (businesses.origin_city). Null = stay generic. */
  origin_city?: string | null;
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
  eta: string | null; // ISO date string: the date the customer sees (revised when late); null once the revisions are used up
  etaEstimated: boolean;
  /** The order's own date (or the day-13 end of the window), never revised. */
  etaOriginal: string | null;
  /** true when `eta` is a revised date shown because the original one passed. */
  etaRevised: boolean;
  /** Set for an order past its estimated date at Out for Delivery (see "Late orders"). */
  late: { daysPast: number; stage: LateStage; reason: string } | null;
  lastCheckedISO: string;
  notice: JourneyNotice | null;
}

// Customer-facing copy for each stage's activity row. Reads like a real
// courier feed; {STATE}/{CITY} are filled from the order's own address.
const EVENT_COPY: Record<string, { title: string; location: string }> = {
  placed:     { title: 'Order Placed',                  location: 'Order confirmed' },
  processing: { title: 'Order Processing',              location: '{ORIGIN}' },
  packed:     { title: 'Packed & Ready to Ship',        location: '{ORIGIN}' },
  shipped:    { title: 'Shipped',                       location: 'Handed over to courier, {ORIGIN}' },
  firstscan:  { title: 'Shipment Picked Up',            location: '{ORIGIN}' },
  // Spec §5: never invent an intermediate hub. Origin -> destination state only.
  transit:    { title: 'In Transit',                    location: '{ORIGIN} to {STATE}' },
  state:      { title: 'Reached {STATE}',               location: '{STATE}' },
  city:       { title: 'Reached {CITY}',                location: '{CITY}' },
  hub:        { title: 'Arrived at Local Delivery Hub', location: '{CITY}' },
  ofd:        { title: 'Out for Delivery',              location: '{CITY}' },
  delivered:  { title: 'Delivered',                     location: '{CITY}' },
};

function fillText(
  tpl: string, state?: string | null, city?: string | null, origin?: string | null,
): string {
  // No origin configured -> a generic warehouse, never a guessed city.
  const originText = origin && origin.trim() ? `${titleCase(origin.trim())} warehouse` : 'Seller warehouse';
  return tpl
    .replace('{ORIGIN}', originText)
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
function eventTime(base: number, i: number, windowDays: number): number {
  if (i === 0) return base;
  const onDay = base + stageStartDay(i, windowDays) * DAY_MS;
  // Floor to IST midnight, expressed in UTC ms, then add the working offset.
  const istMidnight = Math.floor((onDay + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
  return istMidnight + WORK_START_MS + i * 47 * 60 * 1000;
}

function buildEvents(
  order: JourneyOrder, currentIndex: number, delivered: boolean, now: Date, windowDays: number,
  late: { etaISO: string; daysPast: number } | null = null,
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
    times.push(Math.min(eventTime(base, i, windowDays), nowMs));
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
      title: fillText(copy.title, order.state, order.city, order.origin_city),
      location: fillText(copy.location, order.state, order.city, order.origin_city),
      timeISO: new Date(times[i]).toISOString(),
    });
  }

  // Late lines: one a day at 10:00 IST after the estimated date, at most LATE_EVENT_DAYS,
  // each after the Out for Delivery line (an order whose estimated date was earlier than
  // the schedule gets them in order all the same).
  if (late && !delivered) {
    let prev = times.length ? times[times.length - 1] : 0;
    for (let k = 1; k <= Math.min(late.daysPast, LATE_EVENT_DAYS); k++) {
      const copy = LATE_EVENTS[k - 1];
      const at = Math.max(lateEventTime(late.etaISO, k), prev + 60_000);
      if (at > now.getTime()) break;
      prev = at;
      events.push({
        key: `late${k}`,
        title: fillText(copy.title, order.state, order.city, order.origin_city),
        location: fillText(copy.location, order.state, order.city, order.origin_city),
        timeISO: new Date(at).toISOString(),
      });
    }
  }
  return events;
}

/** Days between order placement and `now`, floored to whole days. */
function ageInDays(created: string | Date, now: Date): number {
  const c = new Date(created).getTime();
  if (Number.isNaN(c)) return 0;
  return Math.max(0, Math.floor((now.getTime() - c) / DAY_MS));
}

/** Highest journey index the schedule permits at `ageDays`. It stops at Out for
 *  Delivery: the schedule NEVER moves an order into Delivered. Only the team marks
 *  an order Delivered (owner's rule, 2026-09-30). Until 2026-09-30 this returned
 *  Delivered from day 13, the cron wrote it to the database and the track page showed
 *  it, which is how 169 orders read "Delivered" with nobody having delivered them.
 *  `windowDays` is the order's days to its estimated date (windowDaysFor): Out for
 *  Delivery starts 1 day before it. */
export function expectedIndexForAge(ageDays: number, windowDays: number = AUTO_DELIVER_DAY): number {
  let idx = 0;
  for (let i = 0; i < JOURNEY.length; i++) {
    if (ageDays >= stageStartDay(i, windowDays)) idx = i;
  }
  return Math.min(idx, LAST_AUTO_INDEX_BEFORE_DELIVERED);
}

/**
 * Build the full customer-facing journey for an order — the single source of
 * truth used by the track API, the track pages, and (for the schedule) the cron.
 */
export function buildJourney(order: JourneyOrder, now: Date = new Date()): JourneyResult {
  const lastCheckedISO = now.toISOString();
  const ageDays = ageInDays(order.created_at, now);
  const windowDays = windowDaysFor(order.created_at, order.estimated_delivery);
  const expectedIndex = expectedIndexForAge(ageDays, windowDays);
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
      delivered: false, deliveredEstimated: false, eta, etaEstimated, etaOriginal: eta, etaRevised: false,
      late: null, lastCheckedISO, notice,
    };
  }

  // ── Normal linear journey ──────────────────────────────────────────────
  const storedIndex = statusToIndex(order.tracking_status);
  // Delivered only when the stored status says so, and only the team sets that. An
  // order's age never makes it Delivered (owner's rule, 2026-09-30).
  const delivered = storedIndex === DELIVERED_INDEX;

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

  // Delivered is always a team confirmation now; the flag stays for old callers.
  const deliveredEstimated = false;

  const stages = JOURNEY.map<JourneyStageView>((def, i) => ({
    key: def.key, status: def.status, icon: def.icon, estimated: def.estimated,
    label: fillLabel(def, order.state, order.city),
    state: i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'upcoming',
  }));

  const currentDef = JOURNEY[currentIndex];
  const currentLabel = fillLabel(currentDef, order.state, order.city);

  // Late: the estimated day is over (from 10:00 IST the next morning), the order is at Out
  // for Delivery and nobody has marked it Delivered. The original date stays in
  // `etaOriginal`; `eta` becomes the revised date the customer sees, then null.
  const etaOriginal = eta;
  let etaRevised = false;
  let late: JourneyResult['late'] = null;
  if (!delivered && eta && currentIndex === LAST_AUTO_INDEX_BEFORE_DELIVERED) {
    const daysPast = lateDays(eta, now);
    if (daysPast >= 1) {
      const stage = lateStage(daysPast);
      late = { daysPast, stage, reason: LATE_REASONS[stage] };
      eta = revisedEta(etaOriginal, daysPast);
      etaRevised = eta !== null;
    }
  }

  const events = buildEvents(order, currentIndex, delivered, now, windowDays, late && etaOriginal ? { etaISO: etaOriginal, daysPast: late.daysPast } : null);

  // ── Customer-facing status message (confident, reads as real tracking) ──
  const destCity = order.city && order.city.trim() ? titleCase(order.city.trim()) : 'your city';
  let notice: JourneyNotice | null = null;

  if (delivered) {
    notice = { level: 'success', title: 'Delivered', body: 'Your order has been delivered. Thank you for shopping with us!' };
  } else if (late) {
    // Past the estimated date and the team has not marked it Delivered: the reason from the
    // delay ladder, never "arriving soon", never "today", never Delivered.
    const tail = eta ? ' The revised delivery date is shown below.' : ' Our team will confirm your delivery date.';
    notice = { level: 'warn', title: LATE_TITLES[late.stage], body: late.reason + tail };
  } else if (currentIndex >= 9) {
    // Not "will reach you today": the order can sit at this stage for days, and the stage
    // is a schedule, not a courier scan.
    notice = { level: 'info', title: 'Out for delivery', body: `Your order is in the final delivery stage in ${destCity}. Please keep your phone reachable for the delivery agent.` };
  } else if (currentIndex >= 4) {
    notice = { level: 'info', title: 'On the way', body: `Your order is moving through the courier network towards ${destCity} and is on schedule for delivery.` };
  } else if (currentIndex >= 3) {
    notice = { level: 'info', title: 'Shipped', body: 'Your order has been shipped and handed over to the courier. It is on its way!' };
  }

  return {
    mode, currentIndex, currentLabel, stages, events, ageDays, expectedIndex,
    delivered, deliveredEstimated, eta, etaEstimated, etaOriginal, etaRevised, late, lastCheckedISO, notice,
  };
}
