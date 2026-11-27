import { useState } from 'react';
import { api } from '../api';
import { Dialog, Icon, fmtDate, useToast } from '../ui';

export type Milestone = { id?: string; kind: string; label: string; target_on: string | null; done_on: string | null; note?: string };

/** Today in the viewer's own time zone, as YYYY-MM-DD. */
export const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const days = (from: string, to: string) => Math.round((Date.parse(to + 'T12:00:00') - Date.parse(from + 'T12:00:00')) / 86400000);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Where the permit is: the first step not done yet, how long it has been there, and the whole run so far. */
export function timelineSummary(ms: Milestone[]) {
  const today = localToday();
  const current = ms.find((m) => !m.done_on) || null;
  const lastDone = [...ms].reverse().find((m) => m.done_on) || null;
  const first = ms.find((m) => m.done_on) || null;
  const approved = ms.find((m) => m.kind === 'approved' && m.done_on);
  if (!first) return { current, text: 'Not submitted to the city yet.' };
  if (!current || approved) {
    const end = (approved || lastDone)!.done_on!;
    return { current: null, text: `Approved ${fmtDate(end)}, ${plural(days(first.done_on!, end), 'day')} after submittal.` };
  }
  const since = lastDone?.done_on ? days(lastDone.done_on, today) : 0;
  const total = days(first.done_on!, today);
  const late = current.target_on && current.target_on < today;
  return {
    current,
    text: `Waiting on "${current.label}" for ${plural(Math.max(0, since), 'day')}. ${plural(Math.max(0, total), 'day')} since submittal.${late ? ` Target was ${fmtDate(current.target_on)}.` : ''}`,
  };
}

/**
 * The permit's path through the city, left to right: submitted, under review, comments, resubmitted, approved
 * (plus any steps the PM adds). Done steps are green, the current one is lit, late targets are amber.
 * Read-only unless the PM passes projectId and onChange.
 */
export function PermitTimeline({ milestones, projectId, onChange }: { milestones: Milestone[]; projectId?: string; onChange?: (ms: Milestone[]) => void }) {
  const toast = useToast();
  const [edit, setEdit] = useState<Milestone | null>(null);
  const [adding, setAdding] = useState(false);
  const editable = !!(projectId && onChange);
  const today = localToday();
  const { current, text } = timelineSummary(milestones);

  async function markDone(m: Milestone) {
    try {
      const r = await api(`/milestones/${m.id}`, { method: 'PATCH', body: { done_on: localToday() } });
      onChange?.(r.milestones);
      toast(`${m.label}: marked done.`);
    } catch (e: any) {
      toast(e.message, true);
    }
  }

  return (
    <div className="ptl-wrap">
      <div className="ptl-sum">
        <span className="hint" style={{ margin: 0 }}>{text}</span>
        {editable && (
          <div className="row" style={{ gap: 8 }}>
            {current && <button className="btn sm primary" onClick={() => markDone(current)}><Icon name="check" size={14} /> Mark “{current.label}” done</button>}
            <button className="btn sm" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Add step</button>
          </div>
        )}
      </div>
      <ol className="ptl" style={{ ['--n' as any]: milestones.length }}>
        {milestones.map((m, i) => {
          const state = m.done_on ? 'done' : m === current ? 'now' : 'next';
          const late = !m.done_on && m.target_on && m.target_on < today;
          const body = (
            <>
              <span className="dot" aria-hidden="true">{m.done_on ? <Icon name="check" size={13} /> : <span>{i + 1}</span>}</span>
              <span className="lbl">{m.label}</span>
              <span className={`when${late ? ' late' : ''}`}>
                {m.done_on ? fmtDate(m.done_on) : m.target_on ? `${late ? 'Was due' : 'Target'} ${fmtDate(m.target_on)}` : editable ? 'Set a date' : 'No date yet'}
              </span>
            </>
          );
          return (
            <li key={m.id || i} className={`${state}${late ? ' late' : ''}`} aria-current={state === 'now' ? 'step' : undefined}>
              {editable ? (
                <button className="ptl-step" onClick={() => setEdit(m)} aria-label={`Edit ${m.label}`}>{body}</button>
              ) : (
                <div className="ptl-step">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
      {edit && projectId && <MilestoneForm m={edit} projectId={projectId} onClose={() => setEdit(null)} onSaved={(ms) => { setEdit(null); onChange?.(ms); }} />}
      {adding && projectId && <MilestoneForm projectId={projectId} onClose={() => setAdding(false)} onSaved={(ms) => { setAdding(false); onChange?.(ms); }} />}
    </div>
  );
}

function MilestoneForm({ m, projectId, onClose, onSaved }: { m?: Milestone; projectId: string; onClose: () => void; onSaved: (ms: Milestone[]) => void }) {
  const [label, setLabel] = useState(m?.label ?? '');
  const [target, setTarget] = useState(m?.target_on ?? '');
  const [done, setDone] = useState(!!m?.done_on);
  const [doneOn, setDoneOn] = useState(m?.done_on ?? localToday());
  const [note, setNote] = useState(m?.note ?? '');
  const [err, setErr] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const r = m
        ? await api(`/milestones/${m.id}`, { method: 'PATCH', body: { label, target_on: target || null, done_on: done ? doneOn : null, note } })
        : await api(`/projects/${projectId}/milestones`, { body: { label, target_on: target || null } });
      onSaved(r.milestones);
    } catch (e: any) {
      setErr(e.message);
    }
  }
  async function remove() {
    try {
      const r = await api(`/milestones/${m!.id}`, { method: 'DELETE' });
      onSaved(r.milestones);
    } catch (e: any) {
      setErr(e.message);
    }
  }
  return (
    <Dialog title={m ? m.label : 'Add a permit step'} onClose={onClose}>
      <form onSubmit={submit} className="col">
        {!m && <p className="hint" style={{ margin: 0 }}>For example a second comment round, a zoning hearing or a fire review. It goes before “Approved”.</p>}
        <label className="field"><span>Step</span><input className="input" value={label} onChange={(e) => setLabel(e.target.value)} required autoFocus={!m} placeholder="Comments received (round 2)" /></label>
        <label className="field"><span>Target date</span><input className="input" type="date" value={target} onChange={(e) => setTarget(e.target.value)} /></label>
        {m && (
          <>
            <label className="check">
              <input type="checkbox" checked={done} onChange={(e) => setDone(e.target.checked)} /> This step is done
            </label>
            {done && <label className="field"><span>Done on</span><input className="input" type="date" value={doneOn} onChange={(e) => setDoneOn(e.target.value)} required /></label>}
            <label className="field"><span>Note (team only)</span><textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reviewer, permit portal reference, what the city said…" /></label>
          </>
        )}
        {err && <p className="err">{err}</p>}
        <div className="foot" style={{ justifyContent: 'space-between' }}>
          <div>{m && <button type="button" className="btn danger" onClick={remove}><Icon name="trash" size={14} /> Remove step</button>}</div>
          <div className="row">
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary">{m ? 'Save' : 'Add step'}</button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
