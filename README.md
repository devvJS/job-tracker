# job-tracker

A personal job-search tracker served at `devvjs.dev/job-tracker`. It runs as
a sidecar service behind the portfolio site's proxy, with a React UI, a Hono
API on Node 26, and Postgres. The owner signs in with GitHub. A Claude
project reads and writes the same API with a bearer key. See
[`AGENTS.md`](AGENTS.md) for how an agent should use it, and
[`openapi.yaml`](openapi.yaml) for the contract.

## Try it locally (no GitHub OAuth app needed)

The test suite's fake GitHub server stands in for the OAuth flow, and an
on-disk PGlite database stands in for Postgres.

```bash
npm ci
npm run build
DATABASE_URL=pglite://.data/dev npm run seed      # the six seed applications

# terminal 1: fake GitHub (signs you in as devvJS)
FAKE_GITHUB_PORT=3001 node e2e/support/fake-github.ts

# terminal 2: the app
DATABASE_URL=pglite://.data/dev PUBLIC_URL=http://localhost:3000 \
SESSION_SECRET=$(openssl rand -hex 32) TRACKER_AGENT_KEY=local-agent-key-0123456789abcdefghij \
GITHUB_CLIENT_ID=local GITHUB_CLIENT_SECRET=local \
GITHUB_OAUTH_URL=http://localhost:3001 GITHUB_API_URL=http://localhost:3001 \
npm start
```

Open <http://localhost:3000/job-tracker/> and sign in. To act as the agent:

```bash
curl -H "Authorization: Bearer local-agent-key-0123456789abcdefghij" \
  http://localhost:3000/job-tracker/api/applications
```

For day-to-day work, copy `.env.example` to `.env` and run `npm run dev`
(Vite plus the API, with the API restarting on change).

## Commands

| Command | Does |
|---|---|
| `npm test` | unit and API tests (Vitest, in-memory PGlite per test) |
| `npm run test:e2e` | browser tests (Playwright, Chromium) |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc --noEmit` |
| `npm run build` | build the UI into `dist/` |
| `npm start` | run the server (`node server/main.ts`; runs migrations at boot) |
| `npm run db:migrate` | apply migrations (Railway pre-deploy) |
| `npm run seed` | seed the six known applications (idempotent) |
| `npm run export` | nightly JSON backup to the private data repo |

## Configuration

Every variable is listed in [`.env.example`](.env.example). `DATABASE_URL`
accepts `postgres://…`, `pglite://<dir>` or `pglite://memory`. Startup fails
fast, naming every missing or invalid variable.

## Layout

```
server/       Hono app: config, db, auth, and features/<feature>/ (routes and services)
src/          React UI: features/<feature>/ pages, lib/api.ts, components/
shared/       Zod schemas and enums shared by server and UI
db/           Drizzle schema, committed migrations, migrate and seed scripts
scripts/      export.ts (the tracker-export cron)
tests/        Vitest suites, one folder per feature
e2e/          Playwright specs and the fake GitHub server
```
