'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, ChevronLeft, ChevronRight, GripVertical, Landmark, Loader2, Palette, Pencil, Plus, RefreshCw, Search, Trash2,
  UserPlus, UserRound, X,
} from 'lucide-react';
import {
  COLORS, DEFAULT_GATEWAYS, EMPTY_BRAND, LIMITS, MAX_FIELDS, founderGroups, labelOf, matchesSearch, missingGateways, moveCard,
  nameKey, uniqueFounders, type BrandField, type BrandInput, type BrandRow, type FieldErrors,
} from '@/lib/brand-directory-rules';

// Payments > Brand Directory (owner 2026-10-17: "ek payment ka section ... sirf super admin"). Every brand with its
// founder / owner, bank account name and up to 10 fields the owner names himself. Super Admin only; reads and
// writes /api/brand-directory. Nothing here is kept in the browser: every change is saved in the database first.
// Owner, same day: "founders mix nahi ... har founder ka alag cube, andar ghus ke uske saare brands": the first view is
// one tile per founder; a click opens that founder and shows only their brands.
// Owner, same evening: a card is dragged to another place (arrows on a phone), coloured, carries up to 10 fields,
// and a new founder starts with the 11 payment gateway cards (DEFAULT_GATEWAYS).
type Alert = (type: 'success' | 'error', message: string) => void;
type Form = { id: string | null; values: BrandInput; errors: FieldErrors; error: string; busy: boolean; withGateways: boolean };
type FounderForm = { name: string; error: string; busy: boolean };

const TEXT_FIELDS: { key: 'founderName' | 'brandName' | 'bankAccountName'; label: string; max: number; required?: boolean; placeholder: string }[] = [
  { key: 'founderName', label: 'Founder / Owner name', max: LIMITS.founder, required: true, placeholder: 'e.g. Sunny' },
  { key: 'brandName', label: 'Brand name', max: LIMITS.brand, required: true, placeholder: 'e.g. Jiva' },
  { key: 'bankAccountName', label: 'Bank account name', max: LIMITS.bank, placeholder: 'Name on the bank account' },
];
const GATEWAY_LIST = DEFAULT_GATEWAYS.join(', ');
const spin = { animation: 'spin 0.6s linear infinite' };

