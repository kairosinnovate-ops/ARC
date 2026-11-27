import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export type Role = 'pm' | 'drafter' | 'architect' | 'engineer';
export const ROLE_LABEL: Record<Role, string> = { pm: 'Project manager', drafter: 'Drafter', architect: 'Architect', engineer: 'Engineer' };

export const SET_STATUS: Record<string, string> = {
  intake: 'Intake',
  draft: 'With drafter',
  pm_review: 'PM check',
  architect_review: 'Architect review',
  pm_rework: 'Rework with PM',
  final_record: 'Final record',
  engineer_review: 'Ready for stamp',
  sealed: 'Sealed',
};
export const SET_TYPES: Record<string, string> = {
  schematic: 'Schematic / Concept',
  zoning: 'Zoning / Land use',
  site_plan: 'Site plan',
  permit: 'Permit set',
  construction: 'Construction documents',
  certificate_of_occupancy: 'Certificate of Occupancy',
  as_built: 'As-built',
  existing_conditions: 'Existing conditions survey',
  demolition: 'Demolition',
  bid: 'Bid set',
  fire_life_safety: 'Fire / Life safety',
  variance: 'Variance / Special permit',
  other: 'Other',
};
export const setTypeList = (types: string[] | null | undefined) => (types || []).map((t) => SET_TYPES[t] || t);
const KIND_LABEL: Record<string, string> = { pdf: 'PDF', dwg: 'DWG', final_pdf: 'PDF', final_cad: 'CAD', sealed_pdf: 'SEALED', reference: 'REF', markup: 'MARKUP', other: 'FILE' };
export const kindLabel = (k: string) => KIND_LABEL[k] || k.toUpperCase();
export const COMMENT_STATUS: Record<string, string> = { open: 'Open', in_progress: 'In progress', addressed: 'Addressed' };

export function Pill({ kind, children }: { kind: string; children: ReactNode }) {
  return <span className={`pill ${kind}`}>{children}</span>;
}

const AV = ['#5a7baa', '#7a6aa8', '#3f8f7a', '#a8746a', '#6a8fa8', '#8a7d4f', '#9a5f86'];
export function Avatar({ name, size }: { name: string; size?: number }) {
  const initials = (name || '?')
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join('');
  let h = 0;
  for (const c of name || '') h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (
    <span className="av" style={{ background: AV[h % AV.length], ...(size ? { width: size, height: size } : {}) }} title={name}>
      {initials}
    </span>
  );
}

const paths: Record<string, string> = {
  projects: 'M3 7l9-4 9 4-9 4-9-4zm0 5l9 4 9-4M3 17l9 4 9-4',
  team: 'M16 19v-1a4 4 0 00-4-4H6a4 4 0 00-4 4v1M9 10a3 3 0 100-6 3 3 0 000 6zm13 9v-1a4 4 0 00-3-3.8M16 4.2a3 3 0 010 5.6',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zm10 3l-5-5',
  plus: 'M12 5v14M5 12h14',
  upload: 'M12 16V4m0 0l-4 4m4-4l4 4M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3',
  download: 'M12 4v12m0 0l-4-4m4 4l4-4M4 18v1a1 1 0 001 1h14a1 1 0 001-1v-1',
  out: 'M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 17l5-5-5-5M15 12H3',
  seal: 'M12 3l2.4 1.8 3-.2.9 2.9 2.4 1.8-.9 2.9.9 2.9-2.4 1.8-.9 2.9-3-.2L12 21l-2.4-1.8-3 .2-.9-2.9L3.3 14.7l.9-2.9-.9-2.9 2.4-1.8.9-2.9 3 .2L12 3zm-3 9l2 2 4-4',
  check: 'M5 12l5 5L20 7',
  back: 'M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3',
  trash: 'M4 7h16M9 7V4h6v3m-8 0l1 13h8l1-13',
  letter: 'M4 5h16v14H4zM4 6l8 7 8-7',
  lock: 'M6 11h12v9H6zM8 11V7a4 4 0 018 0v4',
  link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
  timeline: 'M3 12h18M6 9v6M12 9v6M18 9v6',
  file: 'M14 3H6a1 1 0 00-1 1v16a1 1 0 001 1h12a1 1 0 001-1V8l-5-5zm0 0v5h5',
};
export function Icon({ name, size = 16 }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name] || ''} />
    </svg>
  );
}

