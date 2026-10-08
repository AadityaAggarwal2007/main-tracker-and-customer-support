// ── WhatsApp alert for a chargeback (owner 2026-10-08: "phone whatsapp ka number add kardunga") ──
// Sent through the official WhatsApp Cloud API (Meta). A message the business starts must use an APPROVED
// template, so the owner creates one template in Meta Business (3 variables: panel, gateway, order) and the
// server reads four settings from /etc/tracker/.env:
//   WHATSAPP_CLOUD_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_CHARGEBACK_TEMPLATE, WHATSAPP_TEMPLATE_LANG (default en)
// Nothing is sent, and the alert says "WhatsApp not set up", until they exist. The message carries only the panel's
// name, the gateway's name and the order number: no customer name, phone, address or amount. A failure never stops the
// alert from being saved; it is recorded on the alert (notify_status) and shown on the Chargebacks screen.

export type NotifyResult = 'sent' | 'not_configured' | string;

export function whatsappConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.WHATSAPP_CLOUD_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_CHARGEBACK_TEMPLATE);
}

export async function sendChargebackWhatsApp(
  to: string,
  vars: { panel: string; gateway: string; order: string },
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<NotifyResult> {
  if (!whatsappConfigured(env)) return 'not_configured';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetchImpl(`https://graph.facebook.com/v20.0/${encodeURIComponent(env.WHATSAPP_PHONE_NUMBER_ID as string)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.WHATSAPP_CLOUD_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'template',
        template: {
          name: env.WHATSAPP_CHARGEBACK_TEMPLATE, language: { code: env.WHATSAPP_TEMPLATE_LANG || 'en' },
          components: [{ type: 'body', parameters: [vars.panel, vars.gateway, vars.order].map(text => ({ type: 'text', text: text.slice(0, 120) })) }],
        },
      }),
      signal: ctl.signal,
    });
    return res.ok ? 'sent' : `failed: WhatsApp answered ${res.status}`;
  } catch (e) {
    return (e as Error)?.name === 'AbortError' ? 'failed: WhatsApp did not answer in time' : 'failed: could not reach WhatsApp';
  } finally {
    clearTimeout(timer);
  }
}
