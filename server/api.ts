import { authenticate, type AuthUser } from './auth.ts';
import { many, one } from './db.ts';
import { files } from './storage.ts';
import { parseLetter } from './letter.ts';

type Role = 'drafter' | 'architect' | 'engineer';
const ROLES: Role[] = ['drafter', 'architect', 'engineer'];
type Member = { firm_id: string; firm_name: string; role: Role; is_admin: boolean };
type Ctx = { req: Request; user: AuthUser; member: Member | null; body: any; params: string[] };

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
const bad = (msg: string) => new HttpError(400, msg);
const forbidden = (msg = 'You do not have access to this.') => new HttpError(403, msg);
const notFound = (what = 'Not found') => new HttpError(404, what);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function str(v: unknown, max = 2000): string {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}

function firmOf(ctx: Ctx): Member {
  if (!ctx.member) throw forbidden('Create or join a firm first.');
  return ctx.member;
}
function requireAdmin(ctx: Ctx) {
  const m = firmOf(ctx);
  if (!m.is_admin) throw forbidden('Only firm admins can do this.');
  return m;
}

async function log(m: Member, user: AuthUser, projectId: string, setId: string | null, action: string, note = '') {
  await many(
    `insert into events (firm_id, project_id, revision_set_id, actor_id, actor_name, action, note)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [m.firm_id, projectId, setId, user.id, user.name, action, note],
  );
}

async function loadProject(m: Member, id: string) {
  const p = await one(`select * from projects where id = $1 and firm_id = $2`, [id, m.firm_id]);
  if (!p) throw notFound('Project not found');
  return p;
}
async function loadSet(m: Member, id: string) {
  const s = await one(`select * from revision_sets where id = $1 and firm_id = $2`, [id, m.firm_id]);
  if (!s) throw notFound('Revision set not found');
  return s;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- handlers ----------

async function me(ctx: Ctx) {
  const { user } = ctx;
  // Accept any open invites for this email, then refresh names.
  await many(
    `with inv as (
       update invites set accepted_at = now()
       where lower(email) = $1 and accepted_at is null
       returning firm_id, role, is_admin)
     insert into memberships (firm_id, user_id, email, name, role, is_admin)
     select firm_id, $2, $1, $3, role, is_admin from inv
     on conflict (firm_id, user_id) do nothing`,
    [user.email, user.id, user.name],
  );
  await many(`update memberships set name = $2, email = $3 where user_id = $1 and (name <> $2 or email <> $3)`, [
    user.id,
    user.name,
    user.email,
  ]);
  const firms = await many(
    `select m.firm_id, f.name as firm_name, m.role, m.is_admin
     from memberships m join firms f on f.id = m.firm_id
     where m.user_id = $1 order by m.created_at`,
    [user.id],
  );
  return json({ user, firms });
}

async function createFirm(ctx: Ctx) {
  const name = str(ctx.body.name, 120);
  const role = ctx.body.role as Role;
  if (!name) throw bad('Firm name is required.');
  if (!ROLES.includes(role)) throw bad('Pick a role.');
  const row = await one(
    `with f as (insert into firms (name, created_by) values ($1, $2) returning id, name)
     insert into memberships (firm_id, user_id, email, name, role, is_admin)
     select f.id, $2, $3, $4, $5, true from f
     returning firm_id`,
    [name, ctx.user.id, ctx.user.email, ctx.user.name, role],
  );
  return json({ firm_id: row!.firm_id, firm_name: name, role, is_admin: true }, 201);
}

async function team(ctx: Ctx) {
  const m = firmOf(ctx);
  const members = await many(
    `select user_id, email, name, role, is_admin, created_at from memberships where firm_id = $1 order by created_at`,
    [m.firm_id],
  );
  const invites = await many(
    `select id, email, role, is_admin, created_at from invites where firm_id = $1 and accepted_at is null order by created_at`,
    [m.firm_id],
  );
  return json({ members, invites });
}

async function invite(ctx: Ctx) {
  const m = requireAdmin(ctx);
  const email = str(ctx.body.email, 200).toLowerCase();
  const role = ctx.body.role as Role;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Enter a valid email.');
  if (!ROLES.includes(role)) throw bad('Pick a role.');
  const existing = await one(`select 1 from memberships where firm_id = $1 and lower(email) = $2`, [m.firm_id, email]);
  if (existing) throw bad('That person is already on the team.');
  const row = await one(
    `insert into invites (firm_id, email, role, is_admin, invited_by) values ($1,$2,$3,$4,$5)
     on conflict (firm_id, lower(email)) where accepted_at is null
     do update set role = excluded.role, is_admin = excluded.is_admin
     returning id, email, role, is_admin, created_at`,
    [m.firm_id, email, role, !!ctx.body.is_admin, ctx.user.id],
  );
  return json(row, 201);
}

async function cancelInvite(ctx: Ctx) {
  const m = requireAdmin(ctx);
  await many(`delete from invites where id = $1 and firm_id = $2 and accepted_at is null`, [ctx.params[0], m.firm_id]);
  return json({ ok: true });
}

async function updateMember(ctx: Ctx) {
  const m = firmOf(ctx);
  const target = ctx.params[0];
  const self = target === ctx.user.id;
  if (!m.is_admin && !self) throw forbidden('Only firm admins can change other people.');
  const role = ctx.body.role as Role | undefined;
  if (role !== undefined && !ROLES.includes(role)) throw bad('Unknown role.');
  if (role !== undefined && self && !m.is_admin) throw forbidden('Ask a firm admin to change your role.');
  const isAdmin = ctx.body.is_admin;
  if (isAdmin !== undefined) {
    if (!m.is_admin) throw forbidden();
    if (self && isAdmin === false) {
      const others = await one(
        `select count(*)::int as n from memberships where firm_id = $1 and is_admin and user_id <> $2`,
        [m.firm_id, ctx.user.id],
      );
      if (!others || others.n === 0) throw bad('A firm needs at least one admin.');
    }
  }
  const row = await one(
    `update memberships set role = coalesce($3, role), is_admin = coalesce($4, is_admin)
     where firm_id = $1 and user_id = $2 returning user_id, email, name, role, is_admin`,
    [m.firm_id, target, role ?? null, isAdmin === undefined ? null : !!isAdmin],
  );
  if (!row) throw notFound('Member not found');
  return json(row);
}

async function removeMember(ctx: Ctx) {
  const m = requireAdmin(ctx);
  if (ctx.params[0] === ctx.user.id) throw bad('You cannot remove yourself.');
  await many(`delete from memberships where firm_id = $1 and user_id = $2`, [m.firm_id, ctx.params[0]]);
  return json({ ok: true });
}

async function listProjects(ctx: Ctx) {
  const m = firmOf(ctx);
  const rows = await many(
    `select p.*,
       (select count(*)::int from city_comments c where c.project_id = p.id and c.status <> 'addressed') as open_comments,
       (select max(c.received_on) from city_comments c where c.project_id = p.id) as last_comments_on,
       ls.rev_number as latest_rev, ls.status as latest_status, ls.id as latest_set_id
     from projects p
     left join lateral (
       select id, rev_number, status from revision_sets s where s.project_id = p.id order by rev_number desc limit 1
     ) ls on true
     where p.firm_id = $1 and not p.archived
     order by p.created_at desc`,
    [m.firm_id],
  );
  return json(rows);
}

async function createProject(ctx: Ctx) {
  const m = firmOf(ctx);
  const name = str(ctx.body.name, 200);
  if (!name) throw bad('Project name is required.');
  const p = await one(
    `insert into projects (firm_id, name, number, address, jurisdiction, permit_number, created_by)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [
      m.firm_id,
      name,
      str(ctx.body.number, 60),
      str(ctx.body.address, 300),
      str(ctx.body.jurisdiction, 120),
      str(ctx.body.permit_number, 60),
      ctx.user.id,
    ],
  );
  await log(m, ctx.user, p!.id, null, 'project_created', name);
  return json(p, 201);
}

