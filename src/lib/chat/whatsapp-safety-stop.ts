// ── The safety stop, started from the automation (owner 2026-10-15 night: "1 msg bhi dubara drop ya fail ho toh pause
// ho jae, meta ki limit na kharab ho") ──
// One call for the worker (whatsapp-auto.ts, a Meta-side answer at send time), a later failed delivery report of an
// automation row (whatsapp-auto-status.ts) and the test message's report (whatsapp-foreign.ts): the number stops sending
// order messages until Resume (whatsapp-pause.ts stopWhatsApp) and, when that is a NEW stop, the owner gets ONE WhatsApp
// (whatsapp-alert-queue.ts alertStopped). Never throws: a stop that could not be written still answers (the worker then
// meets Meta's answer again on the next row and tries once more).
import { stopWhatsApp, type StopInfo, type StopResult } from './whatsapp-pause';
import { alertStopped } from './whatsapp-alert-queue';

export async function safetyStop(info: StopInfo, now = Date.now(), sentAt?: number | null, quietBefore = false): Promise<StopResult> {
  let r: StopResult;
  try { r = await stopWhatsApp(info, now, sentAt, quietBefore); }
  catch (e) { console.error('[whatsapp] stop:', (e as Error).message); return { started: false, until: now, at: now }; }
  if (r.started) await alertStopped(r, info, now).catch(() => 0);
  return r;
}
