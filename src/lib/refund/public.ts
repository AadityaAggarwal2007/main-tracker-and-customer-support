// ── Refund form: the guards of the public routes (owner, 2026-10-02) ──
// SERVER ONLY. Every /api/refund/* route (open, files, files/<id>, submit) runs publicGuard first.
// Spec refund_form_spec.md 3.1:
//   1. the form must be on (REFUND_FORMS not "off" and a usable key), else 503 {state:'closed'};
//   2. an IP that sent 20 bad tokens / foreign origins in the last hour gets 429 on every route;
//   3. Content-Type: application/json (open, files POST, submit) or application/octet-stream (a part);
//   4. same origin only: an Origin header must be this host (or NEXT_PUBLIC_BASE_URL's), and
//      Sec-Fetch-Site, when sent, must be same-origin or none. These routes are NOT under
//      /api/widget/* (which gets Access-Control-Allow-Origin: *) and never send any CORS header;
//   5. the body is read with a cap (Content-Length first, then the stream itself);
//   6. every answer carries no-store / noindex / no-referrer / nosniff.
// The token travels in the POST body or the X-Refund-Token header, never in a URL. A bad format and
// an unknown token get the byte-identical 404 {state:'invalid'} (and count as "bad" for the IP).
// Nothing here logs: the routes log one line with an error code only (server.ts logFail).

import { NextResponse } from 'next/server';
import { clientIp } from '@/lib/chat/widget-api';
import { refundFormsState, tokenHash } from './crypto';
import { hit, limited, REFUND_LIMITS } from './limits';

export const PUBLIC_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
// A public answer (never any Access-Control-* header).
export const pjson = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { ...PUBLIC_HEADERS } });
// A Super Admin answer (/api/refunds/*, the Send control): never cached.
export const ajson = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

// Body caps (spec 3.1 step 4). A part is at most PART_BYTES (2 MiB), set by the part route.
export const OPEN_MAX = 1024, FILE_MAX = 1024, SUBMIT_MAX = 16 * 1024;

export const INVALID = { state: 'invalid' } as const;
// A bad token or a foreign origin: counted for the caller's IP (rf:bad); 20 in an hour = 429 everywhere.
export function noteBadToken(ip: string): void {
  hit(`rf:bad:${ip}`, REFUND_LIMITS.bad.max, REFUND_LIMITS.bad.windowMs);
}
export const badToken = (ip: string) => { noteBadToken(ip); return pjson(INVALID, 404); };

const hostOf = (url: string | null | undefined): string => {
  try { return url ? new URL(url).host.toLowerCase() : ''; } catch { return ''; }
};
// Only the form page on our own domain may call these routes.
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin !== null) {
    const from = hostOf(origin);
    const own = (request.headers.get('host') || '').trim().toLowerCase();
    const base = hostOf(process.env.NEXT_PUBLIC_BASE_URL || 'https://shiptrack.store');
    if (!from || (from !== own && from !== base)) return false;
  }
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') return false;
  return true;
}

export class TooLarge extends Error {
  constructor() { super('too_large'); this.name = 'TooLarge'; }
}
// The request body, at most `max` bytes: Content-Length is checked first, then the stream itself is cut
// off past the cap (a client can lie about the length or send none).
export async function readCapped(request: Request, max: number): Promise<Buffer> {
  const len = request.headers.get('content-length');
  if (len !== null && (!/^\d+$/.test(len.trim()) || Number(len.trim()) > max)) throw new TooLarge();
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      try { await reader.cancel(); } catch { /* the client is gone */ }
      throw new TooLarge();
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, total);
}

export type BodyKind = 'json' | 'octet' | 'none';
export interface Guarded {
  res: NextResponse | null;                 // answer this instead (the request was refused)
  ip: string;
  raw: Buffer;
  json: Record<string, unknown> | null;     // kind 'json': the parsed object
}
const CONTENT_TYPE: Record<Exclude<BodyKind, 'none'>, string> = { json: 'application/json', octet: 'application/octet-stream' };

export async function publicGuard(request: Request, opts: { kind: BodyKind; max: number }): Promise<Guarded> {
  const ip = clientIp(request);
  const refuse = (body: unknown, status: number): Guarded => ({ res: pjson(body, status), ip, raw: Buffer.alloc(0), json: null });
  if (refundFormsState() !== 'on') return refuse({ state: 'closed' }, 503);
  if (limited(`rf:bad:${ip}`, REFUND_LIMITS.bad.max)) return refuse({ state: 'slow_down' }, 429);
  if (opts.kind !== 'none') {
    const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type !== CONTENT_TYPE[opts.kind]) return refuse({ state: 'bad_request' }, 415);
  }
  if (!sameOrigin(request)) {
    noteBadToken(ip);
    return refuse({ state: 'forbidden' }, 403);
  }
  let raw: Buffer;
  try {
    raw = opts.kind === 'none' ? Buffer.alloc(0) : await readCapped(request, opts.max);
  } catch (e) {
    if (e instanceof TooLarge) return refuse({ state: 'too_large' }, 413);
    throw e;
  }
  if (opts.kind !== 'json') return { res: null, ip, raw, json: null };
  let json: unknown = null;
  try { json = JSON.parse(raw.toString('utf8')); } catch { json = null; }   // never logged: it holds the customer's text
  if (!json || typeof json !== 'object' || Array.isArray(json)) return refuse({ state: 'bad_request' }, 400);
  return { res: null, ip, raw, json: json as Record<string, unknown> };
}

// The link token's SHA-256 (null = not a token): from the JSON body, or from the X-Refund-Token header
// (file parts and file delete, whose body is the raw bytes / empty).
export const tokenFromBody = (json: Record<string, unknown> | null) => tokenHash(json ? json.token : null);
export const tokenFromHeader = (request: Request) => tokenHash(request.headers.get('x-refund-token'));
