import { authenticate, type AuthUser } from './auth.ts';
import { many, one } from './db.ts';
import { files } from './storage.ts';
import { parseLetter } from './letter.ts';
import { resubmittalPdf } from './resubmittal.ts';

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

/** Only PMs and admins see every project. Drafters, architects and engineers see the projects they are on. */
const limitedToAssigned = (m: Member) => !m.is_admin && m.role !== 'pm';
const onProject = (p: any, userId: string) => [p.pm_id, p.drafter_id, p.architect_id, p.engineer_id].includes(userId);

/**
 * Only the PM and firm admins see people's names. Drafters, architects, engineers and clients see the stage and
 * the role behind it ("Architect review", "With the engineer") and only their own name.
 * Returns null when the viewer may see everyone.
 */
function visiblePeople(m: Member, slots: Set<Slot>, userId: string): Set<string> | null {
  if (slots.has('pm') || m.is_admin || m.role === 'pm') return null;
  return new Set<string>([userId]);
}
function roleOf(p: any, id: string) {
  if (id === p.pm_id) return 'Project manager';
  if (id === p.drafter_id) return 'Drafter';
  if (id === p.architect_id) return 'Architect';
  if (id === p.engineer_id || id.startsWith('stamp:')) return 'Engineer';
  if (id.startsWith('client:')) return 'Client';
  return 'Team member';
}
const canSee = (vis: Set<string> | null, id: string) => !vis || vis.has(id);
/** Stands in for someone else's id, so the page knows the slot is filled without learning who fills it. */
const HIDDEN = 'assigned';

