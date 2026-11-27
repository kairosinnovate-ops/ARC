import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { Dialog, Icon, fmtBytes, fmtDate, timeAgo, useToast } from '../ui';
import { PermitTimeline } from './PermitTimeline';

/**
 * PM: share a read-only link with the owner or client. Either the whole project (permit timeline and every
 * stamped set) or one stamped set. No account needed; the link can be turned off at any time.
 */
export function ShareDialog({ project, sets, links, onClose, onChange }: {
  project: any; sets: any[]; links: any[]; onClose: () => void; onChange: () => void;
}) {
  const toast = useToast();
  const sealed = sets.filter((x) => x.status === 'sealed');
  const [scope, setScope] = useState<string>('project');
  const [name, setName] = useState(project.client_name || '');
  const [email, setEmail] = useState(project.client_email || '');
  const [days, setDays] = useState(30);
  const [timeline, setTimeline] = useState(true);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  function compose(url: string) {
    const what = scope === 'project' ? `the project page for ${project.name}` : `the stamped drawings for ${project.name}`;
    const subject = `${project.name}${project.number ? ` (${project.number})` : ''}: ${scope === 'project' ? 'permit status and drawings' : 'stamped drawings'}`;
    const body = [
      `Hi ${name || 'there'},`,
      '',
      `Here is a private link to ${what}${project.address ? `, ${project.address}` : ''}.`,
      scope === 'project' && timeline ? 'It shows where the permit is with the city and lets you preview or download the stamped sets.' : 'You can preview or download the stamped PDF.',
      '',
      url,
      '',
      'No account is needed. Let us know if you have any questions.',
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
    setErr('');
    try {
      const r = await api(`/projects/${project.id}/share-links`, {
        body: { revision_set_id: scope === 'project' ? null : scope, name, email, days, show_timeline: scope === 'project' ? timeline : false },
      });
      setLink(r.url);
      if (win) win.location.href = compose(r.url).gmail;
      toast(openGmail ? 'Gmail draft opened. Review it and hit Send.' : 'Share link created.');
      onChange();
    } catch (e: any) {
      win?.close();
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  const label = (l: any) => (l.revision_set_id ? `Rev ${l.rev_number} stamped set` : 'Whole project');
  const state = (l: any) => (l.revoked_at ? 'Turned off' : new Date(l.expires_at) < new Date() ? 'Expired' : `Active until ${fmtDate(l.expires_at)}`);

  return (
    <Dialog title="Share with the client" onClose={onClose} wide>
      <div className="col">
        <p className="hint" style={{ margin: 0 }}>
          A read-only page they open without an account. They see the project, {timeline && scope === 'project' ? 'where the permit is, ' : ''}and the stamped PDFs to preview or download. No team names, notes or working drawings.
        </p>
        <div className="field">
          <span>What to share</span>
          <div className="seg" style={{ flexWrap: 'wrap' }}>
            <button type="button" className={scope === 'project' ? 'on' : ''} onClick={() => setScope('project')}>Whole project</button>
            {sealed.map((x) => (
              <button type="button" key={x.id} className={scope === x.id ? 'on' : ''} onClick={() => setScope(x.id)}>Rev {x.rev_number} stamped set</button>
            ))}
          </div>
          {sealed.length === 0 && <span className="hint">No stamped sets yet. The project link shows the permit timeline now and each set once it's sealed.</span>}
        </div>
        <div className="form-grid">
          <label className="field"><span>Client name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field"><span>Client email (for the Gmail draft)</span><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label className="field">
            <span>Link works for</span>
            <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
          </label>
          {scope === 'project' && (
            <label className="check" style={{ alignSelf: 'end', paddingBottom: 10 }}>
              <input type="checkbox" checked={timeline} onChange={(e) => setTimeline(e.target.checked)} /> Show the permit timeline
            </label>
          )}
        </div>
        {err && <p className="err">{err}</p>}
        <div className="row">
          <button className="btn primary" disabled={busy || !email} onClick={() => create(true)}><Icon name="letter" /> Open email in Gmail</button>
          <button className="btn" disabled={busy} onClick={() => create(false)}><Icon name="link" /> Just create the link</button>
        </div>
        {link && (
          <div className="col" style={{ gap: 8 }}>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input className="input mono" readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Share link" />
              <button className="btn" onClick={() => { navigator.clipboard?.writeText(link); toast('Link copied.'); }}>Copy</button>
            </div>
            <div className="hint">
              {email && <>Not using Gmail? <a className="link" href={compose(link).mailto}>Open in your email app</a>. </>}The link is shown only once, so copy it now if you need it.
            </div>
          </div>
        )}
        {links.length > 0 && (
          <>
            <div className="label" style={{ marginTop: 6 }}>Links you've shared</div>
            <div className="queue">
              {links.map((l) => (
                <div key={l.id} className="qi">
                  <div className="s">
                    <div className="t">{label(l)}{l.recipient_name || l.recipient_email ? ` · ${l.recipient_name || l.recipient_email}` : ''}</div>
                    <div className="sub">
                      Created {timeAgo(l.created_at)} · {l.open_count ? `Opened ${l.open_count === 1 ? 'once' : `${l.open_count} times`}, last ${timeAgo(l.last_opened_at)}` : 'Not opened yet'} · {state(l)}
                    </div>
                  </div>
                  {!l.revoked_at && new Date(l.expires_at) > new Date() && (
                    <button className="btn sm" onClick={async () => { await api(`/share-links/${l.id}`, { method: 'DELETE' }); toast('Link turned off.'); onChange(); }}>Turn off</button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** The public page behind a share link. The token is the only credential. */
export default function SharePage() {
  const { token } = useParams();
  const base = `/api/public/share/${token}`;
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    fetch(base)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'Something went wrong.');
        setD(j);
        document.title = `${j.project.name} · ${j.firm_name}`;
      })
      .catch((e) => setErr(e.message));
  }, [base]);

  async function open(fileId: string, inline: boolean) {
    setMsg('');
    // Open the tab first so the browser doesn't block it as a pop-up.
    const win = inline ? window.open('about:blank', '_blank') : null;
    const r = await fetch(`${base}/files/${fileId}${inline ? '?inline=1' : ''}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      win?.close();
      return setMsg(j.error || 'That file is not available.');
    }
    if (win) win.location.href = j.url;
    else window.location.href = j.url;
  }

  if (err)
    return (
      <div className="auth">
        <div className="card col"><span className="label">Shared project</span><h1>Link not available</h1><p className="hint">{err}</p></div>
      </div>
    );
  if (!d) return <div className="auth"><div className="hint">Loading…</div></div>;
  const p = d.project;

  return (
    <div className="auth public">
      <div className="col" style={{ width: '100%', maxWidth: 860, gap: 18, paddingTop: 24 }}>
        <div className="row" style={{ gap: 10 }}>
          <span className="logo" style={{ margin: 0 }}>A</span>
          <span className="label">{d.firm_name} · {d.scope === 'project' ? 'project status' : 'stamped drawings'}</span>
        </div>
        <div>
          <h1 style={{ fontSize: 30 }}>{p.name}</h1>
          <p className="hint" style={{ marginTop: 6 }}>
            {[p.number, p.address, p.jurisdiction, p.permit_number && `Permit ${p.permit_number}`].filter(Boolean).join(' · ')}
          </p>
        </div>
        {d.timeline && (
          <section className="card">
            <h2>Permit status</h2>
            <PermitTimeline milestones={d.timeline} />
          </section>
        )}
        <section className="card col">
          <h2 style={{ margin: 0 }}>{d.scope === 'project' ? 'Stamped drawing sets' : 'Stamped drawings'}</h2>
          {d.sets.length === 0 && <div className="empty">No stamped sets yet. They show up here as soon as {d.firm_name} seals them.</div>}
          {d.sets.map((s: any, i: number) => (
            <div key={s.id} className={`col${i === 0 ? ' sealbox' : ''}`} style={{ gap: 10, padding: 14, border: '1px solid var(--line)', borderRadius: 12 }}>
              <div className="row" style={{ gap: 10, justifyContent: 'space-between' }}>
                <div className="row" style={{ gap: 10, flexWrap: 'nowrap', minWidth: 0 }}>
                  <Icon name="seal" size={20} />
                  <div style={{ minWidth: 0 }}>
                    <b>Rev {s.rev_number}{s.title ? ` · ${s.title}` : ''}</b>
                    <div className="hint">
                      Stamped and sealed {fmtDate(s.sealed_at)}{s.engineer_license ? ` · License ${s.engineer_license}` : ''}{s.reason === 'city' ? ' · Revised per city comments' : ''}
                    </div>
                  </div>
                </div>
                {i === 0 && d.sets.length > 1 && <span className="pill st-sealed">Latest</span>}
              </div>
              {s.files.length === 0 && <div className="hint">No files in this set. Contact {d.firm_name}.</div>}
              {s.files.map((f: any) => (
                <div key={f.id} className="row" style={{ gap: 8, flexWrap: 'nowrap', minWidth: 0 }}>
                  <span className="kind sealed_pdf">PDF</span>
                  <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.filename}>{f.filename}</span>
                  <span className="hint hide-sm" style={{ whiteSpace: 'nowrap' }}>{fmtBytes(Number(f.size_bytes))}</span>
                  <button className="btn sm" onClick={() => open(f.id, true)}>Preview</button>
                  <button className="btn sm primary" onClick={() => open(f.id, false)} aria-label={`Download ${f.filename}`}><Icon name="download" size={14} /> <span className="hide-sm">Download</span></button>
                </div>
              ))}
            </div>
          ))}
          {msg && <div className="err">{msg}</div>}
        </section>
        <p className="hint" style={{ textAlign: 'center' }}>
          Shared by {d.firm_name} through Arc. This link works until {fmtDate(d.expires_at)}. Questions about the project go to {d.firm_name}.
        </p>
      </div>
    </div>
  );
}
