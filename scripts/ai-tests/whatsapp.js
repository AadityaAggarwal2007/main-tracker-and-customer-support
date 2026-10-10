// WhatsApp in Chat Support (owner 2026-10-10): the REAL whatsapp.ts / whatsapp-inbound.ts and the REAL webhook
// route against a fake database and a fake Cloud API (fetch). Nothing here touches Meta or a database.
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module'), crypto = require('crypto');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true }, fileName: filename }).outputText, filename);

const S = {};
function reset() {
  Object.assign(S, { convs: [], msgs: [], panels: [{ id: 'bizVast', is_default: true }, { id: 'bizKurt', is_default: false }], sites: [{ id: 'site1', tracker_business_id: 'bizVast' }], updates: [], subject: [], health: [], fetches: [], fetchStatus: 200, fetchBody: { messages: [{ id: 'wamid.out1' }] }, settings: {}, metaTemplates: null, profile: { about: 'Order help', description: 'Vastora support', address: '', email: '', websites: ['https://vastora.in'], vertical: 'RETAIL', profile_picture_url: 'https://pps.whatsapp.net/old.jpg' }, profileWrites: [], phone: { display_phone_number: '+91 87964 14056', verified_name: 'Shiptrack', name_status: 'PENDING_REVIEW', quality_rating: 'GREEN', status: 'CONNECTED', messaging_limit_tier: 'TIER_250', code_verification_status: 'VERIFIED' }, nameAsks: [], uploadStart: null, uploadBytes: null, uploadHeaders: null });
}
reset();
let seq = 0;
const db = {
  query: async (sql, p = []) => {
    if (/^INSERT INTO messages/.test(sql)) { S.msgs.push({ id: 'm' + (++seq), conversation_id: p[0], sender: 'visitor', content: p[1], metadata: JSON.parse(p[2]), ts: p[3] }); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE conversations/.test(sql)) { const c = S.convs.find((x) => x.id === p[0]); if (c) { c.unread_count++; if (!['human_needed', 'agent_handling'].includes(c.status)) c.status = 'agent_handling'; if (!c.visitor_name) c.visitor_name = p[1]; } S.updates.push(p); return { rows: [], rowCount: c ? 1 : 0 }; }
    if (/^INSERT INTO chat_settings/.test(sql)) { S.settings[p[0]] = p[1]; return { rows: [], rowCount: 1 }; }
    if (/^UPDATE conversations SET last_message_at/.test(sql)) return { rows: [], rowCount: 1 };
    if (/WHERE c\.source = 'whatsapp' AND c\.merged_into IS NULL/.test(sql)) { const rows = S.convs.map((c) => ({ id: c.id, name: c.visitor_name, phone: c.visitor_phone, status: c.status, unread: c.unread_count, last_message_at: null, last_message: (S.msgs.filter((m) => m.conversation_id === c.id).pop() || {}).content || null, last_sender: 'visitor', panel: 'vastora' })); return { rows, rowCount: rows.length }; }
    if (/WHERE c\.source = 'whatsapp' AND m\.sender = 'agent'/.test(sql)) { const rows = S.msgs.filter((m) => m.sender === 'agent').map((m) => ({ id: m.id, conversation_id: m.conversation_id, content: m.content, created_at: '2026-10-10T10:00:00Z', metadata: m.metadata, name: 'Jatin', phone: '+919876543210' })); return { rows, rowCount: rows.length }; }
    if (/^UPDATE messages/.test(sql)) { const hits = S.msgs.filter((m) => m.metadata && m.metadata.wa_id === p[0]); for (const m of hits) { if (p[1] != null) m.metadata.wa_status = p[1]; if (p[2] != null) m.metadata.wa_error = p[2]; } return { rows: [], rowCount: hits.length }; }
    throw new Error('fake db query: ' + sql.slice(0, 80));
  },
  queryOne: async (sql, p = []) => {
    if (/FROM chat_settings WHERE key = \$1/.test(sql)) { const v = S.settings[p[0]]; return v == null ? null : { value: v }; }
    if (/SELECT name FROM businesses WHERE id::text/.test(sql)) { const b = S.panels.find((x) => x.id === p[0]); return b ? { name: b.id } : null; }
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
  '@/lib/auth': { getAuthFromRequest: (req) => req.__user || null },
  '@/lib/chat/team-routing': { staffActor: (u) => ({ name: u.displayName || u.username }) },
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
global.fetch = async (url, init = {}) => {
  S.fetches.push({ url, method: init.method, init: { ...init, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body }, auth: init.headers && init.headers.Authorization });
  if (/whatsapp_business_profile/.test(url)) {
    if (init.method === 'GET') return { ok: true, status: 200, json: async () => ({ data: [S.profile] }) };
    const b = JSON.parse(init.body); S.profileWrites.push(b); if (b.about !== undefined) Object.assign(S.profile, b); if (b.profile_picture_handle) S.profile.profile_picture_url = 'https://pps.whatsapp.net/new.jpg';
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  }
  if (/\/1335396902996145\?fields=/.test(url)) return { ok: true, status: 200, json: async () => S.phone };
  if (/\/1335396902996145$/.test(url) && init.method === 'POST') { S.nameAsks.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ success: true }) }; }
  if (/\/1427249435405269\/uploads\?/.test(url)) { S.uploadStart = url; return { ok: true, status: 200, json: async () => ({ id: 'upload:MTph' }) }; }
  if (/\/upload:MTph$/.test(url)) { S.uploadBytes = init.body; S.uploadHeaders = init.headers; return { ok: true, status: 200, json: async () => ({ h: 'HANDLE123' }) }; }
  if (/\/\d{6,}$/.test(url) && init.method === 'POST' && S.metaTemplates && !/messages$/.test(url)) {
    const id = url.split('/').pop(); const t = S.metaTemplates.find((x) => x.id === id);
    if (!t) return { ok: false, status: 400, json: async () => ({ error: { message: 'Unsupported post request', code: 100 } }) };
    Object.assign(t, JSON.parse(init.body), { status: 'PENDING' }); return { ok: true, status: 200, json: async () => ({ success: true }) };
  }
  if (/message_templates/.test(url) && S.metaTemplates) {
    if (init.method === 'GET') return { ok: true, status: 200, json: async () => ({ data: S.metaTemplates }) };
    if (init.method === 'POST') { const b = JSON.parse(init.body); S.metaTemplates.push({ id: 't' + S.metaTemplates.length, status: 'PENDING', ...b }); return { ok: true, status: 200, json: async () => ({ id: 'tnew', status: 'PENDING', category: b.category }) }; }
    if (init.method === 'DELETE') { const n = decodeURIComponent(url.split('name=')[1]); const i = S.metaTemplates.findIndex((t) => t.name === n); if (i < 0) return { ok: false, status: 400, json: async () => ({ error: { message: 'not found', code: 100 } }) }; S.metaTemplates.splice(i, 1); return { ok: true, status: 200, json: async () => ({ success: true }) }; }
  }
  return { ok: S.fetchStatus < 400, status: S.fetchStatus, json: async () => S.fetchBody };
};

