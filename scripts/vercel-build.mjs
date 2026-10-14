// Vercel build: compile everything, then apply database migrations for
// production deployments so the schema is ready before the new version serves
// traffic. Migrations need the table owner (MIGRATION_DATABASE_URL); preview
// builds never migrate, so a preview can't alter the production schema.
import { spawnSync } from "node:child_process";

function run(command) {
  console.log(`\n> ${command}`);
  const result = spawnSync(command, { stdio: "inherit", shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("npm run build");

if (process.env.VERCEL_ENV !== "production") {
  console.log(`\nSkipping migrations (VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"}).`);
} else if (!process.env.MIGRATION_DATABASE_URL) {
  console.error("\nMIGRATION_DATABASE_URL is not set: production deployments must be able to migrate the database.");
  process.exit(1);
} else {
  run("node apps/api/dist/scripts/migrate.js");
  // Functions have no startup phase, so the platform admin is ensured here.
  run("node apps/api/dist/scripts/ensure-admin.js");
}
