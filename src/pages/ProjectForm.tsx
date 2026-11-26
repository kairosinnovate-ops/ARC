import { useEffect, useState } from 'react';
import { api } from '../api';
import { useSession } from '../App';
import { PURPOSE, ROLE_LABEL, type Role } from '../ui';

export type Member = { user_id: string; name: string; email: string; role: Role };

const EMPTY = {
  name: '', number: '', address: '', jurisdiction: '', permit_number: '',
  kind: 'initial', requirements: '',
  pm_id: '', drafter_id: '', architect_id: '', engineer_id: '', engineer_name: '', engineer_email: '',
  purpose: 'permit', client_name: '', client_email: '',
};
export type ProjectFormValue = typeof EMPTY;

export function toForm(p: any | null, me: string): ProjectFormValue {
  if (!p) return { ...EMPTY, pm_id: me };
  const out: any = { ...EMPTY };
  for (const k of Object.keys(EMPTY)) out[k] = p[k] ?? '';
  if (!out.purpose) out.purpose = 'permit';
  return out;
}

/** Fields shared by "New project" and "Project details". */
export function ProjectFields({ f, setF }: { f: ProjectFormValue; setF: (f: ProjectFormValue) => void }) {
  const s = useSession();
  const [members, setMembers] = useState<Member[]>([]);
  useEffect(() => {
    api('/team').then((d) => setMembers(d.members)).catch(() => {});
  }, [s.firm.firm_id]);
  const set = (k: keyof ProjectFormValue) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF({ ...f, [k]: e.target.value });

  // People whose firm role matches come first; anyone on the team can still be picked.
  const pick = (k: keyof ProjectFormValue, role: Role, label: string, none: string) => {
    const sorted = [...members].sort((a, b) => Number(b.role === role) - Number(a.role === role) || a.name.localeCompare(b.name));
    return (
      <label className="field">
        <span>{label}</span>
        <select className="input" value={f[k]} onChange={set(k)}>
          <option value="">{none}</option>
          {sorted.map((m) => (
            <option key={m.user_id} value={m.user_id}>
              {m.name}{m.role !== role ? ` (${ROLE_LABEL[m.role]})` : ''}
            </option>
          ))}
        </select>
      </label>
    );
  };

  return (
    <div className="form-grid">
      <label className="field wide"><span>Project name</span><input className="input" value={f.name} onChange={set('name')} required autoFocus /></label>
      <div className="field wide">
        <span>Type of work</span>
        <div className="seg" role="radiogroup">
          {[['initial', 'Initial drawings'], ['modification', 'Modification']].map(([k, l]) => (
            <button type="button" key={k} className={f.kind === k ? 'on' : ''} role="radio" aria-checked={f.kind === k} onClick={() => setF({ ...f, kind: k })}>{l}</button>
          ))}
        </div>
      </div>
      <div className="field wide">
        <span>Set type</span>
        <div className="seg" role="radiogroup">
          {Object.entries(PURPOSE).map(([k, l]) => (
            <button type="button" key={k} className={f.purpose === k ? 'on' : ''} role="radio" aria-checked={f.purpose === k} onClick={() => setF({ ...f, purpose: k })}>{l}</button>
          ))}
        </div>
      </div>
      <label className="field wide">
        <span>Scope and requirements</span>
        <textarea className="input" value={f.requirements} onChange={set('requirements')} placeholder="Scope, standards, what to draw or change, due date…" />
      </label>
      {pick('pm_id', 'pm', 'Project manager', 'Choose a PM')}
      {pick('drafter_id', 'drafter', 'Drafter', 'Not assigned yet')}
      {pick('architect_id', 'architect', 'Architect', 'Not assigned yet')}
      {pick('engineer_id', 'engineer', 'Engineer (in Arc)', 'Not in Arc yet, email them')}
      {!f.engineer_id && (
        <>
          <label className="field"><span>Engineer name</span><input className="input" value={f.engineer_name} onChange={set('engineer_name')} /></label>
          <label className="field"><span>Engineer email</span><input className="input" type="email" value={f.engineer_email} onChange={set('engineer_email')} /></label>
        </>
      )}
      <label className="field"><span>Client name</span><input className="input" value={f.client_name} onChange={set('client_name')} /></label>
      <label className="field"><span>Client email</span><input className="input" type="email" value={f.client_email} onChange={set('client_email')} /></label>
      <label className="field"><span>Project number</span><input className="input" value={f.number} onChange={set('number')} placeholder="2026-014" /></label>
      <label className="field"><span>Permit number</span><input className="input" value={f.permit_number} onChange={set('permit_number')} /></label>
      <label className="field wide"><span>Site address</span><input className="input" value={f.address} onChange={set('address')} /></label>
      <label className="field wide"><span>Jurisdiction (city or county)</span><input className="input" value={f.jurisdiction} onChange={set('jurisdiction')} /></label>
    </div>
  );
}
