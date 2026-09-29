// ── Rules for files an agent sends in a chat reply ─────────────
// Shared by the inbox, which refuses a file before uploading it, and the API,
// which checks everything again from the file's own bytes — a file's name and
// the MIME type the browser reports are only hints.
// No server-only imports here: the inbox page bundles this file.

export type AttachmentKind = 'image' | 'file';

export interface AttachmentType {
  mime: string;
  exts: string[];
  kind: AttachmentKind;
}

// Only formats a browser shows safely on its own. SVG is left out on purpose:
// it can carry script.
export const ATTACHMENT_TYPES: AttachmentType[] = [
  { mime: 'image/jpeg', exts: ['jpg', 'jpeg'], kind: 'image' },
  { mime: 'image/png', exts: ['png'], kind: 'image' },
  { mime: 'image/webp', exts: ['webp'], kind: 'image' },
  { mime: 'image/gif', exts: ['gif'], kind: 'image' },
  { mime: 'application/pdf', exts: ['pdf'], kind: 'file' },
];

const MB = 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 10 * MB;
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
// Keeps an email reply under Gmail's 25 MB limit once the files are encoded.
export const MAX_ATTACHMENT_TOTAL_BYTES = 15 * MB;

export const UNSUPPORTED_TYPE_MESSAGE = 'File type not supported. You can send JPG, PNG, WEBP, GIF or PDF files.';
export const TOO_LARGE_MESSAGE = `File size exceeds the allowed limit of ${MAX_ATTACHMENT_BYTES / MB} MB.`;
export const TOO_MANY_MESSAGE = `You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files to one message.`;
export const TOTAL_TOO_LARGE_MESSAGE = `Files on one message can add up to ${MAX_ATTACHMENT_TOTAL_BYTES / MB} MB.`;
export const EMPTY_FILE_MESSAGE = 'That file is empty.';

// For the file picker's accept attribute.
export const ATTACHMENT_ACCEPT = ATTACHMENT_TYPES
  .flatMap(t => [t.mime, ...t.exts.map(e => `.${e}`)])
  .join(',');

export const ATTACHMENT_ID_PATTERN = /^[a-f0-9]{64}$/;

// What a sent message keeps in messages.metadata.attachments.
export interface StoredAttachment {
  id: string;
  url: string;
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
  status: 'sent';
}

export function attachmentUrl(id: string): string {
  return `/api/widget/files/${id}`;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

// Browser-side first pass, before any upload. Either the reported type or the
// extension has to be one we take; the server decides for real.
export function checkBrowserFile(file: { name: string; type: string; size: number }): string | null {
  const ext = extensionOf(file.name);
  const known = ATTACHMENT_TYPES.some(t => t.mime === file.type || t.exts.includes(ext));
  if (!known) return UNSUPPORTED_TYPE_MESSAGE;
  if (file.size === 0) return EMPTY_FILE_MESSAGE;
  if (file.size > MAX_ATTACHMENT_BYTES) return TOO_LARGE_MESSAGE;
  return null;
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

const ascii = (s: string) => Array.from(s, c => c.charCodeAt(0));

// Server-side: the type comes from the file's first bytes, never from its name.
export function sniffAttachmentType(bytes: Uint8Array): AttachmentType | null {
  const byMime = (mime: string) => ATTACHMENT_TYPES.find(t => t.mime === mime) ?? null;

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return byMime('image/jpeg');
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return byMime('image/png');
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return byMime('image/gif');
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return byMime('image/webp');

  // PDF readers accept the header anywhere in the first kilobyte, and some
  // generators put a few bytes in front of it.
  const head = String.fromCharCode(...Array.from(bytes.subarray(0, 1024)));
  if (head.includes('%PDF-')) return byMime('application/pdf');

  return null;
}

// Drops any path, control and reserved characters, and makes the extension
// match what the bytes turned out to be.
export function cleanFileName(raw: string, type: AttachmentType): string {
  const last = (raw || '').split(/[\\/]/).pop() || '';
  const tidy = last
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');

  const ext = extensionOf(tidy);
  const base = (ext ? tidy.slice(0, -(ext.length + 1)) : tidy).trim().slice(0, 100) || 'file';
  return `${base}.${type.exts.includes(ext) ? ext : type.exts[0]}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}
