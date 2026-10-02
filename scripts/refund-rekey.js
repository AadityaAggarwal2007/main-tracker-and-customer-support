#!/usr/bin/env node
// Refund form: re-encrypt the stored UPI / bank details and photos / video with a NEW key (owner,
// 2026-10-02; spec 2.1 "Rotation"). Rare. Run ON THE SERVER, only while rotating the key:
//   1. Put the new key in REFUND_DATA_KEY and the previous one in REFUND_DATA_KEY_OLD
//      (/etc/tracker/.env, the developer edits it himself), then deploy.
//   2. cd /var/www/tracker && node scripts/refund-rekey.js --dry    (reads + test-decrypts, writes nothing)
//      cd /var/www/tracker && node scripts/refund-rekey.js          (re-keys)
//   3. When it says "Still on the old key: 0", remove REFUND_DATA_KEY_OLD and deploy again.
// Per request and per file, in ONE transaction each: SET LOCAL lock_timeout, set_config
// ('shiptrack.refund_rekey','on', true) (the only switch that lets the refund-forms.sql guards accept
// a new payout_enc / payout_fp / phone_fp / key_id / part), re-seal with the same AAD, recompute the
// fingerprints with the new key (phone_fp from the order's phone now; NULL when the order is gone,
// as at submit), and one refund_events row 'rekey' (ids and key ids only).
// It prints COUNTS ONLY: never a key, a UPI ID, an account, a phone or a file. Errors print the row
// id and a code. The encryption code is the app's own (src/lib/refund/crypto.ts, compiled here with
// TypeScript), so the script and the app can never disagree on the format.
// Safe to run twice: rows already on the new key are skipped. Exit 1 if any row failed.
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.resolve(__dirname, '..');

function loadEnvFile(file) {
  try {
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = l.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* not there */ }
}

// src/lib/refund/{rules,crypto}.ts compiled into a temp dir (rules.ts has no imports; crypto.ts only 'crypto').
function compileRefund(root = ROOT) {
  const ts = require('typescript');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refund-rekey-'));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
  for (const name of ['rules', 'crypto']) {
    const src = fs.readFileSync(path.join(root, 'src/lib/refund', `${name}.ts`), 'utf8');
    fs.writeFileSync(path.join(dir, `${name}.js`), ts.transpileModule(src, { compilerOptions: { module: 'commonjs', target: 'es2020' } }).outputText);
  }
  return { rules: require(path.join(dir, 'rules.js')), crypto: require(path.join(dir, 'crypto.js')) };
}

