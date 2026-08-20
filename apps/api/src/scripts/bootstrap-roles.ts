/**
 * One-time role bootstrap for production-grade tenant isolation.
 *
 * Creates two non-superuser roles:
 *  - autocollect_app     (RLS-enforced)  -> DATABASE_URL for per-request clients
 *  - autocollect_service (BYPASSRLS)     -> SERVICE_DATABASE_URL for background work
 *
 * Run as the table owner / superuser: `npm run db:roles`.
 * Passwords come from APP_DB_PASSWORD / SERVICE_DB_PASSWORD (dev defaults below).
 */
import "dotenv/config";
import { Pool } from "pg";

const dbUrl = process.env.DATABASE_URL ?? "postgres://autocollect:autocollect_dev@localhost:5433/autocollect";
const dbName = (dbUrl.split("/").pop() ?? "autocollect").split("?")[0];
const appPassword = process.env.APP_DB_PASSWORD ?? "autocollect_app_dev";
const servicePassword = process.env.SERVICE_DB_PASSWORD ?? "autocollect_service_dev";

function esc(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: dbUrl });

  const createRole = async (name: string, password: string, extra: string): Promise<void> => {
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${esc(name)}) THEN
        CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE ${extra};
      END IF;
    END $$;`);
    await pool.query(`ALTER ROLE ${name} PASSWORD ${esc(password)}`);
    // Grants for existing objects + default privileges for anything new.
    await pool.query(`GRANT CONNECT ON DATABASE ${dbName} TO ${name}`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${name}`);
    await pool.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${name}`);
    await pool.query(`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${name}`);
    await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${name}`);
    await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${name}`);
    console.log(`role ready: ${name}`);
  };

  await createRole("autocollect_app", appPassword, "");
  await createRole("autocollect_service", servicePassword, "BYPASSRLS");

  await pool.end();
  console.log("Done. Point DATABASE_URL at autocollect_app and SERVICE_DATABASE_URL at autocollect_service.");
}

main().catch((err) => {
  console.error("Role bootstrap failed:", err);
  process.exit(1);
});