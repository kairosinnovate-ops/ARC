import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../App';
import { Avatar, COMMENT_STATUS, Dialog, Icon, NOTE_EVENTS, Pill, SET_STATUS, eventText, fmtDate, timeAgo, useToast } from '../ui';

type Data = { project: any; sets: any[]; comments: any[]; events: any[]; members: any[] };

export default function ProjectPage() {
  const { id } = useParams();
  const s = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(false);

  const load = useCallback(() => api<Data>(`/projects/${id}`).then(setD).catch((e) => setErr(e.message)), [id]);
  useEffect(() => {
    load();
  }, [load, s.firm.firm_id]);
  useEffect(() => {
    if (d) s.setCrumbs(<><span className="sep">/</span><Link to="/" className="hint">Projects</Link><span className="sep">/</span><b>{d.project.name}</b></>);
  }, [d?.project.name]);

  if (err) return <main className="content"><p className="err">{err}</p><Link className="link" to="/">Back to projects</Link></main>;
  if (!d) return <main className="content"><div className="hint">Loading…</div></main>;
  const { project: p, sets } = d;
  const active = sets.find((x) => x.status !== 'sealed');
  const nextRev = sets.length ? sets[0].rev_number + 1 : 0;

  async function newSet() {
    try {
      const set = await api(`/projects/${p.id}/sets`, { body: { title: '' } });
      nav(`/sets/${set.id}`);
    } catch (e: any) {
      toast(e.message, true);
    }
  }

  return (
    <main className="content">
      <div className="page-h">
        <div>
          <span className="label">{p.number || 'Project'}{p.permit_number ? ` · Permit ${p.permit_number}` : ''}</span>
          <h1 style={{ marginTop: 8 }}>{p.name}</h1>
          <p className="hint">{[p.address, p.jurisdiction].filter(Boolean).join(' · ') || 'Add the site address and jurisdiction.'}</p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => setEditing(true)}>Edit details</button>
          {!active && (
            <button className="btn primary" onClick={newSet}>
              <Icon name="plus" /> Start Rev {nextRev}
            </button>
          )}
          {active && (
            <Link className="btn primary" to={`/sets/${active.id}`}>
              Open Rev {active.rev_number}
            </Link>
          )}
        </div>
      </div>

      <div className="grid2">
        <div className="col" style={{ gap: 22 }}>
          <section className="card">
            <div className="card-h">
              <h2>Revision sets</h2>
              <span className="hint">Each set pairs the PDF sheets with their DWG source.</span>
            </div>
            {sets.length === 0 ? (
              <div className="empty">
                No sets yet. Start Rev 0 to upload the first drawings.
                <div style={{ marginTop: 12 }}><button className="btn primary" onClick={newSet}><Icon name="plus" /> Start Rev 0</button></div>
              </div>
            ) : (
              <div className="queue">
                {sets.map((x) => (
                  <Link key={x.id} to={`/sets/${x.id}`} className="qi">
                    <div className="s">
                      <div className="t">Rev {x.rev_number}{x.title ? ` · ${x.title}` : ''}</div>
                      <div className="sub">
                        {x.pdf_count} PDF · {x.dwg_count} DWG · {x.sealed_at ? `sealed ${fmtDate(x.sealed_at)}` : `started ${fmtDate(x.created_at)}`}
                      </div>
                    </div>
                    <Pill kind={`st-${x.status}`}>{SET_STATUS[x.status]}</Pill>
                  </Link>
                ))}
              </div>
            )}
          </section>
          <CommentLog data={d} reload={load} />
        </div>
        <section className="card">
          <h2>Activity</h2>
          {d.events.length === 0 ? (
            <div className="hint">Nothing yet.</div>
          ) : (
            <div className="feed">
              {d.events.map((e) => (
                <div className="f" key={e.id}>
                  <Avatar name={e.actor_name} />
                  <div style={{ minWidth: 0 }}>
                    <div>
                      <b style={{ fontWeight: 500 }}>{e.actor_name}</b> {eventText(e.action)}{' '}
                      {!NOTE_EVENTS.has(e.action) && e.note && <span className="mono">{e.note}</span>}
                    </div>
                    {NOTE_EVENTS.has(e.action) && e.note && <div className="note">“{e.note}”</div>}
                    <time dateTime={e.created_at}>{timeAgo(e.created_at)}</time>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
      {editing && <EditProject project={p} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} />}
    </main>
  );
}

function EditProject({ project, onClose, onSaved }: { project: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: project.name, number: project.number, address: project.address, jurisdiction: project.jurisdiction, permit_number: project.permit_number });
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api(`/projects/${project.id}`, { method: 'PATCH', body: f });
      onSaved();
    } catch (e: any) {
      setErr(e.message);
    }
  }
  return (
    <Dialog title="Project details" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label className="field wide"><span>Project name</span><input className="input" value={f.name} onChange={set('name')} required /></label>
          <label className="field"><span>Project number</span><input className="input" value={f.number} onChange={set('number')} /></label>
          <label className="field"><span>Permit number</span><input className="input" value={f.permit_number} onChange={set('permit_number')} /></label>
          <label className="field wide"><span>Site address</span><input className="input" value={f.address} onChange={set('address')} /></label>
          <label className="field wide"><span>Jurisdiction</span><input className="input" value={f.jurisdiction} onChange={set('jurisdiction')} /></label>
        </div>
        {err && <p className="err">{err}</p>}
        <div className="foot">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary">Save</button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------- City comment log ----------------

function CommentLog({ data, reload }: { data: Data; reload: () => void }) {
  const [filter, setFilter] = useState<'active' | 'all' | 'addressed'>('active');
  const [sheet, setSheet] = useState('');
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const people = useMemo(() => Object.fromEntries(data.members.map((m) => [m.user_id, m.name])), [data.members]);
  const sheets = useMemo(() => [...new Set(data.comments.map((c) => c.sheet).filter(Boolean))].sort(), [data.comments]);
  const revOf = useMemo(() => Object.fromEntries(data.sets.map((x) => [x.id, x.rev_number])), [data.sets]);

  const shown = data.comments.filter(
    (c) =>
      (filter === 'all' || (filter === 'addressed' ? c.status === 'addressed' : c.status !== 'addressed')) && (!sheet || c.sheet === sheet),
  );
  const openCount = data.comments.filter((c) => c.status !== 'addressed').length;

  return (
    <section className="card">
      <div className="card-h">
        <div>
          <h2>City comments</h2>
          <div className="hint" style={{ marginTop: 4 }}>
            {openCount} open of {data.comments.length}. Days waiting counts from the date the letter came in.
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={() => setImporting(true)}><Icon name="letter" /> Paste a letter</button>
          <button className="btn" onClick={() => setAdding(true)}><Icon name="plus" /> Add comment</button>
        </div>
      </div>
      {data.comments.length > 0 && (
        <div className="filters" style={{ marginBottom: 12 }}>
          <div className="seg">
            {(['active', 'addressed', 'all'] as const).map((f) => (
              <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                {f === 'active' ? 'Open' : f === 'addressed' ? 'Addressed' : 'All'}
              </button>
            ))}
          </div>
          {sheets.length > 0 && (
            <select className="input" style={{ width: 'auto' }} value={sheet} onChange={(e) => setSheet(e.target.value)} aria-label="Filter by sheet">
              <option value="">All sheets</option>
              {sheets.map((x) => <option key={x}>{x}</option>)}
            </select>
          )}
        </div>
      )}
      {data.comments.length === 0 ? (
        <div className="empty">When the city sends corrections, paste the letter here and each item becomes a tracked comment.</div>
      ) : shown.length === 0 ? (
        <div className="empty">Nothing in this view.</div>
      ) : (
        <div className="ctable">
          {shown.map((c) => (
            <div key={c.id} className={`citem ${c.status}`}>
              <div className="num">#{c.number || '–'}</div>
              <div style={{ minWidth: 0 }}>
                <div className="body">{c.body}</div>
                <div className="tags">
                  {c.sheet && <span className="mono">{c.sheet}</span>}
                  {c.discipline && <span>{c.discipline}</span>}
                  {c.revision_set_id && revOf[c.revision_set_id] !== undefined && <span>on Rev {revOf[c.revision_set_id]}</span>}
                  <span>{c.owner_id ? `Owner: ${people[c.owner_id] || 'Former member'}` : 'No owner'}</span>
                  {c.status !== 'addressed' ? (
                    <span className={`wait${c.days_waiting >= 7 ? ' late' : ''}`}>{c.days_waiting} day{c.days_waiting === 1 ? '' : 's'} waiting</span>
                  ) : (
                    c.addressed_in_set_id && revOf[c.addressed_in_set_id] !== undefined && <span>Fixed in Rev {revOf[c.addressed_in_set_id]}</span>
                  )}
                </div>
                {c.response && <div className="resp">{c.response}</div>}
              </div>
              <div className="col" style={{ gap: 8, alignItems: 'flex-end' }}>
                <Pill kind={`cs-${c.status}`}>{COMMENT_STATUS[c.status]}</Pill>
                <button className="btn sm" onClick={() => setEdit(c)}>Update</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {adding && <CommentForm data={data} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} />}
      {edit && <CommentForm data={data} comment={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
      {importing && <ImportLetter data={data} onClose={() => setImporting(false)} onSaved={() => { setImporting(false); reload(); }} />}
    </section>
  );
}

function CommentForm({ data, comment, onClose, onSaved }: { data: Data; comment?: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const latestSealed = data.sets.find((x) => x.status === 'sealed');
  const [f, setF] = useState({
    number: comment?.number ?? '',
    sheet: comment?.sheet ?? '',
    discipline: comment?.discipline ?? '',
    reviewer: comment?.reviewer ?? '',
    body: comment?.body ?? '',
    owner_id: comment?.owner_id ?? '',
    status: comment?.status ?? 'open',
    response: comment?.response ?? '',
    revision_set_id: comment?.revision_set_id ?? latestSealed?.id ?? '',
    addressed_in_set_id: comment?.addressed_in_set_id ?? '',
    received_on: comment?.received_on?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
  });
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (comment) {
        await api(`/comments/${comment.id}`, { method: 'PATCH', body: { ...f, owner_id: f.owner_id || null, addressed_in_set_id: f.addressed_in_set_id || null } });
      } else {
        await api(`/projects/${data.project.id}/comments`, { body: { ...f, owner_id: f.owner_id || null, revision_set_id: f.revision_set_id || null } });
      }
      onSaved();
    } catch (e: any) {
      setErr(e.message);
    }
  }
  async function remove() {
    if (!comment) return;
    try {
      await api(`/comments/${comment.id}`, { method: 'DELETE' });
      toast('Comment deleted.');
      onSaved();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  return (
    <Dialog title={comment ? `Comment #${comment.number || ''}` : 'Add a city comment'} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label className="field"><span>Comment number</span><input className="input" value={f.number} onChange={set('number')} placeholder="12" /></label>
          <label className="field"><span>Sheet</span><input className="input" value={f.sheet} onChange={set('sheet')} placeholder="A-201" /></label>
          <label className="field"><span>Discipline</span><input className="input" value={f.discipline} onChange={set('discipline')} placeholder="Structural" /></label>
          <label className="field"><span>City reviewer</span><input className="input" value={f.reviewer} onChange={set('reviewer')} /></label>
          <label className="field wide"><span>Comment</span><textarea className="input" value={f.body} onChange={set('body')} required /></label>
          <label className="field">
            <span>Owner</span>
            <select className="input" value={f.owner_id} onChange={set('owner_id')}>
              <option value="">No owner</option>
              {data.members.map((m) => <option key={m.user_id} value={m.user_id}>{m.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Status</span>
            <select className="input" value={f.status} onChange={set('status')}>
              {Object.entries(COMMENT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          {!comment && (
            <label className="field">
              <span>Comment is on</span>
              <select className="input" value={f.revision_set_id} onChange={set('revision_set_id')}>
                <option value="">No specific revision</option>
                {data.sets.map((x) => <option key={x.id} value={x.id}>Rev {x.rev_number}</option>)}
              </select>
            </label>
          )}
          {!comment && (
            <label className="field"><span>Letter received</span><input className="input" type="date" value={f.received_on} onChange={set('received_on')} /></label>
          )}
          {comment && (
            <label className="field">
              <span>Fixed in revision</span>
              <select className="input" value={f.addressed_in_set_id} onChange={set('addressed_in_set_id')}>
                <option value="">Not yet</option>
                {data.sets.map((x) => <option key={x.id} value={x.id}>Rev {x.rev_number}</option>)}
              </select>
            </label>
          )}
          {comment && (
            <label className="field wide">
              <span>Response to the city</span>
              <textarea className="input" value={f.response} onChange={set('response')} placeholder="Revised detail 4/A-501 to show…" />
            </label>
          )}
        </div>
        {err && <p className="err">{err}</p>}
        <div className="foot" style={{ justifyContent: 'space-between' }}>
          <div>{comment && <button type="button" className="btn danger" onClick={remove}><Icon name="trash" /> Delete</button>}</div>
          <div className="row">
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary">{comment ? 'Save' : 'Add comment'}</button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

function ImportLetter({ data, onClose, onSaved }: { data: Data; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const latest = data.sets.find((x) => x.status === 'sealed') || data.sets[0];
  const [text, setText] = useState('');
  const [items, setItems] = useState<any[] | null>(null);
  const [setId, setSetId] = useState(latest?.id || '');
  const [received, setReceived] = useState(new Date().toISOString().slice(0, 10));
  const [reviewer, setReviewer] = useState('');
  const [err, setErr] = useState('');

  async function preview() {
    try {
      setErr('');
      const r = await api<any[]>(`/projects/${data.project.id}/letter/preview`, { body: { text } });
      if (!r.length) return setErr('No numbered items found. Each comment should start with a number like "1." or "2)".');
      setItems(r);
    } catch (e: any) {
      setErr(e.message);
    }
  }
  async function save() {
    try {
      const r = await api(`/projects/${data.project.id}/letter/import`, {
        body: { items, revision_set_id: setId || null, received_on: received, reviewer },
      });
      toast(`Imported ${r.imported} comments.`);
      onSaved();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  return (
    <Dialog title="Turn a correction letter into comments" onClose={onClose} wide>
      {!items ? (
        <>
          <p className="hint" style={{ marginTop: 0 }}>
            Paste the text of the city's letter. Each numbered item becomes its own comment, and sheet numbers like A-201 are picked up.
          </p>
          <textarea className="input" style={{ minHeight: 240 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={'STRUCTURAL\n1. Sheet S-201: Provide hold-down schedule...\n2. ...'} autoFocus />
          {err && <p className="err">{err}</p>}
          <div className="foot">
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!text.trim()} onClick={preview}>Preview comments</button>
          </div>
        </>
      ) : (
        <>
          <div className="form-grid" style={{ marginBottom: 14 }}>
            <label className="field"><span>Letter received</span><input className="input" type="date" value={received} onChange={(e) => setReceived(e.target.value)} /></label>
            <label className="field">
              <span>Comments are on</span>
              <select className="input" value={setId} onChange={(e) => setSetId(e.target.value)}>
                <option value="">No specific revision</option>
                {data.sets.map((x) => <option key={x.id} value={x.id}>Rev {x.rev_number}</option>)}
              </select>
            </label>
            <label className="field wide"><span>City reviewer (optional)</span><input className="input" value={reviewer} onChange={(e) => setReviewer(e.target.value)} /></label>
          </div>
          <div className="label" style={{ marginBottom: 8 }}>{items.length} comments found. Fix anything before importing.</div>
          <div className="ctable">
            {items.map((it, n) => (
              <div key={n} className="citem" style={{ gridTemplateColumns: '60px 90px 110px minmax(0,1fr) auto' }}>
                <input className="input" value={it.number} aria-label="Number" onChange={(e) => setItems(items.map((x, i) => (i === n ? { ...x, number: e.target.value } : x)))} />
                <input className="input" value={it.sheet} placeholder="Sheet" aria-label="Sheet" onChange={(e) => setItems(items.map((x, i) => (i === n ? { ...x, sheet: e.target.value } : x)))} />
                <input className="input" value={it.discipline} placeholder="Discipline" aria-label="Discipline" onChange={(e) => setItems(items.map((x, i) => (i === n ? { ...x, discipline: e.target.value } : x)))} />
                <textarea className="input" style={{ minHeight: 40 }} value={it.body} aria-label="Comment" onChange={(e) => setItems(items.map((x, i) => (i === n ? { ...x, body: e.target.value } : x)))} />
                <button className="btn ghost sm" aria-label="Remove" onClick={() => setItems(items.filter((_, i) => i !== n))}><Icon name="trash" /></button>
              </div>
            ))}
          </div>
          {err && <p className="err">{err}</p>}
          <div className="foot">
            <button className="btn ghost" onClick={() => setItems(null)}>Back</button>
            <button className="btn primary" disabled={!items.length} onClick={save}>Import {items.length} comments</button>
          </div>
        </>
      )}
    </Dialog>
  );
}
