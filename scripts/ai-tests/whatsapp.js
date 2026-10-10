// WhatsApp in Chat Support (owner 2026-10-10): the REAL whatsapp.ts / whatsapp-inbound.ts and the REAL webhook
// route against a fake database and a fake Cloud API (fetch). Nothing here touches Meta or a database.
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module'), crypto = require('crypto');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true }, fileName: filename }).outputText, filename);

const S = {};
function reset() {
  Object.assign(S, { convs: [], msgs: [], panels: [{ id: 'bizVast', is_default: true }, { id: 'bizKurt', is_default: false }], sites: [{ id: 'site1', tracker_business_id: 'bizVast' }], updates: [], subject: [], health: [], fetches: [], fetchStatus: 200, fetchBody: { messages: [{ id: 'wamid.out1' }] } });
}
reset();
let seq = 0;
const db = {
  query: async (sql, p = []) => {
    if (/^INSERT INTO messages/.test(sql)) { S.msgs.push({ id: 'm' + (++seq), conversation_id: p[0], sender: 'visitor', content: p[1], metadata: JSON.parse(p[2]), ts: p[3] }); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE conversations/.test(sql)) { const c = S.convs.find((x) => x.id === p[0]); if (c) { c.unread_count++; if (!['human_needed', 'agent_handling'].includes(c.status)) c.status = 'agent_handling'; if (!c.visitor_name) c.visitor_name = p[1]; } S.updates.push(p); return { rows: [], rowCount: c ? 1 : 0 }; }
    if (/^UPDATE messages/.test(sql)) { const hits = S.msgs.filter((m) => m.metadata && m.metadata.wa_id === p[0]); for (const m of hits) { if (p[1] != null) m.metadata.wa_status = p[1]; if (p[2] != null) m.metadata.wa_error = p[2]; } return { rows: [], rowCount: hits.length }; }
    throw new Error('fake db query: ' + sql.slice(0, 80));
  },
  queryOne: async (sql, p = []) => {
    if (/metadata->>'wa_id' = \$1 LIMIT 1/.test(sql)) { const m = S.msgs.find((x) => x.metadata && x.metadata.wa_id === p[0]); return m ? { id: m.id } : null; }
    if (/FROM businesses WHERE id::text = \$1/.test(sql)) { const b = S.panels.find((x) => x.id === p[0]); return b ? { id: b.id } : null; }
    if (/FROM businesses ORDER BY is_default DESC/.test(sql)) { const b = [...S.panels].sort((a, c) => (c.is_default ? 1 : 0) - (a.is_default ? 1 : 0))[0]; return b ? { id: b.id } : null; }
    if (/FROM sites WHERE tracker_business_id/.test(sql)) { const s = S.sites.find((x) => x.tracker_business_id === p[0]); return s ? { id: s.id, name: 'Vastora' } : null; }
    if (/^SELECT name, shopify_domain FROM businesses/.test(sql)) return { name: 'Vastora', shopify_domain: null };
    if (/^INSERT INTO sites/.test(sql)) { const s = { id: 'site-' + p[2], tracker_business_id: p[2] }; S.sites.push(s); return { id: s.id, name: p[0] }; }
    if (/FROM conversations\s+WHERE site_id = \$1 AND source = 'whatsapp' AND visitor_id = \$2/.test(sql)) { const c = S.convs.filter((x) => x.site_id === p[0] && x.source === 'whatsapp' && x.visitor_id === p[1] && !x.merged_into).pop(); return c ? { id: c.id, status: c.status } : null; }
    if (/^INSERT INTO conversations/.test(sql)) { const c = { id: 'c' + (++seq), site_id: p[0], visitor_id: p[1], visitor_name: p[2], visitor_phone: p[3], status: 'agent_handling', source: 'whatsapp', unread_count: 0, merged_into: null }; S.convs.push(c); return { id: c.id, status: c.status }; }
    throw new Error('fake db queryOne: ' + sql.slice(0, 80));
  },
};
const fakes = {
  '@/lib/db': db,
  '@/lib/chat/subject': { updateConversationSubject: async (id) => { S.subject.push(id); } },
  '@/lib/chat/health': { updateConversationHealth: async (id) => { S.health.push(id); } },
  'next/server': {
    NextResponse: class NextResponse {
      constructor(body, init = {}) { this.status = init.status || 200; this.body = body; this.headers = init.headers || {}; }
      static json(body, init = {}) { return new NextResponse(body, init); }
    },
    NextRequest: class {},
  },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (fakes[request]) return request;
  if (request.startsWith('@/')) return origResolve.call(this, path.join(SRC, request.slice(2)), parent, ...rest);
  return origResolve.call(this, request, parent, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (fakes[request]) return fakes[request];
  // whatsapp-inbound.ts imports its neighbours as './subject' / './health' (like email.ts does).
  if (/^\.\/(subject|health)$/.test(request) && parent && /whatsapp-inbound/.test(parent.filename || '')) return fakes['@/lib/chat/' + request.slice(2)];
  return origLoad.call(this, request, parent, ...rest);
};
global.fetch = async (url, init) => {
  S.fetches.push({ url, init: { ...init, body: JSON.parse(init.body) }, auth: init.headers.Authorization });
  return { ok: S.fetchStatus < 400, status: S.fetchStatus, json: async () => S.fetchBody };
};

const wa = require(path.join(SRC, 'lib/chat/whatsapp.ts'));
const inbound = require(path.join(SRC, 'lib/chat/whatsapp-inbound.ts'));
const route = require(path.join(SRC, 'app/api/whatsapp/webhook/route.ts'));

const env = { WHATSAPP_CLOUD_TOKEN: 'tok-secret', WHATSAPP_PHONE_NUMBER_ID: '1335396902996145' };
const webhookBody = (messages, statuses, extra = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '28873951022288651', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '918796414056', phone_number_id: '1335396902996145' },
    contacts: [{ profile: { name: 'Jatin' }, wa_id: '919876543210' }], messages, statuses, ...extra,
  } }] }],
});
const textMsg = (id, body, from = '919876543210') => ({ from, id, timestamp: '1760090400', type: 'text', text: { body } });
const req = (method, { query = '', body = '', headers = {} } = {}) => ({
  method,
  nextUrl: { searchParams: new URLSearchParams(query) },
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => body,
});

