// ── Shopify tab: orders by product and by the team's own collections (owner 2026-10-13) ─────────────────────────
// Owner: "ek shopify ka folder ban jaye jisme collection wise order dekhe ... apna hisab se 3-4 collection aur 4-5
// product list karke unka count bhi dekh sake". Answers: the collections are the team's own groups (a name + chosen
// products and / or words like "jhumka"), numbers = orders, pieces and money (COD / prepaid apart) over a date range,
// a product's colours / sizes are one line that opens into its variants, for the Super Admin and the Manager.
// Pure (no imports): the screen and the server both use it; the tests load it as is.

// One order line from the database: which order (its row id), the product name as the order has it, the pieces, the
// unit price, whether the order is Cash on Delivery and when it was placed (ms). Only the panel's not-cancelled
// orders of the range come.
export interface ItemRow { order: string; product_name: string; quantity: number; price: number; cod: boolean; at?: number }

// first / last = when the oldest and the newest of these orders was placed (owner 2026-10-13: "collection ma date nai
// dekh rhi ki kitna purana data ha"); null when there is none.
export interface Totals { orders: number; pieces: number; revenue: number; codOrders: number; codRevenue: number; prepaidOrders: number; prepaidRevenue: number; first: number | null; last: number | null }
export interface VariantLine extends Totals { name: string; variant: string }
export interface ProductLine extends Totals { name: string; variants: VariantLine[] }

// A collection the team made: a name, the products picked from the list (their base names) and words (a product
// whose name holds any of them belongs too, "jhumka" = every jhumka).
export interface ProductGroup { id: string; name: string; products: string[]; words: string[] }
export interface GroupLine extends Totals { id: string; name: string; products: ProductLine[] }

export const MAX_GROUPS = 12;
export const MAX_GROUP_PRODUCTS = 60;
export const MAX_WORDS = 10;
export const MAX_WATCH = 12;
export const MAX_RANGE_DAYS = 92;

const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const money = (v: number) => Math.round(v * 100) / 100;
const zero = (): Totals => ({ orders: 0, pieces: 0, revenue: 0, codOrders: 0, codRevenue: 0, prepaidOrders: 0, prepaidRevenue: 0, first: null, last: null });

// Totals over some lines: an order is counted ONCE however many of the lines it holds (two colours of one product,
// two products of one collection), pieces and money are summed.
export function totalsOf(rows: ItemRow[]): Totals {
  const t = zero();
  const all = new Set<string>(), cod = new Set<string>(), pre = new Set<string>();
  for (const r of rows) {
    const q = num(r.quantity), amount = q * num(r.price);
    t.pieces += q; t.revenue += amount;
    all.add(r.order);
    const at = Number(r.at);
    if (r.at != null && Number.isFinite(at)) { if (t.first == null || at < t.first) t.first = at; if (t.last == null || at > t.last) t.last = at; }
    if (r.cod) { cod.add(r.order); t.codRevenue += amount; } else { pre.add(r.order); t.prepaidRevenue += amount; }
  }
  t.orders = all.size; t.codOrders = cod.size; t.prepaidOrders = pre.size;
  t.revenue = money(t.revenue); t.codRevenue = money(t.codRevenue); t.prepaidRevenue = money(t.prepaidRevenue);
  return t;
}

const oneLine = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim();

// Shopify writes a line as "Title - Variant" ("Jhumka box - Silver / pack-of-3"); the CSV's "Lineitem name" too.
// The base is the title: the text before the LAST " - " when what follows looks like a variant (short, or with a
// " / "); a title that itself holds " - " keeps it when the tail is long text.
export function splitName(name: string): { base: string; variant: string } {
  const s = oneLine(name);
  const i = s.lastIndexOf(' - ');
  if (i > 0) {
    const tail = s.slice(i + 3).trim();
    if (tail && (tail.includes(' / ') || tail.length <= 30)) return { base: s.slice(0, i).trim(), variant: tail };
  }
  return { base: s, variant: '' };
}
const key = (s: string) => oneLine(s).toLowerCase();

