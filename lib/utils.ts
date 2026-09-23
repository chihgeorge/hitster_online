export function isValidYear(year: number | null | undefined): boolean {
  if (year == null) return false;
  return year >= 1900 && year <= new Date().getFullYear() + 1;
}

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function sanitizeText(s: string, maxLength = 100): string {
  return s
    .replace(/[&<>"']/g, (c) => HTML_ESCAPE[c] ?? c)
    .trim()
    .slice(0, maxLength);
}

/** Fisher-Yates shuffle, returns a new array. Was duplicated inline as
 * `.sort(() => Math.random() - 0.5)` in 4 places in party/index.ts (ponytail-audit finding). */
export function shuffle<T>(items: readonly T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
