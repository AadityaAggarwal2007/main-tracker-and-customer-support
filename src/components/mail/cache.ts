import type { Box, Full, ListEntry, ThreadItem } from './types';

// ── What the Mail tab already read stays on screen (owner 2026-10-08: "jo ek baar save ho chuki hai usko save rehne do") ──
// A module-level copy in the browser's memory (not localStorage, so no customer mail is ever written to disk): going to
// another tab and back shows the last list at once and only refreshes it quietly in the background. Gone when
// the page is reloaded or the person signs out (clearMailCache). The server still stores nothing.
export const mailCache = {
  boxes: null as { list: Box[]; canReply: boolean } | null,
  lists: new Map<string, ListEntry>(),
  mails: new Map<string, Full>(),
  threads: new Map<string, ThreadItem[]>(),
};
export const mailKey = (box: string, uid: number, folder: 'inbox' | 'sent' = 'inbox') => (folder === 'sent' ? `${box}:s${uid}` : `${box}:${uid}`);
export const threadKey = (box: string, address: string) => `${box}:${address}`;
export function clearMailCache(): void { mailCache.boxes = null; mailCache.lists.clear(); mailCache.mails.clear(); mailCache.threads.clear(); }