async function getProject(ctx: Ctx) {
  const m = firmOf(ctx);
  const p = await loadProject(m, ctx.params[0]);
  const [sets, comments, events, members] = await Promise.all([
    many(
      `select s.*,
         (select count(*)::int from files f where f.revision_set_id = s.id and f.kind = 'pdf' and f.status = 'ready') as pdf_count,
         (select count(*)::int from files f where f.revision_set_id = s.id and f.kind = 'dwg' and f.status = 'ready') as dwg_count
       from revision_sets s where s.project_id = $1 and s.firm_id = $2 order by rev_number desc`,
      [p.id, m.firm_id],
    ),
    many(
      `select c.*, (current_date - c.received_on)::int as days_waiting
       from city_comments c where c.project_id = $1 and c.firm_id = $2
       order by c.received_on desc, nullif(regexp_replace(c.number, '\\D', '', 'g'), '')::int nulls last, c.created_at`,
      [p.id, m.firm_id],
    ),
    many(`select * from events where project_id = $1 and firm_id = $2 order by created_at desc limit 40`, [p.id, m.firm_id]),
    many(`select user_id, name, email, role from memberships where firm_id = $1 order by name`, [m.firm_id]),
  ]);
  return json({ project: p, sets, comments, events, members });
}

async function updateProject(ctx: Ctx) {
  const m = firmOf(ctx);
  const p = await loadProject(m, ctx.params[0]);
  const b = ctx.body;
  const row = await one(
    `update projects set name = $3, number = $4, address = $5, jurisdiction = $6, permit_number = $7, archived = $8
     where id = $1 and firm_id = $2 returning *`,
    [
      p.id,
      m.firm_id,
      b.name !== undefined ? str(b.name, 200) || p.name : p.name,
      b.number !== undefined ? str(b.number, 60) : p.number,
      b.address !== undefined ? str(b.address, 300) : p.address,
      b.jurisdiction !== undefined ? str(b.jurisdiction, 120) : p.jurisdiction,
      b.permit_number !== undefined ? str(b.permit_number, 60) : p.permit_number,
      b.archived !== undefined ? !!b.archived : p.archived,
    ],
  );
  return json(row);
}

