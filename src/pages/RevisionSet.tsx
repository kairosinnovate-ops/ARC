import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, download, uploadFile } from '../api';
import { useSession } from '../App';
import { Avatar, Icon, Pill, SET_STATUS, fmtBytes, fmtDate, kindLabel, timeAgo, useToast } from '../ui';
import { HandoffFlight, ReviewThread, TURN, flightFor, holder, type Flight } from '../handoff';

type Data = { set: any; project: any; files: any[]; events: any[]; members: any[]; my_slots: string[]; stamp_requests: any[]; client_links: any[] };
type Pending = { name: string; pct: number; error?: string };

const SHEET_RE = /\b([A-Z]{1,2}-?\d{1,3}(?:\.\d{1,2})?[A-Z]?)\b/;
const guessSheet = (filename: string) => filename.replace(/\.[^.]+$/, '').toUpperCase().replace(/_/g, ' ').match(SHEET_RE)?.[1] || '';
const kindOf = (filename: string) => {
  const ext = filename.toLowerCase().split('.').pop();
  return ext === 'pdf' ? 'pdf' : 'other';
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
  const [flight, setFlight] = useState<Flight | null>(null);
  const lastStatus = useRef<string | null>(null);
  const acting = useRef(false);

  const load = useCallback(() => api<Data>(`/sets/${id}`).then(setD).catch((e) => setErr(e.message)), [id]);
  useEffect(() => {
    lastStatus.current = null;
    load();
  }, [load, s.firm.firm_id]);
  // Keep the page live: pick up hand-offs and notes from the rest of the chain.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible' && !acting.current) api<Data>(`/sets/${id}`).then(setD).catch(() => {});
    }, 15000);
    return () => clearInterval(t);
  }, [id, s.firm.firm_id]);
  // When someone else hands the set to you while you're looking, show it arriving.
  useEffect(() => {
    if (!d) return;
    const prev = lastStatus.current;
    lastStatus.current = d.set.status;
    if (!prev || prev === d.set.status || acting.current) return;
    const mine = (TURN[d.set.status] || []).some((x) => d.my_slots.includes(x));
    const by = d.events.find((e) => e.actor_id !== s.user.id && !['file_uploaded', 'file_removed', 'note_added', 'review_note'].includes(e.action));
    if (mine && by) setFlight({ from: by.actor_name, to: 'you', toRole: '', verb: 'Just handed to', dir: 'in' });
  }, [d?.set.status]);
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

  const byKind = useMemo(() => {
    const g: Record<string, any[]> = { drawings: [], reference: [], markup: [], sealed_pdf: [], final: [] };
    for (const f of d?.files || [])
      (g[['pdf', 'dwg', 'other'].includes(f.kind) ? 'drawings' : ['final_pdf', 'final_cad'].includes(f.kind) ? 'final' : f.kind] ||= []).push(f);
    return g;
  }, [d]);
  const sheets = useMemo(() => {
    const map = new Map<string, { pdf: any[]; dwg: any[]; other: any[] }>();
    for (const f of byKind.drawings) {
      const k = f.sheet || '';
      if (!map.has(k)) map.set(k, { pdf: [], dwg: [], other: [] });
      map.get(k)![f.kind as 'pdf' | 'dwg' | 'other'].push(f);
    }
    return [...map.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, undefined, { numeric: true })));
  }, [byKind]);

  if (err) return <main className="content"><p className="err">{err}</p><Link className="link" to="/">Back to projects</Link></main>;
  if (!d) return <main className="content"><div className="hint">Loading…</div></main>;
  const { set, project: p } = d;
  const slots = new Set(d.my_slots);
  const name = (uid: string | null) => d.members.find((m) => m.user_id === uid)?.name;
  const st = set.status;
  const drawingsOpen = (st === 'draft' && (slots.has('drafter') || slots.has('pm'))) || (['pm_review', 'pm_rework'].includes(st) && slots.has('pm'));
  const canMarkup = (st === 'architect_review' && slots.has('architect')) || (['pm_review', 'pm_rework', 'architect_review'].includes(st) && slots.has('pm'));
  const canRef = st !== 'sealed' && (slots.has('pm') || (st === 'intake' && slots.has('architect')));
  const finalOpen = st === 'final_record' && (slots.has('drafter') || slots.has('pm'));
  const hasDwg = byKind.drawings.some((f) => f.kind === 'dwg');
  const intakeNote = [...d.events].reverse().find((e) => e.action === 'intake_started' && e.note);

  async function upload(list: FileList | File[], kind?: string) {
    const arr = [...list];
    setPending(arr.map((f) => ({ name: f.name, pct: 0 })));
    let failed = 0;
    for (let i = 0; i < arr.length; i++) {
      const f = arr[i];
      try {
        await uploadFile(set.id, f, { kind: kind || kindOf(f.name), sheet: kind ? '' : guessSheet(f.name) }, (pct) =>
          setPending((x) => x.map((y, n) => (n === i ? { ...y, pct } : y))),
        );
        setPending((x) => x.map((y, n) => (n === i ? { ...y, pct: 100 } : y)));
      } catch (e: any) {
        failed++;
        setPending((x) => x.map((y, n) => (n === i ? { ...y, error: e.message } : y)));
      }
    }
    await load();
    if (!failed) {
      setPending([]);
      toast(`Uploaded ${arr.length} file${arr.length === 1 ? '' : 's'}.`);
    }
  }

  async function act(action: string, extra: Record<string, string> = {}) {
    setBusy(true);
    acting.current = true;
    try {
      await api(`/sets/${set.id}/action`, { body: { action, note, ...extra } });
      setNote('');
      const f = flightFor(action, s.user.name, { name, p });
      if (f) setFlight(f);
      await load();
      if (!f) toast(
        ({
          submit: 'Sent to the PM.',
          pm_approve: 'Sent to the architect.',
          pm_return: 'Sent back to the drafter.',
          pm_send_back: 'Sent back to the drafter with the markups.',
          pm_resubmit: 'Sent back to the architect.',
          architect_approve: 'Approved. The drafter turns in the final PDF and CAD next.',
          send_to_drafter: 'Scope sent to the drafter.',
          submit_final: 'Final record turned in. Ready for stamp.',
          architect_return: 'Markups sent to the PM.',
          engineer_return: 'Sent back to the PM.',
          seal: 'Sealed. This set is now locked. Send it to the client next.',
        } as Record<string, string>)[action] || 'Done.',
      );
    } catch (e: any) {
      toast(e.message, true);
    } finally {
      setBusy(false);
      acting.current = false;
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

  const steps: [string, string, string[]][] = [
    ['Intake', set.reason === 'city' ? 'City comments' : 'Site notes and scope', ['intake']],
    ['Drafting', name(p.drafter_id) || 'Drafter', ['draft']],
    ['PM check', name(p.pm_id) || 'PM', ['pm_review', 'pm_rework']],
    ['Architect review', name(p.architect_id) || 'Architect', ['architect_review']],
    ['Final record', 'Final PDF and CAD', ['final_record']],
    ['Engineer stamp', name(p.engineer_id) || p.engineer_name || 'Engineer', ['engineer_review']],
    ['Client', set.delivered_at ? `Sent ${fmtDate(set.delivered_at)}` : 'Stamped set delivered', ['sealed']],
  ];
  const at = steps.findIndex((x) => x[2].includes(st));
  const turnSlots = TURN[st] || [];
  const myTurn = turnSlots.some((x) => slots.has(x)) || (st === 'sealed' && !set.delivered_at && slots.has('pm'));
  const hold = holder(st, { name, p });
  const arrived = d.events.find((e) => !['file_uploaded', 'file_removed', 'note_added', 'review_note', 'markup_uploaded', 'final_uploaded', 'sealed_uploaded', 'stamp_link_sent', 'client_link_sent', 'client_opened'].includes(e.action));
  const last = steps.length - 1;
  const lastNote = (actions: string[]) => d.events.find((e) => actions.includes(e.action) && e.note);

  return (
    <main className="content">
      <div className="page-h">
        <div>
          <span className="label">{p.name} · {p.kind === 'modification' ? 'Modification' : 'Initial drawings'}</span>
          <h1 style={{ marginTop: 8 }}>Rev {set.rev_number}{set.title ? ` · ${set.title}` : ''}</h1>
          <p className="hint">
            {st === 'sealed'
              ? `Sealed ${fmtDate(set.sealed_at)}${set.sealed_by_name ? ` by ${set.sealed_by_name}` : ''}${set.sealed_via === 'link' ? ' through the email link' : ''}. The drawings and their fingerprints are locked.`
              : st === 'intake'
                ? 'Collect the site notes, sketches and photos here. The PM writes the scope and sends it to the drafter.'
                : 'Review rounds are PDF only. Name each PDF with its sheet number, like A-101.pdf. The CAD files come in with the final record.'}
          </p>
        </div>
        <Pill kind={`st-${st}`}>{SET_STATUS[st]}</Pill>
      </div>

      <section className="card">
        <div className="chain">
          {steps.map(([t, who], n) => (
            <div key={t} className={`step ${st === 'sealed' ? (n === last ? (set.delivered_at ? 'sealed' : 'now') : 'done') : n < at ? 'done' : n === at ? (st === 'pm_rework' ? 'back now' : 'now') : 'later'}${myTurn && (n === at || (st === 'sealed' && n === last && !set.delivered_at)) ? ' mine' : ''}`}>
              <div className="dot" />
              <div className="t">{t}</div>
              <div className="d">{n === 2 && st === 'pm_rework' ? 'Rework from review' : who}</div>
              {myTurn && (n === at || (st === 'sealed' && n === last && !set.delivered_at)) && <span className="turn">Your turn</span>}
            </div>
          ))}
        </div>
        {st !== 'sealed' && hold && (
          <div className={`court${myTurn ? ' mine' : ''}`}>
            {myTurn ? <span className="ball" /> : <Avatar name={hold.who} size={22} />}
            <span>
              {myTurn ? <b>The ball is in your court.</b> : <>With <b>{hold.who}</b> <span className="hint">· {hold.label}</span></>}
              {arrived && <span className="hint"> {myTurn ? `${arrived.actor_name === s.user.name ? 'You moved it here' : `From ${arrived.actor_name}`}` : 'since'} {timeAgo(arrived.created_at)}.</span>}
            </span>
          </div>
        )}
      </section>

      {flight && <HandoffFlight f={flight} onDone={() => setFlight(null)} />}

      <ActionBox mine={myTurn} d={d} slots={slots} note={note} setNote={setNote} busy={busy} act={act} upload={upload} lastNote={lastNote} name={name} reload={load} />

      {(set.brief || intakeNote || st === 'intake' || byKind.reference.length > 0) && (
        <section className="card">
          <div className="card-h"><h2>{st === 'intake' ? 'Intake' : 'Scope and instructions'}</h2></div>
          {intakeNote && (
            <div style={{ marginBottom: 12 }}>
              <div className="label" style={{ marginBottom: 8 }}>Site notes from {intakeNote.actor_name}</div>
              <div className="brief">{intakeNote.note}</div>
            </div>
          )}
          {set.brief ? (
            <>
              <div className="label" style={{ marginBottom: 8 }}>Scope from {name(p.pm_id) || 'the PM'}</div>
              <div className="brief">{set.brief}</div>
            </>
          ) : st === 'intake' ? <div className="hint">The PM hasn't written the scope yet.</div> : null}
          {byKind.reference.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="label" style={{ marginBottom: 8 }}>Sketches, photos and reference drawings</div>
              <FileCells files={byKind.reference} editable={canRef} onRemove={removeFile} missing="" />
            </div>
          )}
          {canRef && <div style={{ marginTop: 12 }}><DropZone onFiles={(f) => upload(f, 'reference')} label="Add hand sketches, site photos or reference drawings:" accept="*" compact /></div>}
        </section>
      )}

      <div className={st === 'intake' ? 'col' : 'grid2'} style={st === 'intake' ? { gap: 22 } : undefined}>
        <div className="col" style={{ gap: 22 }}>
          {st !== 'intake' && <section className="card">
            <div className="card-h">
              <h2>Sheets</h2>
              <span className="hint">{byKind.drawings.filter((f) => f.kind === 'pdf').length} PDF{hasDwg ? ` · ${byKind.drawings.filter((f) => f.kind === 'dwg').length} DWG` : ''}</span>
            </div>
            {drawingsOpen && <DropZone onFiles={(fl) => upload(fl)} label="Drop PDF sheets here, or" accept=".pdf" />}
            {pending.length > 0 && <Progress items={pending} onClear={() => setPending([])} />}
            {sheets.length === 0 ? (
              <div className="empty" style={{ marginTop: drawingsOpen ? 14 : 0 }}>No drawings uploaded yet.</div>
            ) : (
              <table className="ftable" style={{ marginTop: 14 }}>
                <thead><tr><th>Sheet</th><th>PDF</th>{hasDwg && <th>DWG source</th>}</tr></thead>
                <tbody>
                  {sheets.map(([sheet, g]) => (
                    <tr key={sheet || 'none'}>
                      <td className="mono" style={{ whiteSpace: 'nowrap' }}>{sheet || <span className="hint">No sheet no.</span>}</td>
                      <td><FileCells files={[...g.pdf, ...g.other]} editable={drawingsOpen} onRemove={removeFile} missing="No PDF" /></td>
                      {hasDwg && <td><FileCells files={g.dwg} editable={false} onRemove={removeFile} missing="" /></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>}
          {(byKind.markup.length > 0 || canMarkup) && (
            <section className="card">
              <div className="card-h">
                <h2>Markups</h2>
                <span className="hint">Redlines from review. The PM forwards them to the drafter.</span>
              </div>
              {byKind.markup.length > 0 ? (
                <FileCells files={byKind.markup} editable={canMarkup} onRemove={removeFile} missing="" showSharing={!slots.has('drafter') || slots.size > 1} />
              ) : (
                <div className="hint" style={{ marginBottom: 10 }}>No markups yet.</div>
              )}
              {canMarkup && <div style={{ marginTop: 12 }}><DropZone onFiles={(f) => upload(f, 'markup')} label="Add a marked-up PDF:" accept=".pdf,image/*" compact /></div>}
            </section>
          )}
          {(finalOpen || byKind.final.length > 0) && (
            <section className="card">
              <div className="card-h">
                <h2>Final record</h2>
                <span className="hint">The final PDF and CAD files kept with this revision.</span>
              </div>
              <div className="form-grid">
                <div className="col" style={{ gap: 8 }}>
                  <div className="label">Final PDF</div>
                  <FileCells files={byKind.final.filter((f) => f.kind === 'final_pdf')} editable={finalOpen} onRemove={removeFile} missing="Not uploaded" />
                  {finalOpen && <DropZone onFiles={(f) => upload(f, 'final_pdf')} label="Final PDF set:" accept=".pdf" compact />}
                </div>
                <div className="col" style={{ gap: 8 }}>
                  <div className="label">CAD files</div>
                  <FileCells files={byKind.final.filter((f) => f.kind === 'final_cad')} editable={finalOpen} onRemove={removeFile} missing="Not uploaded" />
                  {finalOpen && <DropZone onFiles={(f) => upload(f, 'final_cad')} label="DWG, DXF or RVT:" accept="*" compact />}
                </div>
              </div>
            </section>
          )}
          {byKind.sealed_pdf.length > 0 && (
            <section className="card sealbox">
              <h2>Sealed set</h2>
              <FileCells files={byKind.sealed_pdf} editable={st === 'engineer_review' && (slots.has('engineer') || slots.has('pm'))} onRemove={removeFile} missing="" />
              {set.engineer_license && <div className="hint" style={{ marginTop: 8 }}>License {set.engineer_license}</div>}
            </section>
          )}
        </div>
        <ReviewThread events={d.events} people={{ name, p }} me={s.user.id} slots={slots} setId={set.id} sealed={st === 'sealed'} reload={load} />
      </div>
    </main>
  );
}

function ActionBox(props: {
  mine?: boolean; d: Data; slots: Set<string>; note: string; setNote: (s: string) => void; busy: boolean;
  act: (a: string, extra?: Record<string, string>) => void; upload: (f: FileList | File[], kind?: string) => void;
  lastNote: (a: string[]) => any; name: (id: string | null) => string | undefined; reload: () => void;
}) {
  const { d, slots, note, setNote, busy, act, upload, lastNote, name, reload, mine } = props;
  const { set, project: p } = d;
  const st = set.status;
  const [license, setLicense] = useState('');
  const [scope, setScope] = useState(set.brief || (set.rev_number === 0 ? p.requirements : '') || '');
  const [engineerName, setEngineerName] = useState(p.engineer_name || '');
  const finals = d.files.filter((f) => f.kind === 'final_pdf').length;
  const cads = d.files.filter((f) => f.kind === 'final_cad').length;
  const sealedFiles = d.files.filter((f) => f.kind === 'sealed_pdf');
  const pdfs = d.files.filter((f) => f.kind === 'pdf').length;
  const noteBox = (placeholder: string, rows = 70) => (
    <textarea className="input" style={{ minHeight: rows }} placeholder={placeholder} value={note} onChange={(e) => setNote(e.target.value)} />
  );
  const quote = (e: any) => e && <div><span className="label">From {e.actor_name}</span><div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>“{e.note}”</div></div>;

  if (st === 'sealed')
    return (
      <>
        <section className="card sealbox row">
          <Icon name="seal" size={22} />
          <div>
            <b>Sealed and locked.</b>{' '}
            <span className="hint">
              {slots.has('pm')
                ? 'Send the stamped set to the client below. When city comments come back, log them on the project page to start the next round.'
                : 'When city comments come back, the PM starts the next revision.'}
            </span>
          </div>
        </section>
        {slots.has('pm') && <ClientLink d={d} reload={reload} />}
      </>
    );

  if (st === 'intake' && slots.has('pm'))
    return (
      <section className={`card actionbox col${mine ? ' mine' : ''}`}>
        <div><b>Set the scope.</b> <span className="hint">Review the site notes and sketches below, then tell {name(p.drafter_id) || 'the drafter'} what to draw.</span></div>
        <textarea className="input" style={{ minHeight: 120 }} placeholder="What to draw, permit or construction set, standards to follow, due date." value={scope} onChange={(e) => setScope(e.target.value)} />
        <div className="row">
          <button className="btn primary" disabled={busy || !scope.trim() || !p.drafter_id} onClick={() => act('send_to_drafter', { note: scope })}><Icon name="check" /> Send scope to drafter</button>
          {!p.drafter_id && <span className="hint">Assign a drafter on the project page first.</span>}
        </div>
      </section>
    );

  if (st === 'intake' && slots.has('architect'))
    return (
      <section className={`card actionbox${mine ? ' mine' : ''}`}>
        <b>Add your hand sketches, site photos and notes below.</b> <span className="hint">{name(p.pm_id) || 'The PM'} will set the scope and send it to the drafter.</span>
      </section>
    );

  if (st === 'final_record' && (slots.has('drafter') || slots.has('pm')))
    return (
      <section className={`card actionbox col${mine ? ' mine' : ''}`}>
        <div><b>Approved. Turn in the final record.</b> <span className="hint">Upload the final PDF set and the CAD files below. They're kept with this revision and go to the engineer for stamp.</span></div>
        <div className="hint">{finals ? `${finals} final PDF` : 'No final PDF yet'} · {cads ? `${cads} CAD file${cads === 1 ? '' : 's'}` : 'no CAD files yet'}</div>
        <div className="row"><button className="btn primary" disabled={busy || !finals || !cads} onClick={() => act('submit_final')}><Icon name="check" /> Turn in final record</button></div>
      </section>
    );

  if (st === 'draft' && slots.has('drafter'))
    return (
      <section className={`card actionbox col${mine ? ' mine' : ''}`}>
        {quote(lastNote(['pm_returned']))}
        <div className="hint">{pdfs ? `${pdfs} PDF sheet${pdfs === 1 ? '' : 's'} uploaded.` : 'Upload at least one PDF sheet.'} When you're done, send it to {name(p.pm_id) || 'the PM'} for a check.</div>
        {noteBox('Note for the PM (optional)', 60)}
        <div className="row"><button className="btn primary" disabled={busy || !pdfs} onClick={() => act('submit')}><Icon name="check" /> Submit to PM</button></div>
      </section>
    );

  if (st === 'pm_review' && slots.has('pm'))
    return (
      <section className={`card actionbox col${mine ? ' mine' : ''}`}>
        <div><b>Check the drafter's work.</b> <span className="hint">Send it on to {name(p.architect_id) || 'the architect'}, or back to {name(p.drafter_id) || 'the drafter'} with notes.</span></div>
        {quote(lastNote(['submitted']))}
        {noteBox('Notes (required to send back)')}
        <div className="row">
          <button className="btn primary" disabled={busy || !p.architect_id} onClick={() => act('pm_approve')}><Icon name="check" /> Send to architect</button>
          <button className="btn" disabled={busy || !note.trim()} onClick={() => act('pm_return')}><Icon name="back" /> Back to drafter</button>
          {!p.architect_id && <span className="hint">Assign an architect on the project page first.</span>}
        </div>
      </section>
    );

  if (st === 'pm_rework' && slots.has('pm'))
    return (
      <section className={`card actionbox col${mine ? ' mine' : ''}`} style={{ borderColor: 'color-mix(in srgb, var(--amber) 35%, var(--line))' }}>
        <div><b>Rework came back from review.</b> <span className="hint">Forward the notes and markups to the drafter, or fix it yourself and resubmit to the architect.</span></div>
        {quote(lastNote(['architect_returned', 'engineer_returned']))}
        {noteBox('Instructions for the drafter (required to send back)')}
        <div className="row">
          <button className="btn primary" disabled={busy || !note.trim()} onClick={() => act('pm_send_back')}><Icon name="back" /> Send to drafter with markups</button>
          <button className="btn" disabled={busy} onClick={() => act('pm_resubmit')}>Resubmit to architect</button>
        </div>
      </section>
    );

  if (st === 'architect_review' && slots.has('architect'))
    return (
      <section className={`card actionbox col${mine ? ' mine' : ''}`}>
        <div><b>Your review.</b> <span className="hint">Download the sheets. Approve them for stamp, or add a marked-up PDF below and send the rework to {name(p.pm_id) || 'the PM'}.</span></div>
        {noteBox('Notes for the PM (required to send rework)')}
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={() => act('architect_approve')}><Icon name="check" /> Approve for stamp</button>
          <button className="btn" disabled={busy || !note.trim()} onClick={() => act('architect_return')}><Icon name="back" /> Send rework to PM</button>
        </div>
      </section>
    );

  if (st === 'engineer_review') {
    const inApp = slots.has('engineer');
    const sender = slots.has('pm') || slots.has('architect');
    return (
      <>
        {inApp && (
          <section className="card sealbox col">
            <div><b>Ready for your stamp.</b> <span className="hint">Sign and seal the PDF with your usual tool, upload it, then lock the set.</span></div>
            {sealedFiles.length === 0 ? (
              <DropZone onFiles={(f) => upload(f, 'sealed_pdf')} label="Drop the signed and sealed PDF here, or" accept=".pdf" />
            ) : (
              <div className="hint">Sealed PDF uploaded: {sealedFiles.map((f) => f.filename).join(', ')}</div>
            )}
            <div className="form-grid">
              <label className="field"><span>License number (optional)</span><input className="input" value={license} onChange={(e) => setLicense(e.target.value)} /></label>
            </div>
            {noteBox('Notes for the PM (required to send back)', 60)}
            <div className="row">
              <button className="btn seal" disabled={busy || sealedFiles.length === 0} onClick={() => act('seal', { license })}><Icon name="lock" /> Seal and lock this set</button>
              <button className="btn" disabled={busy || !note.trim()} onClick={() => act('engineer_return')}><Icon name="back" /> Send back to PM</button>
            </div>
          </section>
        )}
        {sender && <StampLink d={d} reload={reload} />}
        {slots.has('pm') && !inApp && (
          <section className="card col">
            <div><b>Got the stamp by email?</b> <span className="hint">Upload the stamped PDF yourself and record who stamped it.</span></div>
            {sealedFiles.length === 0 ? (
              <DropZone onFiles={(f) => upload(f, 'sealed_pdf')} label="Stamped PDF:" accept=".pdf" compact />
            ) : (
              <div className="hint">Stamped PDF uploaded: {sealedFiles.map((f) => f.filename).join(', ')}</div>
            )}
            <div className="form-grid">
              <label className="field"><span>Engineer who stamped it</span><input className="input" value={engineerName} onChange={(e) => setEngineerName(e.target.value)} /></label>
              <label className="field"><span>License number (optional)</span><input className="input" value={license} onChange={(e) => setLicense(e.target.value)} /></label>
            </div>
            <div className="row">
              <button className="btn seal" disabled={busy || sealedFiles.length === 0 || !engineerName.trim()} onClick={() => act('seal', { license, engineer_name: engineerName })}><Icon name="lock" /> Record the stamp and lock the set</button>
            </div>
          </section>
        )}
        {!inApp && !sender && (
          <section className="card"><b>Waiting on the engineer's stamp.</b></section>
        )}
      </>
    );
  }

  const waitingOn: Record<string, string | undefined> = {
    intake: name(p.pm_id) || 'the PM',
    final_record: name(p.drafter_id) || 'the drafter',
    draft: name(p.drafter_id) || 'the drafter',
    pm_review: name(p.pm_id) || 'the PM',
    pm_rework: name(p.pm_id) || 'the PM',
    architect_review: name(p.architect_id) || 'the architect',
  };
  return (
    <section className="card">
      <b>Waiting on {waitingOn[st]}.</b> <span className="hint">You'll see actions here when it's your step.</span>
    </section>
  );
}

/** Send the ready-to-stamp set to an engineer who doesn't use Arc yet. */
function StampLink({ d, reload }: { d: Data; reload: () => void }) {
  const toast = useToast();
  const p = d.project;
  const engineerMember = d.members.find((m) => m.user_id === p.engineer_id);
  const [email, setEmail] = useState(p.engineer_email || engineerMember?.email || '');
  const [name, setName] = useState(p.engineer_name || engineerMember?.name || '');
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const live = d.stamp_requests.find((r) => !r.revoked_at && !r.used_at && new Date(r.expires_at) > new Date());

  function compose(url: string) {
    const subject = `Ready for stamp: ${p.name}${p.number ? ` (${p.number})` : ''}, Rev ${d.set.rev_number}`;
    const body = [
      `Hi ${name || 'there'},`,
      '',
      `The drawings for ${p.name}${p.address ? `, ${p.address}` : ''} (Rev ${d.set.rev_number}) are approved and ready for your stamp.`,
      '',
      'Download the set and upload the stamped PDF here. No account is needed:',
      url,
      '',
      'If anything needs to change before you stamp, you can send notes back from the same page.',
      '',
      'Thanks,',
    ].join('\n');
    return {
      gmail: `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
      mailto: `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
    };
  }

  async function create(openGmail: boolean) {
    // Open the tab first so the browser treats it as a click, then point it at the draft.
    const win = openGmail ? window.open('about:blank', '_blank') : null;
    setBusy(true);
    try {
      const r = await api(`/sets/${d.set.id}/stamp-links`, { body: { email, name } });
      setLink(r.url);
      if (win) win.location.href = compose(r.url).gmail;
      toast(openGmail ? 'Gmail draft opened. Review it and hit Send.' : 'Stamp link created.');
      reload();
    } catch (e: any) {
      win?.close();
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card col">
      <div>
        <b>Send for stamp by email.</b>{' '}
        <span className="hint">For engineers who aren't in Arc yet. They get a private link to download the set and upload the stamped PDF. It works for {30} days, and only one link is active at a time.</span>
      </div>
      <div className="form-grid">
        <label className="field"><span>Engineer name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>Engineer email</span><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      </div>
      <div className="row">
        <button className="btn primary" disabled={busy || !email} onClick={() => create(true)}><Icon name="letter" /> {live ? 'Send a new link in Gmail' : 'Open email in Gmail'}</button>
        <button className="btn" disabled={busy || !email} onClick={() => create(false)}>Just create the link</button>
      </div>
      {link && (
        <div className="col" style={{ gap: 8 }}>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input className="input mono" readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Stamp link" />
            <button className="btn" onClick={() => { navigator.clipboard?.writeText(link); toast('Link copied.'); }}>Copy</button>
          </div>
          <div className="hint">
            Not using Gmail? <a className="link" href={compose(link).mailto}>Open in your email app</a>. The link is shown only once, so copy it now if you need it.
          </div>
        </div>
      )}
      {d.stamp_requests.length > 0 && (
        <div className="queue">
          {d.stamp_requests.slice(0, 4).map((r) => (
            <div key={r.id} className="qi">
              <div className="s">
                <div className="t">{r.engineer_name || r.engineer_email}</div>
                <div className="sub">
                  Sent {timeAgo(r.created_at)} ·{' '}
                  {r.used_at ? 'Used' : r.revoked_at ? 'Replaced' : new Date(r.expires_at) < new Date() ? 'Expired' : `Active until ${fmtDate(r.expires_at)}`}
                </div>
              </div>
              {!r.used_at && !r.revoked_at && (
                <button className="btn sm" onClick={async () => { await api(`/stamp-links/${r.id}`, { method: 'DELETE' }); reload(); }}>Turn off</button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Send the stamped set to the client: a private download link in a Gmail draft. */
function ClientLink({ d, reload }: { d: Data; reload: () => void }) {
  const toast = useToast();
  const p = d.project;
  const [email, setEmail] = useState(p.client_email || '');
  const [name, setName] = useState(p.client_name || '');
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const live = d.client_links.find((r) => !r.revoked_at && new Date(r.expires_at) > new Date());

  function compose(url: string) {
    const subject = `Stamped drawings: ${p.name}${p.number ? ` (${p.number})` : ''}, Rev ${d.set.rev_number}`;
    const body = [
      `Hi ${name || 'there'},`,
      '',
      `The stamped and sealed drawings for ${p.name}${p.address ? `, ${p.address}` : ''} are ready.`,
      '',
      'Download them here (no account needed):',
      url,
      '',
      'If the city sends comments back, forward them to us and we will take care of the revisions.',
      '',
      'Thanks,',
    ].join('\n');
    return {
      gmail: `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
      mailto: `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
    };
  }

  async function create(openGmail: boolean) {
    const win = openGmail ? window.open('about:blank', '_blank') : null;
    setBusy(true);
    try {
      const r = await api(`/sets/${d.set.id}/client-links`, { body: { email, name } });
      setLink(r.url);
      if (win) win.location.href = compose(r.url).gmail;
      toast(openGmail ? 'Gmail draft opened. Review it and hit Send.' : 'Client link created.');
      reload();
    } catch (e: any) {
      win?.close();
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card col">
      <div>
        <b>Send the stamped set to the client.</b>{' '}
        <span className="hint">They get a private link to download the sealed PDF. It works for 30 days. Sending a new link turns off the old one.</span>
      </div>
      <div className="form-grid">
        <label className="field"><span>Client name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>Client email</span><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      </div>
      <div className="row">
        <button className="btn primary" disabled={busy || !email} onClick={() => create(true)}><Icon name="letter" /> {live ? 'Send a new link in Gmail' : 'Open email in Gmail'}</button>
        <button className="btn" disabled={busy || !email} onClick={() => create(false)}>Just create the link</button>
      </div>
      {link && (
        <div className="col" style={{ gap: 8 }}>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input className="input mono" readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Client link" />
            <button className="btn" onClick={() => { navigator.clipboard?.writeText(link); toast('Link copied.'); }}>Copy</button>
          </div>
          <div className="hint">
            Not using Gmail? <a className="link" href={compose(link).mailto}>Open in your email app</a>. The link is shown only once, so copy it now if you need it.
          </div>
        </div>
      )}
      {d.client_links.length > 0 && (
        <div className="queue">
          {d.client_links.slice(0, 4).map((r) => (
            <div key={r.id} className="qi">
              <div className="s">
                <div className="t">{r.client_name || r.client_email}</div>
                <div className="sub">
                  Sent {timeAgo(r.created_at)} · {r.opened_at ? `Opened ${timeAgo(r.opened_at)}` : 'Not opened yet'} ·{' '}
                  {r.revoked_at ? 'Turned off' : new Date(r.expires_at) < new Date() ? 'Expired' : `Active until ${fmtDate(r.expires_at)}`}
                </div>
              </div>
              {!r.revoked_at && (
                <button className="btn sm" onClick={async () => { await api(`/client-links/${r.id}`, { method: 'DELETE' }); reload(); }}>Turn off</button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function FileCells({ files, editable, onRemove, missing, showSharing }: { files: any[]; editable: boolean; onRemove: (f: any) => void; missing: string; showSharing?: boolean }) {
  if (!files.length) return missing ? <span className="hint" style={{ color: 'var(--amber)' }}>{missing}</span> : null;
  return (
    <div className="col" style={{ gap: 6 }}>
      {files.map((f) => (
        <div key={f.id} className="row" style={{ gap: 8, flexWrap: 'nowrap', minWidth: 0 }}>
          <span className={`kind ${f.kind}`}>{kindLabel(f.kind)}</span>
          <button className="link" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => download(f.id)} title={`Download ${f.filename}`}>
            {f.filename}
          </button>
          <span className="hint hide-sm" style={{ whiteSpace: 'nowrap' }}>{fmtBytes(Number(f.size_bytes))}</span>
          <span className="mono hash hide-sm" title={`SHA-256 ${f.sha256}`}>{f.sha256.slice(0, 8)}</span>
          {showSharing && f.kind === 'markup' && <span className="hint hide-sm" style={{ whiteSpace: 'nowrap' }}>{f.shared_with_drafter ? 'Drafter can see' : 'PM only'}</span>}
          {editable && <button className="btn ghost sm" aria-label={`Remove ${f.filename}`} onClick={() => onRemove(f)}><Icon name="trash" size={14} /></button>}
        </div>
      ))}
    </div>
  );
}

function DropZone({ onFiles, label, accept, compact }: { onFiles: (f: FileList) => void; label: string; accept: string; compact?: boolean }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`drop${over ? ' over' : ''}`}
      style={compact ? { padding: 12 } : undefined}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files); }}
    >
      {!compact && <Icon name="upload" size={20} />}
      <div style={{ marginTop: compact ? 0 : 6 }}>
        {label} <button className="link" onClick={() => input.current?.click()}>choose files</button>
      </div>
      <input ref={input} type="file" multiple accept={accept === '*' ? undefined : accept} hidden onChange={(e) => { if (e.target.files?.length) onFiles(e.target.files); e.target.value = ''; }} />
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