// The lines of every product (base name), each with its variants, biggest first (orders, then pieces, then name).
export function productLines(rows: ItemRow[]): ProductLine[] {
  const byBase = new Map<string, { name: string; rows: ItemRow[]; variants: Map<string, { variant: string; name: string; rows: ItemRow[] }> }>();
  for (const r of rows) {
    const { base, variant } = splitName(r.product_name);
    if (!base) continue;
    const k = key(base);
    let p = byBase.get(k);
    if (!p) { p = { name: base, rows: [], variants: new Map() }; byBase.set(k, p); }
    p.rows.push(r);
    const vk = key(variant);
    let v = p.variants.get(vk);
    if (!v) { v = { variant: variant || '(no variant)', name: oneLine(r.product_name), rows: [] }; p.variants.set(vk, v); }
    v.rows.push(r);
  }
  const order = (a: Totals & { name: string }, b: Totals & { name: string }) => b.orders - a.orders || b.pieces - a.pieces || a.name.localeCompare(b.name);
  return Array.from(byBase.values()).map((p) => ({
    name: p.name, ...totalsOf(p.rows),
    variants: Array.from(p.variants.values()).map((v) => ({ name: v.name, variant: v.variant, ...totalsOf(v.rows) })).sort(order),
  })).sort(order);
}

// Does a product (its base name) belong to a group: picked by name, or its name holds one of the group's words.
export function inGroup(g: ProductGroup, base: string): boolean {
  const b = key(base);
  if (g.products.some((p) => key(p) === b)) return true;
  return g.words.some((w) => { const k = key(w); return k.length >= 2 && b.includes(k); });
}

// Every group with its totals (each order once) and its products (a product may sit in two groups).
export function groupLines(groups: ProductGroup[], rows: ItemRow[], products: ProductLine[]): GroupLine[] {
  return groups.map((g) => ({
    id: g.id, name: g.name,
    products: products.filter((p) => inGroup(g, p.name)),
    ...totalsOf(rows.filter((r) => inGroup(g, splitName(r.product_name).base))),
  }));
}

// The watch list: the chosen products in the chosen order; one with no order in the range shows as zero.
export function watchLines(watch: string[], products: ProductLine[]): ProductLine[] {
  return watch.map((w) => products.find((p) => key(p.name) === key(w)) ?? { name: w, variants: [], ...zero() });
}

// ── Cleaning what the screen sends ─────────────────────────────────────────────────────────────────────────
const cleanText = (v: unknown, max: number) => oneLine(String(v ?? '')).replace(/[<>]/g, '').slice(0, max);
const uniq = (xs: string[]) => { const seen = new Set<string>(); return xs.filter((x) => { const k = key(x); if (!x || seen.has(k)) return false; seen.add(k); return true; }); };

export function cleanGroups(raw: unknown): { groups: ProductGroup[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'Send the list of collections' };
  if (raw.length > MAX_GROUPS) return { error: `At most ${MAX_GROUPS} collections` };
  const out: ProductGroup[] = [];
  for (let i = 0; i < raw.length; i++) {
    const g = (raw[i] && typeof raw[i] === 'object' ? raw[i] : {}) as Record<string, unknown>;
    const name = cleanText(g.name, 40);
    if (name.length < 2) return { error: `Collection ${i + 1}: give it a name` };
    const products = uniq((Array.isArray(g.products) ? g.products : []).map((p) => cleanText(p, 160))).slice(0, MAX_GROUP_PRODUCTS);
    const words = uniq((Array.isArray(g.words) ? g.words : []).map((w) => cleanText(w, 30)).filter((w) => w.length >= 2)).slice(0, MAX_WORDS);
    if (!products.length && !words.length) return { error: `"${name}": pick a product or type a word` };
    const id = /^[a-z0-9-]{4,40}$/i.test(String(g.id ?? '')) ? String(g.id) : `g${Date.now().toString(36)}${i}`;
    out.push({ id, name, products, words });
  }
  if (new Set(out.map((g) => key(g.name))).size !== out.length) return { error: 'Two collections have the same name' };
  return { groups: out };
}

