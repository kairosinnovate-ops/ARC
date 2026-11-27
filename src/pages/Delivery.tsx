import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Icon, fmtBytes, fmtDate } from '../ui';

/** Public page a client opens from the email to download the stamped set. The token is the only credential. */
export default function DeliveryPage() {
  const { token } = useParams();
  const base = `/api/public/delivery/${token}`;
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    document.title = 'Stamped drawings · Arc';
    fetch(base)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'Something went wrong.');
        setD(j);
      })
      .catch((e) => setErr(e.message));
  }, [base]);

  async function get(fileId: string) {
    setMsg('');
    const r = await fetch(`${base}/files/${fileId}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return setMsg(j.error || 'Download failed.');
    window.location.href = j.url;
  }

  if (err)
    return (
      <div className="auth">
        <div className="card col"><span className="label">Stamped drawings</span><h1>Link not available</h1><p className="hint">{err}</p></div>
      </div>
    );
  if (!d) return <div className="auth"><div className="hint">Loading…</div></div>;

  return (
    <div className="auth" style={{ placeItems: 'start center' }}>
      <div className="col" style={{ width: 'min(720px, 100%)', gap: 18, paddingTop: 24 }}>
        <div className="row" style={{ gap: 10 }}>
          <span className="logo" style={{ margin: 0 }}>A</span>
          <span className="label">{d.firm_name} · stamped drawings</span>
        </div>
        <div>
          <h1 style={{ fontSize: 30 }}>{d.project.name}</h1>
          <p className="hint" style={{ marginTop: 6 }}>
            Rev {d.rev_number}{d.title ? ` · ${d.title}` : ''}{d.project.number ? ` · ${d.project.number}` : ''}
            {d.project.address ? ` · ${d.project.address}` : ''}{d.project.jurisdiction ? ` · ${d.project.jurisdiction}` : ''}
          </p>
        </div>
        <section className="card sealbox col">
          <div className="row" style={{ gap: 10 }}>
            <Icon name="seal" size={22} />
            <div>
              <b>Stamped and sealed{d.sealed_at ? ` ${fmtDate(d.sealed_at)}` : ''}.</b>{' '}
              <span className="hint">{d.engineer_license ? `Stamped by a licensed engineer · License ${d.engineer_license}` : 'Stamped by a licensed engineer'}</span>
            </div>
          </div>
          <div className="col" style={{ gap: 8 }}>
            {d.files.length === 0 && <div className="hint">No files yet. Contact {d.firm_name}.</div>}
            {d.files.map((f: any) => (
              <div key={f.id} className="row" style={{ gap: 8, flexWrap: 'nowrap', minWidth: 0 }}>
                <span className="kind sealed_pdf">PDF</span>
                <button className="link" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => get(f.id)}>{f.filename}</button>
                <span className="hint" style={{ whiteSpace: 'nowrap' }}>{fmtBytes(Number(f.size_bytes))}</span>
              </div>
            ))}
          </div>
          {msg && <div className="err">{msg}</div>}
        </section>
        <p className="hint" style={{ textAlign: 'center' }}>
          Sent by {d.firm_name} through Arc. This link works until {fmtDate(d.expires_at)}. If the city sends comments back, forward them to {d.firm_name}.
        </p>
      </div>
    </div>
  );
}