function redactProject(p: any, slots: Set<Slot>, vis: Set<string> | null) {
  if (!vis) return p;
  const q = { ...p, client_name: '', client_email: '', engineer_name: '', created_by: null, deleted_by: null };
  for (const k of ['pm_id', 'drafter_id', 'architect_id', 'engineer_id']) if (q[k] && !vis.has(q[k])) q[k] = HIDDEN;
  // The architect can send the stamp link, so they keep the address it goes to. Nobody else needs it.
  if (!slots.has('architect')) q.engineer_email = '';
  return q;
}
/** A revision set's seal, as a non-PM sees it: the engineer's name only if it is their own. */
function redactSet(s: any, vis: Set<string> | null) {
  if (!vis || !s) return s;
  return { ...s, sealed_by_name: s.sealed_by && vis.has(s.sealed_by) ? s.sealed_by_name : '', created_by: null };
}
/** Event notes that carry someone's name or email. */
const PRIVATE_NOTES = ['stamp_link_sent', 'client_link_sent'];
function redactPeople<T extends { actor_id?: string; uploaded_by?: string }>(rows: T[], p: any, slots: Set<Slot>, vis: Set<string> | null, nameKey: 'actor_name' | 'uploaded_by_name', idKey: 'actor_id' | 'uploaded_by'): T[] {
  void slots;
  if (!vis) return rows;
  return rows.map((r: any) => {
    const id = String(r[idKey] || '');
    const out = canSee(vis, id) ? r : { ...r, [nameKey]: roleOf(p, id), [idKey]: HIDDEN };
    if (PRIVATE_NOTES.includes(out.action)) return { ...out, note: out.action === 'client_link_sent' ? 'the client' : 'the engineer' };
    if (out.action === 'sealed' && /^Stamped by /.test(out.note || '')) return { ...out, note: 'Stamp received by email' };
    return out;
  });
}

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
  if (limitedToAssigned(m) && !onProject(p, userId)) throw notFound('Project not found');
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
  if (limitedToAssigned(m)) {
    // Only PMs and admins see who's who. Everyone else sees only themselves.
    return json({ members: members.filter((x) => x.user_id === ctx.user.id), invites: [], limited: true });
  }
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
       (select count(*)::int from city_comments c where c.project_id = p.id and c.status <> 'addressed' and c.round_set_id is null) as unrounded_comments,
       ls.rev_number as latest_rev, ls.status as latest_status, ls.id as latest_set_id,
       ls.reason as latest_reason, ls.delivered_at as latest_delivered_at,
       (select count(*)::int from events e where e.revision_set_id = ls.id
          and e.action in ('pm_returned','architect_returned','engineer_returned')) as latest_returns,
       (select count(*)::int from revision_sets s2 where s2.project_id = p.id and s2.reason = 'city' and s2.rev_number <= ls.rev_number) as city_round,
       (select max(s3.delivered_at) from revision_sets s3 where s3.project_id = p.id) as last_delivered_at,
       pm.name as pm_name, dr.name as drafter_name
     from projects p
     left join lateral (
       select id, rev_number, status, reason, delivered_at from revision_sets s where s.project_id = p.id order by rev_number desc limit 1
     ) ls on true
     left join memberships pm on pm.firm_id = p.firm_id and pm.user_id = p.pm_id
     left join memberships dr on dr.firm_id = p.firm_id and dr.user_id = p.drafter_id
     where p.firm_id = $1 and not p.archived and p.deleted_at is null
       and ($2::boolean = false or $3 in (p.pm_id, p.drafter_id, p.architect_id, p.engineer_id))
     order by p.created_at desc`,
    [m.firm_id, limitedToAssigned(m), ctx.user.id],
  );
  const out: any[] = rows.map((r) => {
    const st = projectStage(r);
    const yourTurn = !!st.waiting_on && slotsOf(r, m, ctx.user.id).has(st.waiting_on)
      // Admins can act as PM everywhere, but a PM step is only "theirs" when they are the PM or nobody is.
      && (st.waiting_on !== 'pm' || r.pm_id === ctx.user.id || !r.pm_id);
    return { ...r, ...st, your_turn: yourTurn };
  });
  if (!limitedToAssigned(m)) return json(out);
  // Names stay with the PM and admins. Everyone else gets the stage and the role it waits on.
  return json(out.map((r) => {
    const vis = new Set([ctx.user.id]);
    const q = redactProject(r, slotsOf(r, m, ctx.user.id), vis);
    return { ...q, pm_name: r.pm_id === ctx.user.id ? r.pm_name : null, drafter_name: r.drafter_id === ctx.user.id ? r.drafter_name : null };
  }));
}

type Stage = 'intake' | 'review' | 'final_record' | 'stamp' | 'ready' | 'delivered' | 'city';
/**
 * Where a project is, and whose move it is, from its latest revision set.
 * intake -> review (draft / PM check / architect / rework, numbered by round) -> final_record -> stamp
 * -> ready (stamped, not yet sent to the client) -> delivered. City comments make it a city revision round.
 */
function projectStage(r: any): { stage: Stage; round: number; waiting_on: Slot | null } {
  const status: string | null = r.latest_status;
  const city = r.latest_reason === 'city';
  if (!status) return { stage: 'intake', round: 0, waiting_on: 'pm' };
  if (status === 'sealed') {
    if (r.unrounded_comments > 0) return { stage: 'city', round: (r.city_round || 0) + 1, waiting_on: 'pm' };
    if (!r.latest_delivered_at) return { stage: 'ready', round: 0, waiting_on: 'pm' };
    return { stage: 'delivered', round: 0, waiting_on: null };
  }
  const who: Record<string, Slot> = {
    intake: 'pm', draft: 'drafter', pm_review: 'pm', architect_review: 'architect', pm_rework: 'pm',
    final_record: 'drafter', engineer_review: 'engineer',
  };
  const waiting_on = who[status] ?? null;
  if (city) return { stage: 'city', round: r.city_round || 1, waiting_on };
  if (status === 'intake') return { stage: 'intake', round: 0, waiting_on };
  if (status === 'final_record') return { stage: 'final_record', round: 0, waiting_on };
  if (status === 'engineer_review') return { stage: 'stamp', round: 0, waiting_on };
  return { stage: 'review', round: 1 + (r.latest_returns || 0), waiting_on };
}

async function memberOrNull(m: Member, userId: unknown): Promise<string | null> {
  if (!userId) return null;
  const r = await one(`select user_id from memberships where firm_id = $1 and user_id = $2`, [m.firm_id, String(userId)]);
  if (!r) throw bad('That person is not on the team.');
  return r.user_id;
}

/** Drawing set types a project can carry (several at once). */
const SET_TYPES = ['schematic', 'zoning', 'site_plan', 'permit', 'construction', 'certificate_of_occupancy', 'as_built', 'existing_conditions', 'demolition', 'bid', 'fire_life_safety', 'variance', 'other'];

function projectFields(b: any, cur: any = {}) {
  const pick = (k: string, max: number) => (b[k] !== undefined ? str(b[k], max) : cur[k] ?? '');
  const kind = b.kind !== undefined ? str(b.kind, 20) : cur.kind ?? 'initial';
  if (!['initial', 'modification'].includes(kind)) throw bad('Project type must be initial drawings or modification.');
  const engineerEmail = pick('engineer_email', 200).toLowerCase();
  if (engineerEmail && !EMAIL.test(engineerEmail)) throw bad('Enter a valid engineer email.');
  const clientEmail = pick('client_email', 200).toLowerCase();
  if (clientEmail && !EMAIL.test(clientEmail)) throw bad('Enter a valid client email.');
  const rawTypes = b.set_types !== undefined ? b.set_types : cur.set_types;
  const setTypes = [...new Set((Array.isArray(rawTypes) ? rawTypes : []).map((x: unknown) => String(x)))];
  if (setTypes.some((x) => !SET_TYPES.includes(x))) throw bad('Unknown drawing set type.');
  if (!setTypes.length) setTypes.push('permit');
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
    client_name: pick('client_name', 120),
    client_email: clientEmail,
    set_types: setTypes,
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
       engineer_name, engineer_email, pm_id, drafter_id, architect_id, engineer_id, created_by, client_name, client_email, set_types)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::text[]) returning *`,
    [
      m.firm_id, f.name, f.number, f.address, f.jurisdiction, f.permit_number, f.kind, f.requirements,
      f.engineer_name, f.engineer_email, pm,
      await memberOrNull(m, b.drafter_id),
      (await memberOrNull(m, b.architect_id)) ?? (m.role === 'architect' ? ctx.user.id : null),
      await memberOrNull(m, b.engineer_id),
      ctx.user.id,
      f.client_name, f.client_email, f.set_types,
    ],
  );
  await log(m, ctx.user, p!.id, null, 'project_created', f.name);
  return json(p, 201);
}

async function getProject(ctx: Ctx) {
  const m = firmOf(ctx);
  const p = await loadProject(m, ctx.params[0], ctx.user.id);
  await seedMilestones(m, p, ctx.user.id);
  const slotSet0 = slotsOf(p, m, ctx.user.id);
  const [sets, comments, events, members, milestones, shareLinks] = await Promise.all([
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
    listMilestones(p.id),
    !slotSet0.has('pm')
      ? Promise.resolve([])
      : many(
          `select l.id, l.revision_set_id, s.rev_number, l.recipient_name, l.recipient_email, l.show_timeline, l.created_at, l.expires_at,
             l.opened_at, l.last_opened_at, l.open_count, l.revoked_at
           from share_links l left join revision_sets s on s.id = l.revision_set_id
           where l.project_id = $1 order by l.created_at desc limit 20`,
          [p.id],
        ),
  ]);
  const slotSet = slotSet0;
  const slots = [...slotSet];
  const vis = visiblePeople(m, slotSet, ctx.user.id);
  return json({
    project: redactProject(p, slotSet, vis),
    sets: sets.map((x) => redactSet(x, vis)),
    comments: vis
      ? comments.map((c: any) => (c.owner_id && !vis.has(c.owner_id) ? { ...c, owner_id: HIDDEN, owner_label: roleOf(p, c.owner_id), created_by: null } : { ...c, created_by: null }))
      : comments,
    events: redactPeople(redactEvents(events, slots), p, slotSet, vis, 'actor_name', 'actor_id'),
    members: vis ? members.filter((x) => vis.has(x.user_id)) : members,
    my_slots: slots,
    milestones,
    share_links: shareLinks,
  });
}

