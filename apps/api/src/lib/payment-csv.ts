/** Read a CSV cell by header alias. Ignores case, spaces and punctuation. */
export function paymentCsvField(row: Record<string, string>, aliases: string[]): string {
  const norm = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const cells = new Map<string, string>();
  for (const [key, value] of Object.entries(row)) {
    const name = norm(key);
    if (!name || cells.has(name)) continue;
    const text = value == null ? "" : String(value).trim();
    if (text) cells.set(name, text);
  }
  for (const alias of aliases) {
    const hit = cells.get(norm(alias));
    if (hit) return hit;
  }
  return "";
}
