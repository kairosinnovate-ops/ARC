import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useSession } from '../App';
import { Avatar, Icon, ROLE_LABEL, fmtDate, useToast, type Role } from '../ui';

export default function TeamPage() {
  const s = useSession();
  const toast = useToast();
  const [d, setD] = useState<{ members: any[]; invites: any[]; limited?: boolean } | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('drafter');
  const [admin, setAdmin] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(() => api('/team').then(setD).catch((e) => setErr(e.message)), []);
  useEffect(() => {
    s.setCrumbs(<><span className="sep">/</span><b>Team</b></>);
    load();
  }, [s.firm.firm_id]);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    try {
      await api('/team/invites', { body: { email, role, is_admin: admin } });
      toast(`Invite saved. Ask ${email} to create an account at ${location.host} with that email.`);
      setEmail('');
      setAdmin(false);
      load();
    } catch (e: any) {
      setErr(e.message);
    }
  }
  async function patch(userId: string, body: any) {
    try {
      await api(`/team/members/${encodeURIComponent(userId)}`, { method: 'PATCH', body });
      await load();
      if (userId === s.user.id) await s.reload();
    } catch (e: any) {
      toast(e.message, true);
    }
  }
  async function remove(userId: string, name: string) {
    if (!window.confirm(`Remove ${name} from ${s.firm.firm_name}?`)) return;
    try {
      await api(`/team/members/${encodeURIComponent(userId)}`, { method: 'DELETE' });
      load();
    } catch (e: any) {
      toast(e.message, true);
    }
  }
  async function cancel(id: string) {
    await api(`/team/invites/${id}`, { method: 'DELETE' }).catch((e) => toast(e.message, true));
    load();
  }

  return (
    <main className="content">
      <div className="page-h">
        <div>
          <span className="label">{s.firm.firm_name}</span>
          <h1 style={{ marginTop: 8 }}>Team</h1>
          <p className="hint">
            {d?.limited
              ? "For privacy, only project managers and admins see who's on the team. You see yourself, and each project shows the stage it's at."
              : "Each person's role here is their usual job. Who does what on a project is set on each project's page. Only PMs and admins see every project and the whole team. Everyone else sees the projects they're on and the PM."}
          </p>
        </div>
      </div>
      <div className="grid2">
        <section className="card">
          <h2>People</h2>
          {!d ? (
            <div className="hint">Loading…</div>
          ) : (
            <div className="queue">
              {d.members.map((m) => (
                <div key={m.user_id} className="qi">
                  <div className="row" style={{ minWidth: 0, flexWrap: 'nowrap' }}>
                    <Avatar name={m.name} />
                    <div className="s">
                      <div className="t">{m.name}{m.user_id === s.user.id ? ' (you)' : ''}</div>
                      <div className="sub">{m.email}{m.is_admin ? ' · Admin' : ''}</div>
                    </div>
                  </div>
                  {s.firm.is_admin ? (
                    <div className="row" style={{ gap: 8 }}>
                      <select className="input" style={{ width: 'auto' }} value={m.role} onChange={(e) => patch(m.user_id, { role: e.target.value })} aria-label={`Role for ${m.name}`}>
                        {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </select>
                      <label className="hint row" style={{ gap: 4 }}>
                        <input type="checkbox" checked={m.is_admin} onChange={(e) => patch(m.user_id, { is_admin: e.target.checked })} /> Admin
                      </label>
                      {m.user_id !== s.user.id && (
                        <button className="btn ghost sm" aria-label={`Remove ${m.name}`} onClick={() => remove(m.user_id, m.name)}><Icon name="trash" size={14} /></button>
                      )}
                    </div>
                  ) : (
                    <span className="hint">{ROLE_LABEL[m.role as Role]}</span>
                  )}
                </div>
              ))}
            </div>
          )}
          {d && d.invites.length > 0 && (
            <>
              <h2 style={{ marginTop: 22 }}>Waiting to join</h2>
              <div className="queue">
                {d.invites.map((i) => (
                  <div key={i.id} className="qi">
                    <div className="s">
                      <div className="t">{i.email}</div>
                      <div className="sub">{ROLE_LABEL[i.role as Role]}{i.is_admin ? ' · Admin' : ''} · invited {fmtDate(i.created_at)}</div>
                    </div>
                    {s.firm.is_admin && <button className="btn sm" onClick={() => cancel(i.id)}>Cancel</button>}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
        {s.firm.is_admin && (
          <section className="card">
            <h2>Invite someone</h2>
            <form className="col" onSubmit={invite}>
              <label className="field"><span>Email</span><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
              <div className="field">
                <span>Role</span>
                <div className="seg">
                  {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
                    <button type="button" key={r} className={role === r ? 'on' : ''} onClick={() => setRole(r)}>{ROLE_LABEL[r]}</button>
                  ))}
                </div>
              </div>
              <label className="hint row" style={{ gap: 6 }}>
                <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} /> Can manage the team
              </label>
              {err && <div className="err">{err}</div>}
              <div><button className="btn primary">Save invite</button></div>
              <p className="hint" style={{ margin: 0 }}>
                Arc doesn't send emails yet. Send them the link {location.origin} and ask them to create an account with this email. They join
                {' '}{s.firm.firm_name} as soon as they sign in.
              </p>
            </form>
          </section>
        )}
      </div>
    </main>
  );
}
