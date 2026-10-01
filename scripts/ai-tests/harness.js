// Runs the REAL getAIResponse (src/lib/chat/ai.ts and the guards around it) against a
// fake database and either a scripted fake model (offline) or the real model (live).
// Nothing here writes to a real database or sends anything to a customer.
const fs = require('fs'), os = require('os'), path = require('path'), Module = require('module');
const ts = require('typescript');

const SRC = path.resolve(__dirname, '../../src/');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tests-'));
// The compiled copies are deleted when the run ends.
process.on('exit', () => { try { fs.rmSync(OUT, { recursive: true, force: true }); } catch { /* ignore */ } });

const FILES = ['ai', 'lookup-guard', 'introduction', 'plain-text', 'cod', 'delay-ladder', 'escalation', 'today-promise', 'brain', 'brain-learn', 'brain-examples', 'health-rules'];
for (const f of FILES) {
  if (!fs.existsSync(path.join(SRC, 'lib/chat', f + '.ts'))) continue; // an older checkout may lack a newer file
  const src = fs.readFileSync(path.join(SRC, 'lib/chat', f + '.ts'), 'utf8');
  const js = ts.transpileModule(src, { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true } }).outputText;
  fs.writeFileSync(path.join(OUT, f + '.js'), js);
}

// What the current test case set up, read by the stubs below.
const state = {
  mode: 'offline', history: [], verifiedOrderId: null, fresh: null, verified: false, facts: null,
  lookups: {}, faqs: [], brain: [], brainError: false, examples: [], codStates: null, script: [], requests: [], responses: [],
};

const digits = (x) => String(x == null ? '' : x).replace(/\D/g, '');
const normId = (x) => String(x == null ? '' : x).toLowerCase().replace(/[#\s]/g, '');

// The same outcomes as orders.lookupOrder: needs both, a full 10-digit phone, then a match.
async function lookupOrder({ order_id, phone_number }) {
  const id = normId(order_id), ph = digits(phone_number).slice(-10);
  if (!id && !ph) return { found: false, needs_verification: true, message: 'Ask the customer for their order ID and the phone number on the order. Both are needed.' };
  if (!id) return { found: false, needs_verification: true, message: 'A phone number alone verifies nothing. Ask for the order ID as well, then look up again with both.' };
  if (ph.length !== 10) return { found: false, needs_verification: true, message: 'An order number alone is not proof of ownership. Ask for the complete phone number on the order (all 10 digits), then look up again with both.' };
  const o = state.lookups[id + '|' + ph];
  if (o) return { found: true, count: 1, orders: [o] };
  return { found: false, message: 'No order found with that order ID and phone number. Ask the customer to double-check both and try once more.' };
}

const stubs = {
  '@/lib/db': {
    query: async (sql, params) => {
      if (/FROM messages/.test(sql) && /ORDER BY created_at ASC/.test(sql)) return { rows: state.history };
      if (/site_faqs/.test(sql)) return { rows: state.faqs };
      if (/FROM brain_examples/.test(sql)) return { rows: state.examples.filter((e) => (params?.[1] || []).includes(e.situation)) };
      if (/brain_notes/.test(sql)) { if (state.brainError) throw new Error('relation "brain_notes" does not exist'); return { rows: state.brain }; }
      return { rows: [] };
    },
    queryOne: async (sql) => {
      if (/EXISTS/.test(sql)) return { yes: state.history.some((m) => m.sender === 'ai' && (m.content || '').trim()) };
      if (/verified_order_id FROM conversations/.test(sql)) return { verified_order_id: state.verifiedOrderId };
      if (/cod_states/.test(sql)) return { cod_states: state.codStates };
      return null;
    },
  },
  './orders': {
    customerKeyForOrderSql: () => 'NULL', lookupOrder,
    lookupVerifiedOrder: async () => state.fresh || { found: false, message: 'The verified order could not be loaded.' },
    normalizePhone: (x) => digits(x).slice(-10),
  },
  './lookup-limits': { LIMITS: { order: { max: 999, windowMs: 1 }, phone: { max: 999, windowMs: 1 }, visitor: { max: 999, windowMs: 1 }, ip: { max: 999, windowMs: 1 } }, isLimited: () => false, release() {}, reserve() {} },
  './verified': { chatIsVerified: async () => state.verified },
  './order-facts': { loadOrderFacts: async () => state.facts },
  'openai': {
    __esModule: true,
    default: class FakeOpenAI {
      constructor() {
        this.chat = { completions: { create: async (body) => {
          state.requests.push(body);
          let res;
          if (state.mode === 'live') {
            const Real = realOpenAI();
            const Cls = Real.default || Real;
            res = await new Cls({ baseURL: `${process.env.CODEX_URL}/v1`, apiKey: process.env.AI_API_KEY }).chat.completions.create(body, { timeout: 60000, maxRetries: 1 });
          } else {
            const next = state.script.length ? state.script.shift() : { content: 'Sure, happy to help.' };
            res = { model: body.model, choices: [{ message: { content: next.content ?? null, tool_calls: next.tool_calls || null }, finish_reason: 'stop' }], usage: {} };
          }
          state.responses.push(res);
          return res;
        } } };
      }
    },
  },
};

const origLoad = Module._load;
const realOpenAI = () => origLoad.call(Module, 'openai', module, false);
Module._load = function (req, parent, isMain) {
  if (stubs[req]) return stubs[req];
  if (req.startsWith('./') && parent && parent.filename && parent.filename.startsWith(OUT)) {
    const p = path.join(OUT, req.slice(2) + '.js');
    if (fs.existsSync(p)) return origLoad.call(this, p, parent, isMain);
  }
  return origLoad.apply(this, arguments);
};

function loadEnvFile(file) {
  try {
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = l.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* not on the server */ }
}

module.exports = { state, getAI: () => { process.env.AI_API_KEY = process.env.AI_API_KEY || 'offline'; return require(path.join(OUT, 'ai.js')); }, loadEnvFile, OUT };