/** Drafters work only with the PM: they don't see the architect's or engineer's return notes directly. */
function redactEvents(events: any[], slots: string[]) {
  const onlyDrafter = slots.length === 1 && slots[0] === 'drafter';
  if (!onlyDrafter) return events;
  return events
    .filter((e) => e.action !== 'review_note')
    .map((e) => (['architect_returned', 'engineer_returned'].includes(e.action) ? { ...e, note: '' } : e));
}

/**
 * A note on the review thread. The PM's and drafter's notes are visible to the whole chain (note_added).
 * Notes from the architect or engineer stay between the reviewers and the PM (review_note); the drafter
 * hears about them through the PM, the same way markups reach them.
 */
async function addSetNote(ctx: Ctx) {
  const m = firmOf(ctx);
  const { s, p } = await loadSet(m, ctx.params[0], ctx.user.id);
  const slots = slotsOf(p, m, ctx.user.id);
  if (!slots.size) throw forbidden('Only people on this project can add notes.');
  const note = str(ctx.body.note, 4000);
  if (!note) throw bad('Write a note first.');
  const reviewerOnly = !slots.has('pm') && !slots.has('drafter');
  await log(m, ctx.user, s.project_id, s.id, reviewerOnly ? 'review_note' : 'note_added', note);
  return json({ ok: true }, 201);
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
       engineer_name=$10, engineer_email=$11, pm_id=$12, drafter_id=$13, architect_id=$14, engineer_id=$15, archived=$16,
       client_name=$17, client_email=$18, set_types=$19::text[]
     where id = $1 and firm_id = $2 returning *`,
    [
      p.id, m.firm_id, f.name, f.number, f.address, f.jurisdiction, f.permit_number, f.kind, f.requirements,
      f.engineer_name, f.engineer_email, pmId, drafterId,
      await assign('architect_id'), await assign('engineer_id'),
      b.archived !== undefined ? !!b.archived : p.archived,
      f.client_name, f.client_email, f.set_types,
    ],
  );
  if (drafterId !== p.drafter_id) await log(m, ctx.user, p.id, null, 'drafter_assigned', '');
  return json(row);
}

// ---------- revision sets ----------

/**
 * Starts the next revision. The architect (or PM) can start it at intake to share site notes and sketches;
 * the PM can also send it straight to the drafter with the scope. With from_comments, the open city comments
 * are tied to this round.
 */
async function createSet(ctx: Ctx) {
  const m = firmOf(ctx);
  const p = await loadProject(m, ctx.params[0], ctx.user.id);
  const slots = slotsOf(p, m, ctx.user.id);
  if (!slots.has('pm') && !slots.has('architect')) throw forbidden('The architect or project manager starts each revision.');
  const brief = str(ctx.body.brief, 8000);
  const direct = slots.has('pm') && !ctx.body.intake;
  if (direct && !p.drafter_id) throw bad('Assign a drafter to this project first.');
  if (direct && !brief) throw bad('Write what the drafter needs to do.');
  const open = await one(
    `select rev_number from revision_sets where project_id = $1 and status <> 'sealed' limit 1`,
    [p.id],
  );
  if (open) throw bad(`Rev ${open.rev_number} is still in progress. Finish or seal it before starting a new revision.`);
  const fromComments = !!ctx.body.from_comments;
  const s = await one(
    `insert into revision_sets (firm_id, project_id, rev_number, title, brief, created_by, status, reason)
     select $1, $2, coalesce(max(rev_number) + 1, 0), $3, $4, $5, $6, $7 from revision_sets where project_id = $2
     returning *`,
    [m.firm_id, p.id, str(ctx.body.title, 200), brief, ctx.user.id, direct ? 'draft' : 'intake', fromComments ? 'city' : ''],
  );
  if (fromComments) {
    await many(`update city_comments set round_set_id = $2 where project_id = $1 and status <> 'addressed' and round_set_id is null`, [p.id, s!.id]);
  }
  await log(m, ctx.user, p.id, s!.id, direct ? 'sent_to_drafter' : 'intake_started', direct ? brief : str(ctx.body.note, 4000));
  return json(s, 201);
}

async function updateSet(ctx: Ctx) {
  const m = firmOf(ctx);
  const { s, p } = await loadSet(m, ctx.params[0], ctx.user.id);
  const sl = slotsOf(p, m, ctx.user.id);
  if (!sl.has('pm') && !(sl.has('architect') && s.status === 'intake')) throw forbidden();
  if (s.status === 'sealed') throw bad('This set is sealed.');
  void p;
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
  const slotSet = slotsOf(p, m, ctx.user.id);
  const slots = [...slotSet];
  const onlyDrafter = slots.length === 1 && slots[0] === 'drafter';
  const vis = visiblePeople(m, slotSet, ctx.user.id);
  const sendsOut = slotSet.has('pm') || slotSet.has('architect');
  const [fileRows, events, members, stamps, clientLinks] = await Promise.all([
    many(
      `select f.*, coalesce(mb.name, 'Engineer (email link)') as uploaded_by_name from files f
       left join memberships mb on mb.firm_id = f.firm_id and mb.user_id = f.uploaded_by
       where f.revision_set_id = $1 and f.status = 'ready' and ($2::boolean = false or f.shared_with_drafter)
       order by f.kind, f.sheet, f.filename`,
      [s.id, onlyDrafter],
    ),
    many(`select * from events where revision_set_id = $1 order by created_at desc`, [s.id]),
    many(`select user_id, name, email, role from memberships where firm_id = $1 order by name`, [m.firm_id]),
    !sendsOut
      ? Promise.resolve([])
      : many(
          `select id, engineer_name, engineer_email, created_at, expires_at, used_at, revoked_at from stamp_requests
           where revision_set_id = $1 order by created_at desc`,
          [s.id],
        ),
    !slotSet.has('pm')
      ? Promise.resolve([])
      : many(
          `select id, client_name, client_email, created_at, expires_at, opened_at, revoked_at from client_links
           where revision_set_id = $1 order by created_at desc`,
          [s.id],
        ),
  ]);
  return json({
    set: redactSet(s, vis),
    project: redactProject(p, slotSet, vis),
    files: redactPeople(fileRows, p, slotSet, vis, 'uploaded_by_name', 'uploaded_by'),
    events: redactPeople(redactEvents(events, slots), p, slotSet, vis, 'actor_name', 'actor_id'),
    members: vis ? members.filter((x) => vis.has(x.user_id)) : members,
    my_slots: slots,
    // Non-PMs see the link's address (they may have sent it) but not the engineer's name.
    stamp_requests: vis ? stamps.map((r: any) => ({ ...r, engineer_name: '' })) : stamps,
    client_links: clientLinks,
  });
}

const FILE_KINDS = ['pdf', 'dwg', 'sealed_pdf', 'reference', 'markup', 'final_pdf', 'final_cad', 'other'];
const MAX_BYTES = 500 * 1024 * 1024;

/**
 * Who may add which kind of file at which step. Review rounds are PDF only; the CAD source comes in with the
 * final PDF for the record once the architect approves.
 */
function canUpload(kind: string, status: string, slots: Set<Slot>) {
  if (status === 'sealed') return false;
  switch (kind) {
    case 'pdf':
    case 'other':
      return (status === 'draft' && (slots.has('drafter') || slots.has('pm'))) ||
        (['pm_review', 'pm_rework'].includes(status) && slots.has('pm'));
    case 'dwg':
      return false;
    case 'reference':
      return slots.has('pm') || (status === 'intake' && slots.has('architect'));
    case 'markup':
      return (status === 'architect_review' && slots.has('architect')) ||
        (['pm_review', 'pm_rework', 'architect_review'].includes(status) && slots.has('pm'));
    case 'final_pdf':
    case 'final_cad':
      return status === 'final_record' && (slots.has('drafter') || slots.has('pm'));
    case 'sealed_pdf':
      return status === 'engineer_review' && (slots.has('engineer') || slots.has('pm'));
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
    if (kind === 'sealed_pdf') throw forbidden('The engineer (or the PM, for a stamp received by email) uploads the sealed set once it is ready for stamp.');
    if (kind === 'final_pdf' || kind === 'final_cad') throw bad('The final PDF and CAD files go in after the architect approves the set.');
    if (kind === 'dwg') throw bad('Review rounds are PDF only. Upload the CAD files with the final PDF after the architect approves.');
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
  const ev = f.kind === 'sealed_pdf' ? 'sealed_uploaded' : f.kind === 'markup' ? 'markup_uploaded' : f.kind === 'final_pdf' || f.kind === 'final_cad' ? 'final_uploaded' : 'file_uploaded';
  await log(m, ctx.user, f.project_id, f.revision_set_id, ev, f.filename);
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
 * The workflow. intake (architect's site notes, PM sets the scope) -> draft (drafter) -> pm_review (PM) ->
 * architect_review -> final_record (drafter uploads final PDF + CAD) -> engineer_review (ready for stamp) -> sealed.
 * The PM can send work back to the drafter; the architect and engineer send markups back to the PM (pm_rework),
 * and the PM either forwards them to the drafter or resubmits to the architect.
 */
const STEPS: Record<string, { from: string[]; slots: Slot[]; to: string; event: string; note?: boolean }> = {
  send_to_drafter: { from: ['intake'], slots: ['pm'], to: 'draft', event: 'sent_to_drafter' },
  submit: { from: ['draft'], slots: ['drafter'], to: 'pm_review', event: 'submitted' },
  pm_approve: { from: ['pm_review'], slots: ['pm'], to: 'architect_review', event: 'pm_approved' },
  pm_return: { from: ['pm_review'], slots: ['pm'], to: 'draft', event: 'pm_returned', note: true },
  pm_send_back: { from: ['pm_rework'], slots: ['pm'], to: 'draft', event: 'pm_returned', note: true },
  pm_resubmit: { from: ['pm_rework'], slots: ['pm'], to: 'architect_review', event: 'pm_approved' },
  architect_approve: { from: ['architect_review'], slots: ['architect'], to: 'final_record', event: 'architect_approved' },
  architect_return: { from: ['architect_review'], slots: ['architect'], to: 'pm_rework', event: 'architect_returned', note: true },
  submit_final: { from: ['final_record'], slots: ['drafter', 'pm'], to: 'engineer_review', event: 'final_submitted' },
  engineer_return: { from: ['engineer_review'], slots: ['engineer'], to: 'pm_rework', event: 'engineer_returned', note: true },
  seal: { from: ['engineer_review'], slots: ['engineer', 'pm'], to: 'sealed', event: 'sealed' },
};
const SLOT_NAME: Record<Slot, string> = { pm: 'the project manager', drafter: 'the assigned drafter', architect: 'the project architect', engineer: 'the project engineer' };

async function countFiles(setId: string, kind: string) {
  const c = await one(`select count(*)::int as n from files where revision_set_id = $1 and kind = $2 and status = 'ready'`, [setId, kind]);
  return c?.n ?? 0;
}

async function setAction(ctx: Ctx) {
  const m = firmOf(ctx);
  const { s, p } = await loadSet(m, ctx.params[0], ctx.user.id);
  const action = str(ctx.body.action, 30);
  const step = STEPS[action];
  if (!step) throw bad('Unknown action.');
  if (!step.from.includes(s.status)) throw bad('That step is not available for this set right now.');
  const slots = slotsOf(p, m, ctx.user.id);
  if (!step.slots.some((x) => slots.has(x))) throw forbidden(`This step is for ${SLOT_NAME[step.slots[0]]}.`);
  const note = str(ctx.body.note, 4000);
  if (step.note && !note) throw bad('Say what needs to change.');

  let seal: { by: string; name: string; via: string; license: string } | null = null;
  if (action === 'send_to_drafter') {
    if (!p.drafter_id) throw bad('Assign a drafter to this project first.');
    const brief = note || s.brief;
    if (!brief) throw bad('Write the scope for the drafter.');
    await many(`update revision_sets set brief = $2 where id = $1`, [s.id, brief]);
  }
  if (action === 'submit' && !(await countFiles(s.id, 'pdf'))) throw bad('Upload at least one PDF sheet before submitting.');
  if (action === 'submit_final') {
    if (!(await countFiles(s.id, 'final_pdf'))) throw bad('Upload the final PDF set first.');
    if (!(await countFiles(s.id, 'final_cad'))) throw bad('Upload the final CAD files first.');
  }
  if (action === 'seal') {
    if (!(await countFiles(s.id, 'sealed_pdf'))) throw bad('Upload the signed and sealed PDF first.');
    const byEngineer = slots.has('engineer');
    const engineerName = byEngineer ? ctx.user.name : str(ctx.body.engineer_name, 120) || p.engineer_name;
    if (!engineerName) throw bad('Enter the name of the engineer who stamped it.');
    seal = { by: ctx.user.id, name: engineerName, via: byEngineer ? 'app' : 'manual', license: str(ctx.body.license, 60) };
  }

  const row = await transition(s, step.to, seal);
  if (action === 'pm_send_back') {
    // Forwarding to the drafter shares the architect's markups with them.
    await many(`update files set shared_with_drafter = true where revision_set_id = $1 and kind = 'markup'`, [s.id]);
  }
  await log(m, ctx.user, s.project_id, s.id, step.event, action === 'send_to_drafter' ? note || s.brief : action === 'seal' && seal?.via === 'manual' ? `Stamped by ${seal.name}, received by email` : note);
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
  if (s.status !== 'engineer_review') throw bad('The set is sent for stamp once the final PDF and CAD files are in.');
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
       where revision_set_id = $1 and status = 'ready' and (kind in ('final_pdf','final_cad') or (kind = 'sealed_pdf' and uploaded_by = $2))
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
      `select * from files where id = $1 and revision_set_id = $2 and status = 'ready' and (kind in ('final_pdf','final_cad') or uploaded_by = $3)`,
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

// ---------- client delivery links (no account needed) ----------

const CLIENT_DAYS = 30;

async function createClientLink(ctx: Ctx) {
  const m = firmOf(ctx);
  const { s, p } = await loadSet(m, ctx.params[0], ctx.user.id);
  if (!slotsOf(p, m, ctx.user.id).has('pm')) throw forbidden('The project manager sends the stamped set to the client.');
  if (s.status !== 'sealed') throw bad('The client gets the set once it is stamped and sealed.');
  const email = str(ctx.body.email, 200).toLowerCase();
  const name = str(ctx.body.name, 120);
  if (!EMAIL.test(email)) throw bad("Enter the client's email.");
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await many(`update client_links set revoked_at = now() where revision_set_id = $1 and revoked_at is null`, [s.id]);
  const r = await one(
    `insert into client_links (firm_id, project_id, revision_set_id, token_hash, client_name, client_email, created_by, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7, now() + interval '${CLIENT_DAYS} days') returning id, expires_at`,
    [m.firm_id, p.id, s.id, await sha256Hex(token), name, email, ctx.user.id],
  );
  if (!p.client_email) {
    await many(`update projects set client_email = $2, client_name = coalesce(nullif(client_name, ''), $3) where id = $1`, [p.id, email, name]);
  }
  await many(`update revision_sets set delivered_at = coalesce(delivered_at, now()) where id = $1`, [s.id]);
  await log(m, ctx.user, p.id, s.id, 'client_link_sent', name ? `${name} <${email}>` : email);
  const origin = new URL(ctx.req.url).origin;
  return json({ id: r!.id, url: `${origin}/d/${token}`, expires_at: r!.expires_at }, 201);
}

async function revokeClientLink(ctx: Ctx) {
  const m = firmOf(ctx);
  const r = await one(`select project_id from client_links where id = $1 and firm_id = $2`, [ctx.params[0], m.firm_id]);
  if (!r) throw notFound('Link not found');
  const p = await loadProject(m, r.project_id, ctx.user.id);
  if (!slotsOf(p, m, ctx.user.id).has('pm')) throw forbidden();
  await many(`update client_links set revoked_at = now() where id = $1`, [ctx.params[0]]);
  return json({ ok: true });
}

async function publicDelivery(path: string, method: string): Promise<Response> {
  const mm = path.match(/^\/public\/delivery\/([\w-]{20,64})(?:\/files\/([0-9a-f-]{36}))?$/);
  if (!mm || method !== 'GET') return json({ error: 'Not found' }, 404);
  const r = await one(
    `select c.*, s.rev_number, s.title, s.sealed_at, s.sealed_by_name, s.engineer_license,
       p.name as project_name, p.number as project_number, p.address, p.jurisdiction, f.name as firm_name
     from client_links c
     join revision_sets s on s.id = c.revision_set_id
     join projects p on p.id = c.project_id
     join firms f on f.id = c.firm_id
     where c.token_hash = $1 and p.deleted_at is null`,
    [await sha256Hex(mm[1])],
  );
  if (!r || r.revoked_at) throw notFound('This link is no longer active. Ask the firm for a new one.');
  if (new Date(r.expires_at).getTime() < Date.now()) throw notFound('This link has expired. Ask the firm for a new one.');
  if (mm[2]) {
    const f = await one(`select * from files where id = $1 and revision_set_id = $2 and kind = 'sealed_pdf' and status = 'ready'`, [mm[2], r.revision_set_id]);
    if (!f) throw notFound('File not found');
    return json({ url: await files().downloadUrl(f.storage_key, f.filename) });
  }
  if (!r.opened_at) {
    await many(`update client_links set opened_at = now() where id = $1`, [r.id]);
    await log({ firm_id: r.firm_id }, { id: `client:${r.id}`, name: r.client_name || r.client_email }, r.project_id, r.revision_set_id, 'client_opened', '');
  }
  const list = await many(
    `select id, filename, size_bytes, sha256 from files where revision_set_id = $1 and kind = 'sealed_pdf' and status = 'ready' order by filename`,
    [r.revision_set_id],
  );
  return json({
    firm_name: r.firm_name,
    client_name: r.client_name,
    project: { name: r.project_name, number: r.project_number, address: r.address, jurisdiction: r.jurisdiction },
    rev_number: r.rev_number,
    title: r.title,
    sealed_at: r.sealed_at,
    // Clients see that the set is stamped and the license, not the names of the firm's people.
    engineer_license: r.engineer_license,
    expires_at: r.expires_at,
    files: list,
  });
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
  await many(`update client_links set revoked_at = now() where project_id = $1 and revoked_at is null`, [p.id]);
  await many(`update share_links set revoked_at = now() where project_id = $1 and revoked_at is null`, [p.id]);
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
      b.owner_id !== undefined && b.owner_id !== HIDDEN ? await memberOrNull(m, b.owner_id) : c.owner_id,
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


// ---------- permit timeline ----------

/** The standard permit path. Every project starts with these; the PM can add more steps between them. */
const MILESTONES: [string, string][] = [
  ['submitted', 'Submitted to the city'],
  ['under_review', 'Under review'],
  ['comments_received', 'Comments received'],
  ['resubmitted', 'Resubmitted'],
  ['approved', 'Approved'],
];

async function seedMilestones(m: Member, p: any, userId: string) {
  await many(
    `insert into permit_milestones (firm_id, project_id, kind, label, position, created_by)
     select $1, $2, x.kind, x.label, x.position, $3
     from jsonb_to_recordset($4::jsonb) as x(kind text, label text, position int)
     where not exists (select 1 from permit_milestones where project_id = $2)`,
    [m.firm_id, p.id, userId, JSON.stringify(MILESTONES.map(([kind, label], i) => ({ kind, label, position: i })))],
  );
}

function listMilestones(projectId: string) {
  return many(
    `select id, kind, label, position, to_char(target_on, 'YYYY-MM-DD') as target_on, to_char(done_on, 'YYYY-MM-DD') as done_on, note
     from permit_milestones where project_id = $1 order by position, created_at`,
    [projectId],
  );
}

/** A date field: "" or null clears it, YYYY-MM-DD sets it, undefined keeps what is there. */
function dateField(v: unknown, cur: string | null): string | null {
  if (v === undefined) return cur;
  if (v === null || v === '') return null;
  const s = str(v, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw bad('Dates look like 2026-12-01.');
  return s;
}

async function milestoneFor(ctx: Ctx) {
  const m = firmOf(ctx);
  const row = await one(
    `select id, project_id, label, note, to_char(target_on, 'YYYY-MM-DD') as target_on, to_char(done_on, 'YYYY-MM-DD') as done_on
     from permit_milestones where id = $1 and firm_id = $2`,
    [ctx.params[0], m.firm_id],
  );
  if (!row) throw notFound('Milestone not found');
  const p = await loadProject(m, row.project_id, ctx.user.id);
  if (!slotsOf(p, m, ctx.user.id).has('pm')) throw forbidden('The project manager keeps the permit timeline.');
  return { m, p, row };
}

async function addMilestone(ctx: Ctx) {
  const m = firmOf(ctx);
  const p = await loadProject(m, ctx.params[0], ctx.user.id);
  if (!slotsOf(p, m, ctx.user.id).has('pm')) throw forbidden('The project manager keeps the permit timeline.');
  await seedMilestones(m, p, ctx.user.id);
  const label = str(ctx.body.label, 120);
  if (!label) throw bad('Name the step.');
  // New steps go before "Approved" unless the PM says where.
  const all = await listMilestones(p.id);
  const approved = all.find((x) => x.kind === 'approved');
  const after = all.find((x) => x.id === ctx.body.after_id);
  const at = after ? after.position + 1 : approved ? approved.position : all.length;
  await many(`update permit_milestones set position = position + 1 where project_id = $1 and position >= $2`, [p.id, at]);
  const kind = MILESTONES.some(([k]) => k === ctx.body.kind) ? ctx.body.kind : 'other';
  const row = await one(
    `insert into permit_milestones (firm_id, project_id, kind, label, position, target_on, created_by)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [m.firm_id, p.id, kind, label, at, dateField(ctx.body.target_on, null), ctx.user.id],
  );
  return json({ id: row!.id, milestones: await listMilestones(p.id) }, 201);
}

