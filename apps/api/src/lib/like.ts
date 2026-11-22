/**
 * A contains-pattern for ILIKE that treats `%`, `_` and `\` in user input as
 * literals. Callers must add `ESCAPE '\\'` on the predicate.
 */
export function likeContains(raw: string | null | undefined, max = 200): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().slice(0, max);
  if (!trimmed) return null;
  return `%${trimmed.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}
