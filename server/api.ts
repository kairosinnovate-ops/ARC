import { authenticate, type AuthUser } from './auth.ts';
import { many, one } from './db.ts';
import { files } from './storage.ts';
import { parseLetter } from './letter.ts';

type Role = 'pm' | 'drafter' | 'architect' | 'engineer';
const ROLES: Role[] = ['pm', 'drafter', 'architect', 'engineer'];
type Member = { firm_id: string; firm_name: string; role: Role; is_admin: boolean };
type Ctx = { req: Request; user: AuthUser; member: Member | null; body: any; params: string[] };
type Slot = 'pm' | 'drafter' | 'architect' | 'engineer';

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

/** Drafters who aren't admins only see the projects they are assigned to. */
const limitedToAssigned = (m: Member) => m.role === 'drafter' && !m.is_admin;

/** Which slots on this project the user fills. Admins can always act as PM. */
function slotsOf(p: any, m: Member, userId: string): Set<Slot> {
  const s = new Set<Slot>();
  if (p.pm_id === userId || m.is_admin) s.add('pm');
  if (p.drafter_id === userId) s.add('drafter');
  if (p.architect_id === userId) s.add('architect');
  if (p.engineer_id === userId) s.add('engineer');
  return s;
}

async function log(m: { firm_id: string }, actor: { id: string; name: string }, projectId: string, setId: string | null, action: string, note = '') {
  await many(
    `insert into events (firm_id, project_id, revision_set_id, actor_id, actor_name, action, note)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [m.firm_id, projectId, setId, actor.id, actor.name, action, note],
  );
}

async function loadProject(m: Member, id: string, userId: string) {
  const p = await one(`select * from projects where id = $1 and firm_id = $2 and deleted_at is null`, [id, m.firm_id]);
  if (!p) throw notFound('Project not found');
  if (limitedToAssigned(m) && p.drafter_id !== userId) throw notFound('Project not found');
  return p;
}
async function loadSet(m: Member, id: string, userId: string) {
  const s = await one(`select * from revision_sets where id = $1 and firm_id = $2`, [id, m.firm_id]);
  if (!s) throw notFound('Revision set not found');
  const p = await loadProject(m, s.project_id, userId);
  return { s, p };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ---------- account and firm ----------

async function me(ctx: Ctx) {
  const { user } = ctx;
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
  if (!EMAIL.test(email)) throw bad('Enter a valid email.');
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
  const m = requireAdmin(ctx);
  const target = ctx.params[0];
  const self = target === ctx.user.id;
  const role = ctx.body.role as Role | undefined;
  if (role !== undefined && !ROLES.includes(role)) throw bad('Unknown role.');
  const isAdmin = ctx.body.is_admin;
  if (isAdmin !== undefined && self && isAdmin === false) {
    const others = await one(
      `select count(*)::int as n from memberships where firm_id = $1 and is_admin and user_id <> $2`,
      [m.firm_id, ctx.user.id],
    );
    if (!others || others.n === 0) throw bad('A firm needs at least one admin.');
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

// ---------- projects ----------

async function listProjects(ctx: Ctx) {
  const m = firmOf(ctx);
  const rows = await many(
    `select p.*,
       (select count(*)::int from city_comments c where c.project_id = p.id and c.status <> 'addressed') as open_comments,
       (select max(c.received_on) from city_comments c where c.project_id = p.id) as last_comments_on,
       ls.rev_number as latest_rev, ls.status as latest_status, ls.id as latest_set_id,
       pm.name as pm_name, dr.name as drafter_name
     from projects p
     left join lateral (
       select id, rev_number, status from revision_sets s where s.project_id = p.id order by rev_number desc limit 1
     ) ls on true
     left join memberships pm on pm.firm_id = p.firm_id and pm.user_id = p.pm_id
     left join memberships dr on dr.firm_id = p.firm_id and dr.user_id = p.drafter_id
     where p.firm_id = $1 and not p.archived and p.deleted_at is null and ($2::boolean = false or p.drafter_id = $3)
     order by p.created_at desc`,
    [m.firm_id, limitedToAssigned(m), ctx.user.id],
  );
  return json(rows);
}

async function memberOrNull(m: Member, userId: unknown): Promise<string | null> {
  if (!userId) return null;
  const r = await one(`select user_id from memberships where firm_id = $1 and user_id = $2`, [m.firm_id, String(userId)]);
  if (!r) throw bad('That person is not on the team.');
  return r.user_id;
}

function projectFields(b: any, cur: any = {}) {
  const pick = (k: string, max: number) => (b[k] !== undefined ? str(b[k], max) : cur[k] ?? '');
  const kind = b.kind !== undefined ? str(b.kind, 20) : cur.kind ?? 'initial';
  if (!['initial', 'modification'].includes(kind)) throw bad('Project type must be initial drawings or modification.');
  const engineerEmail = pick('engineer_email', 200).toLowerCase();
  if (engineerEmail && !EMAIL.test(engineerEmail)) throw bad('Enter a valid engineer email.');
  return {
    name: pick('name', 200),
    number: pick('number', 60),
    address: pick('address', 300),
    jurisdiction: pick('jurisdiction', 120),
    permit_number: pick('permit_number', 60),
    kind,
    requirements: pick('requirements', 8000),
    engineer_name: pick('engineer_name', 120),
    engineer_email: engineerEmail,
  };
}

async function createProject(ctx: Ctx) {
  const m = firmOf(ctx);
  if (!m.is_admin && !['pm', 'architect'].includes(m.role)) throw forbidden('Project managers and architects create projects.');
  const f = projectFields(ctx.body);
  if (!f.name) throw bad('Project name is required.');
  const b = ctx.body;
  const pm = (await memberOrNull(m, b.pm_id)) ?? ctx.user.id;
  const p = await one(
    `insert into projects (firm_id, name, number, address, jurisdiction, permit_number, kind, requirements,
       engineer_name, engineer_email, pm_id, drafter_id, architect_id, engineer_id, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *`,
    [
      m.firm_id, f.name, f.number, f.address, f.jurisdiction, f.permit_number, f.kind, f.requirements,
      f.engineer_name, f.engineer_email, pm,
      await memberOrNull(m, b.drafter_id),
      (await memberOrNull(m, b.architect_id)) ?? (m.role === 'architect' ? ctx.user.id : null),
      await memberOrNull(m, b.engineer_id),
      ctx.user.id,
    ],
  );
  await log(m, ctx.user, p!.id, null, 'project_created', f.name);
  return json(p, 201);
}

async function getProject(ctx: Ctx) {
  const m = firmOf(ctx);
  const p = await loadProject(m, ctx.params[0], ctx.user.id);
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
    many(`select user_id, name, email, role, is_admin from memberships where firm_id = $1 order by name`, [m.firm_id]),
  ]);
  const slots = [...slotsOf(p, m, ctx.user.id)];
  return json({ project: p, sets, comments, events: redactEvents(events, slots), members, my_slots: slots });
}

/** Drafters work only with the PM: they don't see the architect's or engineer's return notes directly. */
function redactEvents(events: any[], slots: string[]) {
  const onlyDrafter = slots.length === 1 && slots[0] === 'drafter';
  if (!onlyDrafter) return events;
  return events.map((e) => (['architect_returned', 'engineer_returned'].includes(e.action) ? { ...e, note: '' } : e));
}

async function updateProject(ctx: Ctx) {
  const m = firmOf(ctx);
  const p = await loadProject(m, ctx.params[0], ctx.user.id);
  if (!slotsOf(p, m, ctx.user.id).has('pm')) throw forbidden('Only the project manager or a firm admin can change the project.');
  const b = ctx.body;
  const f = projectFields(b, p);
  if (!f.name) f.name = p.name;
  const assign = async (k: string) => (b[k] !== undefined ? await memberOrNull(m, b[k]) : p[k]);
  const pmId = b.pm_id !== undefined ? (await memberOrNull(m, b.pm_id)) ?? p.pm_id : p.pm_id;
  const drafterId = await assign('drafter_id');
  const row = await one(
    `update projects set name=$3, number=$4, address=$5, jurisdiction=$6, permit_number=$7, kind=$8, requirements=$9,
       engineer_name=$10, engineer_email=$11, pm_id=$12, drafter_id=$13, architect_id=$14, engineer_id=$15, archived=$16
     where id = $1 and firm_id = $2 returning *`,
    [
      p.id, m.firm_id, f.name, f.number, f.address, f.jurisdiction, f.permit_number, f.kind, f.requirements,
      f.engineer_name, f.engineer_email, pmId, drafterId,
      await assign('architect_id'), await assign('engineer_id'),
      b.archived !== undefined ? !!b.archived : p.archived,
    ],
  );
  if (drafterId !== p.drafter_id) await log(m, ctx.user, p.id, null, 'drafter_assigned', '');
  return json(row);
}

// ---------- revision sets ----------

async function createSet(ctx: Ctx) {
  const m = firmOf(ctx);
  const p = await loadProject(m, ctx.params[0], ctx.user.id);
  if (!slotsOf(p, m, ctx.user.id).has('pm')) throw forbidden('The project manager starts each revision and sends it to the drafter.');
  if (!p.drafter_id) throw bad('Assign a drafter to this project first.');
  const open = await one(
    `select rev_number from revision_sets where project_id = $1 and status <> 'sealed' limit 1`,
    [p.id],
  );
  if (open) throw bad(`Rev ${open.rev_number} is still in progress. Finish or seal it before starting a new revision.`);
  const brief = str(ctx.body.brief, 8000);
  const s = await one(
    `insert into revision_sets (firm_id, project_id, rev_number, title, brief, created_by)
     select $1, $2, coalesce(max(rev_number) + 1, 0), $3, $4, $5 from revision_sets where project_id = $2
     returning *`,
    [m.firm_id, p.id, str(ctx.body.title, 200), brief, ctx.user.id],
  );
  await log(m, ctx.user, p.id, s!.id, 'sent_to_drafter', brief);
  return json(s, 201);
}

async function updateSet(ctx: Ctx) {
  const m = firmOf(ctx);
  const { s, p } = await loadSet(m, ctx.params[0], ctx.user.id);
  if (!slotsOf(p, m, ctx.user.id).has('pm')) throw forbidden();
  if (s.status === 'sealed') throw bad('This set is sealed.');
  const row = await one(`update revision_sets set title = $2, brief = $3 where id = $1 returning *`, [
    s.id,
    ctx.body.title !== undefined ? str(ctx.body.title, 200) : s.title,
    ctx.body.brief !== undefined ? str(ctx.body.brief, 8000) : s.brief,
  ]);
  return json(row);
}

async function getSet(ctx: Ctx) {
  const m = firmOf(ctx);
  const { s, p } = await loadSet(m, ctx.params[0], ctx.user.id);
  const slots = [...slotsOf(p, m, ctx.user.id)];
  const onlyDrafter = slots.length === 1 && slots[0] === 'drafter';
  const [fileRows, events, members, stamps] = await Promise.all([
    many(
      `select f.*, coalesce(mb.name, 'Engineer (email link)') as uploaded_by_name from files f
       left join memberships mb on mb.firm_id = f.firm_id and mb.user_id = f.uploaded_by
       where f.revision_set_id = $1 and f.status = 'ready' and ($2::boolean = false or f.shared_with_drafter)
       order by f.kind, f.sheet, f.filename`,
      [s.id, onlyDrafter],
    ),
    many(`select * from events where revision_set_id = $1 order by created_at desc`, [s.id]),
    many(`select user_id, name, email, role from memberships where firm_id = $1 order by name`, [m.firm_id]),
    onlyDrafter
      ? Promise.resolve([])
      : many(
          `select id, engineer_name, engineer_email, created_at, expires_at, used_at, revoked_at from stamp_requests
           where revision_set_id = $1 order by created_at desc`,
          [s.id],
        ),
  ]);
  return json({ set: s, project: p, files: fileRows, events: redactEvents(events, slots), members, my_slots: slots, stamp_requests: stamps });
}

const FILE_KINDS = ['pdf', 'dwg', 'sealed_pdf', 'reference', 'markup', 'other'];
const MAX_BYTES = 500 * 1024 * 1024;

/** Who may add which kind of file at which step. */
function canUpload(kind: string, status: string, slots: Set<Slot>) {
  if (status === 'sealed') return false;
  switch (kind) {
    case 'pdf':
    case 'dwg':
    case 'other':
      return (status === 'draft' && (slots.has('drafter') || slots.has('pm'))) ||
        (['pm_review', 'pm_rework'].includes(status) && slots.has('pm'));
    case 'reference':
      return slots.has('pm');
    case 'markup':
      return (status === 'architect_review' && slots.has('architect')) ||
        (['pm_review', 'pm_rework', 'architect_review'].includes(status) && slots.has('pm'));
    case 'sealed_pdf':
      return status === 'engineer_review' && slots.has('engineer');
  }
  return false;
}

function uploadMeta(b: any) {
  const filename = str(b.filename, 255);
  const size = Number(b.size);
  const sha256 = str(b.sha256, 64).toLowerCase();
  if (!filename) throw bad('Missing file name.');
  if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES) throw bad('Files must be under 500 MB.');
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw bad('Missing file fingerprint.');
  return { filename, size, sha256, contentType: str(b.content_type, 120) || 'application/octet-stream' };
}

async function registerUpload(s: any, kind: string, sheet: string, meta: ReturnType<typeof uploadMeta>, uploadedBy: string, shared: boolean) {
  const safe = meta.filename.replace(/[^\w.\-]+/g, '_');
  const key = `${s.firm_id}/${s.project_id}/${s.id}/${crypto.randomUUID()}-${safe}`;
  const f = await one(
    `insert into files (firm_id, project_id, revision_set_id, kind, sheet, filename, size_bytes, sha256, content_type, storage_key, uploaded_by, shared_with_drafter)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
    [s.firm_id, s.project_id, s.id, kind, sheet, meta.filename, meta.size, meta.sha256, meta.contentType, key, uploadedBy, shared],
  );
  const url = await files().uploadUrl(key, meta.contentType);
  return { file_id: f!.id, upload_url: url, content_type: meta.contentType };
}

async function startUpload(ctx: Ctx) {
  const m = firmOf(ctx);
  const { s, p } = await loadSet(m, ctx.params[0], ctx.user.id);
  const kind = str(ctx.body.kind, 20);
  if (!FILE_KINDS.includes(kind)) throw bad('Unknown file type.');
  const slots = slotsOf(p, m, ctx.user.id);
  if (!canUpload(kind, s.status, slots)) {
    if (kind === 'sealed_pdf') throw forbidden('Only the project engineer uploads the sealed set, once it is ready for stamp.');
    if (kind === 'markup') throw forbidden('Markups come from the architect or PM during review.');
    throw bad('Drawings are locked at this step. They open again when the set is back with the drafter.');
  }
  // Architect markups stay with the PM until the PM sends them back to the drafter.
  const shared = !(kind === 'markup' && !slots.has('pm'));
  const r = await registerUpload(s, kind, str(ctx.body.sheet, 40), uploadMeta(ctx.body), ctx.user.id, shared);
  return json(r, 201);
}

async function finishUpload(ctx: Ctx) {
  const m = firmOf(ctx);
  const f = await one(`select * from files where id = $1 and firm_id = $2`, [ctx.params[0], m.firm_id]);
  if (!f) throw notFound('File not found');
  if (f.uploaded_by !== ctx.user.id) throw forbidden();
  await completeFile(f);
  await log(m, ctx.user, f.project_id, f.revision_set_id, f.kind === 'sealed_pdf' ? 'sealed_uploaded' : f.kind === 'markup' ? 'markup_uploaded' : 'file_uploaded', f.filename);
  return json({ ok: true });
}

async function completeFile(f: any) {
  const size = await files().size(f.storage_key);
  if (size === null) throw bad('The upload did not reach storage. Try again.');
  if (Number(size) !== Number(f.size_bytes)) throw bad('The uploaded file size does not match. Try again.');
  await many(`update files set status = 'ready' where id = $1`, [f.id]);
}

async function downloadFile(ctx: Ctx) {
  const m = firmOf(ctx);
  const f = await one(`select * from files where id = $1 and firm_id = $2 and status = 'ready'`, [ctx.params[0], m.firm_id]);
  if (!f) throw notFound('File not found');
  const p = await loadProject(m, f.project_id, ctx.user.id);
  const slots = slotsOf(p, m, ctx.user.id);
  if (!f.shared_with_drafter && slots.size === 1 && slots.has('drafter')) throw notFound('File not found');
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
  const p = await loadProject(m, f.project_id, ctx.user.id);
  const slots = slotsOf(p, m, ctx.user.id);
  const mine = f.uploaded_by === ctx.user.id;
  if (!canUpload(f.kind, f.set_status, slots) || (!mine && !slots.has('pm'))) throw bad('This file is locked at this step.');
  await many(`delete from files where id = $1`, [f.id]);
  await log(m, ctx.user, f.project_id, f.revision_set_id, 'file_removed', f.filename);
  return json({ ok: true });
}

/**
 * The review loop. draft (drafter) -> pm_review (PM) -> architect_review (architect) -> engineer_review -> sealed.
 * The PM can send work back to the drafter; the architect and engineer send markups back to the PM (pm_rework),
 * and the PM either forwards them to the drafter or resubmits to the architect.
 */
const STEPS: Record<string, { from: string[]; slot: Slot; to: string; event: string; note?: boolean }> = {
  submit: { from: ['draft'], slot: 'drafter', to: 'pm_review', event: 'submitted' },
  pm_approve: { from: ['pm_review'], slot: 'pm', to: 'architect_review', event: 'pm_approved' },
  pm_return: { from: ['pm_review'], slot: 'pm', to: 'draft', event: 'pm_returned', note: true },
  pm_send_back: { from: ['pm_rework'], slot: 'pm', to: 'draft', event: 'pm_returned', note: true },
  pm_resubmit: { from: ['pm_rework'], slot: 'pm', to: 'architect_review', event: 'pm_approved' },
  architect_approve: { from: ['architect_review'], slot: 'architect', to: 'engineer_review', event: 'architect_approved' },
  architect_return: { from: ['architect_review'], slot: 'architect', to: 'pm_rework', event: 'architect_returned', note: true },
  engineer_return: { from: ['engineer_review'], slot: 'engineer', to: 'pm_rework', event: 'engineer_returned', note: true },
  seal: { from: ['engineer_review'], slot: 'engineer', to: 'sealed', event: 'sealed' },
};
const SLOT_NAME: Record<Slot, string> = { pm: 'the project manager', drafter: 'the assigned drafter', architect: 'the project architect', engineer: 'the project engineer' };

async function setAction(ctx: Ctx) {
  const m = firmOf(ctx);
  const { s, p } = await loadSet(m, ctx.params[0], ctx.user.id);
  const action = str(ctx.body.action, 30);
  const step = STEPS[action];
  if (!step) throw bad('Unknown action.');
  if (!step.from.includes(s.status)) throw bad('That step is not available for this set right now.');
  const slots = slotsOf(p, m, ctx.user.id);
  if (!slots.has(step.slot)) throw forbidden(`This step is for ${SLOT_NAME[step.slot]}.`);
  const note = str(ctx.body.note, 4000);
  if (step.note && !note) throw bad('Say what needs to change.');

  if (action === 'submit') {
    const c = await one(`select count(*)::int as n from files where revision_set_id = $1 and kind = 'pdf' and status = 'ready'`, [s.id]);
    if (!c || c.n === 0) throw bad('Upload at least one PDF sheet before submitting.');
  }
  if (action === 'seal') {
    const c = await one(`select count(*)::int as n from files where revision_set_id = $1 and kind = 'sealed_pdf' and status = 'ready'`, [s.id]);
    if (!c || c.n === 0) throw bad('Upload the signed and sealed PDF first.');
  }

  const row = await transition(s, step.to, step.to === 'sealed' ? { by: ctx.user.id, name: ctx.user.name, via: 'app', license: str(ctx.body.license, 60) } : null);
  if (action === 'pm_send_back') {
    // Forwarding to the drafter shares the architect's markups with them.
    await many(`update files set shared_with_drafter = true where revision_set_id = $1 and kind = 'markup'`, [s.id]);
  }
  await log(m, ctx.user, s.project_id, s.id, step.event, note);
  return json(row);
}

async function transition(s: any, to: string, seal: { by: string; name: string; via: string; license: string } | null) {
  const row = await one(
    `update revision_sets set status = $2,
       submitted_at = case when $2 = 'pm_review' then now() else submitted_at end,
       sealed_at = case when $2 = 'sealed' then now() else sealed_at end,
       sealed_by = case when $2 = 'sealed' then $4 else sealed_by end,
       sealed_by_name = case when $2 = 'sealed' then $5 else sealed_by_name end,
       sealed_via = case when $2 = 'sealed' then $6 else sealed_via end,
       engineer_license = case when $2 = 'sealed' then $7 else engineer_license end
     where id = $1 and status = $3 returning *`,
    [s.id, to, s.status, seal?.by ?? null, seal?.name ?? '', seal?.via ?? '', seal?.license ?? ''],
  );
  if (!row) throw bad('Someone else just changed this set. Reload and try again.');
  return row;
}

// ---------- engineer stamp links (no account needed) ----------

const STAMP_DAYS = 30;

async function sha256Hex(text: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function createStampLink(ctx: Ctx) {
  const m = firmOf(ctx);
  const { s, p } = await loadSet(m, ctx.params[0], ctx.user.id);
  const slots = slotsOf(p, m, ctx.user.id);
  if (!slots.has('pm') && !slots.has('architect')) throw forbidden('The PM or architect sends the set out for stamp.');
  if (s.status !== 'engineer_review') throw bad('The set is sent for stamp after the architect approves it.');
  const email = str(ctx.body.email, 200).toLowerCase();
  const name = str(ctx.body.name, 120);
  if (!EMAIL.test(email)) throw bad("Enter the engineer's email.");
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  // Only one live link per set: sending a new one retires the old.
  await many(`update stamp_requests set revoked_at = now() where revision_set_id = $1 and used_at is null and revoked_at is null`, [s.id]);
  const r = await one(
    `insert into stamp_requests (firm_id, project_id, revision_set_id, token_hash, engineer_name, engineer_email, created_by, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7, now() + interval '${STAMP_DAYS} days') returning id, expires_at`,
    [m.firm_id, p.id, s.id, await sha256Hex(token), name, email, ctx.user.id],
  );
  if (!p.engineer_email) {
    await many(`update projects set engineer_email = $2, engineer_name = coalesce(nullif(engineer_name, ''), $3) where id = $1`, [p.id, email, name]);
  }
  await log(m, ctx.user, p.id, s.id, 'stamp_link_sent', name ? `${name} <${email}>` : email);
  const origin = new URL(ctx.req.url).origin;
  return json({ id: r!.id, url: `${origin}/stamp/${token}`, expires_at: r!.expires_at }, 201);
}

async function revokeStampLink(ctx: Ctx) {
  const m = firmOf(ctx);
  await many(`update stamp_requests set revoked_at = now() where id = $1 and firm_id = $2 and used_at is null`, [ctx.params[0], m.firm_id]);
  return json({ ok: true });
}

async function stampFromToken(token: string) {
  if (!/^[\w-]{20,64}$/.test(token)) throw notFound('This link is not valid.');
  const r = await one(
    `select r.*, s.status as set_status, s.rev_number, s.title, s.sealed_at, s.sealed_by_name,
       p.name as project_name, p.number as project_number, p.address, p.jurisdiction, f.name as firm_name
     from stamp_requests r
     join revision_sets s on s.id = r.revision_set_id
     join projects p on p.id = r.project_id
     join firms f on f.id = r.firm_id
     where r.token_hash = $1 and p.deleted_at is null`,
    [await sha256Hex(token)],
  );
  if (!r || r.revoked_at) throw notFound('This link is no longer active. Ask the firm for a new one.');
  if (new Date(r.expires_at).getTime() < Date.now()) throw notFound('This link has expired. Ask the firm for a new one.');
  return r;
}
const linkActor = (r: any) => ({ id: `stamp:${r.id}`, name: `${r.engineer_name || r.engineer_email} (email link)` });

async function publicStamp(req: Request, path: string, method: string, body: any): Promise<Response> {
  const mm = path.match(/^\/public\/stamp\/([\w-]+)(?:\/(.*))?$/);
  if (!mm) return json({ error: 'Not found' }, 404);
  const r = await stampFromToken(mm[1]);
  const rest = mm[2] || '';
  const open = r.set_status === 'engineer_review' && !r.used_at;
  const set = { id: r.revision_set_id, firm_id: r.firm_id, project_id: r.project_id };

  if (method === 'GET' && rest === '') {
    const list = await many(
      `select id, kind, sheet, filename, size_bytes, sha256 from files
       where revision_set_id = $1 and status = 'ready' and (kind in ('pdf','dwg','other') or (kind = 'sealed_pdf' and uploaded_by = $2))
       order by kind, sheet, filename`,
      [r.revision_set_id, `stamp:${r.id}`],
    );
    return json({
      firm_name: r.firm_name,
      project: { name: r.project_name, number: r.project_number, address: r.address, jurisdiction: r.jurisdiction },
      rev_number: r.rev_number,
      title: r.title,
      engineer_name: r.engineer_name,
      engineer_email: r.engineer_email,
      status: r.used_at || r.set_status === 'sealed' ? 'sealed' : open ? 'open' : 'closed',
      sealed_at: r.sealed_at,
      files: list,
    });
  }
  const fm = rest.match(/^files\/([0-9a-f-]{36})$/);
  if (method === 'GET' && fm) {
    const f = await one(
      `select * from files where id = $1 and revision_set_id = $2 and status = 'ready' and (kind in ('pdf','dwg','other') or uploaded_by = $3)`,
      [fm[1], r.revision_set_id, `stamp:${r.id}`],
    );
    if (!f) throw notFound('File not found');
    return json({ url: await files().downloadUrl(f.storage_key, f.filename) });
  }
  if (method !== 'POST') return json({ error: 'Not found' }, 404);
  if (!open) throw bad('This set is no longer waiting for a stamp.');
  const actor = linkActor(r);

  if (rest === 'upload') {
    const meta = uploadMeta(body);
    if (!/\.pdf$/i.test(meta.filename)) throw bad('Upload the stamped set as a PDF.');
    return json(await registerUpload(set, 'sealed_pdf', '', { ...meta, contentType: 'application/pdf' }, actor.id, true), 201);
  }
  const cm = rest.match(/^complete\/([0-9a-f-]{36})$/);
  if (cm) {
    const f = await one(`select * from files where id = $1 and uploaded_by = $2`, [cm[1], actor.id]);
    if (!f) throw notFound('File not found');
    await completeFile(f);
    await log(set, actor, r.project_id, r.revision_set_id, 'sealed_uploaded', f.filename);
    return json({ ok: true });
  }
  if (rest === 'seal') {
    const name = str(body.name, 120);
    if (!name) throw bad('Enter your name.');
    const c = await one(`select count(*)::int as n from files where revision_set_id = $1 and kind = 'sealed_pdf' and status = 'ready' and uploaded_by = $2`, [r.revision_set_id, actor.id]);
    if (!c || c.n === 0) throw bad('Upload the stamped PDF first.');
    await transition({ id: r.revision_set_id, status: 'engineer_review' }, 'sealed', { by: actor.id, name, via: 'link', license: str(body.license, 60) });
    await many(`update stamp_requests set used_at = now() where id = $1`, [r.id]);
    await log(set, { id: actor.id, name: `${name} (email link)` }, r.project_id, r.revision_set_id, 'sealed', str(body.license, 60) ? `License ${str(body.license, 60)}` : '');
    return json({ ok: true });
  }
  if (rest === 'return') {
    const note = str(body.note, 4000);
    const name = str(body.name, 120) || r.engineer_name || r.engineer_email;
    if (!note) throw bad('Say what needs to change.');
    await transition({ id: r.revision_set_id, status: 'engineer_review' }, 'pm_rework', null);
    await many(`update stamp_requests set used_at = now() where id = $1`, [r.id]);
    await log(set, { id: actor.id, name: `${name} (email link)` }, r.project_id, r.revision_set_id, 'engineer_returned', note);
    return json({ ok: true });
  }
  void req;
  return json({ error: 'Not found' }, 404);
}

// ---------- deleting projects ----------

export const TRASH_DAYS = 30;

function confirmName(p: any, typed: unknown) {
  if (str(typed, 200).toLowerCase() !== String(p.name).trim().toLowerCase()) throw bad('Type the project name exactly to confirm.');
}

async function deleteProject(ctx: Ctx) {
  const m = firmOf(ctx);
  const p = await loadProject(m, ctx.params[0], ctx.user.id);
  if (!slotsOf(p, m, ctx.user.id).has('pm')) throw forbidden('Only the project manager or a firm admin can delete a project.');
  confirmName(p, ctx.body.confirm_name);
  await many(`update projects set deleted_at = now(), deleted_by = $2 where id = $1`, [p.id, ctx.user.id]);
  // Any outstanding stamp links stop working with the project.
  await many(`update stamp_requests set revoked_at = now() where project_id = $1 and used_at is null and revoked_at is null`, [p.id]);
  await log(m, ctx.user, p.id, null, 'project_deleted', p.name);
  return json({ ok: true, purge_after_days: TRASH_DAYS });
}

/** Deleted projects this person may restore: their own as PM, or all of the firm's for admins. */
async function trashedProject(ctx: Ctx, id: string) {
  const m = firmOf(ctx);
  const p = await one(`select * from projects where id = $1 and firm_id = $2 and deleted_at is not null`, [id, m.firm_id]);
  if (!p || (!m.is_admin && p.pm_id !== ctx.user.id)) throw notFound('Project not found in Trash');
  return { m, p };
}

async function listTrash(ctx: Ctx) {
  const m = firmOf(ctx);
  const rows = await many(
    `select p.id, p.name, p.number, p.deleted_at, mb.name as deleted_by_name,
       p.deleted_at + interval '${TRASH_DAYS} days' as purge_at,
       (select count(*)::int from revision_sets s where s.project_id = p.id and s.status = 'sealed') as sealed_sets,
       (select count(*)::int from files f where f.project_id = p.id) as file_count
     from projects p left join memberships mb on mb.firm_id = p.firm_id and mb.user_id = p.deleted_by
     where p.firm_id = $1 and p.deleted_at is not null and ($2::boolean or p.pm_id = $3)
     order by p.deleted_at desc`,
    [m.firm_id, m.is_admin, ctx.user.id],
  );
  return json(rows);
}

async function restoreProject(ctx: Ctx) {
  const { m, p } = await trashedProject(ctx, ctx.params[0]);
  await many(`update projects set deleted_at = null, deleted_by = null where id = $1`, [p.id]);
  await log(m, ctx.user, p.id, null, 'project_restored', p.name);
  return json({ ok: true });
}

/** Removes a project's stored files, then its rows (everything else cascades). */
export async function purgeProject(projectId: string) {
  const keys = (await many(`select storage_key from files where project_id = $1`, [projectId])).map((r) => r.storage_key);
  await files().remove(keys);
  await many(`delete from projects where id = $1 and deleted_at is not null`, [projectId]);
  return keys.length;
}

async function deleteForever(ctx: Ctx) {
  const { p } = await trashedProject(ctx, ctx.params[0]);
  confirmName(p, ctx.body.confirm_name);
  const removed = await purgeProject(p.id);
  return json({ ok: true, files_removed: removed });
}

/** Called daily by the scheduled function. */
export async function purgeExpired() {
  const rows = await many(`select id from projects where deleted_at < now() - interval '${TRASH_DAYS} days'`);
  let n = 0;
  for (const r of rows) n += await purgeProject(r.id);
  return { projects: rows.length, files: n };
}

// ---------- city comments ----------

const COMMENT_STATUS = ['open', 'in_progress', 'addressed'];

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
  const p = await loadProject(m, ctx.params[0], ctx.user.id);
  const b = ctx.body;
  const body = str(b.body, 4000);
  if (!body) throw bad('Comment text is required.');
  const c = await one(
    `insert into city_comments (firm_id, project_id, revision_set_id, number, sheet, discipline, reviewer, body, owner_id, received_on, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [
      m.firm_id, p.id, await setOrNull(m, p.id, b.revision_set_id), str(b.number, 20), str(b.sheet, 40),
      str(b.discipline, 60), str(b.reviewer, 120), body, await memberOrNull(m, b.owner_id), dateOrToday(b.received_on), ctx.user.id,
    ],
  );
  await log(m, ctx.user, p.id, null, 'comment_added', `#${c!.number || '?'} ${c!.sheet}`.trim());
  return json(c, 201);
}

async function previewLetter(ctx: Ctx) {
  const m = firmOf(ctx);
  await loadProject(m, ctx.params[0], ctx.user.id);
  return json(parseLetter(str(ctx.body.text, 100_000)));
}

async function importLetter(ctx: Ctx) {
  const m = firmOf(ctx);
  const p = await loadProject(m, ctx.params[0], ctx.user.id);
  const items: any[] = Array.isArray(ctx.body.items) ? ctx.body.items.slice(0, 300) : [];
  if (!items.length) throw bad('No comments to import.');
  const setId = await setOrNull(m, p.id, ctx.body.revision_set_id);
  const cols = items
    .map((it) => ({ number: str(it.number, 20), sheet: str(it.sheet, 40), discipline: str(it.discipline, 60), body: str(it.body, 4000) }))
    .filter((c) => c.body);
  await many(
    `insert into city_comments (firm_id, project_id, revision_set_id, number, sheet, discipline, reviewer, body, received_on, created_by)
     select $1, $2, $3, x.number, x.sheet, x.discipline, $4, x.body, $5, $6
     from jsonb_to_recordset($7::jsonb) as x(number text, sheet text, discipline text, body text)`,
    [m.firm_id, p.id, setId, str(ctx.body.reviewer, 120), dateOrToday(ctx.body.received_on), ctx.user.id, JSON.stringify(cols)],
  );
  await log(m, ctx.user, p.id, null, 'letter_imported', `${cols.length} comments`);
  return json({ imported: cols.length }, 201);
}

async function updateComment(ctx: Ctx) {
  const m = firmOf(ctx);
  const c = await one(`select * from city_comments where id = $1 and firm_id = $2`, [ctx.params[0], m.firm_id]);
  if (!c) throw notFound('Comment not found');
  await loadProject(m, c.project_id, ctx.user.id);
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
      c.id, m.firm_id,
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
  if (status !== c.status) await log(m, ctx.user, c.project_id, null, 'comment_' + status, `#${c.number || '?'} ${c.sheet}`.trim());
  return json(row);
}

async function deleteComment(ctx: Ctx) {
  const m = firmOf(ctx);
  const c0 = await one(`select project_id from city_comments where id = $1 and firm_id = $2`, [ctx.params[0], m.firm_id]);
  if (!c0) return json({ ok: true });
  await loadProject(m, c0.project_id, ctx.user.id);
  const c = await one(`delete from city_comments where id = $1 and firm_id = $2 returning project_id, number`, [ctx.params[0], m.firm_id]);
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
  ['GET', /^\/trash$/, listTrash],
  ['POST', new RegExp(`^/trash/${ID}/restore$`), restoreProject],
  ['POST', new RegExp(`^/trash/${ID}/delete$`), deleteForever],
  ['POST', new RegExp(`^/projects/${ID}/delete$`), deleteProject],
  ['POST', /^\/projects$/, createProject],
  ['GET', new RegExp(`^/projects/${ID}$`), getProject],
  ['PATCH', new RegExp(`^/projects/${ID}$`), updateProject],
  ['POST', new RegExp(`^/projects/${ID}/sets$`), createSet],
  ['POST', new RegExp(`^/projects/${ID}/comments$`), addComment],
  ['POST', new RegExp(`^/projects/${ID}/letter/preview$`), previewLetter],
  ['POST', new RegExp(`^/projects/${ID}/letter/import$`), importLetter],
  ['GET', new RegExp(`^/sets/${ID}$`), getSet],
  ['PATCH', new RegExp(`^/sets/${ID}$`), updateSet],
  ['POST', new RegExp(`^/sets/${ID}/files$`), startUpload],
  ['POST', new RegExp(`^/sets/${ID}/action$`), setAction],
  ['POST', new RegExp(`^/sets/${ID}/stamp-links$`), createStampLink],
  ['DELETE', new RegExp(`^/stamp-links/${ID}$`), revokeStampLink],
  ['POST', new RegExp(`^/files/${ID}/complete$`), finishUpload],
  ['GET', new RegExp(`^/files/${ID}/download$`), downloadFile],
  ['DELETE', new RegExp(`^/files/${ID}$`), deleteFile],
  ['PATCH', new RegExp(`^/comments/${ID}$`), updateComment],
  ['DELETE', new RegExp(`^/comments/${ID}$`), deleteComment],
];

async function readBody(req: Request) {
  if (req.method === 'GET' || req.method === 'DELETE') return {};
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw bad('Invalid JSON');
  }
}

export async function handle(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '') || '/';

    // Engineer stamp links work without an account; the token in the URL is the credential.
    if (path.startsWith('/public/stamp/')) return await publicStamp(req, path, req.method, await readBody(req));

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
    const body = await readBody(req);

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