async function updateMilestone(ctx: Ctx) {
  const { m, p, row } = await milestoneFor(ctx);
  const b = ctx.body;
  // done: true marks it complete today (or on done_on); done: false reopens it.
  let doneOn = dateField(b.done_on, row.done_on);
  if (b.done === true && !doneOn) doneOn = new Date().toISOString().slice(0, 10);
  if (b.done === false) doneOn = null;
  const label = b.label !== undefined ? str(b.label, 120) || row.label : row.label;
  await many(
    `update permit_milestones set label = $2, target_on = $3, done_on = $4, note = $5 where id = $1`,
    [row.id, label, dateField(b.target_on, row.target_on), doneOn, b.note !== undefined ? str(b.note, 1000) : row.note],
  );
  if (!row.done_on && doneOn) await log(m, ctx.user, p.id, null, 'milestone_done', label);
  if (row.done_on && !doneOn) await log(m, ctx.user, p.id, null, 'milestone_reopened', label);
  return json({ milestones: await listMilestones(p.id) });
}

async function deleteMilestone(ctx: Ctx) {
  const { p, row } = await milestoneFor(ctx);
  await many(`delete from permit_milestones where id = $1`, [row.id]);
  return json({ milestones: await listMilestones(p.id) });
}

// ---------- share links (read-only, no account needed) ----------