// "Copy from another panel" (owner 2026-10-13: "asa same kurtiya ma bhi karde"): the other panel's collections are
// ADDED to this panel's; a name this panel already has is kept as it is (skipped), never replaced, and nothing is
// deleted. New ids, so the two panels never share one.
export function mergeGroups(mine: ProductGroup[], theirs: ProductGroup[], now = Date.now()): { groups: ProductGroup[]; added: string[]; skipped: string[] } {
  const names = new Set(mine.map((g) => key(g.name)));
  const groups = [...mine], added: string[] = [], skipped: string[] = [];
  theirs.forEach((g, i) => {
    if (names.has(key(g.name)) || groups.length >= MAX_GROUPS) { skipped.push(g.name); return; }
    names.add(key(g.name));
    groups.push({ id: `g${now.toString(36)}c${i}`, name: g.name, products: [...g.products], words: [...g.words] });
    added.push(g.name);
  });
  return { groups, added, skipped };
}

export function cleanWatch(raw: unknown): { watch: string[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'Send the list of products' };
  const watch = uniq(raw.map((p) => cleanText(p, 160)));
  if (watch.length > MAX_WATCH) return { error: `At most ${MAX_WATCH} products` };
  return { watch };
}

export interface ProductSetup { groups: ProductGroup[]; watch: string[] }
export function parseSetup(value: string | null | undefined): ProductSetup {
  try {
    const j = JSON.parse(String(value ?? '')) as Partial<ProductSetup>;
    const g = cleanGroups(j.groups ?? []);
    const w = cleanWatch(j.watch ?? []);
    return { groups: 'groups' in g ? g.groups : [], watch: 'watch' in w ? w.watch : [] };
  } catch { return { groups: [], watch: [] }; }
}
export const setupKey = (businessId: string) => `product_setup:${businessId}`;

// ── The date range, in India days ────────────────────────────────────────────────────────────────────────────
export type RangeKey = 'today' | 'yesterday' | '7d' | '30d' | 'custom';
const IST_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const istMidnight = (ms: number) => Math.floor((ms + IST_MS) / DAY_MS) * DAY_MS - IST_MS;
export const istDate = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const dateMs = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? Date.parse(`${d}T00:00:00Z`) - IST_MS : NaN);

// [from, to) in ms. custom = from / to India dates (both days counted), at most MAX_RANGE_DAYS, never in the future.
export function rangeOf(range: string | null | undefined, now: number, fromDate?: string | null, toDate?: string | null): { range: RangeKey; from: number; to: number; label: string } {
  const today = istMidnight(now);
  if (range === 'yesterday') return { range, from: today - DAY_MS, to: today, label: istDate(today - DAY_MS) };
  if (range === '7d') return { range, from: today - 6 * DAY_MS, to: today + DAY_MS, label: 'Last 7 days' };
  if (range === '30d') return { range, from: today - 29 * DAY_MS, to: today + DAY_MS, label: 'Last 30 days' };
  if (range === 'custom') {
    let f = dateMs(String(fromDate ?? '')), t = dateMs(String(toDate ?? fromDate ?? ''));
    if (Number.isFinite(f) && Number.isFinite(t)) {
      if (t < f) [f, t] = [t, f];
      t = Math.min(t, today);
      f = Math.max(f, t - (MAX_RANGE_DAYS - 1) * DAY_MS);
      return { range, from: f, to: t + DAY_MS, label: f === t ? istDate(f) : `${istDate(f)} to ${istDate(t)}` };
    }
  }
  return { range: 'today', from: today, to: today + DAY_MS, label: 'Today' };
}

export const RANGES: { key: RangeKey; label: string }[] = [
  { key: 'today', label: 'Today' }, { key: 'yesterday', label: 'Yesterday' }, { key: '7d', label: '7 days' }, { key: '30d', label: '30 days' }, { key: 'custom', label: 'Dates' },
];

// "13 Oct" / "13 Oct, 8:40 AM" in India time, for the dates the screen shows.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function dayText(ms: number): string {
  const d = istDate(ms);
  return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
}
export function timeText(ms: number): string {
  const m = Math.floor(((ms + IST_MS) % DAY_MS + DAY_MS) % DAY_MS / 60_000);
  const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, '0');
  return `${dayText(ms)}, ${h % 12 || 12}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
}
// The days a range covers: "13 Oct" or "7 Oct – 13 Oct" (the end is exclusive).
export function rangeDays(from: number, to: number): string {
  const a = dayText(from), b = dayText(to - 1);
  return a === b ? a : `${a} – ${b}`;
}

export const rupees = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`;
