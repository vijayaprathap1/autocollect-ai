// Copies SQL migrations next to the compiled scripts so `node dist/scripts/migrate.js`
// finds them in production images (tsc only emits .js files).
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "src", "migrations");
const to = join(root, "dist", "migrations");

if (!existsSync(from)) {
  console.error(`copy-migrations: ${from} not found`);
  process.exit(1);
}
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`copy-migrations: ${from} -> ${to}`);
