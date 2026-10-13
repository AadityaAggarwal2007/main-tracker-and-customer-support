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
  state.liveFaqs = JSON.parse(psql(`SELECT COALESCE(json_agg(json_build_object('question',question,'answer',answer) ORDER BY sort_order, created_at),'[]') FROM site_faqs WHERE site_id='${SITE_ID}' AND is_enabled`).trim());
  // The notes in the Brain right now (this panel's and the common ones), so the live run tests them too.
  state.liveBrain = JSON.parse(psql(`SELECT COALESCE(json_agg(json_build_object('kind',kind,'title',title,'body',body,'topics',topics,'always',always,'sort_order',sort_order,'source',source) ORDER BY sort_order, created_at),'[]') FROM brain_notes WHERE is_enabled AND (site_id='${SITE_ID}' OR site_id IS NULL)`).trim() || '[]');
  state.liveExamples = JSON.parse(psql(`SELECT COALESCE(json_agg(json_build_object('id',id,'situation',situation,'customer_said',customer_said,'team_replied',team_replied) ORDER BY created_at DESC),'[]') FROM brain_examples WHERE site_id='${SITE_ID}' AND status='approved' AND is_enabled`).trim() || '[]');
  // --candidate: test a new panel prompt and extra notes from scripts/ai-tests/candidate/ BEFORE they go live.
  if (args.includes('--candidate')) {
    const dir = require('path').join(__dirname, 'candidate');
    sitePrompt = require('fs').readFileSync(require('path').join(dir, 'prompt.txt'), 'utf8');
    const extra = JSON.parse(require('fs').readFileSync(require('path').join(dir, 'notes.json'), 'utf8')).map((n, i) => ({ id: 'cand-' + i, ...n }));
    // --candidate replaces the notes that came from the prompt with the candidate's own.
    state.liveBrain = [...extra, ...(state.liveBrain || []).filter((n) => n.source !== 'prompt')];
  }
  if (args.includes('--nobrain')) { state.liveBrain = []; state.liveExamples = []; } // to compare with and without the Brain
  siteId = SITE_ID;
  state.mode = 'live';
}

function rowsFor(history) {
  const now = Date.now(), rows = [];
  history.forEach((h, i) => {
    const at = new Date(now - (h.ago ?? (history.length - i) * 20000));
    if (h.who === 'visitor') rows.push({ sender: 'visitor', content: h.text, metadata: null, created_at: at });
    else if (h.who === 'ai') rows.push({ sender: 'ai', content: h.text, metadata: null, created_at: at });
    else if (h.who === 'system') rows.push({ sender: 'system', content: h.text, metadata: { system: 'refund', step: 'form', lang: 'hinglish' }, created_at: at });
    else if (h.who === 'lookup') {
      rows.push({ sender: 'ai', content: '', created_at: at, metadata: { hidden: true, tool_calls: [{ id: h.id, type: 'function', function: { name: 'lookup_order', arguments: JSON.stringify({ order_id: h.orderId, phone_number: h.phone }) } }] } });
      rows.push({ sender: 'tool_result', content: JSON.stringify(h.result), created_at: at, metadata: { hidden: true, tool_call_id: h.id } });
    }
  });
  return rows;
}

// Old cases run at Normal for every group (what they were written for). A case can set its own
// `effort` settings; EFFORT=default uses the panel defaults (Frustrated High, Critical Max),
// EFFORT=high|max puts every customer group on that level (to try a level on the whole suite).
const ALL = (lv) => ({ calm: lv, uneasy: lv, frustrated: lv, critical: lv });
function effortFor(c) {
  if (c.effort !== undefined) return c.effort;
  const env = process.env.EFFORT || '';
  if (env === 'default') return null;
  if (env === 'high' || env === 'max') return ALL(env);
  return ALL('normal');
}

