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
  // Only PMs and admins see people's names; everyone else sees the stage and the role it waits on.
  const seesNames = s.firm.is_admin || s.firm.role === 'pm';
  const canCreate = s.firm.is_admin || ['pm', 'architect'].includes(s.firm.role);
  const creating = params.get('new') === '1' && canCreate;
  const typeFilter = params.get('type') || '';
  const view = (params.get('view') || 'all') as View;
  const all = projects || [];
  const byType = all.filter((p) => !typeFilter || (p.set_types || []).includes(typeFilter));
  const shown = byType
    .filter(VIEWS[view]?.test ?? (() => true))
    .sort((a, b) => Number(b.your_turn) - Number(a.your_turn));
  const usedTypes = Object.keys(SET_TYPES).filter((k) => all.some((p) => (p.set_types || []).includes(k)));
  const setParam = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    if (v && v !== 'all') n.set(k, v); else n.delete(k);
    setParams(n);
  };

  useEffect(() => {
    s.setCrumbs(<><span className="sep">/</span><b>Projects</b></>);
    api<any[]>('/projects').then(setProjects).catch((e) => setErr(e.message));
  }, [s.firm.firm_id]);

  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const tiles: { n: number; l: string; v: View; hot?: boolean }[] = [
    { n: all.filter((p) => p.stage !== 'delivered').length, l: 'Active projects', v: 'all' },
    { n: all.filter((p) => p.your_turn).length, l: 'Waiting on you', v: 'mine', hot: true },
    { n: all.filter((p) => p.last_delivered_at && new Date(p.last_delivered_at) >= monthStart).length, l: 'Delivered this month', v: 'delivered' },
    { n: all.filter((p) => p.stage === 'city').length, l: 'City revision rounds open', v: 'city' },
  ];

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
        <div className="statline tiles">
          {tiles.map((t) => (
            <button
              key={t.l}
              type="button"
              className={`stat${view === t.v && t.v !== 'all' ? ' on' : ''}${t.hot && t.n > 0 ? ' hot' : ''}`}
              onClick={() => setParam('view', view === t.v ? 'all' : t.v)}
            >
              <div className="n">{t.n}</div>
              <div className="l">{t.l}</div>
            </button>
          ))}
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
      {projects && projects.length > 0 && (
        <div className="filters" style={{ margin: '18px 0 14px' }}>
          <div className="chips" role="group" aria-label="Show">
            {(Object.keys(VIEWS) as View[]).map((k) => (
              <button key={k} type="button" className={`chip${view === k ? ' on' : ''}`} aria-pressed={view === k} onClick={() => setParam('view', k)}>
                {VIEWS[k].label}
                {k === 'mine' && tiles[1].n > 0 && <span className="count">{tiles[1].n}</span>}
              </button>
            ))}
          </div>
          {usedTypes.length > 1 && (
            <select
              className="input"
              style={{ width: 'auto', marginLeft: 'auto' }}
              value={typeFilter}
              aria-label="Filter by drawing set type"
              onChange={(e) => setParam('type', e.target.value)}
            >
              <option value="">All set types</option>
              {usedTypes.map((k) => <option key={k} value={k}>{SET_TYPES[k]}</option>)}
            </select>
          )}
          {(typeFilter || view !== 'all') && <span className="hint">{shown.length} of {projects.length} projects</span>}
        </div>
      )}
      {projects && projects.length > 0 && shown.length === 0 && (
        <div className="empty"><p style={{ margin: 0 }}>{view === 'mine' ? 'Nothing is waiting on you right now.' : 'No projects match this filter.'}</p></div>
      )}
      {projects && projects.length > 0 && (
        <div className="pgrid">
          {shown.map((p) => (
            <Link key={p.id} to={`/projects/${p.id}`} className={`pcard${p.your_turn ? ' mine' : ''}`}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="mono" style={{ color: 'var(--faint)' }}>{p.number || 'No number'}</span>
                {p.latest_status && <span className="mono" style={{ color: 'var(--faint)' }}>Rev {p.latest_rev}</span>}
              </div>
              <div className="stagebox">
                <Pill kind={`sg-${p.stage}`}>{stageLabel(p)}</Pill>
                <WaitingOn p={p} />
              </div>
              <h3>{p.name}</h3>
              <div className="meta">{p.kind === 'modification' ? 'Modification' : 'Initial drawings'}{p.address ? ` · ${p.address}` : ''}</div>
              {p.set_types?.length > 0 && <div className="tagrow">{setTypeList(p.set_types).map((t) => <span key={t} className="tag">{t}</span>)}</div>}
              {seesNames && <div className="meta">PM: {p.pm_name || 'none'} · Drafter: {p.drafter_name || 'not assigned'}</div>}
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

type View = 'all' | 'mine' | 'review' | 'city' | 'delivered';
const VIEWS: Record<View, { label: string; test: (p: any) => boolean }> = {
  all: { label: 'All', test: () => true },
  mine: { label: 'Your turn', test: (p) => p.your_turn },
  review: { label: 'In review', test: (p) => ['review', 'final_record', 'stamp'].includes(p.stage) },
  city: { label: 'City revisions', test: (p) => p.stage === 'city' },
  delivered: { label: 'Delivered', test: (p) => p.stage === 'delivered' },
};

const ROLE: Record<string, string> = { pm: 'project manager', drafter: 'drafter', architect: 'architect', engineer: 'engineer' };

function stageLabel(p: any) {
  switch (p.stage) {
    case 'intake': return 'Intake';
    case 'review': return `Review round ${p.round}`;
    case 'final_record': return 'Awaiting final record';
    case 'stamp': return 'Awaiting stamp';
    case 'ready': return 'Stamped, ready for client';
    case 'delivered': return 'Delivered to client';
    case 'city': return `City revisions · round ${p.round}`;
    default: return 'Unknown';
  }
}

/** What the next move is, in plain words, for whoever it's waiting on. */
function nextStep(p: any) {
  if (!p.latest_status) return 'Start the intake';
  if (p.latest_status === 'intake') return 'Send the scope to the drafter';
  if (p.latest_status === 'sealed') return p.stage === 'city' ? 'Start the city round' : p.stage === 'ready' ? 'Send to the client' : '';
  return SET_STATUS[p.latest_status];
}

function WaitingOn({ p }: { p: any }) {
  if (!p.waiting_on) return <div className="waiting done">Nothing waiting</div>;
  const step = nextStep(p);
  if (p.your_turn) return <div className="waiting yours"><span className="turn">Your turn</span>{step}</div>;
  return <div className="waiting">Waiting on {ROLE[p.waiting_on]}{step ? <span className="step-l"> · {step}</span> : null}</div>;
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