const SHARE_DAYS = [7, 30, 90];

async function createShareLink(ctx: Ctx) {
  const m = firmOf(ctx);
  const p = await loadProject(m, ctx.params[0], ctx.user.id);
  if (!slotsOf(p, m, ctx.user.id).has('pm')) throw forbidden('The project manager shares the project with the client.');
  let setId: string | null = null;
  if (ctx.body.revision_set_id) {
    setId = await setOrNull(m, p.id, ctx.body.revision_set_id);
    const s = await one(`select status from revision_sets where id = $1`, [setId]);
    if (s?.status !== 'sealed') throw bad('Only stamped and sealed sets can be shared.');
  }
  const email = str(ctx.body.email, 200).toLowerCase();
  if (email && !EMAIL.test(email)) throw bad('Enter a valid email, or leave it blank.');
  const days = SHARE_DAYS.includes(Number(ctx.body.days)) ? Number(ctx.body.days) : 30;
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = await one(
    `insert into share_links (firm_id, project_id, revision_set_id, token_hash, recipient_name, recipient_email, show_timeline, created_by, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(days => $9)) returning id, expires_at`,
    [m.firm_id, p.id, setId, await sha256Hex(token), str(ctx.body.name, 120), email, ctx.body.show_timeline !== false, ctx.user.id, days],
  );
  await log(m, ctx.user, p.id, setId, 'share_link_created', setId ? 'one stamped set' : 'the project');
  const origin = new URL(ctx.req.url).origin;
  return json({ id: r!.id, url: `${origin}/share/${token}`, expires_at: r!.expires_at }, 201);
}

