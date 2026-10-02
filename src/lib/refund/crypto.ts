// ── Refund form: encryption, fingerprints and link tokens (owner, 2026-10-02) ──
// SERVER ONLY. The only file that reads REFUND_DATA_KEY / REFUND_DATA_KEY_OLD (refund-isolation.js I1).
//
// - The UPI / bank details a customer gives are stored ONLY as AES-256-GCM blobs. The AAD binds each
//   blob to its row (request id; file id + part), so someone with database write access cannot move
//   one request's details onto another, or swap / reorder a file's parts.
// - Fingerprints (HMAC-SHA256) find "the same UPI / account / phone" without storing it.
// - Link tokens: 32 random bytes; only their SHA-256 is stored (refund_links.token_hash).
// - NO fallback key, and never derived from AUTH_TOKEN_SECRET (changing that is how the owner signs
//   everyone out; it must never lock the stored bank details). No key = the form is closed (fail
//   closed): the public routes answer 503, Send is blocked, reveal / file view answer 503.
// - Errors carry a code only, never plaintext. Callers log `[refund] decrypt failed <id> <code>`.
// Rotation (rare): new key in REFUND_DATA_KEY, the old one in REFUND_DATA_KEY_OLD, deploy, run
// `node scripts/refund-rekey.js`, then remove REFUND_DATA_KEY_OLD and deploy again.

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'crypto';

export class RefundCryptoError extends Error {
  constructor(public code: 'no_key' | 'bad_blob' | 'unknown_key' | 'auth_failed') {
    super(code);
    this.name = 'RefundCryptoError';
  }
}
interface Keyset { id: string; enc: Buffer; fp: Buffer }

// REFUND_DATA_KEY: 32 random bytes as base64 (44 chars, `openssl rand -base64 32`) or 64 hex chars.
// Anything else (missing, 31 / 33 bytes, garbage) is no key.
function parseKey(raw: string | undefined): Buffer | null {
  const s = (raw || '').trim();
  if (!s) return null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return null;
  const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return b.length === 32 ? b : null;
}
function derive(master: Buffer): Keyset {
  const salt = Buffer.from('shiptrack-refund-v1');
  return {
    id: createHash('sha256').update('refund-kid:').update(master).digest('hex').slice(0, 8),
    enc: Buffer.from(hkdfSync('sha256', master, salt, 'refund-enc-v1', 32)),
    fp: Buffer.from(hkdfSync('sha256', master, salt, 'refund-fp-v1', 32)),
  };
}
// Cached per raw env value (recomputed when the value changes, e.g. in tests).
const cache = new Map<string, Keyset | null>();
function keysetFor(raw: string | undefined): Keyset | null {
  const k = raw || '';
  if (!cache.has(k)) {
    if (cache.size > 8) cache.clear();
    const master = parseKey(k);
    cache.set(k, master ? derive(master) : null);
  }
  return cache.get(k) || null;
}
const current = (): Keyset | null => keysetFor(process.env.REFUND_DATA_KEY);
const old = (): Keyset | null => keysetFor(process.env.REFUND_DATA_KEY_OLD);   // decrypting only
function byId(id: string): Keyset | null {
  const c = current();
  if (c && c.id === id) return c;
  const o = old();
  if (o && o.id === id) return o;
  return null;
}
function need(): Keyset {
  const c = current();
  if (!c) throw new RefundCryptoError('no_key');
  return c;
}

export const refundCryptoReady = (): boolean => current() !== null;
export const currentKeyId = (): string => need().id;
// The previous key's id while rotating (REFUND_DATA_KEY_OLD), else null. For scripts/refund-rekey.js.
export const oldKeyId = (): string | null => old()?.id ?? null;
// 'off' = REFUND_FORMS=off (the owner's kill switch); 'key_missing' = no usable REFUND_DATA_KEY.
export function refundFormsState(): 'on' | 'off' | 'key_missing' {
  if ((process.env.REFUND_FORMS || '').trim().toLowerCase() === 'off') return 'off';
  return refundCryptoReady() ? 'on' : 'key_missing';
}

const b64u = (b: Buffer) => b.toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url');
const B64U_RE = /^[A-Za-z0-9_-]+$/;

