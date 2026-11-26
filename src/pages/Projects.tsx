import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../App';
import { Dialog, Icon, Pill, SET_STATUS, fmtDate } from '../ui';

export default function ProjectsPage() {
  const s = useSession();
  const [projects, setProjects] = useState<any[] | null>(null);
  const [err, setErr] = useState('');
  const [params, setParams] = useSearchParams();
  const creating = params.get('new') === '1';

  useEffect(() => {
    s.setCrumbs(<><span className="sep">/</span><b>Projects</b></>);
    api<any[]>('/projects').then(setProjects).catch((e) => setErr(e.message));
  }, [s.firm.firm_id]);

  const open = (projects || []).reduce((n, p) => n + p.open_comments, 0);
  const inReview = (projects || []).filter((p) => ['architect_review', 'engineer_review'].includes(p.latest_status)).length;
  const sealed = (projects || []).filter((p) => p.latest_status === 'sealed').length;

  return (
    <main className="content">
      <div className="page-h">
        <div>
          <span className="label">{s.firm.firm_name}</span>
          <h1 style={{ marginTop: 8 }}>Projects</h1>
          <p className="hint">Each project holds its revision sets, the review chain and the city's comments.</p>
        </div>
        <button className="btn primary" onClick={() => setParams({ new: '1' })}>
          <Icon name="plus" /> New project
        </button>
      </div>

      {projects && projects.length > 0 && (
        <div className="statline">
          <div className="stat"><div className="n">{inReview}</div><div className="l">Sets in review</div></div>
          <div className="stat"><div className="n">{open}</div><div className="l">Open city comments</div></div>
          <div className="stat"><div className="n">{sealed}</div><div className="l">Projects with a sealed latest set</div></div>
        </div>
      )}

      {err && <div className="err">{err}</div>}
      {!projects && !err && <div className="hint">Loading projects…</div>}
      {projects && projects.length === 0 && (
        <div className="empty">
          <p style={{ marginTop: 0 }}>No projects yet. Create the first one to upload a drawing set.</p>
          <button className="btn primary" onClick={() => setParams({ new: '1' })}><Icon name="plus" /> New project</button>
        </div>
      )}
      {projects && projects.length > 0 && (
        <div className="pgrid">
          {projects.map((p) => (
            <Link key={p.id} to={`/projects/${p.id}`} className="pcard">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="mono" style={{ color: 'var(--faint)' }}>{p.number || 'No number'}</span>
                {p.latest_status ? (
                  <Pill kind={`st-${p.latest_status}`}>Rev {p.latest_rev} · {SET_STATUS[p.latest_status]}</Pill>
                ) : (
                  <Pill kind="st-draft">No sets yet</Pill>
                )}
              </div>
              <h3>{p.name}</h3>
              <div className="meta">{[p.address, p.jurisdiction].filter(Boolean).join(' · ') || 'No address yet'}</div>
              <div className="row hint" style={{ justifyContent: 'space-between' }}>
                <span style={{ color: p.open_comments ? 'var(--redline)' : undefined }}>
                  {p.open_comments} open city comment{p.open_comments === 1 ? '' : 's'}
                </span>
                {p.last_comments_on && <span>Last letter {fmtDate(p.last_comments_on)}</span>}
              </div>
            </Link>
          ))}
        </div>
      )}
      {creating && <NewProject onClose={() => setParams({})} />}
    </main>
  );
}

function NewProject({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const [f, setF] = useState({ name: '', number: '', address: '', jurisdiction: '', permit_number: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const p = await api('/projects', { body: f });
      nav(`/projects/${p.id}`);
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  }
  return (
    <Dialog title="New project" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label className="field wide"><span>Project name</span><input className="input" value={f.name} onChange={set('name')} required autoFocus /></label>
          <label className="field"><span>Project number</span><input className="input" value={f.number} onChange={set('number')} placeholder="2026-014" /></label>
          <label className="field"><span>Permit number</span><input className="input" value={f.permit_number} onChange={set('permit_number')} /></label>
          <label className="field wide"><span>Site address</span><input className="input" value={f.address} onChange={set('address')} /></label>
          <label className="field wide"><span>Jurisdiction (city or county)</span><input className="input" value={f.jurisdiction} onChange={set('jurisdiction')} /></label>
        </div>
        {err && <p className="err">{err}</p>}
        <div className="foot">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create project'}</button>
        </div>
      </form>
    </Dialog>
  );
}
