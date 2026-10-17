'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ChevronRight, Landmark, Loader2, Pencil, Plus, RefreshCw, Search, Trash2, UserRound, X } from 'lucide-react';
import {
  EMPTY_BRAND, LIMITS, founderGroups, labelOf, matchesSearch, nameKey, uniqueFounders,
  type BrandInput, type BrandRow, type FieldErrors,
} from '@/lib/brand-directory-rules';

// Payments > Brand Directory (owner 2026-10-17: "ek payment ka section ... sirf super admin"). Every brand with its
// founder / owner, bank account name and two fields the owner names himself. Super Admin only; reads and writes
// /api/brand-directory. Nothing here is kept in the browser: every change is saved in the database first.
// Owner, same day: "founders mix nahi ... har founder ka alag cube, andar ghus ke uske saare brands": the first view is
// one tile per founder; a click opens that founder and shows only their brands.
type Alert = (type: 'success' | 'error', message: string) => void;
type Form = { id: string | null; values: BrandInput; errors: FieldErrors; error: string; busy: boolean };

const FIELDS: { key: keyof BrandInput; label: string; max: number; required?: boolean; placeholder: string }[] = [
  { key: 'founderName', label: 'Founder / Owner name', max: LIMITS.founder, required: true, placeholder: 'e.g. Sunny' },
  { key: 'brandName', label: 'Brand name', max: LIMITS.brand, required: true, placeholder: 'e.g. Jiva' },
  { key: 'bankAccountName', label: 'Bank account name', max: LIMITS.bank, placeholder: 'Name on the bank account' },
];

