'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronDown, ChevronRight, Copy, Eye, Layers, Loader2, Pencil, Plus, RefreshCw, Search, ShoppingBag, Trash2, X } from 'lucide-react';
import {
  MAX_GROUPS, MAX_WATCH, RANGES, dayText, rupees, timeText,
  type GroupLine, type ProductGroup, type ProductLine, type RangeKey, type Totals,
} from '@/lib/product-stats';

// Shopify tab (owner 2026-10-13: "shopify ka folder ... collection wise order ... apna hisab se 3-4 collection aur 4-5
// product list karke unka count"). The active panel's orders by the team's own collections, a watch list of chosen
// products, and every product with its colours / sizes. Super Admin and Manager. Reads GET /api/product-stats.
interface Stats {
  range: { range: RangeKey; label: string; days: string };
  at: string;
  totals: Totals; cancelled: number;
  products: ProductLine[]; groups: GroupLine[]; watch: ProductLine[];
  setup: { groups: ProductGroup[]; watch: string[] };
  capped: boolean;
}
type Edit = { id: string | null; name: string; words: string; products: string[]; busy: boolean; error: string };

const RANGE_KEY = 'ps_range';
const readRange = (): RangeKey => { try { const v = localStorage.getItem(RANGE_KEY); return (RANGES.some((r) => r.key === v) ? v : 'today') as RangeKey; } catch { return 'today'; } };
const n = (v: number) => v.toLocaleString('en-IN');

// When the orders behind these numbers were placed: "Orders from 7 Oct to 13 Oct · newest 13 Oct, 8:40 AM".
function Span({ t }: { t: Totals }) {
  if (t.first == null || t.last == null) return null;
  const a = dayText(t.first), b = dayText(t.last);
  return <div className="meta ps-span"><CalendarDays size={12} /> Orders from {a}{a === b ? '' : ` to ${b}`} · newest {timeText(t.last)}</div>;
}

function Figures({ t, small }: { t: Totals; small?: boolean }) {
  return (
    <div className={`ps-figs${small ? ' ps-figs-sm' : ''}`}>
      <span><b>{n(t.orders)}</b> orders</span>
      <span><b>{n(t.pieces)}</b> pcs</span>
      <span><b>{rupees(t.revenue)}</b></span>
      <span className="meta">COD {n(t.codOrders)} · {rupees(t.codRevenue)}</span>
      <span className="meta">Prepaid {n(t.prepaidOrders)} · {rupees(t.prepaidRevenue)}</span>
    </div>
  );
}

