import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { sha256 } from '../api';
import { Icon, fmtBytes, fmtDate, kindLabel } from '../ui';

/** Public page an engineer opens from the email. The token in the URL is the only credential. */
export default function StampPage() {
  const { token } = useParams();
  const base = `/api/public/stamp/${token}`;
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const [name, setName] = useState('');
  const [license, setLicense] = useState('');
  const [note, setNote] = useState('');
  const [mode, setMode] = useState<'stamp' | 'return'>('stamp');
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const call = async (path: string, body?: unknown) => {
    const r = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Something went wrong.');
    return j;
  };
  const load = useCallback(() => call('').then((x) => { setD(x); setName((n) => n || x.engineer_name || ''); }).catch((e) => setErr(e.message)), [token]);
  useEffect(() => {
    document.title = 'Stamp request · Arc';
    load();
  }, [load]);

  async function get(fileId: string) {
    try {
      const { url } = await call(`/files/${fileId}`);
      window.location.href = url;
    } catch (e: any) {
      setMsg(e.message);
    }
  }

  async function upload(file: File) {
    setMsg('');
    if (!/\.pdf$/i.test(file.name)) return setMsg('Upload the stamped set as a PDF.');
    setBusy(true);
    try {
      const start = await call('/upload', { filename: file.name, size: file.size, sha256: await sha256(file) });
      await new Promise<void>((res, rej) => {
        const x = new XMLHttpRequest();
        x.open('PUT', start.upload_url);
        x.setRequestHeader('content-type', start.content_type);
        x.upload.onprogress = (e) => e.lengthComputable && setPct(Math.round((e.loaded / e.total) * 100));
        x.onload = () => (x.status < 300 ? res() : rej(new Error(`Upload failed (${x.status})`)));
        x.onerror = () => rej(new Error('Upload failed. Check your connection.'));
        x.send(file);
      });
      await call(`/complete/${start.file_id}`, {});
      await load();
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(false);
      setPct(null);
    }
  }

  async function finish() {
    setBusy(true);
    setMsg('');
    try {
      if (mode === 'stamp') await call('/seal', { name, license });
      else await call('/return', { name, note });
      await load();
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (err)
    return (
      <div className="auth">
        <div className="card col"><span className="label">Arc stamp request</span><h1>Link not available</h1><p className="hint">{err}</p></div>
      </div>
    );
  if (!d) return <div className="auth"><div className="hint">Loading…</div></div>;

  const drawings = d.files.filter((f: any) => f.kind !== 'sealed_pdf');
  const mine = d.files.filter((f: any) => f.kind === 'sealed_pdf');

  return (
    <div className="auth" style={{ placeItems: 'start center' }}>
      <div className="col" style={{ width: 'min(720px, 100%)', gap: 18, paddingTop: 24 }}>
        <div className="row" style={{ gap: 10 }}>
          <span className="logo" style={{ margin: 0 }}>A</span>
          <span className="label">{d.firm_name} · stamp request</span>
        </div>
        <div>
          <h1 style={{ fontSize: 30 }}>{d.project.name}</h1>
          <p className="hint" style={{ marginTop: 6 }}>
            Rev {d.rev_number}{d.title ? ` · ${d.title}` : ''}{d.project.number ? ` · ${d.project.number}` : ''}
            {d.project.address ? ` · ${d.project.address}` : ''}{d.project.jurisdiction ? ` · ${d.project.jurisdiction}` : ''}
          </p>
        </div>

        {d.status === 'sealed' ? (
          <section className="card sealbox row">
            <Icon name="seal" size={22} />
            <div><b>Done. Thank you.</b> <span className="hint">The stamped set is with {d.firm_name}{d.sealed_at ? ` as of ${fmtDate(d.sealed_at)}` : ''}.</span></div>
          </section>
        ) : d.status === 'closed' ? (
          <section className="card"><b>This set is no longer waiting for a stamp.</b> <span className="hint">The firm may have pulled it back for changes. They'll send a new link when it's ready.</span></section>
        ) : null}

        <section className="card">
          <div className="card-h"><h2>1. Download the drawings</h2><span className="hint">{drawings.length} files</span></div>
          <div className="col" style={{ gap: 8 }}>
            {drawings.map((f: any) => (
              <div key={f.id} className="row" style={{ gap: 8, flexWrap: 'nowrap', minWidth: 0 }}>
                <span className={`kind ${f.kind}`}>{kindLabel(f.kind)}</span>
                <button className="link" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => get(f.id)}>{f.filename}</button>
                <span className="hint" style={{ whiteSpace: 'nowrap' }}>{fmtBytes(Number(f.size_bytes))}</span>
                {f.sheet && <span className="mono hash">{f.sheet}</span>}
              </div>
            ))}
          </div>
        </section>

        {d.status === 'open' && (
          <section className="card col">
            <div className="seg" style={{ alignSelf: 'flex-start' }}>
              <button className={mode === 'stamp' ? 'on' : ''} onClick={() => setMode('stamp')}>Stamp and return</button>
              <button className={mode === 'return' ? 'on' : ''} onClick={() => setMode('return')}>Needs changes</button>
            </div>
            {mode === 'stamp' ? (
              <>
                <h2 style={{ margin: 0 }}>2. Upload the signed and sealed PDF</h2>
                {mine.length > 0 ? (
                  <div className="hint">Uploaded: {mine.map((f: any) => f.filename).join(', ')}. <button className="link" onClick={() => input.current?.click()}>Add another</button></div>
                ) : (
                  <div className="drop">
                    <Icon name="upload" size={20} />
                    <div style={{ marginTop: 6 }}>{pct !== null ? `Uploading… ${pct}%` : <>Choose the stamped PDF: <button className="link" onClick={() => input.current?.click()}>choose file</button></>}</div>
                  </div>
                )}
                <input ref={input} type="file" accept=".pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
                <div className="form-grid">
                  <label className="field"><span>Your name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
                  <label className="field"><span>License number (optional)</span><input className="input" value={license} onChange={(e) => setLicense(e.target.value)} /></label>
                </div>
                <div><button className="btn seal" disabled={busy || !mine.length || !name.trim()} onClick={finish}><Icon name="lock" /> Send the stamped set</button></div>
              </>
            ) : (
              <>
                <h2 style={{ margin: 0 }}>What needs to change?</h2>
                <label className="field"><span>Your name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
                <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Sheet numbers and the changes needed before you can stamp." />
                <div><button className="btn primary" disabled={busy || !note.trim()} onClick={finish}><Icon name="back" /> Send notes to the firm</button></div>
                <p className="hint" style={{ margin: 0 }}>This closes the link. The firm will send a new one when the revised set is ready.</p>
              </>
            )}
            {msg && <div className="err">{msg}</div>}
          </section>
        )}
        <p className="hint" style={{ textAlign: 'center' }}>Sent through Arc. This private link is meant for {d.engineer_email}.</p>
      </div>
    </div>
  );
}
