// The "Hello / Regards" tick (owner 2026-10-13): one setting per browser for the notes, the suggested replies and Sudharo
// (localStorage `reply_wrap`, on by default). Storage can be missing (private window): then it is on.
const KEY = 'reply_wrap';
export function getReplyWrap(): boolean {
  try { return localStorage.getItem(KEY) !== '0'; } catch { return true; }
}
export function setReplyWrap(on: boolean): void {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* nothing to keep */ }
}