async function revokeShareLink(ctx: Ctx) {
  const m = firmOf(ctx);
  const r = await one(`select project_id from share_links where id = $1 and firm_id = $2`, [ctx.params[0], m.firm_id]);
  if (!r) throw notFound('Link not found');
  const p = await loadProject(m, r.project_id, ctx.user.id);
  if (!slotsOf(p, m, ctx.user.id).has('pm')) throw forbidden();
  await many(`update share_links set revoked_at = coalesce(revoked_at, now()) where id = $1`, [ctx.params[0]]);
  return json({ ok: true });
}

async function publicShare(path: string, method: string, url: URL): Promise<Response> {
  const mm = path.match(/^\/public\/share\/([\w-]{20,64})(?:\/files\/([0-9a-f-]{36}))?$/);
  if (!mm || method !== 'GET') return json({ error: 'Not found' }, 404);
  const r = await one(
    `select l.*, p.name as project_name, p.number as project_number, p.address, p.jurisdiction, p.permit_number,
       f.name as firm_name
     from share_links l join projects p on p.id = l.project_id join firms f on f.id = l.firm_id
     where l.token_hash = $1 and p.deleted_at is null`,
    [await sha256Hex(mm[1])],
  );
  if (!r || r.revoked_at) throw notFound('This link is no longer active. Ask the firm for a new one.');
  if (new Date(r.expires_at).getTime() < Date.now()) throw notFound('This link has expired. Ask the firm for a new one.');
  // Only stamped sets are ever shared: the whole project shows every sealed set, a set link shows just that one.
  const sets = await many(
    `select id, rev_number, title, reason, sealed_at, engineer_license from revision_sets
     where project_id = $1 and status = 'sealed' and ($2::uuid is null or id = $2) order by rev_number desc`,
    [r.project_id, r.revision_set_id],
  );
  const ids = sets.map((s) => s.id);
  if (mm[2]) {
    const f = await one(`select * from files where id = $1 and kind = 'sealed_pdf' and status = 'ready' and revision_set_id = any($2::uuid[])`, [mm[2], ids]);
    if (!f) throw notFound('File not found');
    return json({ url: await files().downloadUrl(f.storage_key, f.filename, url.searchParams.get('inline') === '1') });
  }
  await many(`update share_links set opened_at = coalesce(opened_at, now()), last_opened_at = now(), open_count = open_count + 1 where id = $1`, [r.id]);
  if (!r.opened_at) {
    await log({ firm_id: r.firm_id }, { id: `client:${r.id}`, name: r.recipient_name || r.recipient_email || 'The client' }, r.project_id, r.revision_set_id, 'share_opened', '');
  }
  const fileRows = ids.length
    ? await many(
        `select id, revision_set_id, filename, size_bytes, sha256 from files
         where revision_set_id = any($1::uuid[]) and kind = 'sealed_pdf' and status = 'ready' order by filename`,
        [ids],
      )
    : [];
  return json({
    firm_name: r.firm_name,
    recipient_name: r.recipient_name,
    scope: r.revision_set_id ? 'set' : 'project',
    project: { name: r.project_name, number: r.project_number, address: r.address, jurisdiction: r.jurisdiction, permit_number: r.permit_number },
    // Clients see stage names and dates, not the PM's notes or anyone's name.
    timeline: r.show_timeline ? (await listMilestones(r.project_id)).map(({ kind, label, target_on, done_on }) => ({ kind, label, target_on, done_on })) : null,
    sets: sets.map((s) => ({ ...s, files: fileRows.filter((f) => f.revision_set_id === s.id).map(({ revision_set_id, ...f }) => (void revision_set_id, f)) })),
    expires_at: r.expires_at,
  });
}

