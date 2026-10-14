import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * True when the calling module is the process entry point (`node x.js` / `tsx x.ts`).
 * Uses pathToFileURL so it works on Windows (`C:\...` -> `file:///C:/...`); the previous
 * `new URL("file://" + argv[1])` comparison never matched there, so `npm run db:migrate`
 * silently did nothing on Windows.
 */
export function isMainModule(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === importMetaUrl;
  } catch {
    return false;
  }
}
