import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, query } from "../lib/db.js";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

async function ensureTable(client: { query: (text: string) => Promise<unknown> }) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `);
}

export async function migrate(): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('autocollect:migrations'))");
    await ensureTable(client);
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    const applied = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );
    const done: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
      done.push(file);
    }
    return done;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('autocollect:migrations'))").catch(() => {});
    client.release();
  }
}

// Run directly: `npm run db:migrate`
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  migrate()
    .then((done) => {
      console.log(done.length ? `Applied migrations: ${done.join(", ")}` : "Migrations up to date");
      return pool.end();
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}