// ── The chargeback WhatsApp, through the template the install already has (owner 2026-10-14: "chargeback pa msg bhejna
// ka lia kah rha ha setup nai ha, kar aur template banala agar banana ha kar setup") ──
// notify.ts needs its own 3-variable template named in WHATSAPP_CHARGEBACK_TEMPLATE, which was never made, so every
// chargeback said "WhatsApp not set up". The ShipTrack alert template ("shiptrack_alert", one variable, made from
// WhatsApp > Templates or the button on the Chargeback card, the same one the AI-credit and risk alerts use) now carries
// it too: when the env template is set it still wins; else, with the WhatsApp token + phone number id on the server and
// "shiptrack_alert" APPROVED on the Messaging account, the alert goes as {{1}} = chargebackAlertText. Never throws.
import { sendWhatsAppTemplate, waConfigured } from '@/lib/chat/whatsapp';
import { listTemplates } from '@/lib/chat/whatsapp-templates';
import { templatesAccount } from '@/lib/chat/whatsapp-settings';
import { chargebackAlertText, sendChargebackWhatsApp, whatsappConfigured, type NotifyResult } from './notify';

export const ALERT_TEMPLATE = 'shiptrack_alert';
type Tpl = { name: string; language: string; status: string } | null;
let cache: { at: number; tpl: Tpl } | null = null;
// The last APPROVED template seen (memory): a real chargeback still goes out when Meta's template list cannot be read for
// a moment (review 2026-10-14: a hiccup used to file it as "WhatsApp not set up", with no WhatsApp at all).
let lastApproved: Tpl = null;

// The "shiptrack_alert" template as Meta has it (any status), cached a minute (5 once approved).
export async function alertTemplate(fresh = false): Promise<Tpl | { error: string }> {
  if (!fresh && cache && Date.now() - cache.at < (cache.tpl?.status === 'APPROVED' ? 300_000 : 60_000)) return cache.tpl;
  try {
    const account = await templatesAccount();
    if (!account) return { error: 'The WhatsApp account id is not saved (WhatsApp > Setup).' };
    const r = await listTemplates(account);
    if ('error' in r) return { error: r.error };
    const all = r.value.filter((t) => t.name === ALERT_TEMPLATE);
    const t = all.find((x) => x.status === 'APPROVED') || all[0] || null;
    const tpl = t ? { name: t.name, language: t.language, status: t.status } : null;
    cache = { at: Date.now(), tpl };
    if (tpl?.status === 'APPROVED') lastApproved = tpl;
    return tpl;
  } catch (e) { return { error: (e as Error).message || 'Could not read the templates' }; }
}

export interface ChargebackWaSetup {
  ready: boolean;
  token: boolean;              // WHATSAPP_CLOUD_TOKEN + WHATSAPP_PHONE_NUMBER_ID on the server
  envTemplate: boolean;        // an own chargeback template named in the .env
  template: { name: string; status: string } | null;
  error: string | null;        // Meta could not be read
}

export async function chargebackWhatsAppSetup(fresh = false): Promise<ChargebackWaSetup> {
  if (whatsappConfigured()) return { ready: true, token: true, envTemplate: true, template: null, error: null };
  if (!waConfigured()) return { ready: false, token: false, envTemplate: false, template: null, error: null };
  const got = await alertTemplate(fresh);
  if (got && 'error' in got) return { ready: false, token: true, envTemplate: false, template: null, error: got.error };
  const t = got as Tpl;
  return { ready: t?.status === 'APPROVED', token: true, envTemplate: false, template: t ? { name: t.name, status: t.status } : null, error: null };
}

export async function notifyChargeback(to: string, vars: { panel: string; gateway: string; order: string }): Promise<NotifyResult> {
  if (whatsappConfigured()) return sendChargebackWhatsApp(to, vars);
  if (!waConfigured()) return 'not_configured';
  const got = await alertTemplate();
  const t: Tpl = got && 'error' in got ? lastApproved : (got as Tpl);
  if (!t && got && 'error' in got) return `failed: could not read the WhatsApp templates from Meta (${String(got.error).slice(0, 120)})`;
  if (!t || t.status !== 'APPROVED') return 'not_configured';
  const r = await sendWhatsAppTemplate(to, t.name, t.language, [chargebackAlertText(vars)]);
  return 'error' in r ? `failed: ${String(r.error).slice(0, 160)}` : 'sent';
}
