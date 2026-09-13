# PhotoManager — context for Claude Code

This is a personal hard fork of [Immich](https://github.com/immich-app/immich) (AGPLv3), adding
reliable support for external/removable drives: index photos in place (don't copy them), and
correctly recognize a drive that was disconnected and reconnected — even under a different
OS-assigned mount path, or across Windows/Linux — instead of Immich's upstream behavior of
treating every file as newly discovered and reprocessing it (see immich-app/immich issues
[#17290](https://github.com/immich-app/immich/issues/17290),
[#19774](https://github.com/immich-app/immich/discussions/19774),
[#19768](https://github.com/immich-app/immich/issues/19768)).

**Fuller design doc, decision log, and progress history:** a `claude.ai` Project named
"PhotoManager" has a living `claude/plan.md` doc with the full design rationale, work-item
statuses, and a dated progress log. This file is a condensed pointer for a fresh session that
doesn't have access to that Project — if you're continuing work here, read this file fully before
making changes, and treat it as the current source of truth for local work. If you have access to
read/update that Project's docs, keep them in sync too.

## Ground rules for this project

- Act as a software architect with SDLC experience: concise, simple wording; industry-standard
  practices; principles of portability, reliability, performance, reusability, automated testing.
- Straightforward/obvious decisions can be made autonomously. Architecturally significant
  decisions (new data model, new strategy, anything hard to reverse) should be confirmed with the
  user first — ask, don't assume.
- Keep new code in clearly separated modules/files rather than editing shared Immich files where
  avoidable, to minimize future upstream-merge conflicts. When a shared file must be touched
  (e.g. `BaseService`, `LibraryService`), that's a deliberate, noted tradeoff, not an oversight.
- `main` tracks upstream; this fork's own work happens on feature branches merged into `main`,
  one concern per commit/branch. No direct unreviewed commits to `main` for anything nontrivial.
- Every change ships with tests; net test coverage should not drop. Run the full relevant test
  suite (server and/or web) before considering anything done.

## Where the code lives

- Fork: `https://github.com/varghesejo/image_manager` (`origin`). Upstream:
  `https://github.com/immich-app/immich` (`upstream`), for pulling in future Immich updates.
- Unlike a prior cloud-sandbox session that built this fork's early history, a local Claude Code
  session on your own machine has your real git credentials — it can commit and push directly.
  There's no need for the patch-file (`git format-patch` / `git am`) workflow once you're here;
  that was only a workaround for a sandboxed session with no push access.

## Current status (as of 2026-09-12)

Phase 1 (external/removable drive support) — work items, see `claude/plan.md` for full detail:

1. ⏳ **Not started.** Real-hardware spike: reproduce the reprocessing bug on an actual
   disconnect/reconnect cycle with your NAS/USB drive, to confirm the exact baseline. **This is
   likely why you're reading this file** — it needs real hardware, which is why work moved here.
2. ✅ Device-resolver module (`server/src/services/device-resolver/`): layered identity
   strategies — filesystem volume serial → USB hardware serial → marker file → content
   fingerprint — each with a confidence level.
3. ✅ `device_mount` table + repository (volume identity → last-known path mapping), including a
   real, verified Postgres migration.
4. ✅ Relinking on reconnect: path-prefix rewrite (fast path) + content-checksum fallback (for
   files also renamed/moved within the drive), automatic mount discovery, wired into the existing
   library-scan job queue (cron + manual "scan now").
5. ✅ "Ask, don't guess": a match found only via the low-confidence content-fingerprint strategy
   is parked (`device_mount.pendingPath`) for explicit confirm/reject rather than auto-relinked.
6. ✅ Admin-UI: `GET/POST /libraries/:id/device-mount...` API, and a status card (connected /
   offline / needs-confirmation, with confirm/reject buttons) on the library detail page in the
   web UI.
7. 🟡 **Partial.** Unit tests for all of the above are done. Still needed: an integration test
   simulating mount/unmount against a real database, and a manual pass with a real USB drive.
8. ⏳ **Not started.** Short runbook for adding a new external drive.

## Dev environment

Immich's documented dev stack is Docker Compose (`docker/docker-compose.dev.yml`) — Postgres,
Redis, server, web, ML. Use that here if your machine has normal Docker registry access (the
cloud sandbox that built most of this fork didn't, and used a native Postgres 16 + pgvector +
Redis install instead — see the plan doc's progress log if you ever need to reproduce that
workaround, but you shouldn't need to locally).

Key commands (from `server/`, with `DB_URL` pointing at your dev Postgres):

- `pnpm install` (repo root) — install all workspace packages.
- `pnpm run build` — compile the server (needed before migration commands, which run against
  `dist/`).
- `pnpm run migrations:run` / `migrations:generate` / `migrations:revert` — the `sql-tools`
  migration CLI. Always verify a new migration's `down()` actually works by running it, not just
  by reading the generated SQL — one already had a bug (dropped a table before its trigger).
- `pnpm run test` — server unit tests (vitest).
- From `web/`: `pnpm run check:typescript`, `pnpm run check:svelte`, `pnpm run lint`,
  `pnpm run test` — all should be clean before calling UI work done.
- To regenerate `@immich/sdk` after changing API routes/DTOs: `node server/dist/bin/sync-open-api.js`
  (writes `open-api/immich-openapi-specs.json`; needs `DB_URL` set, runs in Nest's `--preview`
  mode so it doesn't need Redis or a fully running app), then from the repo root:
  `npx oazapfts --optimistic --argumentStyle=object --useEnumType --allSchemas open-api/immich-openapi-specs.json packages/sdk/src/fetch-client.ts`,
  then `pnpm --filter @immich/sdk build`.

## Conventions worth knowing before editing

- Repositories vs. services (hexagonal architecture): OS/DB access lives in repositories
  (`server/src/repositories/`), business logic in services (`server/src/services/`). Services
  don't inject each other directly for cross-cutting coordination — they go through the job queue
  (`@OnJob` handlers), see `DeviceMountService.handleReconcile`.
- Adding a new repository/service to `BaseService`'s constructor means updating it in lockstep
  across `base.service.ts`, `repositories/index.ts`, and `test/utils.ts`'s mock harness.
- `server/src/controllers/index.spec.ts` has a deliberate, hand-maintained allowlist
  (`ADMIN_ROUTES`, `SHARED_LINK_ROUTES`) auditing which routes require admin/shared-link access.
  A failure there after adding a route is usually the guard doing its job — update the allowlist,
  don't route around it.
- External assets are checksummed from file content (`ChecksumAlgorithm.sha1File`), not from the
  path string — this was a deliberate fix to Immich's original behavior, since a path-based
  checksum can't survive a file being renamed or moved.