// ---------- resubmittal letter ----------

/** The comments a revision answers: the ones its city round was started for, plus any marked fixed in it. */
function roundComments(setId: string) {
  return many(
    `select * from city_comments where round_set_id = $1 or addressed_in_set_id = $1
     order by nullif(regexp_replace(number, '\\D', '', 'g'), '')::int nulls last, number, created_at`,
    [setId],
  );
}

async function resubmittalLetter(ctx: Ctx) {
  const m = firmOf(ctx);
  const { s, p } = await loadSet(m, ctx.params[0], ctx.user.id);
  if (!slotsOf(p, m, ctx.user.id).has('pm')) throw forbidden('The project manager sends the resubmittal letter.');
  const comments = await roundComments(s.id);
  if (!comments.length) throw bad(`No city comments are tied to Rev ${s.rev_number}. Start a revision for city comments, or mark comments fixed in this revision.`);
  const b = ctx.body;
  const lang = 'en-US';
  const day = /^\d{4}-\d{2}-\d{2}$/.test(str(b.date, 10)) ? new Date(str(b.date, 10) + 'T12:00:00Z') : new Date();
  const revs = new Map((await many(`select id, rev_number from revision_sets where project_id = $1`, [p.id])).map((x) => [x.id, x.rev_number]));
  const pdf = await resubmittalPdf({
    firmName: m.firm_name,
    date: day.toLocaleDateString(lang, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }),
    to: str(b.to, 600) || [p.jurisdiction ? `${p.jurisdiction} Building Department` : 'Building Department', 'Plan Review'].join('\n'),
    project: { name: p.name, number: p.number, address: p.address, jurisdiction: p.jurisdiction, permit_number: p.permit_number },
    revNumber: s.rev_number,
    revTitle: s.title,
    intro: b.intro !== undefined ? str(b.intro, 4000) : defaultIntro(p, s),
    closing: b.closing !== undefined ? str(b.closing, 4000) : 'Please contact us with any questions about these revisions.',
    signer: str(b.signer, 120) || ctx.user.name,
    signerTitle: b.signer_title !== undefined ? str(b.signer_title, 120) : 'Project Manager',
    comments: comments.map((c) => ({
      number: c.number, sheet: c.sheet, discipline: c.discipline, body: c.body, response: c.response,
      fixedIn: c.addressed_in_set_id && revs.has(c.addressed_in_set_id) ? `Rev ${revs.get(c.addressed_in_set_id)}` : '',
    })),
  });
  await log(m, ctx.user, p.id, s.id, 'resubmittal_letter', `Rev ${s.rev_number}, ${comments.length} comments`);
  const file = `Resubmittal-${p.name.replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')}-Rev${s.rev_number}.pdf`;
  return new Response(pdf, {
    status: 200,
    headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${file}"`, 'cache-control': 'no-store' },
  });
}

