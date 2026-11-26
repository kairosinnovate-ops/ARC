import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { auth, type SessionUser } from './auth';
import { api, setFirm } from './api';
import { Avatar, Icon, ROLE_LABEL, ToastProvider, type Role } from './ui';
import ProjectsPage from './pages/Projects';
import ProjectPage from './pages/Project';
import SetPage from './pages/RevisionSet';
import TeamPage from './pages/Team';
import TrashPage from './pages/Trash';
import DeliveryPage from './pages/Delivery';
import StampPage from './pages/Stamp';

export type Firm = { firm_id: string; firm_name: string; role: Role; is_admin: boolean };
type Session = {
  user: SessionUser;
  firm: Firm;
  firms: Firm[];
  reload: () => Promise<void>;
  switchFirm: (id: string) => void;
  crumbs: ReactNode;
  setCrumbs: (n: ReactNode) => void;
};
const SessionCtx = createContext<Session>(null as any);
export const useSession = () => useContext(SessionCtx);

const FIRM_KEY = 'arc-firm';
function savedFirm() {
  try {
    return localStorage.getItem(FIRM_KEY) || '';
  } catch {
    return '';
  }
}

export default function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/stamp/:token" element={<StampPage />} />
          <Route path="/d/:token" element={<DeliveryPage />} />
          <Route path="*" element={<Boot />} />
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  );
}

function Boot() {
  const [state, setState] = useState<'loading' | 'out' | 'nofirm' | 'in' | 'error'>('loading');
  const [user, setUser] = useState<SessionUser | null>(null);
  const [firms, setFirms] = useState<Firm[]>([]);
  const [firmId, setFirmId] = useState(savedFirm());
  const [crumbs, setCrumbs] = useState<ReactNode>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const u = await auth.current();
      if (!u) return setState('out');
      const me = await api<{ user: SessionUser; firms: Firm[] }>('/me');
      setUser(me.user);
      setFirms(me.firms);
      setState(me.firms.length ? 'in' : 'nofirm');
    } catch (e: any) {
      if (e.status === 401) return setState('out');
      setError(e.message);
      setState('error');
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const firm = firms.find((f) => f.firm_id === firmId) || firms[0];
  setFirm(firm?.firm_id || '');

  const session = useMemo<Session | null>(
    () =>
      user && firm
        ? {
            user,
            firm,
            firms,
            reload: load,
            switchFirm: (id) => {
              try {
                localStorage.setItem(FIRM_KEY, id);
              } catch {}
              setFirmId(id);
            },
            crumbs,
            setCrumbs,
          }
        : null,
    [user, firm, firms, load, crumbs],
  );

  if (state === 'loading') return <div className="auth"><div className="hint">Loading…</div></div>;
  if (state === 'error')
    return (
      <div className="auth">
        <div className="card col">
          <h1>Can't reach Arc</h1>
          <p className="err">{error}</p>
          <button className="btn primary" onClick={() => { setState('loading'); load(); }}>Try again</button>
        </div>
      </div>
    );
  if (state === 'out') return <SignIn onDone={() => { setState('loading'); load(); }} />;
  if (state === 'nofirm' || !session) return <CreateFirm user={user!} onDone={load} />;
  return (
    <SessionCtx.Provider value={session}>
      <Shell />
    </SessionCtx.Provider>
  );
}