function evaluate(c, result, usage) {
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
  for (const t of e.brainUsed || []) if (!(usage?.brain || []).some((b) => b.title === t)) fails.push(`the Brain note "${t}" should have been shown`);
  for (const t of e.brainNotUsed || []) if ((usage?.brain || []).some((b) => b.title === t)) fails.push(`the Brain note "${t}" must not have been shown`);
  // (at High / Max thinking is on by design: this check is for Normal replies)
  if (e.reasoningOff && (usage?.effort?.level || 'normal') === 'normal' && state.requests[0]?.reasoning?.enabled !== false && String(state.requests[0]?.model).startsWith('deepseek/deepseek-v4')) fails.push('thinking should be off for deepseek-v4');
  // Effort (effort.ts): the level chosen, thinking on the first request, the Max self-check.
  const isCheck = (r) => /^\(Note from the system, not the customer: before your reply above is sent/.test(String(r?.messages?.[r.messages.length - 1]?.content || ''));
  if (e.level && usage?.effort?.level !== e.level) fails.push(`effort should be ${e.level}, was ${usage?.effort?.level}`);
  if (e.thinking === true && !(state.requests[0]?.reasoning?.enabled === true && state.requests[0]?.max_tokens >= 6000)) fails.push('the first request should think, with room');
  if (e.thinking === false && state.requests[0]?.reasoning?.enabled !== false) fails.push('the first request should not think');
  if (e.selfChecked !== undefined && state.requests.some(isCheck) !== e.selfChecked) fails.push(`self-check should ${e.selfChecked ? '' : 'not '}run`);
  if (e.requests !== undefined && state.requests.length !== e.requests) fails.push(`should make ${e.requests} model requests, made ${state.requests.length}`);
  if (e.secondNoThinking && !(state.requests[1] && state.requests[1].reasoning?.enabled === false && state.requests[1].model === state.requests[0].model)) fails.push('the second request should be the same model without thinking');
  if (e.checkLight) { const ck = state.requests.find(isCheck); if (!ck || ck.reasoning?.enabled !== false || ck.max_tokens > 800 || ck.tool_choice !== 'none') fails.push('the self-check should be one light call: no thinking, no tools, small'); }
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
        facts: c.facts || null, health: c.health ?? (process.env.HEALTH ? Number(process.env.HEALTH) : null), effortSettings: effortFor(c),
        brain: c.brain || (live ? state.liveBrain || [] : []), brainError: !!c.brainError, faqs: c.faqs || (live ? state.liveFaqs || [] : []), examples: c.examples || (live ? state.liveExamples || [] : []), lookups: c.lookups || {}, script: live ? [] : JSON.parse(JSON.stringify(c.mock || [])), requests: [], responses: [],
      });
      let result, err = null, usage;
      quiet();
      usage = { brain: [] };
      const t0 = Date.now();
      try { result = await getAIResponse('test-conv', sitePrompt, null, null, 'chat', siteId, usage); } catch (e) { err = e; }
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      loud();
      const fails = err ? [`threw: ${err.message}`] : evaluate(c, result, usage);
      if (process.env.DUMP) { const r = state.requests[0]; console.log('--- SYSTEM TAIL ---\n' + String(r?.messages?.[0]?.content || '').slice(-1500)); console.log('--- MESSAGES ---'); for (const m of (r?.messages || []).slice(1)) console.log(m.role + ': ' + String(m.content || JSON.stringify(m.tool_calls || '')).slice(0, 300)); console.log('requests', state.requests.length); }
      const tag = fails.length ? (c.watch ? 'WATCH' : 'FAIL') : 'PASS';
      if (!fails.length) pass++; else if (c.watch) watched++; else { fail++; failed.push(c.id); }
      const eff = usage.effort;
      const cost = live && eff ? `  [${eff.level}${eff.checked ? (eff.changed ? ', fixed' : ', checked') : ''}, ${secs}s, ${eff.promptTokens + eff.completionTokens} tok${eff.reasoningTokens ? `, ${eff.reasoningTokens} thinking` : ''}]` : '';
      console.log(`${tag}  ${c.id}${repeat > 1 ? ` #${n + 1}` : ''} - ${c.title}${cost}`);
      if (fails.length || (live && args.includes('--show'))) {
        for (const f of fails) console.log(`      x ${f}`);
        if (result) console.log(`      reply: ${(result.content || '').replace(/\s+/g, ' ').slice(0, 300)}`);
        if (usage?.effort?.changed && usage.effort.draft) console.log(`      draft before the self-check: ${usage.effort.draft.replace(/\s+/g, ' ').slice(0, 300)}`);
        if (live && fails.length) for (const r of state.responses) { const c = r?.choices?.[0]?.message?.content; if (c) console.log(`      model said: ${String(c).replace(/\s+/g, ' ').slice(0, 400)}`); }
      }
    }
  }
  console.log(`\n${live ? 'LIVE' : 'OFFLINE'}: ${pass} passed, ${fail} failed, ${watched} to watch (of ${run.length * repeat} runs)`);
  if (failed.length) console.log('Failed: ' + [...new Set(failed)].join(', '));
  process.exit(fail ? 1 : 0);
})();
