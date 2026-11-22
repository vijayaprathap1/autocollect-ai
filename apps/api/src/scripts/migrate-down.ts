import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "../config.js";
import { isMainModule } from "../lib/main-module.js";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const downDir = join(migrationsDir, "down");

/**
 * Roll back the latest applied migration that has a companion file in
 * `migrations/down/<same name>`. Refuses to skip a migration that has no
 * down script (that would leave the schema_migrations history lying).
 *
 *   npm run db:migrate:down -- --steps=1
 */
export async function migrateDown(
  steps = 1,
  connectionString = config.migrationDatabaseUrl || config.databaseUrl,
): Promise<string[]> {
  if (!Number.isInteger(steps) || steps < 1 || steps > 20) {
    throw new Error("--steps must be an integer between 1 and 20");
  }
  const client = new pg.Client({ connectionString, ssl: config.dbSsl ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  const rolled: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('autocollect:migrations'))");
    const applied = (
      await client.query<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name DESC`)
    ).rows.map((r) => r.name);

    for (let i = 0; i < steps; i++) {
      const name = applied[i];
      if (!name) break;
      let sql: string;
      try {
        sql = await readFile(join(downDir, name), "utf8");
      } catch {
        throw new Error(`No down migration for ${name}. Refusing to roll back past it.`);
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(`DELETE FROM schema_migrations WHERE name = $1`, [name]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Down migration ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      rolled.push(name);
    }
    return rolled;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('autocollect:migrations'))").catch(() => {});
    await client.end();
  }
}

if (isMainModule(import.meta.url)) {
  const raw = process.argv.find((a) => a.startsWith("--steps="))?.split("=")[1] ?? "1";
  migrateDown(Number(raw))
    .then((done) => {
      console.log(done.length ? `Rolled back: ${done.join(", ")}` : "Nothing to roll back");
      process.exit(0);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
