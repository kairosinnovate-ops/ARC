import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../App';
import { Dialog, Icon, Pill, SET_STATUS, SET_TYPES, fmtDate, setTypeList } from '../ui';
import { ProjectFields, toForm, type ProjectFormValue } from './ProjectForm';

export default function ProjectsPage() {
  const s = useSession();
  const [projects, setProjects] = useState<any[] | null>(null);
  const [err, setErr] = useState('');
  const [params, setParams] = useSearchParams();
  const canCreate = s.firm.is_admin || ['pm', 'architect'].includes(s.firm.role);
  const creating = params.get('new') === '1' && canCreate;
  const typeFilter = params.get('type') || '';
  const shown = (projects || []).filter((p) => !typeFilter || (p.set_types || []).includes(typeFilter));
  const usedTypes = Object.keys(SET_TYPES).filter((k) => (projects || []).some((p) => (p.set_types || []).includes(k)));

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
          <p className="hint">Each project has a PM, a drafter, an architect and an engineer. Work moves from intake to drafting, review, final record, stamp and the client.</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Link className="btn ghost" to="/trash"><Icon name="trash" size={14} /> Trash</Link>
          {canCreate && (
            <button className="btn primary" onClick={() => setParams({ new: '1' })}>
              <Icon name="plus" /> New project
            </button>
          )}
        </div>
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
          {canCreate ? (
            <>
              <p style={{ marginTop: 0 }}>No projects yet. Create one, pick the drafter, and send them the requirements.</p>
              <button className="btn primary" onClick={() => setParams({ new: '1' })}><Icon name="plus" /> New project</button>
            </>
          ) : (
            <p style={{ margin: 0 }}>No projects assigned to you yet. Your project manager will send you one.</p>
          )}
        </div>
      )}
      {projects && projects.length > 0 && usedTypes.length > 1 && (
        <div className="filters" style={{ marginBottom: 14 }}>
          <select
            className="input"
            style={{ width: 'auto' }}
            value={typeFilter}
            aria-label="Filter by drawing set type"
            onChange={(e) => { const n = new URLSearchParams(params); if (e.target.value) n.set('type', e.target.value); else n.delete('type'); setParams(n); }}
          >
            <option value="">All set types</option>
            {usedTypes.map((k) => <option key={k} value={k}>{SET_TYPES[k]}</option>)}
          </select>
          {typeFilter && <span className="hint">{shown.length} of {projects.length} projects</span>}
        </div>
      )}
      {projects && projects.length > 0 && (
        <div className="pgrid">
          {shown.map((p) => (
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
              <div className="meta">{p.kind === 'modification' ? 'Modification' : 'Initial drawings'}{p.address ? ` · ${p.address}` : ''}</div>
              {p.set_types?.length > 0 && <div className="tagrow">{setTypeList(p.set_types).map((t) => <span key={t} className="tag">{t}</span>)}</div>}
              <div className="meta">PM: {p.pm_name || 'none'} · Drafter: {p.drafter_name || 'not assigned'}</div>
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
  const s = useSession();
  const [f, setF] = useState<ProjectFormValue>(toForm(null, s.user.id));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const p = await api('/projects', { body: { ...f, drafter_id: f.drafter_id || null, architect_id: f.architect_id || null, engineer_id: f.engineer_id || null } });
      nav(`/projects/${p.id}`);
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  }
  return (
    <Dialog title="New project" onClose={onClose} wide>
      <form onSubmit={submit}>
        <ProjectFields f={f} setF={setF} />
        {err && <p className="err">{err}</p>}
        <div className="foot">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create project'}</button>
        </div>
      </form>
    </Dialog>
  );
}
