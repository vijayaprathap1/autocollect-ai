/**
 * One-time role bootstrap for production-grade tenant isolation.
 *
 * Creates two non-superuser roles with least privilege (DML only — no DDL,
 * TRUNCATE or ownership):
 *  - autocollect_app     (RLS-enforced)  -> DATABASE_URL for per-request clients
 *  - autocollect_service (BYPASSRLS)     -> SERVICE_DATABASE_URL for platform work
 *
 * Run as the table owner / superuser (MIGRATION_DATABASE_URL or DATABASE_URL):
 *   APP_DB_PASSWORD=... SERVICE_DB_PASSWORD=... npm run db:roles
 * Passwords are REQUIRED outside development.
 */
import "dotenv/config";
import pg from "pg";
import { isMainModule } from "../lib/main-module.js";

const dbUrl =
  process.env.MIGRATION_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgres://autocollect:autocollect_dev@localhost:5433/autocollect";
const devLike = ["development", "test", undefined, ""].includes(process.env.NODE_ENV);

function password(name: string, devDefault: string): string {
  const v = process.env[name];
  if (v && v.length >= 16) return v;
  if (v && !devLike) throw new Error(`${name} must be at least 16 characters`);
  if (!devLike) throw new Error(`${name} is required outside development`);
  return v || devDefault;
}

const ident = (v: string) => `"${v.replace(/"/g, '""')}"`;
const literal = (v: string) => `'${v.replace(/'/g, "''")}'`;

async function main(): Promise<void> {
  const appPassword = password("APP_DB_PASSWORD", "autocollect_app_dev");
  const servicePassword = password("SERVICE_DB_PASSWORD", "autocollect_service_dev");
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  const dbName = (await client.query<{ db: string }>("SELECT current_database() AS db")).rows[0].db;

  const createRole = async (name: string, pwd: string, extra: string): Promise<void> => {
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literal(name)}) THEN
        CREATE ROLE ${ident(name)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE ${extra};
      END IF;
    END $$;`);
    await client.query(`ALTER ROLE ${ident(name)} ${extra} PASSWORD ${literal(pwd)}`);
    await client.query(`GRANT CONNECT ON DATABASE ${ident(dbName)} TO ${ident(name)}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${ident(name)}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ident(name)}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ident(name)}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ident(name)}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${ident(name)}`);
    console.log(`role ready: ${name}`);
  };

  await createRole("autocollect_app", appPassword, "NOBYPASSRLS");
  await createRole("autocollect_service", servicePassword, "BYPASSRLS");

  // The runtime role never needs to see or change migration bookkeeping.
  await client.query(`REVOKE ALL ON TABLE schema_migrations FROM autocollect_app`).catch(() => {});

  await client.end();
  console.log("Done. Point DATABASE_URL at autocollect_app and SERVICE_DATABASE_URL at autocollect_service.");
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("Role bootstrap failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
