#!/usr/bin/env node
// Runs the AI's golden conversations (cases.js) through the real getAIResponse.
//   node scripts/ai-tests/run.js                 offline: scripted model, code-level checks
//   node scripts/ai-tests/run.js --live          the real model, with the live prompt and saved answers
//                                                (run on the server: scripts/ai-tests/run-on-vps.sh)
//   --filter text   only cases whose id contains text     --repeat n   run each live case n times
// Exit code 1 when a case that is not marked `watch` fails.
const { execSync } = require('child_process');
const { state, getAI, loadEnvFile } = require('./harness');
const cases = require('./cases');

const args = process.argv.slice(2);
const live = args.includes('--live');
const filter = args.includes('--filter') ? args[args.indexOf('--filter') + 1] : '';
const repeat = args.includes('--repeat') ? Math.max(1, parseInt(args[args.indexOf('--repeat') + 1], 10) || 1) : 1;
const SITE_ID = '27099376-cfb3-40e1-8101-ad92e28a8449'; // Vastora, where the real prompt and saved answers live

let sitePrompt = null, siteId = 'test-site'; // a site id makes the saved answers and the Brain load
if (live) {
  loadEnvFile('/etc/tracker/.env');
  if (!process.env.AI_API_KEY || !process.env.CODEX_URL) { console.error('Live mode needs AI_API_KEY and CODEX_URL (it reads /etc/tracker/.env on the server).'); process.exit(2); }
  const psql = (sql) => execSync(`sudo -u postgres psql -d tracking_crm -At -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8', maxBuffer: 1 << 26 });
  sitePrompt = JSON.parse(psql(`SELECT to_json(system_prompt) FROM sites WHERE id='${SITE_ID}'`).trim());
  state.codStates = psql(`SELECT cod_states FROM sites WHERE id='${SITE_ID}'`).trim() || null;
  state.faqs = JSON.parse(psql(`SELECT COALESCE(json_agg(json_build_object('question',question,'answer',answer) ORDER BY sort_order, created_at),'[]') FROM site_faqs WHERE site_id='${SITE_ID}' AND is_enabled`).trim());
  // The notes in the Brain right now (this panel's and the common ones), so the live run tests them too.
  state.liveBrain = JSON.parse(psql(`SELECT COALESCE(json_agg(json_build_object('kind',kind,'title',title,'body',body,'topics',topics,'always',always,'sort_order',sort_order) ORDER BY sort_order, created_at),'[]') FROM brain_notes WHERE is_enabled AND (site_id='${SITE_ID}' OR site_id IS NULL)`).trim() || '[]');
  siteId = SITE_ID;
  state.mode = 'live';
}

function rowsFor(history) {
  const now = Date.now(), rows = [];
  history.forEach((h, i) => {
    const at = new Date(now - (h.ago ?? (history.length - i) * 20000));
    if (h.who === 'visitor') rows.push({ sender: 'visitor', content: h.text, metadata: null, created_at: at });
    else if (h.who === 'ai') rows.push({ sender: 'ai', content: h.text, metadata: null, created_at: at });
    else if (h.who === 'lookup') {
      rows.push({ sender: 'ai', content: '', created_at: at, metadata: { hidden: true, tool_calls: [{ id: h.id, type: 'function', function: { name: 'lookup_order', arguments: JSON.stringify({ order_id: h.orderId, phone_number: h.phone }) } }] } });
      rows.push({ sender: 'tool_result', content: JSON.stringify(h.result), created_at: at, metadata: { hidden: true, tool_call_id: h.id } });
    }
  });
  return rows;
}

function evaluate(c, result) {
  const fails = [];
  const reply = result.content || '';
  const sent = state.requests.map((r) => r.messages.filter((m) => m.role !== 'system').map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : ''}${m.tool_calls ? JSON.stringify(m.tool_calls) : ''}`).join('\n')).join('\n');
  const called = state.responses.flatMap((r) => (r.choices?.[0]?.message?.tool_calls || []).map((t) => t.function.name));
  const e = c.expect || {};
  const system = String(state.requests[0]?.messages?.[0]?.content || '');
  if (!reply.trim() || result.allFailed) fails.push('blank or failed reply');
  for (const re of e.match || []) if (!re.test(reply)) fails.push(`reply should match ${re}`);
  for (const re of e.notMatch || []) if (re.test(reply)) fails.push(`reply must not match ${re}`);
  for (const t of e.calls || []) if (!called.includes(t)) fails.push(`should call ${t}`);
  for (const t of e.notCalls || []) if (called.includes(t)) fails.push(`must not call ${t}`);
  if (e.escalated !== undefined && !!result.escalated !== e.escalated) fails.push(`escalated should be ${e.escalated}`);
  for (const re of e.shown || []) if (!re.test(sent)) fails.push(`the model should have been shown ${re}`);
  for (const re of e.notShown || []) if (re.test(sent)) fails.push(`the model must not be shown ${re}`);
  for (const re of e.systemHas || []) if (!re.test(system)) fails.push(`the system prompt should contain ${re}`);
  for (const re of e.systemNotHas || []) if (re.test(system)) fails.push(`the system prompt must not contain ${re}`);
  if (e.reasoningOff && state.requests[0]?.reasoning?.enabled !== false && String(state.requests[0]?.model).startsWith('deepseek/deepseek-v4')) fails.push('thinking should be off for deepseek-v4');
  return fails;
}

(async () => {
  const { getAIResponse } = getAI();
  const origLog = console.log, origErr = console.error;
  const quiet = () => { console.log = () => {}; console.error = () => {}; };
  const loud = () => { console.log = origLog; console.error = origErr; };
  let pass = 0, fail = 0, watched = 0;
  const failed = [];
  const run = cases.filter((c) => (live ? !c.offlineOnly : !!c.mock && !c.liveOnly) && (!filter || c.id.includes(filter)));
  for (const c of run) {
    for (let n = 0; n < repeat; n++) {
      Object.assign(state, {
        history: rowsFor(c.history), verifiedOrderId: c.verified || null, fresh: c.fresh || null, verified: !!c.verified,
        facts: c.facts || null, brain: c.brain || (live ? state.liveBrain || [] : []), brainError: !!c.brainError, lookups: c.lookups || {}, script: live ? [] : JSON.parse(JSON.stringify(c.mock || [])), requests: [], responses: [],
      });
      let result, err = null;
      quiet();
      try { result = await getAIResponse('test-conv', sitePrompt, null, null, 'chat', siteId); } catch (e) { err = e; }
      loud();
      const fails = err ? [`threw: ${err.message}`] : evaluate(c, result);
      const tag = fails.length ? (c.watch ? 'WATCH' : 'FAIL') : 'PASS';
      if (!fails.length) pass++; else if (c.watch) watched++; else { fail++; failed.push(c.id); }
      console.log(`${tag}  ${c.id}${repeat > 1 ? ` #${n + 1}` : ''} - ${c.title}`);
      if (fails.length || (live && args.includes('--show'))) {
        for (const f of fails) console.log(`      x ${f}`);
        if (result) console.log(`      reply: ${(result.content || '').replace(/\s+/g, ' ').slice(0, 300)}`);
      }
    }
  }
  console.log(`\n${live ? 'LIVE' : 'OFFLINE'}: ${pass} passed, ${fail} failed, ${watched} to watch (of ${run.length * repeat} runs)`);
  if (failed.length) console.log('Failed: ' + [...new Set(failed)].join(', '));
  process.exit(fail ? 1 : 0);
})();
