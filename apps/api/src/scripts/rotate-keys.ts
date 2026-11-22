import { rotateStoredSecrets } from "../lib/rotate-secrets.js";
import { isMainModule } from "../lib/main-module.js";
import { closeDb } from "../lib/db.js";

/**
 * Rewrite encrypted integration tokens and TOTP seeds with the current key version.
 *
 *   CREDENTIALS_ENCRYPTION_KEY=...old32chars... \
 *   CREDENTIALS_ENCRYPTION_KEYS=2:...new32chars... \
 *   CREDENTIALS_ENCRYPTION_KEY_VERSION=2 \
 *   npm run db:rotate-keys -w @autocollect/api
 */
async function main() {
  const report = await rotateStoredSecrets();
  console.log(JSON.stringify(report));
  await closeDb();
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