async function createSet(ctx: Ctx) {
  const m = firmOf(ctx);
  const p = await loadProject(m, ctx.params[0]);
  const open = await one(
    `select rev_number from revision_sets where project_id = $1 and status in ('draft','architect_review','returned','engineer_review') limit 1`,
    [p.id],
  );
  if (open) throw bad(`Rev ${open.rev_number} is still in progress. Finish or seal it before starting a new revision.`);
  const s = await one(
    `insert into revision_sets (firm_id, project_id, rev_number, title, created_by)
     select $1, $2, coalesce(max(rev_number) + 1, 0), $3, $4 from revision_sets where project_id = $2
     returning *`,
    [m.firm_id, p.id, str(ctx.body.title, 200), ctx.user.id],
  );
  await log(m, ctx.user, p.id, s!.id, 'set_created', `Rev ${s!.rev_number}`);
  return json(s, 201);
}

async function getSet(ctx: Ctx) {
  const m = firmOf(ctx);
  const s = await loadSet(m, ctx.params[0]);
  const [project, fileRows, events, comments] = await Promise.all([
    loadProject(m, s.project_id),
    many(
      `select f.*, mb.name as uploaded_by_name from files f
       left join memberships mb on mb.firm_id = f.firm_id and mb.user_id = f.uploaded_by
       where f.revision_set_id = $1 and f.status = 'ready' order by f.kind, f.sheet, f.filename`,
      [s.id],
    ),
    many(`select * from events where revision_set_id = $1 order by created_at desc`, [s.id]),
    many(
      `select id, number, sheet, status, body from city_comments where addressed_in_set_id = $1 or revision_set_id = $1`,
      [s.id],
    ),
  ]);
  return json({ set: s, project, files: fileRows, events, comments });
}