function SignIn({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const dev = import.meta.env.VITE_DEV_AUTH === '1';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    const r = mode === 'in' ? await auth.signIn(email, password) : await auth.signUp(name || email.split('@')[0], email, password);
    setBusy(false);
    if (r.error) return setErr(r.error);
    onDone();
  }

  return (
    <div className="auth">
      <form className="card col" onSubmit={submit} style={{ gap: 16 }}>
        <div className="row" style={{ gap: 10 }}>
          <span className="logo" style={{ margin: 0 }}>A</span>
          <span className="label">Arc permit workspace</span>
        </div>
        <div>
          <h1>{mode === 'in' ? 'Sign in' : 'Create your account'}</h1>
          <p className="hint" style={{ marginTop: 6 }}>
            {mode === 'in'
              ? 'Use the email your firm invited.'
              : 'If your firm invited you, use that same email and you will join automatically.'}
          </p>
        </div>
        {mode === 'up' && (
          <label className="field">
            <span>Full name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
          </label>
        )}
        <label className="field">
          <span>Email</span>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            minLength={dev ? 0 : 8}
            required={!dev}
          />
        </label>
        {err && <div className="err">{err}</div>}
        <button className="btn primary" disabled={busy} style={{ justifyContent: 'center', padding: '9px 13px' }}>
          {busy ? 'One moment…' : mode === 'in' ? 'Sign in' : 'Create account'}
        </button>
        <div className="hint" style={{ textAlign: 'center' }}>
          {mode === 'in' ? 'New here? ' : 'Already have an account? '}
          <button type="button" className="link" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setErr(''); }}>
            {mode === 'in' ? 'Create an account' : 'Sign in'}
          </button>
        </div>
        {dev && <div className="hint" style={{ textAlign: 'center' }}>Local mode: any email signs in.</div>}
      </form>
      <SheetTag />
    </div>
  );
}

function CreateFirm({ user, onDone }: { user: SessionUser; onDone: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('pm');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/firms', { body: { name, role } });
      await onDone();
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  }
  return (
    <div className="auth">
      <form className="card col" onSubmit={submit} style={{ gap: 16 }}>
        <div>
          <span className="label">Welcome, {user.name}</span>
          <h1 style={{ marginTop: 8 }}>Set up your firm</h1>
          <p className="hint" style={{ marginTop: 6 }}>
            You will be the firm admin. You can invite your drafters, architects and engineers next. If someone invited you, ask them to
            check the email on the invite matches {user.email}.
          </p>
        </div>
        <label className="field">
          <span>Firm name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Mastan Group" required />
        </label>
        <div className="field">
          <span>Your role in the review chain</span>
          <div className="seg" role="radiogroup">
            {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
              <button type="button" key={r} className={role === r ? 'on' : ''} onClick={() => setRole(r)} role="radio" aria-checked={role === r}>
                {ROLE_LABEL[r]}
              </button>
            ))}
          </div>
        </div>
        {err && <div className="err">{err}</div>}
        <button className="btn primary" disabled={busy} style={{ justifyContent: 'center' }}>
          {busy ? 'Creating…' : 'Create firm'}
        </button>
        <button type="button" className="btn ghost" onClick={async () => { await auth.signOut(); location.reload(); }}>
          Sign out
        </button>
      </form>
      <SheetTag />
    </div>
  );
}

/** A title-block corner, like the bottom right of a drawing sheet. */
function SheetTag() {
  return (
    <div className="sheet-tag" aria-hidden="true">
      <span>Arc</span>
      <span>Permit workspace</span>
      <span>Sheet A-0</span>
    </div>
  );
}

