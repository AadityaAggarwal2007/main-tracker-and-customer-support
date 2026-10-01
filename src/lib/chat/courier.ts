// The courier the chat agent names for an order (owner, 2026-10-01). Pure, tested offline.
// An order's own courier wins; the misspellings found in the data ("volmo", "VALMO") read as
// Valmo; an order with none gets its panel's default courier (businesses.default_courier,
// default-courier.sql). Nothing is written back to the order.
export function courierFor(raw: string | null | undefined, panelDefault: string | null | undefined): string | null {
  const t = String(raw ?? '').trim();
  if (/^v[ao]lmo$/i.test(t)) return 'Valmo';
  if (t && !/^courier\s*partner$/i.test(t)) return t;
  const d = String(panelDefault ?? '').trim();
  return d || null;
}
