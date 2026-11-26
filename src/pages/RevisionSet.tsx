import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, download, uploadFile } from '../api';
import { useSession } from '../App';
import { Avatar, Icon, NOTE_EVENTS, Pill, SET_STATUS, eventText, fmtBytes, fmtDate, timeAgo, useToast } from '../ui';

type Data = { set: any; project: any; files: any[]; events: any[]; members: any[]; my_slots: string[]; stamp_requests: any[] };
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

  const byKind = useMemo(() => {
    const g: Record<string, any[]> = { drawings: [], reference: [], markup: [], sealed_pdf: [] };
    for (const f of d?.files || []) (g[['pdf', 'dwg', 'other'].includes(f.kind) ? 'drawings' : f.kind] ||= []).push(f);
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
  const canRef = st !== 'sealed' && slots.has('pm');

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
    try {
      await api(`/sets/${set.id}/action`, { body: { action, note, ...extra } });
      setNote('');
      await load();
      toast(
        ({
          submit: 'Sent to the PM.',
          pm_approve: 'Sent to the architect.',
          pm_return: 'Sent back to the drafter.',
          pm_send_back: 'Sent back to the drafter with the markups.',
          pm_resubmit: 'Sent back to the architect.',
          architect_approve: 'Approved. Ready for stamp.',
          architect_return: 'Markups sent to the PM.',
          engineer_return: 'Sent back to the PM.',
          seal: 'Sealed. This set is now locked.',
        } as Record<string, string>)[action] || 'Done.',
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

  const steps: [string, string, string[]][] = [
    ['Drafting', name(p.drafter_id) || 'Drafter', ['draft']],
    ['PM check', name(p.pm_id) || 'PM', ['pm_review', 'pm_rework']],
    ['Architect review', name(p.architect_id) || 'Architect', ['architect_review']],
    ['Engineer stamp', name(p.engineer_id) || p.engineer_name || p.engineer_email || 'Engineer', ['engineer_review']],
    ['Sealed', 'Locked to its CAD source', ['sealed']],
  ];
  const at = steps.findIndex((x) => x[2].includes(st));
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
              : 'Name files with the sheet number, like A-101.pdf and A-101.dwg, so each PDF pairs with its DWG source.'}
          </p>
        </div>
        <Pill kind={`st-${st}`}>{SET_STATUS[st]}</Pill>
      </div>

      <section className="card">
        <div className="chain">
          {steps.map(([t, who], n) => (
            <div key={t} className={`step ${st === 'sealed' ? (n === 4 ? 'sealed' : 'done') : n < at ? 'done' : n === at ? (st === 'pm_rework' ? 'back' : 'now') : ''}`}>
              <div className="dot" />
              <div className="t">{t}</div>
              <div className="d">{n === 1 && st === 'pm_rework' ? 'Rework from review' : who}</div>
            </div>
          ))}
        </div>
      </section>

      <ActionBox d={d} slots={slots} note={note} setNote={setNote} busy={busy} act={act} upload={upload} lastNote={lastNote} name={name} reload={load} />

      {set.brief && (
        <section className="card">
          <div className="card-h"><h2>Instructions from the PM</h2><span className="hint">{name(set.created_by) || ''}</span></div>
          <div className="brief">{set.brief}</div>
          {byKind.reference.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="label" style={{ marginBottom: 8 }}>Reference drawings</div>
              <FileCells files={byKind.reference} editable={canRef} onRemove={removeFile} missing="" />
            </div>
          )}
          {canRef && <div style={{ marginTop: 12 }}><DropZone onFiles={(f) => upload(f, 'reference')} label="Add reference drawings or photos:" accept="*" compact /></div>}
        </section>
      )}

      <div className="grid2">
        <div className="col" style={{ gap: 22 }}>
          <section className="card">
            <div className="card-h">
              <h2>Sheets</h2>
              <span className="hint">{byKind.drawings.filter((f) => f.kind === 'pdf').length} PDF · {byKind.drawings.filter((f) => f.kind === 'dwg').length} DWG</span>
            </div>
            {drawingsOpen && <DropZone onFiles={(fl) => upload(fl)} label="Drop PDF and DWG files here, or" accept=".pdf,.dwg,.dxf" />}
            {pending.length > 0 && <Progress items={pending} onClear={() => setPending([])} />}
            {sheets.length === 0 ? (
              <div className="empty" style={{ marginTop: drawingsOpen ? 14 : 0 }}>No drawings uploaded yet.</div>
            ) : (
              <table className="ftable" style={{ marginTop: 14 }}>
                <thead><tr><th>Sheet</th><th>PDF</th><th>DWG source</th></tr></thead>
                <tbody>
                  {sheets.map(([sheet, g]) => (
                    <tr key={sheet || 'none'}>
                      <td className="mono" style={{ whiteSpace: 'nowrap' }}>{sheet || <span className="hint">No sheet no.</span>}</td>
                      <td><FileCells files={[...g.pdf, ...g.other]} editable={drawingsOpen} onRemove={removeFile} missing="No PDF" /></td>
                      <td><FileCells files={g.dwg} editable={drawingsOpen} onRemove={removeFile} missing={sheet ? 'Missing DWG' : ''} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
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
          {byKind.sealed_pdf.length > 0 && (
            <section className="card sealbox">
              <h2>Sealed set</h2>
              <FileCells files={byKind.sealed_pdf} editable={st === 'engineer_review' && slots.has('engineer')} onRemove={removeFile} missing="" />
              {set.engineer_license && <div className="hint" style={{ marginTop: 8 }}>License {set.engineer_license}</div>}
            </section>
          )}
        </div>
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
  d: Data; slots: Set<string>; note: string; setNote: (s: string) => void; busy: boolean;
  act: (a: string, extra?: Record<string, string>) => void; upload: (f: FileList | File[], kind?: string) => void;
  lastNote: (a: string[]) => any; name: (id: string | null) => string | undefined; reload: () => void;
}) {
  const { d, slots, note, setNote, busy, act, upload, lastNote, name, reload } = props;
  const { set, project: p } = d;
  const st = set.status;
  const [license, setLicense] = useState('');
  const sealedFiles = d.files.filter((f) => f.kind === 'sealed_pdf');
  const pdfs = d.files.filter((f) => f.kind === 'pdf').length;
  const noteBox = (placeholder: string, rows = 70) => (
    <textarea className="input" style={{ minHeight: rows }} placeholder={placeholder} value={note} onChange={(e) => setNote(e.target.value)} />
  );
  const quote = (e: any) => e && <div><span className="label">From {e.actor_name}</span><div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>“{e.note}”</div></div>;

  if (st === 'sealed')
    return (
      <section className="card sealbox row">
        <Icon name="seal" size={22} />
        <div><b>Sealed and locked.</b> <span className="hint">When the city responds, the PM sends the next revision from the project page.</span></div>
      </section>
    );

  if (st === 'draft' && slots.has('drafter'))
    return (
      <section className="card actionbox col">
        {quote(lastNote(['pm_returned']))}
        <div className="hint">{pdfs ? `${pdfs} PDF sheet${pdfs === 1 ? '' : 's'} uploaded.` : 'Upload at least one PDF sheet.'} When you're done, send it to {name(p.pm_id) || 'the PM'} for a check.</div>
        {noteBox('Note for the PM (optional)', 60)}
        <div className="row"><button className="btn primary" disabled={busy || !pdfs} onClick={() => act('submit')}><Icon name="check" /> Submit to PM</button></div>
      </section>
    );

  if (st === 'pm_review' && slots.has('pm'))
    return (
      <section className="card actionbox col">
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
      <section className="card actionbox col" style={{ borderColor: 'color-mix(in srgb, var(--amber) 35%, var(--line))' }}>
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
      <section className="card actionbox col">
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
        {!inApp && !sender && (
          <section className="card"><b>Waiting on the engineer's stamp.</b></section>
        )}
      </>
    );
  }

  const waitingOn: Record<string, string | undefined> = {
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

function FileCells({ files, editable, onRemove, missing, showSharing }: { files: any[]; editable: boolean; onRemove: (f: any) => void; missing: string; showSharing?: boolean }) {
  if (!files.length) return missing ? <span className="hint" style={{ color: 'var(--amber)' }}>{missing}</span> : null;
  return (
    <div className="col" style={{ gap: 6 }}>
      {files.map((f) => (
        <div key={f.id} className="row" style={{ gap: 8, flexWrap: 'nowrap', minWidth: 0 }}>
          <span className={`kind ${f.kind}`}>{f.kind === 'sealed_pdf' ? 'SEALED' : f.kind === 'reference' ? 'REF' : f.kind.toUpperCase()}</span>
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