// Payout JSON: {"v":1,"method":"upi","upi":"…","holder":"…"} or {"v":1,"method":"bank","account":"…","ifsc":"…","holder":"…"}
// Blob: v1.<keyId>.<b64url iv12>.<b64url tag16>.<b64url ciphertext>
export function sealJson(obj: unknown, aad: string): { blob: string; keyId: string } {
  const k = need();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k.enc, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
  return { blob: `v1.${k.id}.${b64u(iv)}.${b64u(c.getAuthTag())}.${b64u(ct)}`, keyId: k.id };
}
export function openJson<T = unknown>(blob: string, aad: string): T {
  const parts = typeof blob === 'string' ? blob.split('.') : [];
  if (parts.length !== 5 || parts[0] !== 'v1' || !/^[0-9a-f]{8}$/.test(parts[1]) || !parts.slice(2).every((p) => B64U_RE.test(p))) {
    throw new RefundCryptoError('bad_blob');
  }
  const k = byId(parts[1]);
  if (!k) throw new RefundCryptoError(current() || old() ? 'unknown_key' : 'no_key');
  const iv = unb64u(parts[2]), tag = unb64u(parts[3]), ct = unb64u(parts[4]);
  if (iv.length !== 12 || tag.length !== 16) throw new RefundCryptoError('bad_blob');
  let plain: Buffer;
  try {
    const d = createDecipheriv('aes-256-gcm', k.enc, iv);
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(tag);
    plain = Buffer.concat([d.update(ct), d.final()]);
  } catch {
    throw new RefundCryptoError('auth_failed');
  }
  try {
    return JSON.parse(plain.toString('utf8')) as T;
  } catch {
    throw new RefundCryptoError('bad_blob');
  }
}
// The key id a blob was sealed with ('' when it is not a blob).
export const blobKeyId = (blob: string) => (/^v1\.([0-9a-f]{8})\./.exec(blob || '') || [])[1] || '';
export const payoutAad = (requestId: string) => `refund:${requestId}:payout`;

// File parts: iv(12) | tag(16) | ciphertext; AAD = refund-file:<fileId>:<part>.
const fileAad = (fileId: string, part: number) => Buffer.from(`refund-file:${fileId}:${part}`, 'utf8');
export function sealPart(plain: Buffer, fileId: string, part: number): Buffer {
  const k = need();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k.enc, iv);
  c.setAAD(fileAad(fileId, part));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
export function openPart(sealed: Buffer, fileId: string, part: number, keyId: string): Buffer {
  const k = byId(keyId);
  if (!k) throw new RefundCryptoError(current() || old() ? 'unknown_key' : 'no_key');
  if (!Buffer.isBuffer(sealed) || sealed.length < 29) throw new RefundCryptoError('bad_blob');
  try {
    const d = createDecipheriv('aes-256-gcm', k.enc, sealed.subarray(0, 12));
    d.setAAD(fileAad(fileId, part));
    d.setAuthTag(sealed.subarray(12, 28));
    return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
  } catch {
    throw new RefundCryptoError('auth_failed');
  }
}

// Fingerprints: HMAC-SHA256 with the fp sub-key, base64url, first 32 characters.
//   upi: the lower-cased UPI ID   bank: `${IFSC}:${digits}`   phone: the last 10 digits   ip: the client IP
export type FpKind = 'upi' | 'bank' | 'phone' | 'ip';
export function fpValue(kind: FpKind, value: string): string {
  const v = String(value ?? '');
  if (kind === 'upi') return v.trim().toLowerCase();
  if (kind === 'bank') return v.toUpperCase().replace(/[^A-Z0-9:]/g, '');
  if (kind === 'phone') return v.replace(/\D/g, '').slice(-10);
  return v.trim();
}
export function fingerprint(kind: FpKind, value: string): string {
  return createHmac('sha256', need().fp).update(`${kind}:${fpValue(kind, value)}`).digest('base64url').slice(0, 32);
}
export const ipHash = (ip: string) => fingerprint('ip', ip).slice(0, 24);

// Link tokens: 43 base64url characters (32 random bytes), carried in the URL fragment; only the
// SHA-256 hex is stored.
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: createHash('sha256').update(token).digest('hex') };
}
export function tokenHash(token: unknown): string | null {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  return createHash('sha256').update(token).digest('hex');
}
