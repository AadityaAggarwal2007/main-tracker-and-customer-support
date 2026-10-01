// ── "Is this person really here?" (chat team, owner 2026-10-01) ───
// The server notes a team member as seen in ShipTrack (src/lib/auth.ts, staff_presence) on every
// change they make, and on a GET only when it carries x-st-active: 1. The screens poll every few
// seconds whether anyone is looking or not, so a poll alone must not count: a tab left open on a
// desk overnight, a locked phone or a background tab would keep someone "around" forever, and the
// away rules (a waiting customer's chat can be taken from a member away 30 minutes; a junior marks
// Refund / Ship again while every senior is away) would never start.
//
// So the polls of the inbox (/api/chat/conversations, the open thread) and of the Orders screen's
// chat badge (/api/chat/pending) add activeHeaders(): the header only while the tab is visible AND
// the person touched it (mouse, keys, scroll, touch) in the last 5 minutes. Browser only; nothing
// is stored and nothing is sent anywhere else.

const ACTIVE_WINDOW_MS = 5 * 60_000;
const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'] as const;

// Not set by loading the page: a tab the browser restored by itself has not been touched.
let lastInput = 0;
let listening = false;

function listen() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  const mark = () => { lastInput = Date.now(); };
  // Capture, so a widget that stops an event (a menu, a dialog) still counts; passive, so scrolling
  // is never slowed down. Registered once for the whole page, whichever screen imports this first.
  for (const ev of INPUT_EVENTS) window.addEventListener(ev, mark, { passive: true, capture: true });
}

// Start listening as soon as a screen loads this, so the first poll after a click already counts.
listen();

// The headers to add to a polling GET: { 'x-st-active': '1' } while the person is really using
// this tab, otherwise nothing (the request is still made; it just does not say "I am here").
export function activeHeaders(): Record<string, string> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return {};
  listen();
  if (document.visibilityState !== 'visible') return {};
  if (Date.now() - lastInput > ACTIVE_WINDOW_MS) return {};
  return { 'x-st-active': '1' };
}