function defaultIntro(p: any, s: any) {
  const permit = p.permit_number ? ` (permit ${p.permit_number})` : '';
  return `Enclosed is Rev ${s.rev_number} of the drawings for ${p.name}${permit}, revised in response to the plan review comments. Each comment is listed below with our response and the sheet where the change was made.`;
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
  ['POST', new RegExp(`^/sets/${ID}/notes$`), addSetNote],
  ['POST', new RegExp(`^/sets/${ID}/stamp-links$`), createStampLink],
  ['DELETE', new RegExp(`^/stamp-links/${ID}$`), revokeStampLink],
  ['POST', new RegExp(`^/sets/${ID}/client-links$`), createClientLink],
  ['DELETE', new RegExp(`^/client-links/${ID}$`), revokeClientLink],
  ['POST', new RegExp(`^/files/${ID}/complete$`), finishUpload],
  ['GET', new RegExp(`^/files/${ID}/download$`), downloadFile],
  ['DELETE', new RegExp(`^/files/${ID}$`), deleteFile],
  ['PATCH', new RegExp(`^/comments/${ID}$`), updateComment],
  ['POST', new RegExp(`^/projects/${ID}/milestones$`), addMilestone],
  ['PATCH', new RegExp(`^/milestones/${ID}$`), updateMilestone],
  ['DELETE', new RegExp(`^/milestones/${ID}$`), deleteMilestone],
  ['POST', new RegExp(`^/projects/${ID}/share-links$`), createShareLink],
  ['DELETE', new RegExp(`^/share-links/${ID}$`), revokeShareLink],
  ['POST', new RegExp(`^/sets/${ID}/resubmittal-letter$`), resubmittalLetter],
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
    if (path.startsWith('/public/delivery/')) return await publicDelivery(path, req.method);
    if (path.startsWith('/public/share/')) return await publicShare(path, req.method, url);

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