const EDITABLE = ['draft', 'returned'];
const FILE_KINDS = ['pdf', 'dwg', 'sealed_pdf', 'other'];
const MAX_BYTES = 500 * 1024 * 1024;

async function startUpload(ctx: Ctx) {
  const m = firmOf(ctx);
  const s = await loadSet(m, ctx.params[0]);
  const b = ctx.body;
  const kind = str(b.kind, 20);
  if (!FILE_KINDS.includes(kind)) throw bad('Unknown file type.');
  if (kind === 'sealed_pdf') {
    if (s.status !== 'engineer_review') throw bad('The sealed PDF is uploaded once the set is with the engineer.');
    if (m.role !== 'engineer') throw forbidden('Only the engineer uploads the sealed set.');
  } else if (!EDITABLE.includes(s.status)) {
    throw bad('This set is in review or sealed, so its drawings are locked.');
  }
  const filename = str(b.filename, 255);
  const size = Number(b.size);
  const sha256 = str(b.sha256, 64).toLowerCase();
  if (!filename) throw bad('Missing file name.');
  if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES) throw bad('Files must be under 500 MB.');
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw bad('Missing file fingerprint.');
  const contentType = str(b.content_type, 120) || 'application/octet-stream';
  const safe = filename.replace(/[^\w.\-]+/g, '_');
  const key = `${m.firm_id}/${s.project_id}/${s.id}/${crypto.randomUUID()}-${safe}`;
  const f = await one(
    `insert into files (firm_id, project_id, revision_set_id, kind, sheet, filename, size_bytes, sha256, content_type, storage_key, uploaded_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [m.firm_id, s.project_id, s.id, kind, str(b.sheet, 40), filename, size, sha256, contentType, key, ctx.user.id],
  );
  const url = await files().uploadUrl(key, contentType);
  return json({ file_id: f!.id, upload_url: url, content_type: contentType }, 201);
}

async function finishUpload(ctx: Ctx) {
  const m = firmOf(ctx);
  const f = await one(`select * from files where id = $1 and firm_id = $2`, [ctx.params[0], m.firm_id]);
  if (!f) throw notFound('File not found');
  if (f.uploaded_by !== ctx.user.id) throw forbidden();
  const size = await files().size(f.storage_key);
  if (size === null) throw bad('The upload did not reach storage. Try again.');
  if (Number(size) !== Number(f.size_bytes)) throw bad('The uploaded file size does not match. Try again.');
  await many(`update files set status = 'ready' where id = $1`, [f.id]);
  const verb = f.kind === 'sealed_pdf' ? 'sealed_uploaded' : 'file_uploaded';
  await log(m, ctx.user, f.project_id, f.revision_set_id, verb, f.filename);
  return json({ ok: true });
}

async function downloadFile(ctx: Ctx) {
  const m = firmOf(ctx);
  const f = await one(`select * from files where id = $1 and firm_id = $2 and status = 'ready'`, [ctx.params[0], m.firm_id]);
  if (!f) throw notFound('File not found');
  return json({ url: await files().downloadUrl(f.storage_key, f.filename) });
}

async function deleteFile(ctx: Ctx) {
  const m = firmOf(ctx);
  const f = await one(
    `select f.*, s.status as set_status from files f join revision_sets s on s.id = f.revision_set_id
     where f.id = $1 and f.firm_id = $2`,
    [ctx.params[0], m.firm_id],
  );
  if (!f) throw notFound('File not found');
  const sealedPending = f.kind === 'sealed_pdf' && f.set_status === 'engineer_review';
  if (!EDITABLE.includes(f.set_status) && !sealedPending) throw bad('This set is locked.');
  await many(`delete from files where id = $1`, [f.id]);
  await log(m, ctx.user, f.project_id, f.revision_set_id, 'file_removed', f.filename);
  return json({ ok: true });
}

/** The review chain. Each step names who may take it and from which status. */
const STEPS: Record<string, { from: string[]; role: Role; to: string; event: string }> = {
  submit: { from: ['draft', 'returned'], role: 'drafter', to: 'architect_review', event: 'submitted' },
  approve: { from: ['architect_review'], role: 'architect', to: 'engineer_review', event: 'approved' },
  return_architect: { from: ['architect_review'], role: 'architect', to: 'returned', event: 'returned' },
  return_engineer: { from: ['engineer_review'], role: 'engineer', to: 'returned', event: 'returned' },
  seal: { from: ['engineer_review'], role: 'engineer', to: 'sealed', event: 'sealed' },
};

async function setAction(ctx: Ctx) {
  const m = firmOf(ctx);
  const s = await loadSet(m, ctx.params[0]);
  let action = str(ctx.body.action, 30);
  if (action === 'return') action = s.status === 'engineer_review' ? 'return_engineer' : 'return_architect';
  const step = STEPS[action];
  if (!step) throw bad('Unknown action.');
  if (!step.from.includes(s.status)) throw bad('That step is not available for this set right now.');
  const roleName = { drafter: 'a drafter', architect: 'the architect', engineer: 'the engineer' }[step.role];
  if (m.role !== step.role) throw forbidden(`This step is for ${roleName}.`);
  const note = str(ctx.body.note, 4000);
  if (step.to === 'returned' && !note) throw bad('Say what needs to change.');

  if (action === 'submit') {
    const c = await one(
      `select count(*)::int as n from files where revision_set_id = $1 and kind = 'pdf' and status = 'ready'`,
      [s.id],
    );
    if (!c || c.n === 0) throw bad('Upload at least one PDF sheet before submitting.');
  }
  if (action === 'seal') {
    const c = await one(
      `select count(*)::int as n from files where revision_set_id = $1 and kind = 'sealed_pdf' and status = 'ready'`,
      [s.id],
    );
    if (!c || c.n === 0) throw bad('Upload the signed and sealed PDF first.');
  }

  const row = await one(
    `update revision_sets set status = $3,
       submitted_at = case when $3 = 'architect_review' then now() else submitted_at end,
       sealed_at = case when $3 = 'sealed' then now() else sealed_at end,
       sealed_by = case when $3 = 'sealed' then $4 else sealed_by end
     where id = $1 and firm_id = $2 and status = $5 returning *`,
    [s.id, m.firm_id, step.to, ctx.user.id, s.status],
  );
  if (!row) throw bad('Someone else just changed this set. Reload and try again.');
  await log(m, ctx.user, s.project_id, s.id, step.event, note);
  return json(row);
}

const COMMENT_STATUS = ['open', 'in_progress', 'addressed'];

async function memberOrNull(m: Member, userId: unknown): Promise<string | null> {
  if (!userId) return null;
  const r = await one(`select user_id from memberships where firm_id = $1 and user_id = $2`, [m.firm_id, String(userId)]);
  if (!r) throw bad('That owner is not on the team.');
  return r.user_id;
}
async function setOrNull(m: Member, projectId: string, setId: unknown): Promise<string | null> {
  if (!setId) return null;
  if (!UUID.test(String(setId))) throw bad('Unknown revision.');
  const r = await one(`select id from revision_sets where id = $1 and project_id = $2 and firm_id = $3`, [
    String(setId),
    projectId,
    m.firm_id,
  ]);
  if (!r) throw bad('Unknown revision.');
  return r.id;
}
function dateOrToday(v: unknown): string {
  const s = str(v, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date().toISOString().slice(0, 10);
}

async function addComment(ctx: Ctx) {
  const m = firmOf(ctx);
  const p = await loadProject(m, ctx.params[0]);
  const b = ctx.body;
  const body = str(b.body, 4000);
  if (!body) throw bad('Comment text is required.');
  const c = await one(
    `insert into city_comments (firm_id, project_id, revision_set_id, number, sheet, discipline, reviewer, body, owner_id, received_on, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [
      m.firm_id,
      p.id,
      await setOrNull(m, p.id, b.revision_set_id),
      str(b.number, 20),
      str(b.sheet, 40),
      str(b.discipline, 60),
      str(b.reviewer, 120),
      body,
      await memberOrNull(m, b.owner_id),
      dateOrToday(b.received_on),
      ctx.user.id,
    ],
  );
  await log(m, ctx.user, p.id, null, 'comment_added', `#${c!.number || '?'} ${c!.sheet}`.trim());
  return json(c, 201);
}

