# Arc

Permit workspace for architecture and engineering firms: revision sets that pair PDF sheets with their DWG source, a drafter → architect → engineer review chain, seal handoff by uploading the signed PDF, and a city comment log per sheet and revision. Multi-tenant: every record belongs to a firm.

## Stack

- **Web:** React + Vite (SPA), deployed on Netlify.
- **API:** one Netlify Function (`netlify/functions/api.mts` → `server/api.ts`) at `/api/*`.
- **Database:** Neon Postgres (`db/schema.sql`).
- **Sign-in:** Neon Auth (Managed Better Auth). The browser signs in with Neon Auth; the API verifies its JWT against the JWKS.
- **Files:** Neon Object Storage (S3-compatible). The browser uploads straight to storage with a presigned URL; every file's SHA-256 is recorded.

## How access works

- Each user belongs to one or more firms through `memberships` (role: drafter, architect or engineer; plus an admin flag).
- Admins invite by email. When someone signs in with that email, they join the firm automatically. No emails are sent yet.
- Every query is scoped to the caller's firm (`x-arc-firm` header picks the active firm).
- Review chain: draft → architect review → engineer review → sealed. Either reviewer can return the set with a note. Only the engineer can upload the sealed PDF and seal. Sealed sets are locked.
- Firm admins can switch their own role from the top bar so one person can run every step while testing.

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