export default function BrandDirectoryCard({ token, onAlert }: { token: string; onAlert: Alert }) {
  const [brands, setBrands] = useState<BrandRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notInstalled, setNotInstalled] = useState(false);
  const [q, setQ] = useState('');
  const [form, setForm] = useState<Form | null>(null);
  const [toDelete, setToDelete] = useState<BrandRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [founder, setFounder] = useState<string | null>(null);   // nameKey of the open founder, null = all founders

  const headers = useMemo(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);

  const load = useCallback(async () => {
    setLoading(true); setLoadError('');
    try {
      const res = await fetch('/api/brand-directory', { headers, cache: 'no-store' });
      const d = await res.json().catch(() => ({}));
      if (res.status === 503 && d.notInstalled) { setNotInstalled(true); setBrands([]); return; }
      if (!res.ok) { setLoadError(d.error || 'Could not load the brands'); return; }
      setNotInstalled(false);
      setBrands(Array.isArray(d.brands) ? d.brands : []);
    } catch {
      setLoadError('Could not reach ShipTrack. Check the internet and try again.');
    } finally { setLoading(false); }
  }, [headers]);

  useEffect(() => { void load(); }, [load]);

  const founders = useMemo(() => uniqueFounders(brands), [brands]);
  const groups = useMemo(() => founderGroups(brands.filter((b) => matchesSearch(b, q))), [brands, q]);
  const openGroup = founder ? founderGroups(brands).find((g) => g.key === founder) || null : null;
  const shown = openGroup ? openGroup.brands.filter((b) => matchesSearch(b, q)) : [];
  // The open founder's last brand deleted or renamed away: back to all founders.
  useEffect(() => { if (founder && !loading && !openGroup) setFounder(null); }, [founder, loading, openGroup]);

  const openAdd = () => setForm({ id: null, values: { ...EMPTY_BRAND, founderName: openGroup?.name || '' }, errors: {}, error: '', busy: false });
  const openEdit = (b: BrandRow) => setForm({
    id: b.id, errors: {}, error: '', busy: false,
    values: {
      founderName: b.founderName, brandName: b.brandName, bankAccountName: b.bankAccountName,
      customField1Label: b.customField1Label, customField1Value: b.customField1Value,
      customField2Label: b.customField2Label, customField2Value: b.customField2Value,
    },
  });
  const setField = (k: keyof BrandInput, v: string) => setForm((f) => f && { ...f, values: { ...f.values, [k]: v }, errors: { ...f.errors, [k]: undefined }, error: '' });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form || form.busy) return;
    const errors: FieldErrors = {};
    if (!form.values.founderName.trim()) errors.founderName = 'Founder / Owner name is required';
    if (!form.values.brandName.trim()) errors.brandName = 'Brand name is required';
    if (Object.keys(errors).length) { setForm({ ...form, errors }); return; }
    setForm({ ...form, busy: true, error: '' });
    try {
      const res = await fetch(form.id ? `/api/brand-directory/${form.id}` : '/api/brand-directory', {
        method: form.id ? 'PATCH' : 'POST', headers, body: JSON.stringify(form.values),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.brand) {
        setForm((f) => f && { ...f, busy: false, errors: d.fields || {}, error: d.error || 'Could not save' });
        return;
      }
      const saved: BrandRow = d.brand;
      setBrands((list) => {
        const rest = list.filter((b) => b.id !== saved.id);
        return [...rest, saved].sort((a, b) => a.brandName.localeCompare(b.brandName, 'en', { sensitivity: 'base' }));
      });
      onAlert('success', form.id ? `${saved.brandName} saved` : `${saved.brandName} added`);
      if (founder) setFounder(nameKey(saved.founderName));   // a founder renamed in the edit: follow the brand
      setForm(null);
    } catch {
      setForm((f) => f && { ...f, busy: false, error: 'Could not reach ShipTrack. Nothing was saved; try again.' });
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
          <input className="form-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search founder, brand, bank or custom fields" aria-label="Search brands" />
          {q && <button type="button" className="bd-clear" onClick={() => setQ('')} aria-label="Clear search"><X size={14} /></button>}
        </div>
        <button type="button" className="btn btn-outline bd-refresh" onClick={() => void load()} disabled={loading} aria-label="Refresh"><RefreshCw size={14} /></button>
        <button type="button" className="btn btn-primary bd-add" onClick={openAdd} disabled={notInstalled}><Plus size={15} /> {openGroup ? `Add brand for ${openGroup.name}` : 'Add Brand'}</button>
      </div>

      {loading && !brands.length ? (
        <div className="bd-empty"><Loader2 size={20} style={{ animation: 'spin 0.6s linear infinite' }} /> Loading brands…</div>
      ) : notInstalled ? (
        <div className="bd-empty bd-warn">Brand Directory is not installed yet. Run <code>brand-directory.sql</code> once on the server, then press Refresh.</div>
      ) : loadError ? (
        <div className="bd-empty bd-warn">{loadError} <button type="button" className="btn btn-outline" onClick={() => void load()}>Try again</button></div>
      ) : !brands.length ? (
        <div className="bd-empty">No brands yet. Press <b>Add Brand</b> to save the first one.</div>
      ) : !openGroup ? (
        !groups.length ? <div className="bd-empty">No brand matches “{q}”.</div> : (
          <div className="bd-founders">
            {groups.map((g) => (
              <button key={g.key} type="button" className="bd-founder" onClick={() => setFounder(g.key)}>
                <span className="bd-avatar">{g.name.slice(0, 1).toUpperCase()}</span>
                <span className="bd-fname">{g.name}</span>
                <span className="bd-fcount">{g.brands.length} {g.brands.length === 1 ? 'brand' : 'brands'}{q ? ' match' : ''}</span>
                <span className="bd-fbrands">{g.brands.map((b) => <span key={b.id} className="bd-chip">{b.brandName}</span>)}</span>
                <span className="bd-open">Open <ChevronRight size={14} /></span>
              </button>
            ))}
          </div>
        )
      ) : (<>
        <div className="bd-crumb">
          <button type="button" className="btn btn-outline bd-back" onClick={() => setFounder(null)}><ArrowLeft size={14} /> All founders</button>
          <h3 className="bd-ftitle"><UserRound size={18} /> {openGroup.name}</h3>
          <span className="meta">{openGroup.brands.length} {openGroup.brands.length === 1 ? 'brand' : 'brands'}</span>
        </div>
        {!shown.length ? <div className="bd-empty">No brand of {openGroup.name} matches “{q}”.</div> : (
        <div className="bd-grid">
          {shown.map((b) => (
            <div key={b.id} className="bd-card">
              <div className="bd-row"><span className="bd-k">Founder / Owner</span><span className="bd-v">{b.founderName}</span></div>
              <div className="bd-row"><span className="bd-k">Brand Name</span><span className="bd-v bd-brand">{b.brandName}</span></div>
              <div className="bd-row"><span className="bd-k">Bank Account Name</span><span className={`bd-v${b.bankAccountName ? '' : ' bd-none'}`}>{b.bankAccountName || '—'}</span></div>
              <div className="bd-row bd-custom"><span className="bd-k">{labelOf(b.customField1Label, 1)}</span><span className={`bd-v${b.customField1Value ? '' : ' bd-none'}`}>{b.customField1Value || '—'}</span></div>
              <div className="bd-row bd-custom"><span className="bd-k">{labelOf(b.customField2Label, 2)}</span><span className={`bd-v${b.customField2Value ? '' : ' bd-none'}`}>{b.customField2Value || '—'}</span></div>
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
              {FIELDS.map((f) => (
                <div key={f.key} className="form-group">
                  <label className="form-label" htmlFor={`bd-${f.key}`}>{f.label}{f.required ? ' *' : ' (optional)'}</label>
                  <input id={`bd-${f.key}`} className="form-input" value={form.values[f.key]} maxLength={f.max} placeholder={f.placeholder}
                    onChange={(e) => setField(f.key, e.target.value)} aria-invalid={!!form.errors[f.key]} autoFocus={f.key === 'founderName'} />
                  {form.errors[f.key] && <p className="bd-err" role="alert">{form.errors[f.key]}</p>}
                </div>
              ))}
              {([1, 2] as const).map((n) => {
                const lk = (n === 1 ? 'customField1Label' : 'customField2Label') as keyof BrandInput;
                const vk = (n === 1 ? 'customField1Value' : 'customField2Value') as keyof BrandInput;
                return (
                  <fieldset key={n} className="bd-fieldset">
                    <legend>Custom field {n} (optional)</legend>
                    <div className="bd-pair">
                      <div className="form-group">
                        <label className="form-label" htmlFor={`bd-${lk}`}>Label</label>
                        <input id={`bd-${lk}`} className="form-input" value={form.values[lk]} maxLength={LIMITS.label} placeholder={`Custom Field ${n}`} onChange={(e) => setField(lk, e.target.value)} aria-invalid={!!form.errors[lk]} />
                        {form.errors[lk] && <p className="bd-err" role="alert">{form.errors[lk]}</p>}
                      </div>
                      <div className="form-group">
                        <label className="form-label" htmlFor={`bd-${vk}`}>Value</label>
                        <input id={`bd-${vk}`} className="form-input" value={form.values[vk]} maxLength={LIMITS.value} onChange={(e) => setField(vk, e.target.value)} aria-invalid={!!form.errors[vk]} />
                        {form.errors[vk] && <p className="bd-err" role="alert">{form.errors[vk]}</p>}
                      </div>
                    </div>
                  </fieldset>
                );
              })}
              {form.error && !Object.values(form.errors).some(Boolean) && <p className="bd-err" role="alert">{form.error}</p>}
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setForm(null)} disabled={form.busy}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={form.busy}>
                  {form.busy ? <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> : null} {form.id ? 'Save Changes' : 'Add Brand'}
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
                {deleting ? <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> : <Trash2 size={14} />} Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
