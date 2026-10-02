// Every match of what was searched for, in yellow, as plain text (never a
// pattern). data-search lets the thread scroll to the newest match.
export function highlightText(text: string, term: string, keyBase: string) {
  if (!term) return text;
  const re = new RegExp('(' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
  return text.split(re).map((part, i) => i % 2 === 1
    ? <mark key={`${keyBase}-${i}`} data-search="1" style={{ background: '#fde047', color: '#111', borderRadius: 3, padding: '0 1px' }}>{part}</mark>
    : part);
}

export function renderWithLinks(text: string, term = '') {
  return text.split(/(https?:\/\/[^\s*]+)/g).map((part, i) =>
    /^https?:\/\//.test(part)
      ? <a key={i} href={part} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline', wordBreak: 'break-all' }}>{highlightText(part, term, `l${i}`)}</a>
      : <span key={i}>{highlightText(part, term, `s${i}`)}</span>
  );
}
