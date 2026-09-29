// ── Clean text for chat bubbles and emails ─────────────────────
// What the team or the AI sends is cleaned here before it is saved, because
// customers see it exactly as typed. No imports: small and testable on its own.

// Markdown pasted in from other tools ("**Tracking Link:**") reached customers
// as literal asterisks — in 680 of the team's 986 replies by 2026-09-29 — and
// a ** stuck to the end of a link broke the link. Only the markers go: the
// words, lists and single asterisks stay as written, and links are never
// touched.

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

// The store is called Vastora; its web address is vestora.in.net. The team
// wrote "Vestora" in every sign-off (862 replies by 2026-09-29), so the name is
// corrected wherever it stands as a word — never inside a web or email address,
// where vestora is the real spelling.
const BRAND_TYPO = /(?<![@./\w-])vestora(?![\w-]|\.[a-z])/gi;

function matchCase(found: string, right: string): string {
  if (found === found.toUpperCase()) return right.toUpperCase();
  if (found[0] === found[0].toUpperCase()) return right[0].toUpperCase() + right.slice(1);
  return right;
}

export function fixBrandSpelling(text: string): string {
  return text
    .split(LINK)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(BRAND_TYPO, found => matchCase(found, 'vastora'))))
    .join('');
}

// Everything above, for a reply from our side.
export function cleanOutgoingText(text: string): string {
  return fixBrandSpelling(stripMarkdownEmphasis(text));
}