export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Only the topmost dialog closes on Escape.
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const all = document.querySelectorAll('.dialog');
      if (all[all.length - 1] === ref.current) onClose();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** A destructive step the person confirms by typing the project's name. */
export function ConfirmByName({ title, name, children, action, onClose, onConfirm }: {
  title: string; name: string; children: ReactNode; action: string; onClose: () => void; onConfirm: (typed: string) => Promise<void>;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ok = typed.trim().toLowerCase() === name.trim().toLowerCase();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    setErr('');
    try {
      await onConfirm(typed.trim());
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  }
  return (
    <Dialog title={title} onClose={onClose}>
      <form onSubmit={submit} className="col">
        <div className="hint" style={{ margin: 0 }}>{children}</div>
        <label className="field">
          <span>Type <b>{name}</b> to confirm</span>
          <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" aria-label="Confirm project name" />
        </label>
        {err && <p className="err">{err}</p>}
        <div className="foot">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary danger-fill" disabled={!ok || busy}>{busy ? 'Working…' : action}</button>
        </div>
      </form>
    </Dialog>
  );
}

type Toast = { text: string; bad?: boolean } | null;
const ToastCtx = createContext<(text: string, bad?: boolean) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<Toast>(null);
  const timer = useRef<number>();
  const show = useCallback((text: string, bad?: boolean) => {
    setT({ text, bad });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setT(null), bad ? 6000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && (
        <div className={`toast${t.bad ? ' bad' : ''}`} role="status">
          {t.text}
        </div>
      )}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

export function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
export function fmtDate(iso: string | null | undefined) {
  if (!iso) return '';
  const d = iso.length === 10 ? new Date(iso + 'T12:00:00') : new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const EVENT_TEXT: Record<string, string> = {
  project_created: 'created the project',
  intake_started: 'started intake',
  final_uploaded: 'added to the final record:',
  final_submitted: 'turned in the final PDF and CAD. Ready for stamp',
  client_link_sent: 'sent the stamped set to',
  client_opened: 'opened the stamped set',
  set_created: 'started',
  file_uploaded: 'uploaded',
  file_removed: 'removed',
  sent_to_drafter: 'sent the revision to the drafter',
  drafter_assigned: 'changed the drafter',
  submitted: 'submitted the drawings to the PM',
  pm_approved: 'checked the set and sent it to the architect',
  pm_returned: 'sent the set back to the drafter',
  architect_approved: 'approved the set. The drafter turns in the final PDF and CAD next',
  architect_returned: 'sent markups back to the PM',
  engineer_returned: 'sent the set back to the PM',
  markup_uploaded: 'added a markup',
  stamp_link_sent: 'sent the stamp link to',
  sealed_uploaded: 'uploaded the sealed set',
  sealed: 'sealed and locked the set',
  comment_added: 'logged city comment',
  letter_imported: 'imported a correction letter:',
  comment_open: 'reopened comment',
  comment_in_progress: 'started on comment',
  comment_addressed: 'addressed comment',
  comment_deleted: 'deleted comment',
  project_deleted: 'moved the project to Trash',
  project_restored: 'restored the project from Trash',
  note_added: 'left a note',
  milestone_done: 'marked a permit step done:',
  milestone_reopened: 'reopened a permit step:',
  share_link_created: 'shared a read-only link to',
  share_opened: 'opened the shared link',
  resubmittal_letter: 'generated the resubmittal letter for',
  review_note: 'left a reviewer note',
};
export function eventText(action: string) {
  return EVENT_TEXT[action] || action.replace(/_/g, ' ');
}
export const NOTE_EVENTS = new Set(['intake_started', 'sent_to_drafter', 'submitted', 'pm_approved', 'pm_returned', 'architect_approved', 'architect_returned', 'engineer_returned', 'sealed', 'note_added', 'review_note']);
