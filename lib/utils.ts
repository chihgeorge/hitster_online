export function isValidYear(year: number): boolean {
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