const wa = require(path.join(SRC, 'lib/chat/whatsapp.ts'));
const inbound = require(path.join(SRC, 'lib/chat/whatsapp-inbound.ts'));
const route = require(path.join(SRC, 'app/api/whatsapp/webhook/route.ts'));
const tpl = require(path.join(SRC, 'lib/chat/whatsapp-templates.ts'));
const prof = require(path.join(SRC, 'lib/chat/whatsapp-profile.ts'));
const rProfile = require(path.join(SRC, 'app/api/whatsapp/profile/route.ts'));
const rPicture = require(path.join(SRC, 'app/api/whatsapp/profile/picture/route.ts'));
const rName = require(path.join(SRC, 'app/api/whatsapp/display-name/route.ts'));
const errs = require(path.join(SRC, 'lib/chat/whatsapp-errors.ts'));
const rActivity = require(path.join(SRC, 'app/api/whatsapp/activity/route.ts'));
const rTemplates = require(path.join(SRC, 'app/api/whatsapp/templates/route.ts'));
const rSettings = require(path.join(SRC, 'app/api/whatsapp/settings/route.ts'));
const rStart = require(path.join(SRC, 'app/api/whatsapp/start/route.ts'));
const OWNER = { username: 'owner', displayName: 'Super Admin', role: 'admin', businessIds: null, permissions: [] };
const AGENT = { username: 'anurag', displayName: 'Anurag', role: 'agent', businessIds: null, permissions: ['chat.view', 'chat.reply'] };
const VIEWER = { username: 'v', displayName: 'V', role: 'viewer', businessIds: null, permissions: ['chat.view'] };
const jreq = (user, body, url = 'http://x/api') => ({ __user: user, url, json: async () => body, headers: { get: () => null }, nextUrl: { searchParams: new URL(url).searchParams } });
const META = () => [
  { id: 'a1', name: 'hello_world', language: 'en_US', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'HEADER', format: 'TEXT', text: 'Hello World' }, { type: 'BODY', text: 'Welcome and congratulations!!' }, { type: 'FOOTER', text: 'WhatsApp Business Platform sample message' }] },
  { id: '200002', name: 'order_update', language: 'en_US', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hi {{1}}, about your order {{2}}: we are looking into it and will update you here.', example: { body_text: [['Rahul', '#1042']] } }] },
  { id: 'a3', name: 'offer', language: 'en', category: 'MARKETING', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT', components: [{ type: 'BODY', text: 'Sale!' }] },
  { id: 'a4', name: 'pending_one', language: 'hi', category: 'UTILITY', status: 'PENDING', components: [{ type: 'BODY', text: 'Namaste {{1}}' }] },
];

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
  try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 14).join('\n       ')); }
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

  console.log('whatsapp: templates (pure)');
  await t('templateSpec: a good template becomes Meta components; the name is cleaned; examples travel with the body', () => {
    const r = tpl.templateSpec({ name: 'Order Shipped', language: 'en_US', category: 'utility', header: 'Order update', body: 'Hi {{1}}, your order {{2}} has shipped. Track it on our page.', footer: 'Vastora Support', examples: ['Rahul', '#1042'] });
    eq(r.ok, true);
    deq(r.spec, { name: 'order_shipped', language: 'en_US', category: 'UTILITY', vars: 2, components: [
      { type: 'HEADER', format: 'TEXT', text: 'Order update' },
      { type: 'BODY', text: 'Hi {{1}}, your order {{2}} has shipped. Track it on our page.', example: { body_text: [['Rahul', '#1042']] } },
      { type: 'FOOTER', text: 'Vastora Support' },
    ] });
    const plain = tpl.templateSpec({ name: 'hello', language: 'hi', category: 'MARKETING', body: 'Namaste! Sale is on.' });
    deq(plain.spec.components, [{ type: 'BODY', text: 'Namaste! Sale is on.' }]);
  });
  await t('templateSpec: every refusal is one plain sentence', () => {
    const bad = (input) => { const r = tpl.templateSpec({ name: 'ok_name', language: 'en_US', category: 'UTILITY', body: 'Hello there', ...input }); eq(r.ok, false); return r.error; };
    assert.match(bad({ name: 'Bad Name!' }), /Name: small letters/);
    assert.match(bad({ language: 'fr' }), /Pick a language/);
    assert.match(bad({ category: 'AUTHENTICATION' }), /Utility or Marketing/);
    assert.match(bad({ body: '  ' }), /Write the message body/);
    assert.match(bad({ body: 'x'.repeat(1025) }), /over 1024/);
    assert.match(bad({ body: 'Hi {{1}}, order {{3}} shipped.' }), /missing \{\{2\}\}/);
    assert.match(bad({ body: 'Hi {{0}} there' }), /up to \{\{20\}\}/);
    assert.match(bad({ body: '{{1}} is your code' }), /cannot start or end/);
    assert.match(bad({ body: 'Hi {{1}}, see {{2}}.', examples: ['Rahul'] }), /example value for each variable \(2\)/);
    assert.match(bad({ header: 'Hi {{1}}' }), /No variables in the header/);
    assert.match(bad({ header: 'h'.repeat(61) }), /header is over 60/);
    assert.match(bad({ footer: 'f'.repeat(61) }), /footer is over 60/);
  });
  await t('varCount / renderTemplate: values fill {{n}}, a missing value stays visible, header and footer join', () => {
    eq(tpl.varCount('Hi {{1}} and {{2}} and {{1}}'), 2);
    eq(tpl.varCount('plain'), 0);
    eq(tpl.renderTemplate({ header: 'Order update', body: 'Hi {{1}}, order {{2}} shipped.', footer: 'Support' }, ['Rahul', '#1042']), 'Order update\nHi Rahul, order #1042 shipped.\nSupport');
    eq(tpl.renderTemplate({ body: 'Hi {{1}}, order {{2}}.' }, ['Rahul']), 'Hi Rahul, order {{2}}.');
  });
  await t('readTemplates: Meta rows become ours; header / body / footer split; rejected reason kept; junk skipped', () => {
    const rows = tpl.readTemplates({ data: [...META(), 'junk', { id: 'x' }] });
    deq(rows.map((r) => [r.name, r.status, r.vars, r.header, r.footer, r.rejectedReason]), [
      ['hello_world', 'APPROVED', 0, 'Hello World', 'WhatsApp Business Platform sample message', null],
      ['order_update', 'APPROVED', 2, null, null, null],
      ['offer', 'REJECTED', 0, null, null, 'INVALID_FORMAT'],
      ['pending_one', 'PENDING', 1, null, null, null],
    ]);
    deq(tpl.readTemplates(null), []);
  });
  await t('listTemplates / createTemplate / deleteTemplate: the API calls carry the token and the account id; no account id = a plain refusal', async () => {
    S.metaTemplates = META();
    const l = await tpl.listTemplates('28873951022288651', env, global.fetch);
    eq(l.ok, true); eq(l.value.length, 4);
    assert.match(S.fetches[0].url, /^https:\/\/graph\.facebook\.com\/v25\.0\/28873951022288651\/message_templates\?fields=/);
    eq(S.fetches[0].auth, 'Bearer tok-secret');
    const spec = tpl.templateSpec({ name: 'order_shipped', language: 'en_US', category: 'UTILITY', body: 'Hi {{1}}, shipped.', examples: ['Rahul'] }).spec;
    deq(await tpl.createTemplate('28873951022288651', spec, env, global.fetch), { ok: true, value: { id: 'tnew', status: 'PENDING' } });
    deq(S.fetches[1].init.body, { name: 'order_shipped', language: 'en_US', category: 'UTILITY', components: spec.components });
    deq(await tpl.deleteTemplate('28873951022288651', 'order_shipped', env, global.fetch), { ok: true, value: true });
    eq(S.metaTemplates.length, 4);
    deq(await tpl.deleteTemplate('28873951022288651', 'nope', env, global.fetch), { ok: false, error: 'not found' });
    deq(await tpl.listTemplates('', env, global.fetch), { ok: false, error: 'Set the WhatsApp Business Account id first' });
    deq(await tpl.listTemplates('28873951022288651', {}, global.fetch), { ok: false, error: 'WhatsApp is not set up (token missing)' });
    deq(await tpl.deleteTemplate('28873951022288651', 'Bad Name', env, global.fetch), { ok: false, error: 'Not a template name' });
  });

  console.log('whatsapp: template routes');
  const withEnv = async (fn) => { const keep = { ...process.env }; Object.assign(process.env, env); try { await fn(); } finally { delete process.env.WHATSAPP_CLOUD_TOKEN; delete process.env.WHATSAPP_PHONE_NUMBER_ID; Object.assign(process.env, keep); } };
  await t('settings: the Super Admin saves the account id in chat_settings (digits only); a member is refused; GET never carries the token', () => withEnv(async () => {
    eq((await rSettings.GET(jreq(AGENT, {}))).status, 401);
    const r = await rSettings.POST(jreq(OWNER, { waba: ' 2887 3951 0222 88651 ' }));
    deq([r.status, r.body], [200, { ok: true, waba: '28873951022288651' }]);
    eq(S.settings.whatsapp_waba_id, '28873951022288651');
    eq((await rSettings.POST(jreq(OWNER, { waba: '12' }))).status, 400);
    const g = await rSettings.GET(jreq(OWNER, {}));
    deq([g.body.configured, g.body.waba, g.body.panel, g.body.phoneNumberId], [true, '28873951022288651', { id: 'bizVast', name: 'bizVast' }, '1335396902996145']);
    assert.ok(!JSON.stringify(g.body).includes('tok-secret'));
  }));
  await t('templates GET: a member who may reply sees the approved ones with ?approved=1, the Super Admin all; a viewer is refused; no account id = a hint', () => withEnv(async () => {
    S.metaTemplates = META();
    const none = await rTemplates.GET(jreq(OWNER, {}, 'http://x/api/whatsapp/templates'));
    deq([none.body.templates, none.body.error], [[], 'Set the WhatsApp Business Account id in Settings > WhatsApp']);
    S.settings.whatsapp_waba_id = '28873951022288651';
    const all = await rTemplates.GET(jreq(OWNER, {}, 'http://x/api/whatsapp/templates'));
    deq(all.body.templates.map((t) => t.name), ['hello_world', 'order_update', 'offer', 'pending_one']);
    const appr = await rTemplates.GET(jreq(AGENT, {}, 'http://x/api/whatsapp/templates?approved=1'));
    deq(appr.body.templates.map((t) => t.name), ['hello_world', 'order_update']);
    eq((await rTemplates.GET(jreq(VIEWER, {}, 'http://x/api/whatsapp/templates'))).status, 403);
    eq((await rTemplates.GET(jreq(null, {}, 'http://x/api/whatsapp/templates'))).status, 401);
  }));
  await t('templates POST / DELETE: Super Admin only; a bad form is a 400 with the reason; a good one goes to Meta for review', () => withEnv(async () => {
    S.metaTemplates = META(); S.settings.whatsapp_waba_id = '28873951022288651';
    eq((await rTemplates.POST(jreq(AGENT, { name: 'x', language: 'en_US', category: 'UTILITY', body: 'Hi' }))).status, 403);
    const bad = await rTemplates.POST(jreq(OWNER, { name: 'order_shipped', language: 'en_US', category: 'UTILITY', body: 'Hi {{1}}' }));
    deq([bad.status, bad.body.error], [400, 'The body cannot start or end with a variable (Meta refuses it)']);
    const ok = await rTemplates.POST(jreq(OWNER, { name: 'Order Shipped', language: 'en_US', category: 'UTILITY', body: 'Hi {{1}}, your order {{2}} has shipped.', examples: ['Rahul', '#1042'] }));
    deq([ok.status, ok.body], [200, { ok: true, id: 'tnew', status: 'PENDING', name: 'order_shipped' }]);
    eq(S.metaTemplates.length, 5);
    const del = await rTemplates.DELETE(jreq(OWNER, {}, 'http://x/api/whatsapp/templates?name=order_shipped'));
    deq([del.status, S.metaTemplates.length], [200, 4]);
    eq((await rTemplates.DELETE(jreq(AGENT, {}, 'http://x/api/whatsapp/templates?name=hello_world'))).status, 403);
  }));
  await t('start: an approved template with its values opens the chat (With team) and the record keeps the filled text; not approved / missing values / bad number refused', () => withEnv(async () => {
    S.metaTemplates = META(); S.settings.whatsapp_waba_id = '28873951022288651';
    const r = await rStart.POST(jreq(AGENT, { to: '98765 43210', template: 'order_update', params: ['Rahul', '#1042'] }));
    deq([r.status, r.body.ok, r.body.text], [200, true, 'Hi Rahul, about your order #1042: we are looking into it and will update you here.']);
    eq(S.convs.length, 1);
    deq([S.convs[0].visitor_id, S.convs[0].status, S.convs[0].source], ['wa:919876543210', 'agent_handling', 'whatsapp']);
    const sent = S.fetches.find((f) => /\/messages$/.test(f.url));
    deq(sent.init.body, { messaging_product: 'whatsapp', recipient_type: 'individual', to: '919876543210', type: 'template', template: { name: 'order_update', language: { code: 'en_US' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Rahul' }, { type: 'text', text: '#1042' }] }] } });
    deq(S.msgs.map((m) => [m.conversation_id, m.content, m.metadata]), [[S.convs[0].id, 'Hi Rahul, about your order #1042: we are looking into it and will update you here.', { agent: 'Anurag', wa_template: 'order_update', wa_sent: true, wa_id: 'wamid.out1' }]]);
    eq(r.body.conversationId, S.convs[0].id);
    deq((await rStart.POST(jreq(AGENT, { to: '9876543210', template: 'pending_one', params: ['x'] }))).body.error, 'That template is not approved yet (Meta reviews it first)');
    deq((await rStart.POST(jreq(AGENT, { to: '9876543210', template: 'order_update', params: ['Rahul'] }))).body.error, 'Fill every value (2)');
    eq((await rStart.POST(jreq(AGENT, { to: '123', template: 'hello_world', params: [] }))).status, 400);
    eq((await rStart.POST(jreq(VIEWER, { to: '9876543210', template: 'hello_world', params: [] }))).status, 403);
    // The same number again: the same chat, a second message.
    await rStart.POST(jreq(OWNER, { to: '+91 98765 43210', template: 'hello_world', params: [] }));
    deq([S.convs.length, S.msgs.length, S.msgs[1].content], [1, 2, 'Hello World\nWelcome and congratulations!!\nWhatsApp Business Platform sample message']);
  }));
  await t('start: Meta refuses -> the record keeps the refusal and the route says so (502)', () => withEnv(async () => {
    S.metaTemplates = META(); S.settings.whatsapp_waba_id = '28873951022288651';
    const realFetch = global.fetch;
    global.fetch = async (url, init) => /\/messages$/.test(url) ? { ok: false, status: 400, json: async () => ({ error: { code: 131026, message: 'Message Undeliverable' } }) } : realFetch(url, init);
    try {
      const r = await rStart.POST(jreq(OWNER, { to: '9876543210', template: 'hello_world', params: [] }));
      deq([r.status, r.body.error], [502, 'WhatsApp did not take it: This number cannot receive WhatsApp messages from us']);
      deq(S.msgs[0].metadata, { agent: 'Super Admin', wa_template: 'hello_world', wa_sent: false, wa_error: 'This number cannot receive WhatsApp messages from us' });
    } finally { global.fetch = realFetch; }
  }));

  console.log('whatsapp: business profile and the number');
  await t('profileSpec: the form becomes Meta\'s profile body; empty fields clear; every refusal is one sentence', () => {
    const r = prof.profileSpec({ about: ' Order help ', description: 'We ship kurtis', address: 'Jaipur', email: 'help@vastora.in', websites: ['https://vastora.in', ''], vertical: 'retail' });
    deq(r, { ok: true, body: { messaging_product: 'whatsapp', about: 'Order help', description: 'We ship kurtis', address: 'Jaipur', email: 'help@vastora.in', websites: ['https://vastora.in'], vertical: 'RETAIL' } });
    deq(prof.profileSpec({}).body, { messaging_product: 'whatsapp', about: '', description: '', address: '', email: '', websites: [], vertical: 'UNDEFINED' });
    const bad = (i) => { const x = prof.profileSpec(i); eq(x.ok, false); return x.error; };
    assert.match(bad({ about: 'x'.repeat(140) }), /over 139/);
    assert.match(bad({ description: 'x'.repeat(513) }), /over 512/);
    assert.match(bad({ email: 'nope' }), /email address/);
    assert.match(bad({ websites: ['vastora.in'] }), /start with https/);
    assert.match(bad({ websites: ['https://a.in', 'https://b.in', 'https://c.in'] }), /At most 2/);
    assert.match(bad({ vertical: 'SPACE' }), /category/);
  });
  await t('readProfile / readPhone: Meta rows become ours; junk is null', () => {
    deq(prof.readProfile({ data: [S.profile] }), { about: 'Order help', description: 'Vastora support', address: '', email: '', websites: ['https://vastora.in'], vertical: 'RETAIL', pictureUrl: 'https://pps.whatsapp.net/old.jpg' });
    eq(prof.readProfile('x'), null);
    deq(prof.readPhone(S.phone), { displayPhoneNumber: '+91 87964 14056', verifiedName: 'Shiptrack', nameStatus: 'PENDING_REVIEW', qualityRating: 'GREEN', status: 'CONNECTED', messagingLimit: 'TIER_250', codeVerification: 'VERIFIED' });
    eq(prof.readPhone({}), null);
    deq([prof.pictureMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), prof.pictureMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), prof.pictureMime(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))], ['image/jpeg', 'image/png', null]);
  });
  await t('profile routes: GET reads it, POST writes it (Super Admin only); a bad form is a 400', () => withEnv(async () => {
    eq((await rProfile.GET(jreq(AGENT, {}))).status, 401);
    const g = await rProfile.GET(jreq(OWNER, {}));
    deq([g.status, g.body.profile.about, g.body.verticals.length > 5], [200, 'Order help', true]);
    const bad = await rProfile.POST(jreq(OWNER, { email: 'nope' }));
    eq(bad.status, 400);
    const ok = await rProfile.POST(jreq(OWNER, { about: 'Order help, Mon-Sat', description: 'd', address: 'Jaipur', email: 'help@vastora.in', websites: ['https://vastora.in'], vertical: 'APPAREL' }));
    deq([ok.status, ok.body], [200, { ok: true }]);
    deq(S.profileWrites[0], { messaging_product: 'whatsapp', about: 'Order help, Mon-Sat', description: 'd', address: 'Jaipur', email: 'help@vastora.in', websites: ['https://vastora.in'], vertical: 'APPAREL' });
    eq(S.fetches.find((f) => /whatsapp_business_profile$/.test(f.url)).auth, 'Bearer tok-secret');
  }));
  await t('the picture: resumable upload on the Meta app (OAuth auth, file_offset 0), then the handle goes on the profile; JPG / PNG only; needs the app id', () => withEnv(async () => {
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const r = await prof.uploadProfilePicture('1427249435405269', jpg, 'image/jpeg', env, global.fetch);
    deq(r, { ok: true, value: 'HANDLE123' });
    assert.match(S.uploadStart, /\/1427249435405269\/uploads\?file_length=7&file_type=image%2Fjpeg$/);
    deq([S.uploadHeaders.Authorization, S.uploadHeaders.file_offset], ['OAuth tok-secret', '0']);
    eq(S.uploadBytes, jpg);
    deq(S.profileWrites.pop(), { messaging_product: 'whatsapp', profile_picture_handle: 'HANDLE123' });
    deq(await prof.uploadProfilePicture('', jpg, 'image/jpeg', env, global.fetch), { ok: false, error: 'Set the Meta App id first (Settings > WhatsApp)' });
    deq(await prof.uploadProfilePicture('1427249435405269', new Uint8Array(0), 'image/jpeg', env, global.fetch), { ok: false, error: 'That file is empty' });
    // The route: multipart with a PNG, the app id from settings.
    S.settings.whatsapp_app_id = '1427249435405269';
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const file = { size: png.length, arrayBuffer: async () => png.buffer.slice(0) };
    const req = (f) => ({ __user: OWNER, formData: async () => ({ get: () => f }) });
    deq((await rPicture.POST(req(file))).body, { ok: true });
    deq((await rPicture.POST(req({ size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }))).body.error, 'JPG or PNG only');
    eq((await rPicture.POST(req(null))).status, 400);
    eq((await rPicture.POST({ __user: AGENT, formData: async () => ({ get: () => file }) })).status, 401);
    delete S.settings.whatsapp_app_id;
    deq((await rPicture.POST(req(file))).status, 400);
  }));
  await t('display name: Meta is asked (3 to 75 characters), Super Admin only; settings GET shows the number\'s live state and both ids', () => withEnv(async () => {
    deq((await rName.POST(jreq(OWNER, { name: 'Vastora' }))).body, { ok: true });
    deq(S.nameAsks, [{ new_display_name: 'Vastora' }]);
    eq((await rName.POST(jreq(OWNER, { name: 'ab' }))).status, 400);
    eq((await rName.POST(jreq(AGENT, { name: 'Vastora' }))).status, 401);
    await rSettings.POST(jreq(OWNER, { appId: '1427249435405269' }));
    const g = await rSettings.GET(jreq(OWNER, {}));
    deq([g.body.appId, g.body.phone.verifiedName, g.body.phone.nameStatus, g.body.phone.messagingLimit], ['1427249435405269', 'Shiptrack', 'PENDING_REVIEW', 'TIER_250']);
  }));
  await t('template edit: POST with an id changes the components on that template (name / language stay) and it goes back to review', () => withEnv(async () => {
    S.metaTemplates = META(); S.settings.whatsapp_waba_id = '28873951022288651';
    const r = await rTemplates.POST(jreq(OWNER, { id: '200002', name: 'order_update', language: 'en_US', category: 'UTILITY', body: 'Hi {{1}}, your order {{2}} is on its way.', examples: ['Rahul', '#1042'] }));
    deq([r.status, r.body], [200, { ok: true, id: '200002', status: 'PENDING', name: 'order_update', edited: true }]);
    const t2 = S.metaTemplates.find((x) => x.id === '200002');
    deq([t2.status, t2.components[0].text, S.metaTemplates.length], ['PENDING', 'Hi {{1}}, your order {{2}} is on its way.', 4]);
    deq((await tpl.updateTemplate('abc', { components: [], category: 'UTILITY' }, env, global.fetch)), { ok: false, error: 'Not a template id' });
    deq((await tpl.updateTemplate('999999', { components: [], category: 'UTILITY' }, env, global.fetch)), { ok: false, error: 'Unsupported post request' });
  }));

  console.log('whatsapp: errors in plain words, activity');
  await t('metaHint: (#10), a dead token, the 24-hour window, an unknown id, not set up; nothing for an unknown text', () => {
    assert.match(errs.metaHint('(#10) Application does not have permission for this action').fix, /System users.*Assign assets.*whatsapp_business_management/);
    assert.match(errs.metaHint('The WhatsApp token was refused (expired or revoked)').what, /dead/);
    assert.match(errs.metaHint('The customer last wrote over 24 hours ago: WhatsApp only allows a template message now').fix, /approved template/);
    assert.match(errs.metaHint('Meta does not know this WhatsApp Business Account id, or the token has no rights on it').fix, /Setup tab/);
    assert.match(errs.metaHint('WhatsApp is not set up (token or phone number id missing)').fix, /WHATSAPP_CLOUD_TOKEN/);
    assert.match(errs.metaHint('This number cannot receive WhatsApp messages from us').what, /blocked/);
    eq(errs.metaHint('Something odd'), null);
    eq(errs.metaHint(''), null);
  });
  await t('activity route: the WhatsApp chats and what the team sent, with Meta\'s report; Super Admin only', () => withEnv(async () => {
    S.convs.push({ id: 'c1', site_id: 'site1', visitor_id: 'wa:919876543210', visitor_name: 'Jatin', visitor_phone: '+919876543210', status: 'agent_handling', source: 'whatsapp', unread_count: 1, merged_into: null });
    S.msgs.push({ id: 'm1', conversation_id: 'c1', sender: 'visitor', content: 'Hello', metadata: { wa_id: 'w1' } });
    S.msgs.push({ id: 'm2', conversation_id: 'c1', sender: 'agent', content: 'Hi Jatin', metadata: { agent: 'Super Admin', wa_sent: true, wa_id: 'wamid.out1', wa_status: 'read' } });
    S.msgs.push({ id: 'm3', conversation_id: 'c1', sender: 'agent', content: 'Hello World', metadata: { agent: 'Anurag', wa_template: 'hello_world', wa_sent: false, wa_error: 'The WhatsApp token was refused (expired or revoked)' } });
    eq((await rActivity.GET(jreq(AGENT, {}))).status, 401);
    const r = await rActivity.GET(jreq(OWNER, {}));
    eq(r.status, 200);
    deq(r.body.chats.map((c) => [c.id, c.name, c.status, c.unread, c.last_message]), [['c1', 'Jatin', 'agent_handling', 1, 'Hello World']]);
    deq(r.body.sent.map((m) => [m.id, m.by, m.template, m.sent, m.status, m.error]), [
      ['m2', 'Super Admin', null, true, 'read', null],
      ['m3', 'Anurag', 'hello_world', false, null, 'The WhatsApp token was refused (expired or revoked)'],
    ]);
  }));

  console.log(`\nwhatsapp: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
