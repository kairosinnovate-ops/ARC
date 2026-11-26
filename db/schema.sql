-- Arc v1 schema. Every business table carries firm_id; the API scopes every query to the caller's firm.
create extension if not exists pgcrypto;

create table if not exists firms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by text not null,
  created_at timestamptz not null default now()
);

-- role: what the person does in the review chain. is_admin: can invite people and manage the firm.
create table if not exists memberships (
  firm_id uuid not null references firms(id) on delete cascade,
  user_id text not null,
  email text not null,
  name text not null default '',
  role text not null check (role in ('drafter','architect','engineer')),
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (firm_id, user_id)
);
create index if not exists memberships_user_idx on memberships(user_id);

create table if not exists invites (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references firms(id) on delete cascade,
  email text not null,
  role text not null check (role in ('drafter','architect','engineer')),
  is_admin boolean not null default false,
  invited_by text not null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);
create unique index if not exists invites_open_idx on invites(firm_id, lower(email)) where accepted_at is null;

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references firms(id) on delete cascade,
  name text not null,
  number text not null default '',
  address text not null default '',
  jurisdiction text not null default '',
  permit_number text not null default '',
  archived boolean not null default false,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index if not exists projects_firm_idx on projects(firm_id);

-- status: draft -> architect_review -> engineer_review -> sealed; either reviewer can return it (returned).
create table if not exists revision_sets (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references firms(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  rev_number int not null,
  title text not null default '',
  status text not null default 'draft' check (status in ('draft','architect_review','returned','engineer_review','sealed')),
  created_by text not null,
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  sealed_at timestamptz,
  sealed_by text,
  unique (project_id, rev_number)
);
create index if not exists revsets_firm_idx on revision_sets(firm_id);

-- kind: pdf / dwg are the set's drawings; sealed_pdf is the signed set the engineer uploads.
create table if not exists files (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references firms(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  revision_set_id uuid not null references revision_sets(id) on delete cascade,
  kind text not null check (kind in ('pdf','dwg','sealed_pdf','other')),
  sheet text not null default '',
  filename text not null,
  size_bytes bigint not null,
  sha256 text not null,
  content_type text not null default 'application/octet-stream',
  storage_key text not null unique,
  status text not null default 'pending' check (status in ('pending','ready')),
  uploaded_by text not null,
  created_at timestamptz not null default now()
);
create index if not exists files_set_idx on files(revision_set_id);

create table if not exists events (
  id bigserial primary key,
  firm_id uuid not null references firms(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  revision_set_id uuid references revision_sets(id) on delete cascade,
  actor_id text not null,
  actor_name text not null default '',
  action text not null,
  note text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists events_project_idx on events(project_id, created_at desc);

create table if not exists city_comments (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references firms(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  revision_set_id uuid references revision_sets(id) on delete set null,
  number text not null default '',
  sheet text not null default '',
  discipline text not null default '',
  reviewer text not null default '',
  body text not null,
  owner_id text,
  status text not null default 'open' check (status in ('open','in_progress','addressed')),
  response text not null default '',
  addressed_in_set_id uuid references revision_sets(id) on delete set null,
  received_on date not null default current_date,
  addressed_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index if not exists comments_project_idx on city_comments(project_id);

-- ---------------------------------------------------------------------------
-- v2 (2026-11-26): project manager workflow and engineer stamp links.
-- Every project names its PM, drafter, architect and engineer. One person can hold several slots.
-- ---------------------------------------------------------------------------
alter table memberships drop constraint if exists memberships_role_check;
alter table memberships add constraint memberships_role_check check (role in ('pm','drafter','architect','engineer'));
alter table invites drop constraint if exists invites_role_check;
alter table invites add constraint invites_role_check check (role in ('pm','drafter','architect','engineer'));

alter table projects add column if not exists kind text not null default 'initial';
alter table projects drop constraint if exists projects_kind_check;
alter table projects add constraint projects_kind_check check (kind in ('initial','modification'));
alter table projects add column if not exists requirements text not null default '';
alter table projects add column if not exists pm_id text;
alter table projects add column if not exists drafter_id text;
alter table projects add column if not exists architect_id text;
alter table projects add column if not exists engineer_id text;
alter table projects add column if not exists engineer_name text not null default '';
alter table projects add column if not exists engineer_email text not null default '';
update projects set pm_id = created_by where pm_id is null;

-- draft = with the drafter; pm_review = drafter submitted to the PM; architect_review;
-- pm_rework = architect (or engineer) sent markups back to the PM; engineer_review = ready for stamp; sealed.
alter table revision_sets drop constraint if exists revision_sets_status_check;
update revision_sets set status = 'draft' where status = 'returned';
-- (Includes the v4 statuses so re-running this file stays safe.)
alter table revision_sets add constraint revision_sets_status_check
  check (status in ('intake','draft','pm_review','architect_review','pm_rework','final_record','engineer_review','sealed'));
alter table revision_sets add column if not exists brief text not null default '';
alter table revision_sets add column if not exists sealed_by_name text not null default '';
alter table revision_sets add column if not exists sealed_via text not null default '';
alter table revision_sets add column if not exists engineer_license text not null default '';

alter table files drop constraint if exists files_kind_check;
alter table files add constraint files_kind_check check (kind in ('pdf','dwg','sealed_pdf','reference','markup','final_pdf','final_cad','other'));
-- Architect markups stay between the architect and PM until the PM forwards them to the drafter.
alter table files add column if not exists shared_with_drafter boolean not null default true;

-- One-time links that let an engineer without an account download the set and upload the stamped PDF.
create table if not exists stamp_requests (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references firms(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  revision_set_id uuid not null references revision_sets(id) on delete cascade,
  token_hash text not null unique,
  engineer_name text not null default '',
  engineer_email text not null default '',
  created_by text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists stamp_requests_set_idx on stamp_requests(revision_set_id)
;

-- ---------------------------------------------------------------------------
-- v3 (2026-11-26): deleting projects. Deleted projects sit in Trash for 30 days and can be restored;
-- after that (or when deleted for good) the rows and their stored files are removed.
-- ---------------------------------------------------------------------------
alter table projects add column if not exists deleted_at timestamptz;
alter table projects add column if not exists deleted_by text
;

-- ---------------------------------------------------------------------------
-- v4 (2026-11-26): Mastan's full workflow.
-- intake = the architect's site notes and sketches, before the PM sends the scope to the drafter.
-- final_record = approved; the drafter uploads the final PDF and CAD for the record before stamp.
-- ---------------------------------------------------------------------------
alter table revision_sets drop constraint if exists revision_sets_status_check;
alter table revision_sets add constraint revision_sets_status_check
  check (status in ('intake','draft','pm_review','architect_review','pm_rework','final_record','engineer_review','sealed'));
alter table revision_sets add column if not exists reason text not null default '';
alter table revision_sets add column if not exists delivered_at timestamptz;

alter table files drop constraint if exists files_kind_check;
alter table files add constraint files_kind_check
  check (kind in ('pdf','dwg','sealed_pdf','reference','markup','final_pdf','final_cad','other'));

alter table projects add column if not exists purpose text not null default '';
alter table projects add column if not exists client_name text not null default '';
alter table projects add column if not exists client_email text not null default '';

-- The revision that was started to answer a city comment.
alter table city_comments add column if not exists round_set_id uuid references revision_sets(id) on delete set null;

-- Download links for the client's stamped set (no account needed).
create table if not exists client_links (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references firms(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  revision_set_id uuid not null references revision_sets(id) on delete cascade,
  token_hash text not null unique,
  client_name text not null default '',
  client_email text not null default '',
  created_by text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  opened_at timestamptz,
  revoked_at timestamptz
);
create index if not exists client_links_set_idx on client_links(revision_set_id)
;

-- v5 (2026-11-26): set type replaces "drawings are for". permit / construction / permit_construction.
update projects set purpose = case purpose when 'permit_sale' then 'permit' when 'sale' then 'permit' when '' then 'permit' else purpose end
  where purpose not in ('permit', 'construction', 'permit_construction');
alter table projects alter column purpose set default 'permit';
alter table projects drop constraint if exists projects_purpose_check;
alter table projects add constraint projects_purpose_check check (purpose in ('permit','construction','permit_construction'))
;

-- v6 (2026-11-26): drawing set types. A project can carry several (permit, zoning, CO, as-built…).
alter table projects add column if not exists set_types text[] not null default '{permit}';
update projects set set_types = case purpose
    when 'construction' then '{construction}'::text[]
    when 'permit_construction' then '{permit,construction}'::text[]
    else '{permit}'::text[] end
  where set_types = '{permit}' and purpose in ('construction','permit_construction')