function Shell() {
  const s = useSession();
  const [ck, setCk] = useState(false);
  const loc = useLocation();

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCk((v) => !v);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  useEffect(() => setCk(false), [loc.pathname]);

  const isMac = navigator.platform.toLowerCase().includes('mac');
  return (
    <div className="app">
      <nav className="rail" aria-label="Main">
        <Link to="/" className="logo" aria-label="Arc home">A</Link>
        <NavLink to="/" end className={({ isActive }) => `rb${isActive || loc.pathname.startsWith('/projects') || loc.pathname.startsWith('/sets') ? ' on' : ''}`} data-tip="Projects" aria-label="Projects">
          <Icon name="projects" size={19} />
        </NavLink>
        <NavLink to="/team" className={({ isActive }) => `rb${isActive ? ' on' : ''}`} data-tip="Team" aria-label="Team">
          <Icon name="team" size={19} />
        </NavLink>
        <button className="rb" data-tip="Search (⌘K)" aria-label="Search" onClick={() => setCk(true)}>
          <Icon name="search" size={19} />
        </button>
        <div className="grow" />
        <button className="rb" data-tip="Sign out" aria-label="Sign out" onClick={async () => { await auth.signOut(); location.href = '/'; }}>
          <Icon name="out" size={18} />
        </button>
      </nav>
      <div className="main">
        <header className="top">
          <div className="crumb">
            <span className="pj"><i />{s.firm.firm_name}</span>
            {s.crumbs}
          </div>
          <div className="ckwrap">
            <button className="ckbtn" onClick={() => setCk(true)}>
              <Icon name="search" size={15} />
              <span>Jump to a project, set or page</span>
              <kbd>{isMac ? '⌘' : 'Ctrl'} K</kbd>
            </button>
          </div>
          <div className="as">
            <span className="hint">{ROLE_LABEL[s.firm.role]}{s.firm.is_admin ? ' · Admin' : ''}</span>
            <Avatar name={s.user.name} />
          </div>
        </header>
        <Routes>
          <Route path="/" element={<ProjectsPage />} />
          <Route path="/projects/:id" element={<ProjectPage />} />
          <Route path="/sets/:id" element={<SetPage />} />
          <Route path="/team" element={<TeamPage />} />
          <Route path="/trash" element={<TrashPage />} />
          <Route path="*" element={<div className="content"><h1>Page not found</h1><Link className="link" to="/">Back to projects</Link></div>} />
        </Routes>
      </div>
      {ck && <CommandBar onClose={() => setCk(false)} />}
    </div>
  );
}

type Cmd = { label: string; group: string; go: () => void };
function CommandBar({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const s = useSession();
  const [q, setQ] = useState('');
  const [projects, setProjects] = useState<any[]>([]);
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    let live = true;
    api<any[]>('/projects').then((ps) => live && setProjects(ps)).catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const items = useMemo<Cmd[]>(() => {
    const base: Cmd[] = [
      { label: 'All projects', group: 'Go to', go: () => nav('/') },
      { label: 'Team and invites', group: 'Go to', go: () => nav('/team') },
      { label: 'New project', group: 'Action', go: () => nav('/?new=1') },
    ];
    s.firms
      .filter((f) => f.firm_id !== s.firm.firm_id)
      .forEach((f) => base.push({ label: `Switch to ${f.firm_name}`, group: 'Firm', go: () => { s.switchFirm(f.firm_id); nav('/'); } }));
    for (const p of projects) {
      base.push({ label: `${p.number ? p.number + ' · ' : ''}${p.name}`, group: 'Project', go: () => nav(`/projects/${p.id}`) });
      if (p.latest_set_id) base.push({ label: `${p.name}: Rev ${p.latest_rev}`, group: 'Revision set', go: () => nav(`/sets/${p.latest_set_id}`) });
    }
    return base;
  }, [projects, s.firms, s.firm.firm_id]);

  const shown = items.filter((c) => c.label.toLowerCase().includes(q.toLowerCase())).slice(0, 12);
  useEffect(() => setI(0), [q]);

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ck" role="dialog" aria-label="Command bar">
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Type a project, a set or a page"
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') { e.preventDefault(); setI((v) => Math.min(v + 1, shown.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setI((v) => Math.max(v - 1, 0)); }
            if (e.key === 'Enter' && shown[i]) { shown[i].go(); onClose(); }
          }}
        />
        <ul>
          {shown.map((c, n) => (
            <li key={c.group + c.label + n}>
              <button className={n === i ? 'on' : ''} onMouseEnter={() => setI(n)} onClick={() => { c.go(); onClose(); }}>
                <span>{c.label}</span>
                <span className="g">{c.group}</span>
              </button>
            </li>
          ))}
          {!shown.length && <li className="hint" style={{ padding: 12 }}>Nothing matches.</li>}
        </ul>
      </div>
    </div>
  );
}