function ProductRows({ items, onWatch, watched }: { items: ProductLine[]; onWatch?: (name: string) => void; watched?: Set<string> }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!items.length) return <div className="meta" style={{ padding: '0.5rem 0' }}>No orders in these days.</div>;
  return (
    <div className="ps-rows">
      {items.map((p) => (
        <div key={p.name} className="ps-row-wrap">
          <div className="ps-row">
            <button type="button" className="ps-row-name" onClick={() => setOpen(open === p.name ? null : p.name)} aria-expanded={open === p.name} disabled={p.variants.length < 2}>
              {p.variants.length > 1 ? (open === p.name ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <span style={{ width: 14, display: 'inline-block' }} />}
              <span className="truncate">{p.name}</span>
              {p.variants.length > 1 && <span className="meta">· {p.variants.length} variants</span>}
            </button>
            <span className="ps-num">{n(p.orders)}</span>
            <span className="ps-num">{n(p.pieces)}</span>
            <span className="ps-num">{rupees(p.revenue)}</span>
            {onWatch && (
              <button type="button" className="btn btn-ghost btn-sm" title={watched?.has(p.name.toLowerCase()) ? 'On the watch list' : 'Add to the watch list'}
                disabled={watched?.has(p.name.toLowerCase())} onClick={() => onWatch(p.name)}><Eye size={13} /></button>
            )}
          </div>
          {open === p.name && (
            <div className="ps-variants">
              {p.variants.map((v) => (
                <div key={v.variant} className="ps-row ps-row-v">
                  <span className="truncate">{v.variant}</span>
                  <span className="ps-num">{n(v.orders)}</span>
                  <span className="ps-num">{n(v.pieces)}</span>
                  <span className="ps-num">{rupees(v.revenue)}</span>
                  {onWatch && <span />}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const Head = ({ watch }: { watch?: boolean }) => (
  <div className="ps-row ps-head meta"><span>Product</span><span className="ps-num">Orders</span><span className="ps-num">Pieces</span><span className="ps-num">₹</span>{watch && <span />}</div>
);

export default function ProductStatsCard({ token, panelId, panelName, panels, onAlert }: {
  token: string; panelId: string; panelName: string;
  panels: { id: string; name: string }[];   // the other panels this login sees: "Copy from" lists them
  onAlert: (type: 'success' | 'error', message: string) => void;
}) {
  const [range, setRangeState] = useState<RangeKey>('today');
  const [from, setFrom] = useState(''), [to, setTo] = useState('');
  const [data, setData] = useState<Stats | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(40);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [pick, setPick] = useState('');
  const [watchPick, setWatchPick] = useState('');
  const [copying, setCopying] = useState(false);
  useEffect(() => { setRangeState(readRange()); }, []);
  const setRange = (r: RangeKey) => { setRangeState(r); try { localStorage.setItem(RANGE_KEY, r); } catch { /* private window */ } };

  const load = useCallback(async (quiet = false) => {
    if (!token || !panelId) return;
    if (range === 'custom' && !from) return;
    if (!quiet) setBusy(true);
    try {
      const qs = new URLSearchParams({ businessId: panelId, range });
      if (range === 'custom') { qs.set('from', from); qs.set('to', to || from); }
      const res = await fetch(`/api/product-stats?${qs}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j.error || 'Could not read the orders'); setData(null); return; }
      setData(j as Stats); setErr('');
    } catch { setErr('Could not read the orders'); }
    finally { setBusy(false); }
  }, [token, panelId, range, from, to]);
  useEffect(() => { void load(); }, [load]);

  const save = async (body: { groups?: ProductGroup[]; watch?: string[]; copyFrom?: string }) => {
    const res = await fetch('/api/product-stats', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ businessId: panelId, ...body }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || 'Could not save');
    await load(true);
    return j as { copied?: { added: string[]; skipped: string[] } };
  };
  const copyFrom = async (id: string) => {
    const src = panels.find((p) => p.id === id);
    if (!src || !confirm(`Add ${src.name}'s collections to ${panelName}? Collections ${panelName} already has (same name) stay as they are; nothing is deleted.`)) return;
    setCopying(true);
    try {
      const j = await save({ copyFrom: id });
      const added = j.copied?.added ?? [], skipped = j.copied?.skipped ?? [];
      onAlert('success', added.length ? `Added ${added.join(', ')} from ${src.name}${skipped.length ? ` (already here: ${skipped.join(', ')})` : ''}` : `Nothing new: ${panelName} already has ${skipped.join(', ')}`);
    } catch (e) { onAlert('error', (e as Error).message); }
    finally { setCopying(false); }
  };
  const others = panels.filter((p) => p.id !== panelId);

  const groups = data?.setup.groups ?? [];
  const watch = data?.setup.watch ?? [];
  const watched = useMemo(() => new Set(watch.map((w) => w.toLowerCase())), [watch]);
  const productNames = useMemo(() => (data?.products ?? []).map((p) => p.name), [data]);
  const list = useMemo(() => {
    const k = q.trim().toLowerCase();
    return (data?.products ?? []).filter((p) => !k || p.name.toLowerCase().includes(k) || p.variants.some((v) => v.variant.toLowerCase().includes(k)));
  }, [data, q]);

  const addWatch = async (name: string) => {
    if (watch.length >= MAX_WATCH) { onAlert('error', `At most ${MAX_WATCH} products on the watch list`); return; }
    try { await save({ watch: [...watch, name] }); setWatchPick(''); onAlert('success', `Watching ${name}`); } catch (e) { onAlert('error', (e as Error).message); }
  };
  const dropWatch = async (name: string) => {
    try { await save({ watch: watch.filter((w) => w.toLowerCase() !== name.toLowerCase()) }); } catch (e) { onAlert('error', (e as Error).message); }
  };
  const saveGroup = async () => {
    if (!edit) return;
    const g: ProductGroup = { id: edit.id || '', name: edit.name.trim(), products: edit.products, words: edit.words.split(',').map((w) => w.trim()).filter(Boolean) };
    const next = edit.id ? groups.map((x) => (x.id === edit.id ? g : x)) : [...groups, g];
    setEdit({ ...edit, busy: true, error: '' });
    try { await save({ groups: next }); setEdit(null); onAlert('success', `Collection "${g.name}" saved`); } catch (e) { setEdit({ ...edit, busy: false, error: (e as Error).message }); }
  };
  const dropGroup = async (g: GroupLine) => {
    if (!confirm(`Delete the collection "${g.name}"? Orders are not touched.`)) return;
    try { await save({ groups: groups.filter((x) => x.id !== g.id) }); } catch (e) { onAlert('error', (e as Error).message); }
  };

  if (!panelId) return <div className="tl-empty">Pick a panel from the panel switcher to see its orders by product.</div>;
  const t = data?.totals;
  const pickList = productNames.filter((p) => !pick.trim() || p.toLowerCase().includes(pick.trim().toLowerCase())).slice(0, 12);
  const watchList = productNames.filter((p) => !watched.has(p.toLowerCase()) && watchPick.trim() && p.toLowerCase().includes(watchPick.trim().toLowerCase())).slice(0, 8);

  return (
    <div className="ps-wrap">
      <div className="ps-top">
        <ShoppingBag size={20} style={{ color: 'var(--primary)' }} />
        <h2 className="ps-title">Shopify · {panelName}</h2>
        <div className="seg" style={{ marginTop: 0 }}>
          {RANGES.map((r) => <button key={r.key} type="button" className="seg-btn" aria-pressed={range === r.key} onClick={() => setRange(r.key)}>{r.label}</button>)}
        </div>
        {range === 'custom' && (
          <span className="ps-dates">
            <input type="date" className="form-input" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
            <span className="meta">to</span>
            <input type="date" className="form-input" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
          </span>
        )}
        <button type="button" className="btn btn-outline btn-sm" onClick={() => load()} disabled={busy}><RefreshCw size={14} /> Refresh</button>
      </div>
      {err && <div className="chat-note" style={{ color: 'var(--danger)' }}>{err}</div>}
      {range === 'custom' && !from && <div className="meta">Pick the dates.</div>}
      {!data && !err && busy && <div className="tl-empty"><Loader2 size={18} style={{ animation: 'spin 0.6s linear infinite' }} /></div>}
      {data && t && (
        <>
          <div className="ps-card ps-total">
            <div className="meta">{data.range.range === 'custom' ? data.range.days : `${data.range.range === 'yesterday' ? 'Yesterday' : data.range.label} (${data.range.days})`} · orders placed, not cancelled{data.cancelled ? ` · ${n(data.cancelled)} cancelled not counted` : ''} · updated {timeText(Date.parse(data.at))}</div>
            <Figures t={t} />
            <Span t={t} />
            {data.capped && <div className="meta" style={{ color: 'var(--warning)' }}>Too many lines for these days: pick fewer days for exact numbers.</div>}
          </div>

          {/* Collections */}
          <div className="ps-section-head">
            <Layers size={16} /><h3>Collections</h3>
            <span className="chip chip-info"><CalendarDays size={11} /> {data.range.days}</span>
            <span className="meta">Your own groups: pick products or type words like &ldquo;jhumka&rdquo;. An order counts once in a collection.</span>
            {others.length > 0 && (
              <select className="form-input ps-copy" value="" disabled={copying} aria-label="Copy collections from another panel" onChange={(e) => { if (e.target.value) void copyFrom(e.target.value); }}>
                <option value="">{copying ? 'Copying…' : 'Copy from panel…'}</option>
                {others.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
            {groups.length < MAX_GROUPS && <button type="button" className="btn btn-primary btn-sm" onClick={() => { setEdit({ id: null, name: '', words: '', products: [], busy: false, error: '' }); setPick(''); }}><Plus size={13} /> New collection</button>}
          </div>
          {data.groups.length === 0 && !edit && <div className="meta">No collection yet. Make one, for example &ldquo;Jhumka&rdquo; with the word jhumka.</div>}
          <div className="ps-groups">
            {data.groups.map((g) => (
              <div key={g.id} className="ps-card">
                <div className="ps-group-top">
                  <button type="button" className="ps-group-name" onClick={() => setOpenGroup(openGroup === g.id ? null : g.id)} aria-expanded={openGroup === g.id}>
                    {openGroup === g.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {g.name} <span className="meta">· {g.products.length} {g.products.length === 1 ? 'product' : 'products'}</span>
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" title="Edit" onClick={() => { const s = groups.find((x) => x.id === g.id); if (s) { setEdit({ id: s.id, name: s.name, words: s.words.join(', '), products: s.products, busy: false, error: '' }); setPick(''); } }}><Pencil size={13} /></button>
                  <button type="button" className="btn btn-ghost btn-sm" title="Delete" onClick={() => dropGroup(g)}><Trash2 size={13} /></button>
                </div>
                <Figures t={g} small />
                {g.orders > 0 ? <Span t={g} /> : <div className="meta ps-span"><CalendarDays size={12} /> No orders in {data.range.days}</div>}
                {openGroup === g.id && <><Head /><ProductRows items={g.products} /></>}
              </div>
            ))}
          </div>
          {edit && (
            <div className="ps-card ps-edit">
              <div className="ps-group-top"><b>{edit.id ? 'Edit collection' : 'New collection'}</b><button type="button" className="btn btn-ghost btn-sm" onClick={() => setEdit(null)} aria-label="Close"><X size={14} /></button></div>
              <label className="meta">Name</label>
              <input className="form-input" value={edit.name} maxLength={40} placeholder="Jhumka" onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
              <label className="meta">Words (comma between them): every product whose name has one of them</label>
              <input className="form-input" value={edit.words} placeholder="jhumka, earring" onChange={(e) => setEdit({ ...edit, words: e.target.value })} />
              <label className="meta">Or pick products ({edit.products.length} picked) · the list shows products ordered in the chosen days</label>
              <div className="ps-chips">
                {edit.products.map((p) => <span key={p} className="chip chip-info">{p} <button type="button" className="ps-x" onClick={() => setEdit({ ...edit, products: edit.products.filter((x) => x !== p) })} aria-label={`Remove ${p}`}><X size={11} /></button></span>)}
              </div>
              <div className="ps-search"><Search size={14} /><input className="form-input" value={pick} placeholder="Search a product to add" onChange={(e) => setPick(e.target.value)} /></div>
              {pick.trim() && (
                <div className="ps-picks">
                  {pickList.filter((p) => !edit.products.includes(p)).map((p) => <button key={p} type="button" className="btn btn-outline btn-sm" onClick={() => setEdit({ ...edit, products: [...edit.products, p] })}><Plus size={12} /> {p}</button>)}
                  {pickList.length === 0 && <span className="meta">No product with that name in these days.</span>}
                </div>
              )}
              {edit.error && <div className="meta" style={{ color: 'var(--danger)' }}>{edit.error}</div>}
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button type="button" className="btn btn-primary btn-sm" disabled={edit.busy} onClick={saveGroup}>{edit.busy ? <Loader2 size={13} style={{ animation: 'spin 0.6s linear infinite' }} /> : null} Save</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEdit(null)}>Cancel</button>
              </div>
            </div>
          )}

          {/* Watch list */}
          <div className="ps-section-head">
            <Eye size={16} /><h3>Watch list</h3>
            <span className="meta">The products you want to keep an eye on ({watch.length}/{MAX_WATCH}).</span>
          </div>
          <div className="ps-card">
            <div className="ps-search"><Search size={14} /><input className="form-input" value={watchPick} placeholder="Add a product: type its name" onChange={(e) => setWatchPick(e.target.value)} /></div>
            {watchList.length > 0 && <div className="ps-picks">{watchList.map((p) => <button key={p} type="button" className="btn btn-outline btn-sm" onClick={() => addWatch(p)}><Plus size={12} /> {p}</button>)}</div>}
            {data.watch.length > 0 && (
              <>
                <Head watch />
                {data.watch.map((p) => (
                  <div key={p.name} className="ps-watch-line">
                    <ProductRows items={[p]} />
                    <button type="button" className="btn btn-ghost btn-sm" title="Remove from the watch list" onClick={() => dropWatch(p.name)}><X size={13} /></button>
                  </div>
                ))}
              </>
            )}
            {data.watch.length === 0 && <div className="meta">Nothing on the watch list yet. Type a product above, or press the eye on a product below.</div>}
          </div>

          {/* All products */}
          <div className="ps-section-head">
            <ShoppingBag size={16} /><h3>All products</h3>
            <span className="meta">{n(data.products.length)} products · biggest first · a product with several colours / sizes opens into them</span>
          </div>
          <div className="ps-card">
            <div className="ps-search"><Search size={14} /><input className="form-input" value={q} placeholder="Search products or a colour / size" onChange={(e) => { setQ(e.target.value); setShown(40); }} /></div>
            <Head watch />
            <ProductRows items={list.slice(0, shown)} onWatch={addWatch} watched={watched} />
            {list.length > shown && <button type="button" className="btn btn-outline btn-sm" onClick={() => setShown(shown + 60)}>Show more ({n(list.length - shown)})</button>}
          </div>
        </>
      )}
    </div>
  );
}