async function previewLetter(ctx: Ctx) {
  firmOf(ctx);
  return json(parseLetter(str(ctx.body.text, 100_000)));
}

async function importLetter(ctx: Ctx) {
  const m = firmOf(ctx);
  const p = await loadProject(m, ctx.params[0]);
  const items: any[] = Array.isArray(ctx.body.items) ? ctx.body.items.slice(0, 300) : [];
  if (!items.length) throw bad('No comments to import.');
  const setId = await setOrNull(m, p.id, ctx.body.revision_set_id);
  const received = dateOrToday(ctx.body.received_on);
  const reviewer = str(ctx.body.reviewer, 120);
  const cols = items.map((it) => ({
    number: str(it.number, 20),
    sheet: str(it.sheet, 40),
    discipline: str(it.discipline, 60),
    body: str(it.body, 4000),
  })).filter((c) => c.body);
  await many(
    `insert into city_comments (firm_id, project_id, revision_set_id, number, sheet, discipline, reviewer, body, received_on, created_by)
     select $1, $2, $3, x.number, x.sheet, x.discipline, $4, x.body, $5, $6
     from jsonb_to_recordset($7::jsonb) as x(number text, sheet text, discipline text, body text)`,
    [m.firm_id, p.id, setId, reviewer, received, ctx.user.id, JSON.stringify(cols)],
  );
  await log(m, ctx.user, p.id, null, 'letter_imported', `${cols.length} comments`);
  return json({ imported: cols.length }, 201);
}

