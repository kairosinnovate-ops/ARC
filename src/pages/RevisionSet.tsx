import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, download, uploadFile } from '../api';
import { useSession } from '../App';
import { Avatar, Icon, NOTE_EVENTS, Pill, ROLE_LABEL, SET_STATUS, eventText, fmtBytes, fmtDate, timeAgo, useToast } from '../ui';

type Data = { set: any; project: any; files: any[]; events: any[]; comments: any[] };
type Pending = { name: string; pct: number; error?: string };

const SHEET_RE = /\b([A-Z]{1,2}-?\d{1,3}(?:\.\d{1,2})?[A-Z]?)\b/;
const guessSheet = (filename: string) => filename.replace(/\.[^.]+$/, '').toUpperCase().replace(/_/g, ' ').match(SHEET_RE)?.[1] || '';
const kindOf = (filename: string) => {
  const ext = filename.toLowerCase().split('.').pop();
  return ext === 'pdf' ? 'pdf' : ext === 'dwg' ? 'dwg' : 'other';
};

export default function SetPage() {
  const { id } = useParams();
  const s = useSession();
  const toast = useToast();
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api<Data>(`/sets/${id}`).then(setD).catch((e) => setErr(e.message)), [id]);
  useEffect(() => {
    load();
  }, [load, s.firm.firm_id]);
  useEffect(() => {
    if (d)
      s.setCrumbs(
        <>
          <span className="sep">/</span>
          <Link to={`/projects/${d.project.id}`} className="hint">{d.project.name}</Link>
          <span className="sep">/</span>
          <b>Rev {d.set.rev_number}</b>
        </>,
      );
  }, [d?.set.id, d?.project.name]);

  const drawings = useMemo(() => (d?.files || []).filter((f) => f.kind !== 'sealed_pdf'), [d]);
  const sealedFiles = useMemo(() => (d?.files || []).filter((f) => f.kind === 'sealed_pdf'), [d]);
  const sheets = useMemo(() => {
    const map = new Map<string, { pdf: any[]; dwg: any[]; other: any[] }>();
    for (const f of drawings) {
      const k = f.sheet || '';
      if (!map.has(k)) map.set(k, { pdf: [], dwg: [], other: [] });
      map.get(k)![f.kind as 'pdf' | 'dwg' | 'other'].push(f);
    }
    return [...map.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, undefined, { numeric: true })));
  }, [drawings]);

  if (err) return <main className="content"><p className="err">{err}</p><Link className="link" to="/">Back to projects</Link></main>;
  if (!d) return <main className="content"><div className="hint">Loading…</div></main>;
  const { set } = d;
  const role = s.firm.role;
  const editable = ['draft', 'returned'].includes(set.status);

  async function upload(list: FileList | File[], kind?: string) {
    const arr = [...list];
    setPending(arr.map((f) => ({ name: f.name, pct: 0 })));
    let failed = 0;
    for (let i = 0; i < arr.length; i++) {
      const f = arr[i];
      try {
        await uploadFile(set.id, f, { kind: kind || kindOf(f.name), sheet: kind === 'sealed_pdf' ? '' : guessSheet(f.name) }, (pct) =>
          setPending((p) => p.map((x, n) => (n === i ? { ...x, pct } : x))),
        );
        setPending((p) => p.map((x, n) => (n === i ? { ...x, pct: 100 } : x)));
      } catch (e: any) {
        failed++;
        setPending((p) => p.map((x, n) => (n === i ? { ...x, error: e.message } : x)));
      }
    }
    await load();
    if (!failed) {
      setPending([]);
      toast(`Uploaded ${arr.length} file${arr.length === 1 ? '' : 's'}.`);
    }
  }

  async function act(action: string) {
    setBusy(true);
    try {
      await api(`/sets/${set.id}/action`, { body: { action, note } });
      setNote('');
      await load();
      toast(
        {
          submit: 'Sent to the architect for review.',
          approve: 'Approved and sent to the engineer.',
          return: 'Returned for changes.',
          seal: 'Sealed. This set is now locked.',
        }[action] || 'Done.',
      );
    } catch (e: any) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function removeFile(f: any) {
    try {
      await api(`/files/${f.id}`, { method: 'DELETE' });
      await load();
    } catch (e: any) {
      toast(e.message, true);
    }
  }
  const order = ['draft', 'architect_review', 'engineer_review', 'sealed'];
  const at = set.status === 'returned' ? 0 : order.indexOf(set.status);
  const lastReturn = d.events.find((e) => e.action === 'returned');

  return (
    <main className="content">
      <div className="page-h">
        <div>
          <span className="label">{d.project.name}</span>
          <h1 style={{ marginTop: 8 }}>Rev {set.rev_number}{set.title ? ` · ${set.title}` : ''}</h1>
          <p className="hint">
            {set.status === 'sealed'
              ? `Sealed ${fmtDate(set.sealed_at)}. The drawings and their fingerprints are locked.`
              : 'Upload each sheet as a PDF with its DWG source. Name files with the sheet number, like A-101.pdf and A-101.dwg, so they pair up.'}
          </p>
        </div>
        <Pill kind={`st-${set.status}`}>{SET_STATUS[set.status]}</Pill>
      </div>

      <section className="card">
        <div className="chain">
          {[
            ['Drafting', 'Drafter uploads PDF and DWG'],
            ['Architect review', 'Approve or return'],
            ['Engineer seal', 'Upload the sealed PDF'],
            ['Sealed', 'Locked to its CAD source'],
          ].map(([t, sub], n) => (
            <div
              key={t}
              className={`step ${set.status === 'sealed' && n === 3 ? 'sealed' : n < at || (set.status === 'sealed' && n < 3) ? 'done' : n === at ? (set.status === 'returned' ? 'back' : 'now') : ''}`}
            >
              <div className="dot" />
              <div className="t">{t}</div>
              <div className="d">{n === 0 && set.status === 'returned' ? 'Returned for changes' : sub}</div>
            </div>
          ))}
        </div>
      </section>

      <ActionBox set={set} role={role} isAdmin={s.firm.is_admin} drawings={drawings} sealedFiles={sealedFiles} note={note} setNote={setNote} busy={busy} act={act} upload={upload} lastReturn={lastReturn} />

      <div className="grid2">
        <section className="card">
          <div className="card-h">
            <h2>Sheets</h2>
            <span className="hint">{drawings.filter((f) => f.kind === 'pdf').length} PDF · {drawings.filter((f) => f.kind === 'dwg').length} DWG</span>
          </div>
          {editable && <DropZone onFiles={(fl) => upload(fl)} label="Drop PDF and DWG files here, or" accept=".pdf,.dwg,.dxf" />}
          {pending.length > 0 && <Progress items={pending} onClear={() => setPending([])} />}
          {sheets.length === 0 ? (
            <div className="empty" style={{ marginTop: editable ? 14 : 0 }}>No drawings uploaded yet.</div>
          ) : (
            <table className="ftable" style={{ marginTop: 14 }}>
              <thead>
                <tr><th>Sheet</th><th>PDF</th><th>DWG source</th></tr>
              </thead>
              <tbody>
                {sheets.map(([sheet, g]) => (
                  <tr key={sheet || 'none'}>
                    <td className="mono" style={{ whiteSpace: 'nowrap' }}>{sheet || <span className="hint">No sheet no.</span>}</td>
                    <td><FileCells files={[...g.pdf, ...g.other]} editable={editable} onRemove={removeFile} missing="No PDF" /></td>
                    <td><FileCells files={g.dwg} editable={editable} onRemove={removeFile} missing={sheet ? 'Missing DWG' : ''} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {sealedFiles.length > 0 && (
            <>
              <h2 style={{ marginTop: 22 }}>Sealed set</h2>
              <FileCells files={sealedFiles} editable={set.status === 'engineer_review' && role === 'engineer'} onRemove={removeFile} missing="" />
            </>
          )}
        </section>
        <section className="card">
          <h2>History</h2>
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
    </main>
  );
}

function ActionBox(props: {
  set: any; role: string; isAdmin: boolean; drawings: any[]; sealedFiles: any[]; note: string; setNote: (s: string) => void;
  busy: boolean; act: (a: string) => void; upload: (f: FileList | File[], kind?: string) => void; lastReturn: any;
}) {
  const { set, role, isAdmin, drawings, sealedFiles, note, setNote, busy, act, upload, lastReturn } = props;
  const needs: Record<string, string> = { draft: 'drafter', returned: 'drafter', architect_review: 'architect', engineer_review: 'engineer' };
  const who = needs[set.status];
  const pdfs = drawings.filter((f) => f.kind === 'pdf').length;

  if (set.status === 'sealed')
    return (
      <section className="card sealbox row" style={{ justifyContent: 'space-between' }}>
        <div className="row"><Icon name="seal" size={22} /><div><b>Sealed and locked.</b> <span className="hint">Start the next revision from the project page when the city responds.</span></div></div>
      </section>
    );

  if (role !== who)
    return (
      <section className="card row" style={{ justifyContent: 'space-between' }}>
        <div>
          <b>Waiting on the {ROLE_LABEL[who as 'drafter']?.toLowerCase()}.</b>{' '}
          <span className="hint">{set.status === 'returned' && lastReturn?.note ? `Returned: “${lastReturn.note}”` : 'You will see actions here when it is your step.'}</span>
        </div>
        {isAdmin && <span className="hint">As an admin you can switch roles in the top bar.</span>}
      </section>
    );

  if (who === 'drafter')
    return (
      <section className="card actionbox col">
        {set.status === 'returned' && lastReturn?.note && (
          <div><span className="label">Returned by {lastReturn.actor_name}</span><div style={{ marginTop: 6 }}>“{lastReturn.note}”</div></div>
        )}
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="hint">{pdfs ? `${pdfs} PDF sheet${pdfs === 1 ? '' : 's'} ready.` : 'Upload at least one PDF sheet to submit.'} Submitting locks the drawings while they are reviewed.</div>
        </div>
        <textarea className="input" style={{ minHeight: 60 }} placeholder="Note for the architect (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="row"><button className="btn primary" disabled={busy || !pdfs} onClick={() => act('submit')}><Icon name="check" /> Submit for architect review</button></div>
      </section>
    );

  if (who === 'architect')
    return (
      <section className="card actionbox col">
        <div><b>Your review.</b> <span className="hint">Download the sheets, check them, then approve or return with notes.</span></div>
        <textarea className="input" style={{ minHeight: 70 }} placeholder="Notes (required to return)" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={() => act('approve')}><Icon name="check" /> Approve and send to engineer</button>
          <button className="btn" disabled={busy || !note.trim()} onClick={() => act('return')}><Icon name="back" /> Return for changes</button>
        </div>
      </section>
    );

  return (
    <section className="card sealbox col">
      <div><b>Ready for your seal.</b> <span className="hint">Sign and seal the PDF set with your usual signing tool, then upload the signed file here and lock the set.</span></div>
      {sealedFiles.length === 0 ? (
        <DropZone onFiles={(f) => upload(f, 'sealed_pdf')} label="Drop the signed and sealed PDF here, or" accept=".pdf" />
      ) : (
        <div className="hint">Sealed PDF uploaded: {sealedFiles.map((f) => f.filename).join(', ')}</div>
      )}
      <textarea className="input" style={{ minHeight: 60 }} placeholder="Notes (required to return)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="row">
        <button className="btn seal" disabled={busy || sealedFiles.length === 0} onClick={() => act('seal')}><Icon name="lock" /> Seal and lock this set</button>
        <button className="btn" disabled={busy || !note.trim()} onClick={() => act('return')}><Icon name="back" /> Return for changes</button>
      </div>
    </section>
  );
}

function FileCells({ files, editable, onRemove, missing }: { files: any[]; editable: boolean; onRemove: (f: any) => void; missing: string }) {
  if (!files.length) return missing ? <span className="hint" style={{ color: 'var(--amber)' }}>{missing}</span> : null;
  return (
    <div className="col" style={{ gap: 6 }}>
      {files.map((f) => (
        <div key={f.id} className="row" style={{ gap: 8, flexWrap: 'nowrap', minWidth: 0 }}>
          <span className={`kind ${f.kind}`}>{f.kind === 'sealed_pdf' ? 'SEALED' : f.kind.toUpperCase()}</span>
          <button className="link" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => download(f.id)} title={`Download ${f.filename}`}>
            {f.filename}
          </button>
          <span className="hint hide-sm" style={{ whiteSpace: 'nowrap' }}>{fmtBytes(Number(f.size_bytes))}</span>
          <span className="mono hash hide-sm" title={`SHA-256 ${f.sha256}`}>{f.sha256.slice(0, 8)}</span>
          {editable && <button className="btn ghost sm" aria-label={`Remove ${f.filename}`} onClick={() => onRemove(f)}><Icon name="trash" size={14} /></button>}
        </div>
      ))}
    </div>
  );
}

function DropZone({ onFiles, label, accept }: { onFiles: (f: FileList) => void; label: string; accept: string }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`drop${over ? ' over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files); }}
    >
      <Icon name="upload" size={20} />
      <div style={{ marginTop: 6 }}>
        {label} <button className="link" onClick={() => input.current?.click()}>choose files</button>
      </div>
      <input ref={input} type="file" multiple accept={accept} hidden onChange={(e) => { if (e.target.files?.length) onFiles(e.target.files); e.target.value = ''; }} />
    </div>
  );
}

function Progress({ items, onClear }: { items: Pending[]; onClear: () => void }) {
  const done = items.every((i) => i.pct === 100 || i.error);
  return (
    <div className="col" style={{ gap: 8, marginTop: 12 }}>
      {items.map((i, n) => (
        <div key={n}>
          <div className="row hint" style={{ justifyContent: 'space-between' }}>
            <span>{i.name}</span>
            <span className={i.error ? 'err' : ''}>{i.error || (i.pct === 100 ? 'Done' : `${i.pct}%`)}</span>
          </div>
          <div className="bar"><span style={{ width: `${i.pct}%`, background: i.error ? 'var(--redline)' : undefined }} /></div>
        </div>
      ))}
      {done && <button className="link" onClick={onClear}>Clear</button>}
    </div>
  );
}
