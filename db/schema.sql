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
