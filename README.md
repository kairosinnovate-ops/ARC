# Arc

Permit workspace for architecture and engineering firms: revision sets that pair PDF sheets with their DWG source, a drafter → architect → engineer review chain, seal handoff by uploading the signed PDF, and a city comment log per sheet and revision. Multi-tenant: every record belongs to a firm.

## Stack

- **Web:** React + Vite (SPA), deployed on Netlify.
- **API:** one Netlify Function (`netlify/functions/api.mts` → `server/api.ts`) at `/api/*`.
- **Database:** Neon Postgres (`db/schema.sql`).
- **Sign-in:** Neon Auth (Managed Better Auth). The browser signs in with Neon Auth; the API verifies its JWT against the JWKS.
- **Files:** Neon Object Storage (S3-compatible). The browser uploads straight to storage with a presigned URL; every file's SHA-256 is recorded.

## How the workflow runs

- Each firm member has a usual job (project manager, drafter, architect, engineer) and an admin flag. Admins invite by email; people join automatically when they sign in with that email. No emails are sent yet.
- **Every project names its PM, drafter, architect and engineer.** One person can fill several slots (for example PM and architect). Firm admins can always act as PM.
- The PM sets the project type (initial drawings or modification) and requirements, then sends each revision to the drafter with instructions and reference files.
- Review loop (`revision_sets.status`):
  `draft` (drafter) → `pm_review` (PM checks) → `architect_review` → `engineer_review` (ready for stamp) → `sealed`.
  The PM can send work back to the drafter. The architect, or the engineer, sends rework and markups to the PM (`pm_rework`). The PM forwards them to the drafter or resubmits to the architect.
- Drafters (non-admin) only see projects they are assigned to, and don't see the architect's markups or notes until the PM forwards them.
- **Engineer stamp:** an engineer with an account seals in the app. For engineers not on Arc yet, the PM or architect creates a stamp link (`/stamp/<token>`, valid 30 days, one active per set). Arc opens a prefilled Gmail draft with the link. The engineer downloads the set, uploads the stamped PDF and returns it, or sends notes back, with no account. Only a SHA-256 of the token is stored.
- **Phases (v4):** `intake` (architect shares site notes, sketches and photos; the PM writes the scope and sends it to the drafter) → drafting and review (PDF only) → `final_record` (after the architect approves, the drafter uploads the final PDF and CAD files; required before stamp) → `engineer_review` → `sealed` → client delivery. The PM can also upload a stamp that arrived by email and record who stamped it.
- **Client delivery:** the PM sends a 30-day download link (`/d/<token>`) for the sealed PDF in a Gmail draft. Clients need no account. Only a SHA-256 of the token is stored; the first open is logged.
- **City comments:** once comments are logged, the PM starts the next revision "for city comments", which ties the open comments to that round and runs it through the same loop.
- **Who sees who:** only PMs and admins see every project and the whole team. Drafters, architects and engineers see only the projects they're on, the PM, and the person they hand work to (architect ↔ engineer). Other people show up by role (for example "Architect").
- **Deleting projects:** the project's PM (or a firm admin) deletes it by typing its name. It moves to Trash (`projects.deleted_at`), is hidden from everyone, and its open stamp links are revoked. It can be restored for 30 days, or deleted forever (typed name again), which removes its stored files. The scheduled function `purge-trash` runs daily and purges anything in Trash for more than 30 days.
- Every query is scoped to the caller's firm (`x-arc-firm` header picks the active firm). Sealed sets are locked.

## Run locally

Needs Node 20+ and a local Postgres.

```bash
npm install
createdb arc && psql arc -f db/schema.sql   # or set LOCAL_DATABASE_URL
npm run dev                                 # http://127.0.0.1:5173, any email signs in
node scripts/smoke.mjs                      # end-to-end API check against the dev server
```

`npm run dev` uses a local-only backend (`scripts/local-backend.ts`): local Postgres, files in `.local-files/`, and a throwaway sign-in. None of it is deployed.

## Deploy

Netlify builds with `npm run build` and serves `dist/` plus the function. Set these environment variables on the Netlify project (see `.env.example`):

`DATABASE_URL`, `NEON_AUTH_BASE_URL`, `VITE_NEON_AUTH_URL`, `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`.

Schema changes: edit `db/schema.sql` (keep it idempotent) and run `npm run db:migrate` with `DATABASE_URL` set. Add the site's URL to Neon Auth's trusted domains.

## Not in v1

AI assistant, permit timeline, share links, resubmittal letter, revision diff, emailed invites and notifications.