const codeOf = (e) => String((e && e.code) || 'error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 20) || 'error';

async function tx(db, fn) {
  await db.query('BEGIN');
  try {
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SELECT set_config('shiptrack.refund_rekey', 'on', true)");
    const out = await fn();
    await db.query('COMMIT');
    return out;
  } catch (e) {
    try { await db.query('ROLLBACK'); } catch { /* the connection is gone */ }
    throw e;
  }
}

// The order's phone now (panel-scoped, exactly one row), fingerprinted with the current key.
async function phoneFp(db, crypto, businessId, orderId) {
  const o = await db.query(
    'SELECT customer_mobile FROM orders WHERE order_id = $1 AND business_id::text = $2::text LIMIT 2', [orderId, businessId]);
  const digits = o.rows.length === 1 ? String(o.rows[0].customer_mobile || '').replace(/\D/g, '') : '';
  return digits ? crypto.fingerprint('phone', digits) : null;
}

// db: anything with query(text, params) on ONE connection (a pg Client). Returns the counts.
async function rekey(db, { crypto, rules }, { dry = false, log = (s) => console.log(s) } = {}) {
  const cur = crypto.currentKeyId();   // throws RefundCryptoError('no_key')
  const c = { requests: 0, requestsFailed: 0, files: 0, parts: 0, filesFailed: 0, skipped: 0, left: { requests: 0, files: 0 } };

  // ── Requests: payout_enc (+ payout_fp, phone_fp) ──
  const reqs = await db.query('SELECT id FROM refund_requests WHERE payout_key_id <> $1 ORDER BY created_at, id', [cur]);
  for (const { id } of reqs.rows) {
    try {
      if (dry) {
        const r = await db.query('SELECT id, payout_enc FROM refund_requests WHERE id = $1', [id]);
        if (r.rows[0]) crypto.openJson(r.rows[0].payout_enc, crypto.payoutAad(id));
        c.requests++;
        continue;
      }
      const done = await tx(db, async () => {
        const r = await db.query(
          `SELECT id, conversation_id, business_id, order_id, payout_enc, payout_key_id
             FROM refund_requests WHERE id = $1 FOR UPDATE`, [id]);
        const row = r.rows[0];
        if (!row || row.payout_key_id === cur) return false;
        const payout = crypto.openJson(row.payout_enc, crypto.payoutAad(row.id));
        const sealed = crypto.sealJson(payout, crypto.payoutAad(row.id));
        const fpIn = rules.payoutFpInput(payout);
        const fp = crypto.fingerprint(fpIn.kind, fpIn.value);
        const pfp = await phoneFp(db, crypto, row.business_id, row.order_id);
        const u = await db.query(
          `UPDATE refund_requests SET payout_enc = $2, payout_key_id = $3, payout_fp = $4, phone_fp = $5
            WHERE id = $1 AND payout_key_id = $6`, [row.id, sealed.blob, sealed.keyId, fp, pfp, row.payout_key_id]);
        if (u.rowCount !== 1) return false;
        await db.query(
          `INSERT INTO refund_events (request_id, conversation_id, kind, actor, meta)
           VALUES ($1, $2, 'rekey', 'system', $3::jsonb)`,
          [row.id, row.conversation_id, JSON.stringify({ what: 'payout', from_key: row.payout_key_id, to_key: sealed.keyId })]);
        return true;
      });
      if (done) c.requests++; else c.skipped++;
    } catch (e) {
      c.requestsFailed++;
      log(`[refund] rekey failed request ${id} ${codeOf(e)}`);
    }
  }

  // ── Files: every part (one part in memory at a time), then refund_files.key_id ──
  const files = await db.query('SELECT id FROM refund_files WHERE key_id <> $1 ORDER BY created_at, id', [cur]);
  for (const { id } of files.rows) {
    try {
      const n = await (dry ? (async () => {
        const f = await db.query('SELECT id, key_id FROM refund_files WHERE id = $1', [id]);
        if (!f.rows[0]) return 0;
        const ps = await db.query('SELECT part FROM refund_file_parts WHERE file_id = $1 ORDER BY part', [id]);
        for (const { part } of ps.rows) {
          const d = await db.query('SELECT data FROM refund_file_parts WHERE file_id = $1 AND part = $2', [id, part]);
          crypto.openPart(d.rows[0].data, id, part, f.rows[0].key_id);
        }
        return ps.rows.length;
      })() : tx(db, async () => {
        const f = await db.query('SELECT id, link_id, request_id, key_id FROM refund_files WHERE id = $1 FOR UPDATE', [id]);
        const row = f.rows[0];
        if (!row || row.key_id === cur) return -1;
        const ps = await db.query('SELECT part FROM refund_file_parts WHERE file_id = $1 ORDER BY part', [id]);
        for (const { part } of ps.rows) {
          const d = await db.query('SELECT data FROM refund_file_parts WHERE file_id = $1 AND part = $2', [id, part]);
          const plain = crypto.openPart(d.rows[0].data, id, part, row.key_id);
          await db.query('UPDATE refund_file_parts SET data = $3 WHERE file_id = $1 AND part = $2', [id, part, crypto.sealPart(plain, id, part)]);
        }
        await db.query('UPDATE refund_files SET key_id = $2 WHERE id = $1', [id, cur]);
        await db.query(
          `INSERT INTO refund_events (link_id, request_id, kind, actor, meta)
           VALUES ($1, $2, 'rekey', 'system', $3::jsonb)`,
          [row.link_id, row.request_id, JSON.stringify({ what: 'file', file_id: id, parts: ps.rows.length, from_key: row.key_id, to_key: cur })]);
        return ps.rows.length;
      }));
      if (n < 0) c.skipped++;
      else { c.files++; c.parts += n; }
    } catch (e) {
      c.filesFailed++;
      log(`[refund] rekey failed file ${id} ${codeOf(e)}`);
    }
  }

  const left = await db.query(
    `SELECT (SELECT count(*) FROM refund_requests WHERE payout_key_id <> $1) AS requests,
            (SELECT count(*) FROM refund_files WHERE key_id <> $1) AS files`, [cur]);
  c.left = { requests: Number(left.rows[0].requests) || 0, files: Number(left.rows[0].files) || 0 };
  return c;
}

module.exports = { rekey, compileRefund, loadEnvFile };

if (require.main === module) {
  loadEnvFile('/etc/tracker/.env');
  loadEnvFile(path.join(process.cwd(), '.env.production.local'));
  const dry = process.argv.includes('--dry');
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not found: run this on the server, in /var/www/tracker.');
    process.exit(2);
  }
  let mods;
  try { mods = compileRefund(); } catch (e) {
    console.error(`Could not load src/lib/refund (${codeOf(e)}): run it in /var/www/tracker after npm ci.`);
    process.exit(2);
  }
  if (!mods.crypto.refundCryptoReady()) {
    console.error('REFUND_DATA_KEY is missing or is not 32 bytes (base64 or 64 hex): nothing was changed.');
    process.exit(2);
  }
  const oldId = mods.crypto.oldKeyId();
  if (process.env.REFUND_DATA_KEY_OLD && !oldId) {
    console.error('REFUND_DATA_KEY_OLD is set but is not a 32-byte key: nothing was changed.');
    process.exit(2);
  }
  if (oldId && oldId === mods.crypto.currentKeyId()) {
    console.error('REFUND_DATA_KEY_OLD is the same key as REFUND_DATA_KEY: nothing to re-key.');
    process.exit(2);
  }
  const { Client } = require('pg');
  (async () => {
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      const c = await rekey(db, mods, { dry });
      const verb = dry ? 'Readable with the keys now set (dry run, nothing written)' : 'Re-keyed';
      console.log(`${verb}: ${c.requests} refund request(s), ${c.files} file(s) (${c.parts} part(s)). Skipped (already done): ${c.skipped}.`);
      console.log(`Failed: ${c.requestsFailed} request(s), ${c.filesFailed} file(s).`);
      console.log(`Still on the old key: ${c.left.requests} request(s), ${c.left.files} file(s).`);
      if (!dry && !c.requestsFailed && !c.filesFailed && !c.left.requests && !c.left.files) {
        console.log('Done: remove REFUND_DATA_KEY_OLD from /etc/tracker/.env and deploy again.');
      } else if (!oldId && (c.left.requests || c.left.files)) {
        console.log('REFUND_DATA_KEY_OLD is not set: put the previous key there, deploy, and run this again.');
      }
      if (c.requestsFailed || c.filesFailed) process.exitCode = 1;
    } finally {
      await db.end();
    }
  })().catch((e) => {
    if (e && e.code === '42P01') console.error('The refund tables are not installed (refund-forms.sql): nothing to re-key.');
    else console.error(`Re-key stopped (${codeOf(e)}).`);
    process.exit(1);
  });
}
