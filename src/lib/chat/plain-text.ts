// ── Plain text for chat bubbles and emails ─────────────────────
// Chat bubbles and plain-text emails show characters exactly as typed, so
// markdown pasted in from other tools ("**Tracking Link:**") reached customers
// as literal asterisks — in 680 of the team's 986 replies by 2026-09-29 — and
// a ** stuck to the end of a link broke the link. Only the markers go: the
// words, lists and single asterisks stay as written, and links are never
// touched. No imports: the inbox page may bundle this file.

// A link ends at whitespace or an asterisk, so "https://…/abc**" loses the **.
const LINK = /(https?:\/\/[^\s*]+)/;

export function stripMarkdownEmphasis(text: string): string {
  return text
    .split(LINK)
    .map((part, i) => (i % 2 === 1 ? part : part
      .replace(/\*\*/g, '')                          // **bold**, and any left unpaired
      .replace(/__(?=\S)([^_\n]*?\S)__/g, '$1')      // __bold__
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')))        // ### headings
    .join('');
}