let pass = 0, fail = 0;
async function t(name, fn) {
  reset();
  try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n       ')); }
}
const eq = assert.strictEqual, deq = assert.deepStrictEqual;

(async () => {
  console.log('whatsapp: the pure module');
  await t('waDigits: a 10-digit Indian number gets 91, formatted numbers are cleaned, junk is no number', () => {
    deq(['9876543210', '+91 98765 43210', '0919876543210', '919876543210', '12345', '1234567890123456', null].map(wa.waDigits),
      ['919876543210', '919876543210', '919876543210', '919876543210', null, null, null]);
  });
  await t('parseWaWebhook: text, media, location, button replies and delivery reports; junk is skipped', () => {
    const r = wa.parseWaWebhook(webhookBody([
      textMsg('wamid.1', 'Hello, order #1553 not delivered'),
      { from: '919876543210', id: 'wamid.2', timestamp: '1760090401', type: 'image', image: { id: 'media1', mime_type: 'image/jpeg', caption: 'see this' } },
      { from: '919876543210', id: 'wamid.3', timestamp: '1760090402', type: 'document', document: { id: 'media2', filename: 'invoice.pdf' } },
      { from: '919876543210', id: 'wamid.4', timestamp: '1760090403', type: 'audio', audio: { id: 'media3' } },
      { from: '919876543210', id: 'wamid.5', timestamp: '1760090404', type: 'location', location: { latitude: 28.6, longitude: 77.2, name: 'Home' } },
      { from: '919876543210', id: 'wamid.6', timestamp: '1760090405', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Yes' } } },
      { from: '919876543210', id: 'wamid.7', timestamp: 'x', type: 'unsupported', errors: [{ code: 131051 }] },
      { from: '', id: 'wamid.8', type: 'text', text: { body: 'no sender' } },
      'junk', null,
    ], [
      { id: 'wamid.out1', status: 'delivered', timestamp: '1760090500', recipient_id: '919876543210' },
      { id: 'wamid.out2', status: 'failed', recipient_id: '919876543210', errors: [{ code: 131047, title: 'Re-engagement message', error_data: { details: 'Message failed to send because more than 24 hours have passed' } }] },
      { status: 'sent' },
    ]));
    deq(r.messages.map((m) => [m.id, m.type, m.text, m.name, m.from]), [
      ['wamid.1', 'text', 'Hello, order #1553 not delivered', 'Jatin', '919876543210'],
      ['wamid.2', 'image', '[Photo] see this', 'Jatin', '919876543210'],
      ['wamid.3', 'document', '[File] invoice.pdf', 'Jatin', '919876543210'],
      ['wamid.4', 'audio', '[Voice message]', 'Jatin', '919876543210'],
      ['wamid.5', 'location', '[Location] Home · 28.6, 77.2', 'Jatin', '919876543210'],
      ['wamid.6', 'interactive', 'Yes', 'Jatin', '919876543210'],
      ['wamid.7', 'unsupported', '[Unsupported message]', 'Jatin', '919876543210'],
    ]);
    eq(r.messages[0].timestamp, 1760090400000);
    assert.ok(Math.abs(r.messages[6].timestamp - Date.now()) < 5000, 'a bad timestamp = now');
    deq(r.statuses, [
      { id: 'wamid.out1', status: 'delivered', error: null, recipient: '919876543210' },
      { id: 'wamid.out2', status: 'failed', error: '131047 · Re-engagement message · Message failed to send because more than 24 hours have passed', recipient: '919876543210' },
    ]);
    deq(wa.parseWaWebhook({ object: 'page', entry: [] }), { messages: [], statuses: [] });
    deq(wa.parseWaWebhook('nope'), { messages: [], statuses: [] });
    deq(wa.parseWaWebhook(webhookBody(undefined, undefined)), { messages: [], statuses: [] });
  });
  await t('waSignatureOk: no secret = not checked; with one, only the right sha256 HMAC of the raw body passes', () => {
    const body = '{"object":"whatsapp_business_account"}';
    const good = 'sha256=' + crypto.createHmac('sha256', 'app-secret').update(body).digest('hex');
    eq(wa.waSignatureOk(body, null, undefined), true);
    eq(wa.waSignatureOk(body, good, 'app-secret'), true);
    eq(wa.waSignatureOk(body, good.toUpperCase().replace('SHA256=', 'sha256='), 'app-secret'), true);
    eq(wa.waSignatureOk(body + ' ', good, 'app-secret'), false);
    eq(wa.waSignatureOk(body, null, 'app-secret'), false);
    eq(wa.waSignatureOk(body, 'sha256=abc', 'app-secret'), false);
    eq(wa.waSignatureOk(body, good, 'other-secret'), false);
  });
  await t('sendWhatsAppText: the Cloud API call carries the token, the number with 91 and the text; the wamid comes back', async () => {
    const r = await wa.sendWhatsAppText('+91 98765 43210', '  Hi Jatin, we checked your order.  ', env, global.fetch);
    deq(r, { ok: true, id: 'wamid.out1' });
    eq(S.fetches.length, 1);
    eq(S.fetches[0].url, 'https://graph.facebook.com/v25.0/1335396902996145/messages');
    eq(S.fetches[0].auth, 'Bearer tok-secret');
    deq(S.fetches[0].init.body, { messaging_product: 'whatsapp', recipient_type: 'individual', to: '919876543210', type: 'text', text: { preview_url: false, body: 'Hi Jatin, we checked your order.' } });
    const base = await wa.sendWhatsAppText('9876543210', 'x', { ...env, WHATSAPP_API_BASE: 'https://graph.facebook.com/v26.0/' }, global.fetch);
    eq(base.ok, true); eq(S.fetches[1].url, 'https://graph.facebook.com/v26.0/1335396902996145/messages');
  });
  await t('sendWhatsAppText: not set up, no number, nothing to send, and Meta refusals in plain words (24-hour window)', async () => {
    deq(await wa.sendWhatsAppText('9876543210', 'hi', {}, global.fetch), { ok: false, error: 'WhatsApp is not set up (token or phone number id missing)', code: null });
    deq(await wa.sendWhatsAppText('12345', 'hi', env, global.fetch), { ok: false, error: 'Not a WhatsApp number', code: null });
    deq(await wa.sendWhatsAppText('9876543210', '   ', env, global.fetch), { ok: false, error: 'Nothing to send', code: null });
    eq(S.fetches.length, 0);
    S.fetchStatus = 400; S.fetchBody = { error: { message: '(#131047) Re-engagement message', code: 131047 } };
    const r = await wa.sendWhatsAppText('9876543210', 'hi', env, global.fetch);
    deq(r, { ok: false, error: 'The customer last wrote over 24 hours ago: WhatsApp only allows a template message now', code: 131047 });
    S.fetchStatus = 401; S.fetchBody = { error: { message: 'Invalid OAuth access token', code: 190 } };
    deq(await wa.sendWhatsAppText('9876543210', 'hi', env, global.fetch), { ok: false, error: 'The WhatsApp token was refused (expired or revoked)', code: 190 });
    S.fetchStatus = 500; S.fetchBody = null;
    deq(await wa.sendWhatsAppText('9876543210', 'hi', env, global.fetch), { ok: false, error: 'WhatsApp answered 500', code: null });
    const down = await wa.sendWhatsAppText('9876543210', 'hi', env, async () => { throw new Error('ECONNRESET'); });
    deq(down, { ok: false, error: 'Could not reach WhatsApp', code: null });
    assert.ok(!JSON.stringify([r, down]).includes('tok-secret'), 'the token never appears in a result');
  });
  await t('sendWhatsAppTemplate: hello_world without variables, a template with variables, a bad name refused', async () => {
    deq(await wa.sendWhatsAppTemplate('9876543210', 'hello_world', 'en_US', [], env, global.fetch), { ok: true, id: 'wamid.out1' });
    deq(S.fetches[0].init.body, { messaging_product: 'whatsapp', recipient_type: 'individual', to: '919876543210', type: 'template', template: { name: 'hello_world', language: { code: 'en_US' } } });
    await wa.sendWhatsAppTemplate('9876543210', 'order_shipped', 'en_US', ['Rahul', '#1042'], env, global.fetch);
    deq(S.fetches[1].init.body.template.components, [{ type: 'body', parameters: [{ type: 'text', text: 'Rahul' }, { type: 'text', text: '#1042' }] }]);
    deq(await wa.sendWhatsAppTemplate('9876543210', 'Hello World', 'en_US', [], env, global.fetch), { ok: false, error: 'Not a template name', code: null });
  });

  console.log('whatsapp: inbound into Chat Support');
  await t('a first message makes a WhatsApp chat on the default panel with the profile name and the number, unread, With team', async () => {
    const r = await inbound.storeWaInbound(wa.parseWaWebhook(webhookBody([textMsg('wamid.1', 'Hello')])).messages[0], {});
    eq(r.outcome, 'stored');
    eq(S.convs.length, 1);
    const c = S.convs[0];
    deq([c.site_id, c.visitor_id, c.visitor_name, c.visitor_phone, c.status, c.source, c.unread_count], ['site1', 'wa:919876543210', 'Jatin', '+919876543210', 'agent_handling', 'whatsapp', 1]);
    deq(S.msgs.map((m) => [m.conversation_id, m.sender, m.content, m.metadata, m.ts]), [[c.id, 'visitor', 'Hello', { wa_id: 'wamid.1', wa_type: 'text', channel: 'whatsapp' }, 1760090400000]]);
    deq([S.subject, S.health], [[c.id], [c.id]]);
  });
  await t('the same wamid again (Meta resends) is skipped; a second message joins the same chat; a Closed chat reopens for the team', async () => {
    const m1 = wa.parseWaWebhook(webhookBody([textMsg('wamid.1', 'Hello')])).messages[0];
    await inbound.storeWaInbound(m1, {});
    deq(await inbound.storeWaInbound(m1, {}), { outcome: 'duplicate', conversationId: null });
    S.convs[0].status = 'resolved';
    const r2 = await inbound.storeWaInbound(wa.parseWaWebhook(webhookBody([textMsg('wamid.2', 'Anyone there?')])).messages[0], {});
    deq([r2.outcome, S.convs.length, S.msgs.length, S.convs[0].status, S.convs[0].unread_count], ['stored', 1, 2, 'agent_handling', 2]);
    S.convs[0].status = 'human_needed';
    await inbound.storeWaInbound(wa.parseWaWebhook(webhookBody([textMsg('wamid.3', 'Hello?')])).messages[0], {});
    eq(S.convs[0].status, 'human_needed', 'Needs you stays');
  });
  await t('WHATSAPP_PANEL_ID picks the panel (its site is made on demand); an unknown id or no panel = no_panel, nothing stored', async () => {
    const m = wa.parseWaWebhook(webhookBody([textMsg('wamid.1', 'Hello')])).messages[0];
    const r = await inbound.storeWaInbound(m, { WHATSAPP_PANEL_ID: 'bizKurt' });
    deq([r.outcome, S.convs[0].site_id, S.sites.length], ['stored', 'site-bizKurt', 2]);
    deq(await inbound.storeWaInbound({ ...m, id: 'wamid.9' }, { WHATSAPP_PANEL_ID: 'nope' }), { outcome: 'no_panel', conversationId: null });
    S.panels = [];
    deq(await inbound.storeWaInbound({ ...m, id: 'wamid.10' }, {}), { outcome: 'no_panel', conversationId: null });
    eq(S.msgs.length, 1);
  });
  await t('a delivery report lands on our message by its wamid; an unknown wamid changes nothing', async () => {
    S.msgs.push({ id: 'out', conversation_id: 'c1', sender: 'agent', content: 'Hi', metadata: { wa_id: 'wamid.out1', wa_sent: true } });
    eq(await inbound.storeWaStatus({ id: 'wamid.out1', status: 'read', error: null, recipient: '919876543210' }), true);
    deq(S.msgs[0].metadata, { wa_id: 'wamid.out1', wa_sent: true, wa_status: 'read' });
    eq(await inbound.storeWaStatus({ id: 'wamid.out1', status: 'failed', error: '131047 · over 24 hours', recipient: null }), true);
    deq(S.msgs[0].metadata, { wa_id: 'wamid.out1', wa_sent: true, wa_status: 'failed', wa_error: '131047 · over 24 hours' });
    eq(await inbound.storeWaStatus({ id: 'wamid.none', status: 'sent', error: null, recipient: null }), false);
  });

  console.log('whatsapp: the webhook route');
  await t('GET: Meta\'s verify call gets the challenge back only with the right token; no token set = 403', async () => {
    process.env.WHATSAPP_VERIFY_TOKEN = 'shiptrack_verify_x';
    const ok = await route.GET(req('GET', { query: 'hub.mode=subscribe&hub.verify_token=shiptrack_verify_x&hub.challenge=12345' }));
    deq([ok.status, ok.body], [200, '12345']);
    eq((await route.GET(req('GET', { query: 'hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345' }))).status, 403);
    eq((await route.GET(req('GET', { query: 'hub.mode=unsubscribe&hub.verify_token=shiptrack_verify_x&hub.challenge=1' }))).status, 403);
    delete process.env.WHATSAPP_VERIFY_TOKEN;
    eq((await route.GET(req('GET', { query: 'hub.mode=subscribe&hub.verify_token=&hub.challenge=1' }))).status, 403);
  });
  await t('POST: messages are stored and reports applied, repeats counted, always 200; bad JSON 400', async () => {
    S.msgs.push({ id: 'out', conversation_id: 'c0', sender: 'agent', content: 'Hi', metadata: { wa_id: 'wamid.out1' } });
    const body = JSON.stringify(webhookBody([textMsg('wamid.1', 'Hello'), textMsg('wamid.1', 'Hello')], [{ id: 'wamid.out1', status: 'delivered' }, { id: 'wamid.zzz', status: 'read' }]));
    const r = await route.POST(req('POST', { body }));
    deq([r.status, r.body], [200, { ok: true, stored: 1, duplicates: 1, reports: 1 }]);
    eq(S.convs.length, 1);
    const empty = await route.POST(req('POST', { body: JSON.stringify({ object: 'whatsapp_business_account', entry: [] }) }));
    deq([empty.status, empty.body], [200, { ok: true, stored: 0, duplicates: 0, reports: 0 }]);
    eq((await route.POST(req('POST', { body: '{not json' }))).status, 400);
  });
  await t('POST: with WHATSAPP_APP_SECRET set, an unsigned or wrongly signed body is refused and nothing is stored', async () => {
    process.env.WHATSAPP_APP_SECRET = 'app-secret';
    try {
      const body = JSON.stringify(webhookBody([textMsg('wamid.1', 'Hello')]));
      eq((await route.POST(req('POST', { body }))).status, 403);
      eq((await route.POST(req('POST', { body, headers: { 'x-hub-signature-256': 'sha256=deadbeef' } }))).status, 403);
      eq(S.convs.length, 0);
      const sig = 'sha256=' + crypto.createHmac('sha256', 'app-secret').update(body).digest('hex');
      const ok = await route.POST(req('POST', { body, headers: { 'x-hub-signature-256': sig } }));
      deq([ok.status, ok.body.stored, S.convs.length], [200, 1, 1]);
    } finally { delete process.env.WHATSAPP_APP_SECRET; }
  });
  await t('POST: a database failure on one message never breaks the answer (Meta would resend forever)', async () => {
    const origQuery = db.queryOne;
    db.queryOne = async (sql, p) => { if (/wa_id/.test(sql)) throw new Error('db down'); return origQuery(sql, p); };
    try {
      const r = await route.POST(req('POST', { body: JSON.stringify(webhookBody([textMsg('wamid.1', 'Hello')])) }));
      deq([r.status, r.body.stored], [200, 0]);
    } finally { db.queryOne = origQuery; }
  });

  console.log(`\nwhatsapp: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
