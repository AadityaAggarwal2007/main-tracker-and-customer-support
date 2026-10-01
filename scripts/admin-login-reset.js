#!/usr/bin/env node
// Forgot the owner's own (super admin) login? Run ON THE SERVER:
//   cd /var/www/tracker && node scripts/admin-login-reset.js
// It gives the saved super-admin login (admin_login, admin-login.sql) a new strong password, keeps
// the username, signs out every super-admin login made before (session_version + 1, felt within 30
// seconds) and prints the username and the new password ONCE, here only. Then sign in and set your
// own in Team > "Change username / password". If the login was never changed in the panel there
// is no saved row and nothing to reset: the .env login (ADMIN_USERNAME / ADMIN_PASSWORD) works.
const fs = require('fs');
const { randomBytes, randomInt, scryptSync } = require('crypto');
const { Client } = require('pg');

function loadEnvFile(file) {
  try {
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = l.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* not on the server */ }
}
loadEnvFile('/etc/tracker/.env');
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not found: run this on the server, in /var/www/tracker.');
  process.exit(2);
}

const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
const password = Array.from({ length: 14 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
// The same format as hashPassword in src/lib/auth.ts: s1$<salt>$<scrypt hash>.
const salt = randomBytes(16);
const hash = `s1$${salt.toString('base64')}$${scryptSync(password, salt, 32).toString('base64')}`;

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const r = await db.query(
      `UPDATE admin_login
          SET password_hash = $1, session_version = session_version + 1, updated_at = now(), updated_by = 'server reset'
        WHERE id = 1
      RETURNING username`,
      [hash]
    );
    if (!r.rowCount) {
      console.log('No saved login yet: the .env login (ADMIN_USERNAME / ADMIN_PASSWORD) still works. Nothing changed.');
      return;
    }
    console.log('Super admin login reset. Every older super-admin login stops working within 30 seconds.');
    console.log(`  Username: ${r.rows[0].username}`);
    console.log(`  Password: ${password}`);
    console.log('Sign in with these, then set your own password in Team > "Change username / password".');
  } finally {
    await db.end();
  }
})().catch((e) => { console.error('Reset failed:', e.message); process.exit(1); });
