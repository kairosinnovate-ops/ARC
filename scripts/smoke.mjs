// End-to-end API check against the local dev server (npm run dev must be running).
const B = process.env.BASE || 'http://127.0.0.1:5173';
const tok = async (email, name) => (await (await fetch(B + '/dev-auth/token', { method: 'POST', body: JSON.stringify({ email, name }) })).json()).token;
const call = (t, firm) => async (path, method = 'GET', body) => {
  const r = await fetch(B + '/api' + path, { method, headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json', ...(firm ? { 'x-arc-firm': firm } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  return { status: r.status, ...j, _arr: Array.isArray(j) ? j : undefined };
};
const ok = (c, msg) => { if (!c) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok  ', msg); };
const sha = async (buf) => Buffer.from(await crypto.subtle.digest('SHA-256', buf)).toString('hex');
async function up(api, setId, name, kind, sheet, bytes) {
  const s = await api(`/sets/${setId}/files`, 'POST', { kind, sheet, filename: name, size: bytes.length, sha256: await sha(bytes), content_type: 'application/pdf' });
  if (s.status !== 201) return s;
  await fetch(s.upload_url, { method: 'PUT', body: bytes });
  return api(`/files/${s.file_id}/complete`, 'POST', {});
}
const stamp = Date.now();
let D;
async function finalRecord(id) {
  await up(D, id, 'final.pdf', 'final_pdf', '', Buffer.from('%PDF final ' + id));
  await up(D, id, 'final.dwg', 'final_cad', '', Buffer.from('AC final ' + id));
  return D(`/sets/${id}/action`, 'POST', { action: 'submit_final' });
}
const em = (r) => `${r}${stamp}@mastan.test`;
const owner = call(await tok(em('pm'), 'Kairos PM'));
ok((await owner('/me')).firms.length === 0, 'new user has no firm');
const firm = await owner('/firms', 'POST', { name: 'Mastan Group', role: 'pm' });
ok(firm.status === 201 && firm.is_admin && firm.role === 'pm', 'create firm as PM admin');
const PM = call(await tok(em('pm'), 'Kairos PM'), firm.firm_id);
for (const [r, role] of [['d1', 'drafter'], ['d2', 'drafter'], ['ar', 'architect'], ['pe', 'engineer']])
  ok((await PM('/team/invites', 'POST', { email: em(r), role })).status === 201, `invite ${role} ${r}`);
D = call(await tok(em('d1'), 'Dana Drafter'));
const dme = await D('/me');
ok(dme.firms[0]?.role === 'drafter', 'drafter joins on sign-in');
const D2 = call(await tok(em('d2'), 'Other Drafter'));
const d2me = await D2('/me');
const A = call(await tok(em('ar'), 'Ana Architect'));
const ame = await A('/me');
const E = call(await tok(em('pe'), 'Eli Engineer'));
const eme = await E('/me');
const outsider = call(await tok(`x${stamp}@other.test`, 'Outsider'));
await outsider('/firms', 'POST', { name: 'Other Firm', role: 'pm' });

ok((await D('/projects', 'POST', { name: 'Nope' })).status === 403, 'drafter cannot create projects');
const p = await PM('/projects', 'POST', { name: 'Hillside Residence', number: '2026-014', kind: 'modification', requirements: 'Add a rear deck.', drafter_id: dme.user.id, architect_id: ame.user.id, engineer_name: 'Pat PE', engineer_email: 'pat@pe.test' });
ok(p.status === 201 && p.pm_id && p.kind === 'modification', 'PM creates project with team and type');
ok((await outsider(`/projects/${p.id}`)).status === 404, 'other firm cannot see project');
ok((await D2(`/projects/${p.id}`)).status === 404, 'unassigned drafter cannot see project');
ok((await D2('/projects'))._arr.length === 0, 'unassigned drafter sees no projects');
ok((await D('/projects'))._arr.length === 1, 'assigned drafter sees the project');
ok((await D(`/projects/${p.id}/sets`, 'POST', { brief: 'x' })).status === 403, 'drafter cannot start a revision');
// Intake: the architect shares site notes and sketches, the PM sets the scope and sends it to the drafter.
const set = await A(`/projects/${p.id}/sets`, 'POST', { title: 'Deck addition', note: 'Site visit done, sketch attached.' });
ok(set.rev_number === 0 && set.status === 'intake', 'architect starts Rev 0 at intake');
ok((await up(A, set.id, 'sketch.pdf', 'reference', '', Buffer.from('sketch'))).ok, 'architect uploads hand sketch');
ok((await D(`/sets/${set.id}`)).status === 200, 'assigned drafter can open the intake');
ok((await up(D, set.id, 'S-101.pdf', 'pdf', 'S-101', Buffer.from('early'))).status === 400, 'drafter cannot draw before the scope is sent');
ok((await A(`/sets/${set.id}/action`, 'POST', { action: 'send_to_drafter', note: 'x' })).status === 403, 'architect cannot send to drafter');
ok((await up(PM, set.id, 'survey.pdf', 'reference', '', Buffer.from('ref'))).ok, 'PM attaches reference');
ok((await PM(`/sets/${set.id}/action`, 'POST', { action: 'send_to_drafter', note: 'Draw deck framing on S-101. For permit.' })).status === 'draft', 'PM sends scope to drafter');
ok((await D(`/sets/${set.id}`)).set.brief.includes('deck framing'), 'drafter sees the scope');
ok((await up(D, set.id, 'S-101.pdf', 'pdf', 'S-101', Buffer.from('%PDF-1.4 plan'))).ok, 'drafter uploads PDF');
ok((await up(D, set.id, 'S-101.dwg', 'dwg', 'S-101', Buffer.from('AC1032'))).status === 400, 'review rounds are PDF only');
ok((await A(`/sets/${set.id}/action`, 'POST', { action: 'submit' })).status === 403, 'architect cannot submit for drafter');
ok((await D(`/sets/${set.id}/action`, 'POST', { action: 'submit', note: 'Done' })).status === 'pm_review', 'drafter submits to PM');
ok((await up(D, set.id, 'late.pdf', 'pdf', 'S-102', Buffer.from('late'))).status === 400, 'drafter locked out while PM checks');
ok((await PM(`/sets/${set.id}/action`, 'POST', { action: 'pm_return' })).status === 400, 'PM return needs a note');
ok((await PM(`/sets/${set.id}/action`, 'POST', { action: 'pm_return', note: 'Add joist spacing' })).status === 'draft', 'PM sends back to drafter');
ok((await D(`/sets/${set.id}/action`, 'POST', { action: 'submit' })).status === 'pm_review', 'drafter resubmits');
ok((await A(`/sets/${set.id}/action`, 'POST', { action: 'architect_approve' })).status === 400, 'architect cannot act before PM');
ok((await PM(`/sets/${set.id}/action`, 'POST', { action: 'pm_approve' })).status === 'architect_review', 'PM sends to architect');
ok((await up(A, set.id, 'redline.pdf', 'markup', '', Buffer.from('%PDF redline'))).ok, 'architect uploads markup');
ok((await D(`/sets/${set.id}`)).files.every((f) => f.kind !== 'markup'), 'drafter cannot see architect markup yet');
ok((await A(`/sets/${set.id}/action`, 'POST', { action: 'architect_return', note: 'Beam size wrong' })).status === 'pm_rework', 'architect sends rework to PM');
const dEvents = (await D(`/sets/${set.id}`)).events;
ok(dEvents.find((e) => e.action === 'architect_returned')?.note === '', 'drafter does not see architect note directly');
ok((await PM(`/sets/${set.id}/action`, 'POST', { action: 'pm_send_back', note: 'Fix beam per redline' })).status === 'draft', 'PM forwards rework to drafter');
// Review thread notes: reviewers' notes stay with the PM; the PM's and drafter's notes reach everyone.
ok((await A(`/sets/${set.id}/notes`, 'POST', { note: 'Check the ledger bolts too.' })).status === 201, 'architect leaves a reviewer note');
ok((await PM(`/sets/${set.id}/notes`, 'POST', { note: 'Drafter: beam and ledger, see markups.' })).status === 201, 'PM leaves a note');
ok((await D(`/sets/${set.id}/notes`, 'POST', { note: 'On it.' })).status === 201, 'drafter leaves a note');
ok((await D(`/sets/${set.id}/notes`, 'POST', { note: '' })).status === 400, 'empty note is refused');
ok((await D2(`/sets/${set.id}/notes`, 'POST', { note: 'hi' })).status === 404, 'unassigned drafter cannot post');
{
  const dv = (await D(`/sets/${set.id}`)).events;
  ok(!dv.some((e) => e.action === 'review_note') && dv.filter((e) => e.action === 'note_added').length === 2, 'drafter sees PM and own notes, not the reviewer note');
  const pv = (await PM(`/sets/${set.id}`)).events;
  ok(pv.some((e) => e.action === 'review_note' && e.note.includes('ledger')), 'PM sees the reviewer note');
  ok(!(await D(`/projects/${p.id}`)).events.some((e) => e.action === 'review_note'), 'drafter project feed hides the reviewer note');
}
ok((await D(`/sets/${set.id}`)).files.some((f) => f.kind === 'markup'), 'drafter now sees the markup');
ok((await D(`/sets/${set.id}/action`, 'POST', { action: 'submit' })).status === 'pm_review', 'drafter resubmits after rework');
ok((await PM(`/sets/${set.id}/action`, 'POST', { action: 'pm_approve' })).status === 'architect_review', 'PM approves again');
ok((await A(`/sets/${set.id}/action`, 'POST', { action: 'architect_approve' })).status === 'final_record', 'architect approves; final record next');
ok((await PM(`/sets/${set.id}/stamp-links`, 'POST', { email: 'pat@pe.test' })).status === 400, 'no stamp link before final record');
ok((await D(`/sets/${set.id}/action`, 'POST', { action: 'submit_final' })).status === 400, 'final needs PDF and CAD');
ok((await up(D, set.id, 'final.pdf', 'final_pdf', '', Buffer.from('%PDF final'))).ok, 'drafter uploads final PDF');
ok((await D(`/sets/${set.id}/action`, 'POST', { action: 'submit_final' })).status === 400, 'final still needs CAD');
ok((await up(D, set.id, 'S-101.dwg', 'final_cad', 'S-101', Buffer.from('AC1032 final'))).ok, 'drafter uploads final CAD');
ok((await D(`/sets/${set.id}/action`, 'POST', { action: 'submit_final' })).status === 'engineer_review', 'final record done; ready for stamp');
ok((await D(`/sets/${set.id}/stamp-links`, 'POST', { email: 'pat@pe.test' })).status === 403, 'drafter cannot send stamp link');
const link = await PM(`/sets/${set.id}/stamp-links`, 'POST', { email: 'pat@pe.test', name: 'Pat PE' });
ok(link.status === 201 && link.url.includes('/stamp/'), 'PM creates stamp link');
const token = link.url.split('/stamp/')[1];
const pub = async (path, body) => { const r = await fetch(`${B}/api/public/stamp/${token}${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, ...(await r.json()) }; };
const pv = await pub('');
ok(pv.status === 'open' && pv.files.length === 2 && pv.files.every((f) => ['final_pdf', 'final_cad'].includes(f.kind)), 'engineer sees only the final PDF and CAD');
ok((await fetch(`${B}/api/public/stamp/notarealtokenatall123456`)).status === 404, 'bad token rejected');
const dlr = await pub(`/files/${pv.files[0].id}`);
ok(dlr.url && (await fetch(dlr.url)).ok, 'engineer downloads without account');
ok((await pub('/seal', { name: 'Pat PE' })).status === 400, 'cannot seal before upload');
const sealedBytes = Buffer.from('%PDF signed by Pat');
const st = await pub('/upload', { filename: 'stamped.pdf', size: sealedBytes.length, sha256: await sha(sealedBytes) });
await fetch(st.upload_url, { method: 'PUT', body: sealedBytes });
ok((await pub(`/complete/${st.file_id}`, {})).ok, 'engineer uploads stamped PDF via link');
ok((await pub('/seal', { name: 'Pat PE', license: 'PE 12345' })).ok, 'engineer seals via link');
const sd = await PM(`/sets/${set.id}`);
ok(sd.set.status === 'sealed' && sd.set.sealed_via === 'link' && sd.set.engineer_license === 'PE 12345', 'set sealed through link with license');
ok((await pub('/seal', { name: 'Pat PE' })).status === 400, 'link cannot be reused');
ok((await D(`/files/${sd.files.find((f) => f.kind === 'pdf').id}`, 'DELETE')).status === 400, 'cannot delete from sealed set');

// Second revision: in-app engineer path and engineer sending back
await PM(`/projects/${p.id}`, 'PATCH', { engineer_id: eme.user.id });
const set1 = await PM(`/projects/${p.id}/sets`, 'POST', { brief: 'City comments round 1' });
ok(set1.rev_number === 1, 'Rev 1 after seal');
await up(D, set1.id, 'S-101.pdf', 'pdf', 'S-101', Buffer.from('%PDF rev1'));
await D(`/sets/${set1.id}/action`, 'POST', { action: 'submit' });
await PM(`/sets/${set1.id}/action`, 'POST', { action: 'pm_approve' });
await A(`/sets/${set1.id}/action`, 'POST', { action: 'architect_approve' });
await finalRecord(set1.id);
ok((await E(`/sets/${set1.id}/action`, 'POST', { action: 'engineer_return', note: 'Need calcs' })).status === 'pm_rework', 'in-app engineer sends back to PM');
ok((await PM(`/sets/${set1.id}/action`, 'POST', { action: 'pm_resubmit' })).status === 'architect_review', 'PM resubmits to architect');
await A(`/sets/${set1.id}/action`, 'POST', { action: 'architect_approve' });
await finalRecord(set1.id);
ok((await up(E, set1.id, 'sealed.pdf', 'sealed_pdf', '', Buffer.from('%PDF sealed'))).ok, 'in-app engineer uploads seal');
ok((await E(`/sets/${set1.id}/action`, 'POST', { action: 'seal', license: 'PE 9' })).status === 'sealed', 'in-app engineer seals');

const letter = `BUILDING\n1. Sheet A-101: Show egress window sizes.\n2) S-201 Provide hold-down schedule.`;
const prev = await PM(`/projects/${p.id}/letter/preview`, 'POST', { text: letter });
ok(prev._arr?.length === 2, 'letter parsed');
ok((await PM(`/projects/${p.id}/letter/import`, 'POST', { items: prev._arr, revision_set_id: set.id })).imported === 2, 'letter imported');
const c1 = (await PM(`/projects/${p.id}`)).comments[0];
ok((await D(`/comments/${c1.id}`, 'PATCH', { status: 'addressed', owner_id: dme.user.id })).status === 'addressed', 'drafter addresses comment');
ok((await D2(`/comments/${c1.id}`, 'PATCH', { status: 'open' })).status === 404, 'unassigned drafter cannot edit comment');
ok((await D(`/projects/${p.id}`, 'PATCH', { name: 'x' })).status === 403, 'drafter cannot edit project');

// Deleting projects: Trash, restore, delete forever
const { existsSync } = await import('node:fs');
const q = await PM('/projects', 'POST', { name: 'Old Garage', drafter_id: dme.user.id, architect_id: ame.user.id, engineer_name: 'Pat PE', engineer_email: 'pat@pe.test' });
const qs = await PM(`/projects/${q.id}/sets`, 'POST', { brief: 'x' });
await up(D, qs.id, 'G-1.pdf', 'pdf', 'G-1', Buffer.from('%PDF g'));
await D(`/sets/${qs.id}/action`, 'POST', { action: 'submit' });
await PM(`/sets/${qs.id}/action`, 'POST', { action: 'pm_approve' });
await A(`/sets/${qs.id}/action`, 'POST', { action: 'architect_approve' });
await finalRecord(qs.id);
const qlink = await PM(`/sets/${qs.id}/stamp-links`, 'POST', { email: 'pat@pe.test', name: 'Pat PE' });
const qtoken = qlink.url?.split('/stamp/')[1];
ok(qtoken && (await fetch(`${B}/api/public/stamp/${qtoken}`)).ok, 'stamp link works before delete');
const qdir = `.local-files/${firm.firm_id}/${q.id}`;
ok(existsSync(qdir), 'project files stored on disk');
ok((await D(`/projects/${q.id}/delete`, 'POST', { confirm_name: 'Old Garage' })).status === 403, 'drafter cannot delete project');
ok((await A(`/projects/${q.id}/delete`, 'POST', { confirm_name: 'Old Garage' })).status === 403, 'architect cannot delete project');
ok((await PM(`/projects/${q.id}/delete`, 'POST', { confirm_name: 'Old garage!' })).status === 400, 'wrong name is rejected');
ok((await PM(`/projects/${q.id}/delete`, 'POST', { confirm_name: 'old garage' })).ok, 'PM deletes with typed name');
ok((await PM(`/projects/${q.id}`)).status === 404, 'deleted project is hidden');
ok(!(await PM('/projects'))._arr.some((x) => x.id === q.id), 'deleted project leaves the list');
ok((await D(`/sets/${qs.id}`)).status === 404, 'deleted project sets are hidden');
ok((await fetch(`${B}/api/public/stamp/${qtoken}`)).status === 404, 'stamp link stops working');
ok((await PM('/trash'))._arr.some((x) => x.id === q.id && x.file_count === 3), 'project is in Trash');
ok((await D('/trash'))._arr.length === 0, 'drafter sees nothing in Trash');
ok((await D(`/trash/${q.id}/restore`, 'POST', {})).status === 404, 'drafter cannot restore');
ok((await outsider(`/trash/${q.id}/restore`, 'POST', {})).status === 404, 'other firm cannot restore');
ok((await PM(`/trash/${q.id}/restore`, 'POST', {})).ok, 'PM restores');
ok((await PM(`/projects/${q.id}`)).project?.id === q.id, 'restored project is back');
await PM(`/projects/${q.id}/delete`, 'POST', { confirm_name: 'Old Garage' });
ok((await PM(`/trash/${q.id}/delete`, 'POST', { confirm_name: 'nope' })).status === 400, 'delete forever needs the name');
const gone = await PM(`/trash/${q.id}/delete`, 'POST', { confirm_name: 'Old Garage' });
ok(gone.ok && gone.files_removed === 3, 'PM deletes forever');
ok(!existsSync(`${qdir}/${qs.id}`) || !(await import('node:fs')).readdirSync(`${qdir}/${qs.id}`).length, 'stored files removed');
ok(!(await PM('/trash'))._arr.some((x) => x.id === q.id), 'Trash is empty again');
ok((await PM(`/projects/${p.id}`)).project?.id === p.id, 'other projects untouched');

// Who sees who: only the PM and admins see names. Everyone else sees roles and their own name.
const dp = await D(`/projects/${p.id}`);
ok(dp.project.architect_id === 'assigned' && dp.project.engineer_id === 'assigned' && dp.project.pm_id === 'assigned' && dp.project.engineer_email === '', 'drafter sees the slots are filled, not by whom');
ok(dp.members.length === 1 && dp.members[0].user_id === dme.user.id, 'drafter sees only self');
ok(dp.events.some((e) => e.actor_name === 'Architect') && dp.events.filter((e) => e.actor_name === 'Architect').every((e) => e.actor_id === 'assigned'), 'architect actions show as "Architect" to the drafter');
ok(dp.events.some((e) => e.actor_name === 'Project manager'), 'PM actions show as "Project manager" to the drafter');
const ap = await A(`/projects/${p.id}`);
ok(ap.project.drafter_id === 'assigned' && ap.project.engineer_id === 'assigned' && ap.members.length === 1, 'architect does not see the drafter or engineer either');
const pp = await PM(`/projects/${p.id}`);
ok(pp.project.drafter_id === dme.user.id && pp.members.length >= 5, 'PM sees everyone');
const dteam = await D('/team');
ok(dteam.limited && dteam.members.length === 1 && dteam.members[0].user_id === dme.user.id, 'drafter team page shows only themselves');
const other = await PM('/projects', 'POST', { name: 'Not yours', drafter_id: dme.user.id });
ok(!(await A('/projects'))._arr.some((x) => x.id === other.id), 'architect sees only projects they are on');
ok((await A(`/projects/${other.id}`)).status === 404, 'architect cannot open other projects');

// City comments start a new round; PM uploads a stamp received by email; client gets a link
const round = await PM(`/projects/${p.id}/sets`, 'POST', { title: 'City round 1', brief: 'Fix per city comments.', from_comments: true });
ok(round.status === 'draft' && round.reason === 'city', 'PM starts a city-comment round');
ok((await PM(`/projects/${p.id}`)).comments.filter((c) => c.status !== 'addressed').every((c) => c.round_set_id === round.id), 'open comments tied to the round');
await up(D, round.id, 'A-101.pdf', 'pdf', 'A-101', Buffer.from('%PDF city'));
await D(`/sets/${round.id}/action`, 'POST', { action: 'submit' });
await PM(`/sets/${round.id}/action`, 'POST', { action: 'pm_approve' });
await A(`/sets/${round.id}/action`, 'POST', { action: 'architect_approve' });
ok((await finalRecord(round.id)).status === 'engineer_review', 'city round reaches stamp');
ok((await up(D, round.id, 'stamped.pdf', 'sealed_pdf', '', Buffer.from('x'))).status === 403, 'drafter cannot upload a stamp');
ok((await up(PM, round.id, 'stamped-by-email.pdf', 'sealed_pdf', '', Buffer.from('%PDF emailed stamp'))).ok, 'PM uploads stamp received by email');
const ms = await PM(`/sets/${round.id}/action`, 'POST', { action: 'seal', engineer_name: 'Pat PE', license: 'PE 12345' });
ok(ms.status === 'sealed' && ms.sealed_via === 'manual' && ms.sealed_by_name === 'Pat PE', 'PM records the emailed stamp');
ok((await PM(`/sets/${round.id}/client-links`, 'POST', { email: 'bad' })).status === 400, 'client link needs an email');
ok((await D(`/sets/${round.id}/client-links`, 'POST', { email: 'c@client.test' })).status === 403, 'drafter cannot send to client');
const cl = await PM(`/sets/${round.id}/client-links`, 'POST', { email: 'owner@client.test', name: 'Sam Owner' });
ok(cl.status === 201 && cl.url.includes('/d/'), 'PM creates client link');
const ctoken = cl.url.split('/d/')[1];
const cv = await (await fetch(`${B}/api/public/delivery/${ctoken}`)).json();
ok(cv.files.length === 1 && cv.files[0].filename === 'stamped-by-email.pdf' && cv.project.name === 'Hillside Residence', 'client sees only the stamped set');
ok(!/Pat PE|Kairos PM|Dana Drafter|Ana Architect|Eli Engineer/.test(JSON.stringify(cv)), 'client page shows no team names');

// Name privacy: nothing a drafter, architect or engineer loads carries anyone else's name.
const NAMES = { D: 'Dana Drafter', A: 'Ana Architect', E: 'Eli Engineer' };
const OTHERS = ['Kairos PM', 'Dana Drafter', 'Ana Architect', 'Eli Engineer', 'Pat PE', 'Sam Owner', 'Other Drafter', 'owner@client.test', em('pm'), em('d1'), em('ar'), em('pe')];
for (const [k, who] of [['D', D], ['A', A], ['E', E]]) {
  const seen = JSON.stringify([
    await who('/projects'), await who(`/projects/${p.id}`), await who(`/sets/${set.id}`),
    await who(`/sets/${set1.id}`), await who(`/sets/${round.id}`), await who('/team'),
  ]);
  const mine = { D: em('d1'), A: em('ar'), E: em('pe') }[k];
  const leaked = OTHERS.filter((n) => n !== NAMES[k] && n !== mine && seen.includes(n));
  ok(leaked.length === 0, `${NAMES[k]} sees no one else's name${leaked.length ? ` (saw ${leaked.join(', ')})` : ''}`);
  ok(seen.includes(NAMES[k]) || k === 'E', `${NAMES[k]} still sees their own name`);
}
const pseen = JSON.stringify([await PM(`/projects/${p.id}`), await PM(`/sets/${set.id}`)]);
ok(['Dana Drafter', 'Ana Architect', 'Eli Engineer', 'Pat PE'].every((n) => pseen.includes(n)), 'PM still sees every name');
const cdl = await (await fetch(`${B}/api/public/delivery/${ctoken}/files/${cv.files[0].id}`)).json();
ok(cdl.url && (await fetch(cdl.url)).ok, 'client downloads without account');
const rs = await PM(`/sets/${round.id}`);
ok(rs.set.delivered_at && rs.client_links.length === 1 && rs.events.some((e) => e.action === 'client_opened'), 'delivery and first open are logged');
ok((await D(`/sets/${round.id}`)).client_links.length === 0, 'drafter does not see client links');
ok((await PM(`/projects/${p.id}`)).project.client_email === 'owner@client.test', 'client saved on the project');
await PM(`/client-links/${rs.client_links[0].id}`, 'DELETE');
ok((await fetch(`${B}/api/public/delivery/${ctoken}`)).status === 404, 'turned-off client link stops working');
ok((await PM(`/sets/${set1.id}/client-links`, 'POST', { email: 'x@client.test' })).status === 201, 'any sealed set can be delivered');
ok((await PM(`/projects/${p.id}`)).project.set_types.join() === 'permit', 'set type defaults to permit set');
ok((await PM(`/projects/${p.id}`, 'PATCH', { set_types: ['sale'] })).status === 400, 'unknown set type is rejected');
ok((await PM(`/projects/${p.id}`, 'PATCH', { set_types: ['zoning', 'certificate_of_occupancy', 'zoning'] })).set_types.join() === 'zoning,certificate_of_occupancy', 'project carries several set types');
ok((await PM('/projects'))._arr.find((x) => x.id === p.id).set_types.includes('zoning'), 'set types in the project list');

// Dashboard: stage and whose turn it is.
const row = async (api, id) => (await api('/projects'))._arr.find((x) => x.id === id);
const sp = await PM('/projects', 'POST', { name: 'Stage Check', drafter_id: dme.user.id, architect_id: ame.user.id });
let r0 = await row(PM, sp.id);
ok(r0.stage === 'intake' && r0.waiting_on === 'pm' && r0.your_turn, 'new project is intake, PM turn');
const sx = await PM(`/projects/${sp.id}/sets`, 'POST', { title: 'Permit set', brief: 'Draw it.' });
r0 = await row(PM, sp.id);
ok(r0.stage === 'review' && r0.round === 1 && r0.waiting_on === 'drafter' && !r0.your_turn, 'with drafter: review round 1, not PM turn');
ok((await row(D, sp.id)).your_turn, 'drafter sees their turn');
await up(D, sx.id, 'A-101.pdf', 'pdf', 'A-101', Buffer.from('%PDF stage'));
await D(`/sets/${sx.id}/action`, 'POST', { action: 'submit' });
ok((await row(PM, sp.id)).your_turn && !(await row(D, sp.id)).your_turn, 'after submit it is the PM turn');
await PM(`/sets/${sx.id}/action`, 'POST', { action: 'pm_return', note: 'Fix the stair.' });
ok((await row(PM, sp.id)).round === 2, 'a return starts review round 2');
await D(`/sets/${sx.id}/action`, 'POST', { action: 'submit' });
await PM(`/sets/${sx.id}/action`, 'POST', { action: 'pm_approve' });
ok((await row(A, sp.id)).your_turn && (await row(PM, sp.id)).waiting_on === 'architect', 'architect review is the architect turn');
await A(`/sets/${sx.id}/action`, 'POST', { action: 'architect_approve' });
ok((await row(PM, sp.id)).stage === 'final_record' && (await row(D, sp.id)).your_turn, 'awaiting final record, drafter turn');
await finalRecord(sx.id);
const sst = await row(PM, sp.id);
ok(sst.stage === 'stamp' && sst.waiting_on === 'engineer' && !sst.your_turn, 'awaiting stamp, waiting on engineer');
const hpr = await row(PM, p.id);
ok(hpr.stage === 'delivered' && hpr.waiting_on === null && hpr.last_delivered_at, 'delivered project waits on nobody');