async function updateComment(ctx: Ctx) {
  const m = firmOf(ctx);
  const c = await one(`select * from city_comments where id = $1 and firm_id = $2`, [ctx.params[0], m.firm_id]);
  if (!c) throw notFound('Comment not found');
  const b = ctx.body;
  const status = b.status !== undefined ? str(b.status, 20) : c.status;
  if (!COMMENT_STATUS.includes(status)) throw bad('Unknown status.');
  const row = await one(
    `update city_comments set
       number = $3, sheet = $4, discipline = $5, reviewer = $6, body = $7,
       owner_id = $8, status = $9, response = $10, addressed_in_set_id = $11,
       addressed_at = case when $9 = 'addressed' and status <> 'addressed' then now()
                           when $9 <> 'addressed' then null else addressed_at end
     where id = $1 and firm_id = $2 returning *, (current_date - received_on)::int as days_waiting`,
    [
      c.id,
      m.firm_id,
      b.number !== undefined ? str(b.number, 20) : c.number,
      b.sheet !== undefined ? str(b.sheet, 40) : c.sheet,
      b.discipline !== undefined ? str(b.discipline, 60) : c.discipline,
      b.reviewer !== undefined ? str(b.reviewer, 120) : c.reviewer,
      b.body !== undefined ? str(b.body, 4000) || c.body : c.body,
      b.owner_id !== undefined ? await memberOrNull(m, b.owner_id) : c.owner_id,
      status,
      b.response !== undefined ? str(b.response, 4000) : c.response,
      b.addressed_in_set_id !== undefined ? await setOrNull(m, c.project_id, b.addressed_in_set_id) : c.addressed_in_set_id,
    ],
  );
  if (status !== c.status) {
    await log(m, ctx.user, c.project_id, null, 'comment_' + status, `#${c.number || '?'} ${c.sheet}`.trim());
  }
  return json(row);
}

