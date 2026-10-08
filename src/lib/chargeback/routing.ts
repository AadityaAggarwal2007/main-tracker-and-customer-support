// ── Which panel does a chargeback mail belong to? (owner 2026-10-08) ──────────────────────────
// Two panels (Vastrika and kurtiya) can use the SAME chargeback Gmail: each pays through a different gateway (one PayU,
// one PayGlocal), so the mail's gateway tells the panel. Pure; the poller feeds it what the database says.
//   1. one panel in the group -> that panel;
//   2. the mail names an order number: only the panels that HAVE that order stay in the running; one left -> it;
//   3. else the gateway: the panels whose checklist (Settings > Chargeback protection, step 3) ticks that gateway;
//      exactly one -> it;
//   4. else nobody can tell: the first panel gets it, marked "unsure", and the Super Admin moves it by hand.

export interface RoutePanel { businessId: string; gateways: Record<string, { done?: boolean } | undefined> }
export type RoutedBy = 'single' | 'order' | 'gateway' | 'unsure';

export function routeToPanel(panels: RoutePanel[], gatewayKey: string, orderPanels: string[]): { businessId: string; by: RoutedBy } | null {
  if (panels.length === 0) return null;
  if (panels.length === 1) return { businessId: panels[0].businessId, by: 'single' };
  let pool = panels;
  const withOrder = panels.filter(p => orderPanels.includes(p.businessId));
  if (withOrder.length === 1) return { businessId: withOrder[0].businessId, by: 'order' };
  if (withOrder.length > 1) pool = withOrder;
  const withGateway = pool.filter(p => p.gateways[gatewayKey]?.done === true);
  if (withGateway.length === 1) return { businessId: withGateway[0].businessId, by: 'gateway' };
  return { businessId: pool[0].businessId, by: 'unsure' };
}