export default function BrandDirectoryCard({ token, onAlert }: { token: string; onAlert: Alert }) {
  const [brands, setBrands] = useState<BrandRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notInstalled, setNotInstalled] = useState('');
  const [q, setQ] = useState('');
  const [form, setForm] = useState<Form | null>(null);
  const [founderForm, setFounderForm] = useState<FounderForm | null>(null);
  const [toDelete, setToDelete] = useState<BrandRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [founder, setFounder] = useState<string | null>(null);   // nameKey of the open founder, null = all founders
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [paletteFor, setPaletteFor] = useState<string | null>(null);
  const [gatewaysBusy, setGatewaysBusy] = useState(false);

  const headers = useMemo(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);

  const load = useCallback(async () => {
    setLoading(true); setLoadError('');
    try {
      const res = await fetch('/api/brand-directory', { headers, cache: 'no-store' });
      const d = await res.json().catch(() => ({}));
      if (res.status === 503 && d.notInstalled) { setNotInstalled(d.error || 'Brand Directory is not installed yet: run brand-directory.sql once on the server'); setBrands([]); return; }
      if (!res.ok) { setLoadError(d.error || 'Could not load the brands'); return; }
      setNotInstalled('');
      setBrands(Array.isArray(d.brands) ? d.brands : []);
    } catch {
      setLoadError('Could not reach ShipTrack. Check the internet and try again.');
    } finally { setLoading(false); }
  }, [headers]);

  useEffect(() => { void load(); }, [load]);

  const founders = useMemo(() => uniqueFounders(brands), [brands]);
  const allGroups = useMemo(() => founderGroups(brands), [brands]);
  const groups = useMemo(() => founderGroups(brands.filter((b) => matchesSearch(b, q))), [brands, q]);
  const openGroup = founder ? allGroups.find((g) => g.key === founder) || null : null;
  const shown = openGroup ? openGroup.brands.filter((b) => matchesSearch(b, q)) : [];
  const missing = openGroup ? missingGateways(openGroup.brands) : [];
  const canMove = !!openGroup && !q.trim() && openGroup.brands.length > 1;
  // The open founder's last brand deleted or renamed away: back to all founders.
  useEffect(() => { if (founder && !loading && !openGroup) setFounder(null); }, [founder, loading, openGroup]);

  const merge = (rows: BrandRow[]) => setBrands((list) => {
    const byId = new Map(list.map((b) => [b.id, b]));
    for (const r of rows) byId.set(r.id, r);
    return [...byId.values()];
  });

  const isNewFounder = (name: string) => !!nameKey(name) && !allGroups.some((g) => g.key === nameKey(name));

  const openAdd = () => setForm({
    id: null, values: { ...EMPTY_BRAND, founderName: openGroup?.name || '', fields: [{ label: '', value: '' }] },
    errors: {}, error: '', busy: false, withGateways: true,
  });
  const openEdit = (b: BrandRow) => setForm({
    id: b.id, errors: {}, error: '', busy: false, withGateways: false,
    values: {
      founderName: b.founderName, brandName: b.brandName, bankAccountName: b.bankAccountName, color: b.color,
      fields: b.fields.length ? b.fields.map((f) => ({ ...f })) : [{ label: '', value: '' }],
    },
  });
  const setText = (k: 'founderName' | 'brandName' | 'bankAccountName', v: string) =>
    setForm((f) => f && { ...f, values: { ...f.values, [k]: v }, errors: { ...f.errors, [k]: undefined }, error: '' });
  const setFields = (fn: (list: BrandField[]) => BrandField[]) =>
    setForm((f) => f && { ...f, values: { ...f.values, fields: fn(f.values.fields) }, errors: { ...f.errors, fields: undefined }, error: '' });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form || form.busy) return;
    const errors: FieldErrors = {};
    if (!form.values.founderName.trim()) errors.founderName = 'Founder / Owner name is required';
    if (!form.values.brandName.trim()) errors.brandName = 'Brand name is required';
    if (Object.keys(errors).length) { setForm({ ...form, errors }); return; }
    const fields = form.values.fields.filter((f) => f.label.trim() || f.value.trim());
    const withGateways = !form.id && form.withGateways && isNewFounder(form.values.founderName);
    setForm({ ...form, busy: true, error: '' });
    try {
      const res = await fetch(form.id ? `/api/brand-directory/${form.id}` : '/api/brand-directory', {
        method: form.id ? 'PATCH' : 'POST', headers,
        body: JSON.stringify({ ...form.values, fields, ...(withGateways ? { withGateways: true } : {}) }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.brand) {
        setForm((f) => f && { ...f, busy: false, errors: d.fields || {}, error: d.error || 'Could not save' });
        return;
      }
      const saved: BrandRow = d.brand;
      const added: BrandRow[] = Array.isArray(d.added) ? d.added : [];
      merge([saved, ...added]);
      onAlert('success', form.id ? `${saved.brandName} saved`
        : added.length ? `${saved.brandName} added, with ${added.length} payment gateway cards` : `${saved.brandName} added`);
      if (founder || added.length) setFounder(nameKey(saved.founderName));   // follow the brand (a renamed / new founder)
      setForm(null);
    } catch {
      setForm((f) => f && { ...f, busy: false, error: 'Could not reach ShipTrack. Nothing was saved; try again.' });
    }
  };

  // A new founder = the 11 payment gateway cards at once (also: the ones an open founder still lacks).
  const addGateways = async (name: string): Promise<{ ok: boolean; error?: string; added?: BrandRow[] }> => {
    try {
      const res = await fetch('/api/brand-directory', { method: 'POST', headers, body: JSON.stringify({ action: 'founder', founderName: name }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: d.error || 'Could not save' };
      const added: BrandRow[] = Array.isArray(d.added) ? d.added : [];
      merge(added);
      return { ok: true, added };
    } catch { return { ok: false, error: 'Could not reach ShipTrack. Nothing was saved; try again.' }; }
  };

  const saveFounder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!founderForm || founderForm.busy) return;
    const name = founderForm.name.trim();
    if (!name) { setFounderForm({ ...founderForm, error: 'Founder / Owner name is required' }); return; }
    setFounderForm({ ...founderForm, busy: true, error: '' });
    const r = await addGateways(name);
    if (!r.ok) { setFounderForm((f) => f && { ...f, busy: false, error: r.error || 'Could not save' }); return; }
    const n = r.added?.length || 0;
    onAlert('success', n ? `${name} added with ${n} payment gateway cards` : `${name} already has all ${DEFAULT_GATEWAYS.length} gateway cards`);
    setFounder(nameKey(name));
    setFounderForm(null);
  };

  const addMissing = async () => {
    if (!openGroup || gatewaysBusy) return;
    setGatewaysBusy(true);
    const r = await addGateways(openGroup.name);
    setGatewaysBusy(false);
    if (!r.ok) { onAlert('error', r.error || 'Could not save'); return; }
    onAlert('success', `${r.added?.length || 0} gateway cards added for ${openGroup.name}`);
  };

  // A card dropped on another takes its place; saved at once (the whole founder's order).
  const reorder = async (fromId: string | null, toId: string) => {
    setDrag(null); setOver(null);
    if (!openGroup || !fromId || fromId === toId) return;
    const next = moveCard(openGroup.brands, fromId, toId);
    if (next === openGroup.brands) return;
    const place = new Map(next.map((b, i) => [b.id, i]));
    setBrands((list) => list.map((b) => (place.has(b.id) ? { ...b, sortOrder: place.get(b.id) as number } : b)));
    try {
      const res = await fetch('/api/brand-directory', { method: 'POST', headers, body: JSON.stringify({ action: 'order', ids: next.map((b) => b.id) }) });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        onAlert('error', d.error || 'Could not save the new order');
        void load();
      }
    } catch {
      onAlert('error', 'Could not reach ShipTrack. The order was not saved.');
      void load();
    }
  };
  const nudge = (b: BrandRow, step: -1 | 1) => {
    if (!openGroup) return;
    const i = openGroup.brands.findIndex((x) => x.id === b.id);
    const to = openGroup.brands[i + step];
    if (to) void reorder(b.id, to.id);
  };

  const recolor = async (b: BrandRow, color: string) => {
    setPaletteFor(null);
    if (b.color === color) return;
    setBrands((list) => list.map((x) => (x.id === b.id ? { ...x, color } : x)));
    try {
      const res = await fetch(`/api/brand-directory/${b.id}`, { method: 'PATCH', headers, body: JSON.stringify({ color }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.brand) { onAlert('error', d.error || 'Could not save the colour'); void load(); return; }
      merge([d.brand]);
    } catch {
      onAlert('error', 'Could not reach ShipTrack. The colour was not saved.');
      void load();
    }
  };

  const remove = async () => {
    if (!toDelete || deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/brand-directory/${toDelete.id}`, { method: 'DELETE', headers });
      const d = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 404) { onAlert('error', d.error || 'Could not delete'); return; }
      setBrands((list) => list.filter((b) => b.id !== toDelete.id));
      onAlert('success', `${toDelete.brandName} deleted`);
      setToDelete(null);
    } catch {
      onAlert('error', 'Could not reach ShipTrack. Nothing was deleted; try again.');
    } finally { setDeleting(false); }
  };

  const shownFields = (b: BrandRow) => b.fields.map((f, i) => ({ ...f, n: i + 1 })).filter((f) => f.label || f.value);

  return (
    <div className="bd-wrap">
      <div className="bd-head">
        <div className="bd-titles">
          <h2 className="bd-title"><Landmark size={20} /> Brand Directory</h2>
          <p className="meta">Founder &amp; Bank Account Management</p>
        </div>
        <div className="bd-stats">
          <div className="bd-stat"><b>{brands.length}</b><span>Total Brands</span></div>
          <div className="bd-stat"><b>{founders}</b><span>Unique Founders</span></div>
        </div>
      </div>

      <div className="bd-bar">
        <div className="bd-search">
          <Search size={15} />
          <input className="form-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search founder, brand, bank or fields" aria-label="Search brands" />
          {q && <button type="button" className="bd-clear" onClick={() => setQ('')} aria-label="Clear search"><X size={14} /></button>}
        </div>
        <button type="button" className="btn btn-outline bd-refresh" onClick={() => void load()} disabled={loading} aria-label="Refresh"><RefreshCw size={14} /></button>
        {!openGroup && (
          <button type="button" className="btn btn-outline bd-add" onClick={() => setFounderForm({ name: '', error: '', busy: false })} disabled={!!notInstalled}>
            <UserPlus size={15} /> Add Founder
          </button>
        )}
        <button type="button" className="btn btn-primary bd-add" onClick={openAdd} disabled={!!notInstalled}><Plus size={15} /> {openGroup ? `Add brand for ${openGroup.name}` : 'Add Brand'}</button>
      </div>

      {loading && !brands.length ? (
        <div className="bd-empty"><Loader2 size={20} style={spin} /> Loading brands…</div>
      ) : notInstalled ? (
        <div className="bd-empty bd-warn">{notInstalled}. Then press Refresh.</div>
      ) : loadError ? (
        <div className="bd-empty bd-warn">{loadError} <button type="button" className="btn btn-outline" onClick={() => void load()}>Try again</button></div>
      ) : !brands.length ? (
        <div className="bd-empty">No brands yet. Press <b>Add Founder</b>: the {DEFAULT_GATEWAYS.length} payment gateway cards are made for them.</div>
      ) : !openGroup ? (
        !groups.length ? <div className="bd-empty">No brand matches “{q}”.</div> : (
          <div className="bd-founders">
            {groups.map((g) => (
              <button key={g.key} type="button" className="bd-founder" onClick={() => setFounder(g.key)}>
                <span className="bd-avatar">{g.name.slice(0, 1).toUpperCase()}</span>
                <span className="bd-fname">{g.name}</span>
                <span className="bd-fcount">{g.brands.length} {g.brands.length === 1 ? 'brand' : 'brands'}{q ? ' match' : ''}</span>
                <span className="bd-fbrands">{g.brands.map((b) => <span key={b.id} className={`bd-chip${b.color ? ` bd-c-${b.color}` : ''}`}>{b.brandName}</span>)}</span>
                <span className="bd-open">Open <ChevronRight size={14} /></span>
              </button>
            ))}
          </div>
        )
      ) : (<>
        <div className="bd-crumb">
          <button type="button" className="btn btn-outline bd-back" onClick={() => { setFounder(null); setPaletteFor(null); }}><ArrowLeft size={14} /> All founders</button>
          <h3 className="bd-ftitle"><UserRound size={18} /> {openGroup.name}</h3>
          <span className="meta">{openGroup.brands.length} {openGroup.brands.length === 1 ? 'brand' : 'brands'}</span>
          {missing.length > 0 && (
            <button type="button" className="btn btn-outline bd-back" onClick={() => void addMissing()} disabled={gatewaysBusy} title={missing.join(', ')}>
              {gatewaysBusy ? <Loader2 size={14} style={spin} /> : <Plus size={14} />} Add the {missing.length} missing gateway{missing.length === 1 ? '' : 's'}
            </button>
          )}
        </div>
        {canMove && <p className="meta bd-hint">Drag a card to move it. On a phone, use the arrows.</p>}
        {!shown.length ? <div className="bd-empty">No brand of {openGroup.name} matches “{q}”.</div> : (
        <div className="bd-grid">
          {shown.map((b, i) => (
            <div
              key={b.id}
              className={`bd-card${b.color ? ` bd-c-${b.color}` : ''}${drag === b.id ? ' bd-dragging' : ''}${over === b.id && drag !== b.id ? ' bd-over' : ''}`}
              draggable={canMove}
              onDragStart={canMove ? (e) => { setDrag(b.id); setPaletteFor(null); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', b.id); } : undefined}
              onDragOver={canMove ? (e) => { if (!drag) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== b.id) setOver(b.id); } : undefined}
              onDrop={canMove ? (e) => { e.preventDefault(); void reorder(drag, b.id); } : undefined}
              onDragEnd={canMove ? () => { setDrag(null); setOver(null); } : undefined}
            >
              <div className="bd-cardtop">
                <div className="bd-row"><span className="bd-k">Founder / Owner</span><span className="bd-v">{b.founderName}</span></div>
                <div className="bd-tools">
                  {canMove && <span className="bd-grip" title="Drag to move" aria-hidden><GripVertical size={16} /></span>}
                  {canMove && (
                    <span className="bd-move">
                      <button type="button" onClick={() => nudge(b, -1)} disabled={i === 0} aria-label={`Move ${b.brandName} back`}><ChevronLeft size={14} /></button>
                      <button type="button" onClick={() => nudge(b, 1)} disabled={i === shown.length - 1} aria-label={`Move ${b.brandName} forward`}><ChevronRight size={14} /></button>
                    </span>
                  )}
                  <button type="button" className="bd-palbtn" onClick={() => setPaletteFor(paletteFor === b.id ? null : b.id)} aria-label={`Colour of ${b.brandName}`} aria-expanded={paletteFor === b.id}><Palette size={15} /></button>
                </div>
              </div>
              {paletteFor === b.id && (
                <div className="bd-palette" role="group" aria-label="Card colour">
                  {COLORS.map((c) => (
                    <button key={c.key || 'none'} type="button" className={`bd-swatch${c.key ? ` bd-c-${c.key}` : ' bd-sw-none'}${b.color === c.key ? ' on' : ''}`} title={c.name} aria-label={c.name} onClick={() => void recolor(b, c.key)} />
                  ))}
                </div>
              )}
              <div className="bd-row"><span className="bd-k">Brand Name</span><span className="bd-v bd-brand">{b.brandName}</span></div>
              <div className="bd-row"><span className="bd-k">Bank Account Name</span><span className={`bd-v${b.bankAccountName ? '' : ' bd-none'}`}>{b.bankAccountName || '—'}</span></div>
              {shownFields(b).length ? shownFields(b).map((f) => (
                <div key={f.n} className="bd-row bd-custom"><span className="bd-k">{labelOf(f.label, f.n)}</span><span className={`bd-v${f.value ? '' : ' bd-none'}`}>{f.value || '—'}</span></div>
              )) : <div className="bd-nofields">No details yet. Press Edit to add up to {MAX_FIELDS} fields.</div>}
              <div className="bd-actions">
                <button type="button" className="btn btn-outline" onClick={() => openEdit(b)}><Pencil size={13} /> Edit</button>
                <button type="button" className="btn btn-outline bd-del" onClick={() => setToDelete(b)}><Trash2 size={13} /> Delete</button>
              </div>
            </div>
          ))}
        </div>
        )}
      </>)}

      {form && (
        <div className="modal-overlay" onClick={() => { if (!form.busy) setForm(null); }}>
          <form className="modal bd-modal" onClick={(e) => e.stopPropagation()} onSubmit={save} autoComplete="off" noValidate>
            <div className="modal-header"><h3 className="modal-title">{form.id ? 'Edit brand' : 'Add Brand'}</h3></div>
            <div className="bd-form">
              {TEXT_FIELDS.map((f) => (
                <div key={f.key} className="form-group">
                  <label className="form-label" htmlFor={`bd-${f.key}`}>{f.label}{f.required ? ' *' : ' (optional)'}</label>
                  <input id={`bd-${f.key}`} className="form-input" value={form.values[f.key]} maxLength={f.max} placeholder={f.placeholder}
                    onChange={(e) => setText(f.key, e.target.value)} aria-invalid={!!form.errors[f.key]} autoFocus={f.key === 'founderName'} />
                  {form.errors[f.key] && <p className="bd-err" role="alert">{form.errors[f.key]}</p>}
                </div>
              ))}
              {!form.id && isNewFounder(form.values.founderName) && (
                <label className="bd-tick">
                  <input type="checkbox" checked={form.withGateways} onChange={(e) => setForm((f) => f && { ...f, withGateways: e.target.checked })} />
                  <span>New founder: also make the {DEFAULT_GATEWAYS.length} payment gateway cards ({GATEWAY_LIST})</span>
                </label>
              )}
              <div className="form-group">
                <span className="form-label">Card colour</span>
                <div className="bd-palette bd-palette-form" role="radiogroup" aria-label="Card colour">
                  {COLORS.map((c) => (
                    <button key={c.key || 'none'} type="button" role="radio" aria-checked={form.values.color === c.key}
                      className={`bd-swatch${c.key ? ` bd-c-${c.key}` : ' bd-sw-none'}${form.values.color === c.key ? ' on' : ''}`} title={c.name} aria-label={c.name}
                      onClick={() => setForm((f) => f && { ...f, values: { ...f.values, color: c.key } })} />
                  ))}
                </div>
              </div>
              <fieldset className="bd-fieldset">
                <legend>Fields (optional, up to {MAX_FIELDS})</legend>
                {form.values.fields.map((f, i) => (
                  <div key={i} className="bd-pair">
                    <input className="form-input" value={f.label} maxLength={LIMITS.label} placeholder={i === 0 ? 'Label, e.g. MID' : i === 1 ? 'Label, e.g. GST Firm' : `Label ${i + 1}`} aria-label={`Field ${i + 1} label`}
                      onChange={(e) => setFields((list) => list.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                    <input className="form-input" value={f.value} maxLength={LIMITS.value} placeholder="Value" aria-label={`Field ${i + 1} value`}
                      onChange={(e) => setFields((list) => list.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                    <button type="button" className="bd-rmfield" onClick={() => setFields((list) => list.filter((_, j) => j !== i))} aria-label={`Remove field ${i + 1}`}><X size={14} /></button>
                  </div>
                ))}
                {form.values.fields.length < MAX_FIELDS && (
                  <button type="button" className="btn btn-outline bd-addfield" onClick={() => setFields((list) => [...list, { label: '', value: '' }])}>
                    <Plus size={13} /> Add field ({form.values.fields.length}/{MAX_FIELDS})
                  </button>
                )}
                {form.errors.fields && <p className="bd-err" role="alert">{form.errors.fields}</p>}
              </fieldset>
              {form.error && !Object.values(form.errors).some(Boolean) && <p className="bd-err" role="alert">{form.error}</p>}
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setForm(null)} disabled={form.busy}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={form.busy}>
                  {form.busy ? <Loader2 size={14} style={spin} /> : null} {form.id ? 'Save Changes' : 'Add Brand'}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {founderForm && (
        <div className="modal-overlay" onClick={() => { if (!founderForm.busy) setFounderForm(null); }}>
          <form className="modal bd-modal" onClick={(e) => e.stopPropagation()} onSubmit={saveFounder} autoComplete="off" noValidate>
            <div className="modal-header"><h3 className="modal-title">Add Founder</h3></div>
            <div className="bd-form">
              <div className="form-group">
                <label className="form-label" htmlFor="bd-newfounder">Founder / Owner name *</label>
                <input id="bd-newfounder" className="form-input" value={founderForm.name} maxLength={LIMITS.founder} placeholder="e.g. Sunny" autoFocus
                  onChange={(e) => setFounderForm((f) => f && { ...f, name: e.target.value, error: '' })} aria-invalid={!!founderForm.error} />
              </div>
              <p className="meta">These {DEFAULT_GATEWAYS.length} cards are made for them, empty, ready to fill: {GATEWAY_LIST}.
                {!isNewFounder(founderForm.name) && founderForm.name.trim() ? ' This founder is already here: only the cards they do not have yet are added.' : ''}</p>
              {founderForm.error && <p className="bd-err" role="alert">{founderForm.error}</p>}
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setFounderForm(null)} disabled={founderForm.busy}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={founderForm.busy}>
                  {founderForm.busy ? <Loader2 size={14} style={spin} /> : <UserPlus size={14} />} Add Founder
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {toDelete && (
        <div className="modal-overlay" onClick={() => { if (!deleting) setToDelete(null); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="alertdialog" aria-labelledby="bd-del-title">
            <div className="modal-header"><h3 className="modal-title" id="bd-del-title">Delete {toDelete.brandName}?</h3></div>
            <p className="meta" style={{ marginBottom: '1rem' }}>Only this brand and its details are removed. Other brands, and other brands of {toDelete.founderName}, stay as they are. This cannot be undone.</p>
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => setToDelete(null)} disabled={deleting}>Cancel</button>
              <button type="button" className="btn btn-primary bd-del-confirm" onClick={() => void remove()} disabled={deleting}>
                {deleting ? <Loader2 size={14} style={spin} /> : <Trash2 size={14} />} Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