async function deleteComment(ctx: Ctx) {
  const m = firmOf(ctx);
  const c = await one(`delete from city_comments where id = $1 and firm_id = $2 returning project_id, number`, [
    ctx.params[0],
    m.firm_id,
  ]);
  if (c) await log(m, ctx.user, c.project_id, null, 'comment_deleted', `#${c.number || '?'}`);
  return json({ ok: true });
}

// ---------- router ----------

type Handler = (ctx: Ctx) => Promise<Response>;
const ID = '([0-9a-f-]{36})';
const USER = '([\\w-]{1,80})';
const routes: [string, RegExp, Handler][] = [
  ['GET', /^\/me$/, me],
  ['POST', /^\/firms$/, createFirm],
  ['GET', /^\/team$/, team],
  ['POST', /^\/team\/invites$/, invite],
  ['DELETE', new RegExp(`^/team/invites/${ID}$`), cancelInvite],
  ['PATCH', new RegExp(`^/team/members/${USER}$`), updateMember],
  ['DELETE', new RegExp(`^/team/members/${USER}$`), removeMember],
  ['GET', /^\/projects$/, listProjects],
  ['POST', /^\/projects$/, createProject],
  ['GET', new RegExp(`^/projects/${ID}$`), getProject],
  ['PATCH', new RegExp(`^/projects/${ID}$`), updateProject],
  ['POST', new RegExp(`^/projects/${ID}/sets$`), createSet],
  ['POST', new RegExp(`^/projects/${ID}/comments$`), addComment],
  ['POST', new RegExp(`^/projects/${ID}/letter/preview$`), previewLetter],
  ['POST', new RegExp(`^/projects/${ID}/letter/import$`), importLetter],
  ['GET', new RegExp(`^/sets/${ID}$`), getSet],
  ['POST', new RegExp(`^/sets/${ID}/files$`), startUpload],
  ['POST', new RegExp(`^/sets/${ID}/action$`), setAction],
  ['POST', new RegExp(`^/files/${ID}/complete$`), finishUpload],
  ['GET', new RegExp(`^/files/${ID}/download$`), downloadFile],
  ['DELETE', new RegExp(`^/files/${ID}$`), deleteFile],
  ['PATCH', new RegExp(`^/comments/${ID}$`), updateComment],
  ['DELETE', new RegExp(`^/comments/${ID}$`), deleteComment],
];

export async function handle(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '') || '/';
    let matched: { h: Handler; params: string[] } | null = null;
    let pathMatched = false;
    for (const [method, re, h] of routes) {
      const mm = path.match(re);
      if (!mm) continue;
      pathMatched = true;
      if (method === req.method) {
        matched = { h, params: mm.slice(1) };
        break;
      }
    }
    if (!matched) return json({ error: pathMatched ? 'Method not allowed' : 'Not found' }, pathMatched ? 405 : 404);

    const user = await authenticate(req);
    if (!user) return json({ error: 'Please sign in again.' }, 401);

    let body: any = {};
    if (req.method !== 'GET' && req.method !== 'DELETE') {
      const text = await req.text();
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          return json({ error: 'Invalid JSON' }, 400);
        }
      }
    }

    const wanted = req.headers.get('x-arc-firm') || '';
    const member = (await one(
      `select m.firm_id, f.name as firm_name, m.role, m.is_admin
       from memberships m join firms f on f.id = m.firm_id
       where m.user_id = $1 and ($2 = '' or m.firm_id::text = $2)
       order by m.created_at limit 1`,
      [user.id, UUID.test(wanted) ? wanted : ''],
    )) as Member | undefined;

    return await matched.h({ req, user, member: member ?? null, body, params: matched.params });
  } catch (e: any) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'Something went wrong on our side.' }, 500);
  }
}
