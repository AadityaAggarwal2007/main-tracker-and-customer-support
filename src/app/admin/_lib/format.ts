/* ═══ "3 orders" / "1 order" ═══ */
export function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}
