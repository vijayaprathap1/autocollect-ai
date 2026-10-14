import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import pg from "pg";
import { config } from "../config.js";
import { isMainModule } from "../lib/main-module.js";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/**
 * Forward-only SQL migrations.
 *  - Runs as MIGRATION_DATABASE_URL (table owner) when set — the RLS-restricted
 *    runtime role in DATABASE_URL cannot ALTER tables.
 *  - Serialised with an advisory lock so concurrent deploys can't double-apply.
 *  - Each file runs in its own transaction and records a SHA-256 checksum; editing
 *    an already-applied migration is reported instead of silently diverging.
 */
export async function migrate(connectionString = config.migrationDatabaseUrl || config.databaseUrl): Promise<string[]> {
  const client = new pg.Client({ connectionString, ssl: config.dbSsl ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('autocollect:migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT now()
      )`);
    await client.query(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT`);

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    const applied = new Map(
      (await client.query<{ name: string; checksum: string | null }>("SELECT name, checksum FROM schema_migrations")).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );

    const done: string[] = [];
    for (const file of files) {
      const sql = await readFile(join(migrationsDir, file), "utf8");
      const checksum = createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");

      if (applied.has(file)) {
        const recorded = applied.get(file);
        if (!recorded) {
          await client.query("UPDATE schema_migrations SET checksum = $2 WHERE name = $1", [file, checksum]);
        } else if (recorded !== checksum) {
          console.warn(`[migrate] WARNING: ${file} was modified after it was applied (checksum mismatch). Create a new migration instead of editing old ones.`);
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      done.push(file);
    }
    return done;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('autocollect:migrations'))").catch(() => {});
    await client.end();
  }
}

if (isMainModule(import.meta.url)) {
  migrate()
    .then((done) => {
      console.log(done.length ? `Applied migrations: ${done.join(", ")}` : "Migrations up to date");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Migration failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
