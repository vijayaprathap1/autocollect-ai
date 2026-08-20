# AutoCollect AI

Automated B2B invoice chasing for freelancers, agencies, and small businesses.
Connect Stripe (or upload a CSV), approve AI-drafted reminder templates, and get
polite escalating email reminders with 1-click payment links sent automatically.

MVP scope (locked): **Stripe + CSV** sources · **email-only** · **approve-once, then auto-send**.

## Stack

- **Web:** React 19 + Vite + React Router + TanStack Query + Tailwind
- **API:** Node + Fastify (TypeScript)
- **DB:** PostgreSQL (RLS for tenant isolation)
- **Jobs:** in-process scheduler (Inngest adapter planned for production)

## Layout

```
apps/web       React SPA
apps/api       Fastify API + migrations + seed
packages/shared  shared domain types
infra/         deployment notes
```

## Local development

Prereqs: Node 20+, Docker (for Postgres).

```bash
# 1. Start the database
docker compose up -d

# 2. Install workspace deps
npm install

# 3. Configure the API (dev defaults work out of the box)
copy apps/api/.env.example apps/api/.env

# 4. Migrate + seed
npm run db:migrate
npm run db:seed

# 5. Run API + web concurrently
npm run dev
```

- Web: http://localhost:5173
- API: http://localhost:4000 (health: `/health`)

### Dev auth

With no `CLERK_SECRET_KEY` set, the API runs in **dev auth mode**: the SPA's
login screen lets you enter any email, which is sent as `x-dev-user` and
auto-provisions a workspace. Production uses Clerk session JWTs.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Run API + web |
| `npm run build` | Build all workspaces |
| `npm run typecheck` | Type-check all workspaces |
| `npm run db:migrate` | Apply pending SQL migrations |
| `npm run db:seed` | Seed dev tenant + default workflow + templates |

## Environment

See `apps/api/.env.example`. External integrations (Stripe, Postmark, Anthropic,
Clerk) are optional locally and degrade to dev fallbacks when keys are absent.