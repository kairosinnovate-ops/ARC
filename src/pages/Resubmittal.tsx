import { useMemo, useState } from 'react';
import { api, apiDownload } from '../api';
import { useSession } from '../App';
import { Dialog, Icon, useToast } from '../ui';

/** Comments a revision answers: the ones its city round was started for, plus any marked fixed in it. */
export const roundComments = (comments: any[], setId: string) =>
  comments.filter((c) => c.round_set_id === setId || c.addressed_in_set_id === setId);

/** Revisions that have city comments to answer, newest first. */
export const letterRounds = (sets: any[], comments: any[]) => sets.filter((x) => roundComments(comments, x.id).length > 0);

/**
 * PM: build the resubmittal response letter for a city comment round. Responses typed here are saved back to
 * each comment, then Arc renders the letter as a PDF with the project, revision and a comment / response table.
 */
export function ResubmittalDialog({ project, sets, comments, initialSet, onClose, onSaved }: {
  project: any; sets: any[]; comments: any[]; initialSet?: string; onClose: () => void; onSaved: () => void;
}) {
  const s = useSession();
  const toast = useToast();
  const rounds = letterRounds(sets, comments);
  const [setId, setSetId] = useState(initialSet || rounds[0]?.id || '');
  const set = sets.find((x) => x.id === setId);
  const items = useMemo(() => roundComments(comments, setId), [comments, setId]);
  const [responses, setResponses] = useState<Record<string, string>>(() => Object.fromEntries(comments.map((c) => [c.id, c.response || ''])));
  const [to, setTo] = useState(`${project.jurisdiction ? `${project.jurisdiction} Building Department` : 'Building Department'}\nPlan Review`);
  const [intro, setIntro] = useState('');
  const [signer, setSigner] = useState(s.user.name || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const missing = items.filter((c) => !responses[c.id]?.trim()).length;
  const defaultIntro = set
    ? `Enclosed is Rev ${set.rev_number} of the drawings for ${project.name}${project.permit_number ? ` (permit ${project.permit_number})` : ''}, revised in response to the plan review comments. Each comment is listed below with our response and the sheet where the change was made.`
    : '';

  async function generate() {
    setBusy(true);
    setErr('');
    try {
      // Save any responses that changed so the comment log and the letter agree.
      for (const c of items) {
        const r = (responses[c.id] || '').trim();
        if (r !== (c.response || '')) await api(`/comments/${c.id}`, { method: 'PATCH', body: { response: r } });
      }
      const name = await apiDownload(`/sets/${setId}/resubmittal-letter`, { to, intro: intro.trim() || defaultIntro, signer }, `Resubmittal-Rev${set?.rev_number}.pdf`);
      toast(`${name} downloaded.`);
      onSaved();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!rounds.length)
    return (
      <Dialog title="Resubmittal letter" onClose={onClose}>
        <p>No city comments are tied to a revision yet. Start a revision for city comments first, or mark comments as fixed in a revision.</p>
        <div className="foot"><button className="btn primary" onClick={onClose}>OK</button></div>
      </Dialog>
    );

  return (
    <Dialog title="Resubmittal letter" onClose={onClose} wide>
      <div className="col">
        <p className="hint" style={{ margin: 0 }}>
          Arc fills in the project, address, permit and revision, and lists each city comment with your response. Responses you write here are saved to the comment log.
        </p>
        <div className="form-grid">
          <label className="field">
            <span>Revision</span>
            <select className="input" value={setId} onChange={(e) => setSetId(e.target.value)}>
              {rounds.map((x) => <option key={x.id} value={x.id}>Rev {x.rev_number}{x.title ? ` · ${x.title}` : ''}</option>)}
            </select>
          </label>
          <label className="field"><span>Signed by</span><input className="input" value={signer} onChange={(e) => setSigner(e.target.value)} /></label>
          <label className="field"><span>To</span><textarea className="input" style={{ minHeight: 62 }} value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <label className="field"><span>Opening paragraph</span><textarea className="input" style={{ minHeight: 62 }} value={intro} onChange={(e) => setIntro(e.target.value)} placeholder={defaultIntro} /></label>
        </div>
        <div className="label">{items.length} comment{items.length === 1 ? '' : 's'}{missing ? ` · ${missing} without a response` : ' · all answered'}</div>
        <div className="ctable">
          {items.map((c) => (
            <div key={c.id} className="citem letter-row">
              <div className="num">#{c.number || '–'}</div>
              <div style={{ minWidth: 0 }}>
                <div className="body">{c.body}</div>
                <div className="tags">
                  {c.sheet && <span className="mono">{c.sheet}</span>}
                  {c.discipline && <span>{c.discipline}</span>}
                </div>
              </div>
              <textarea
                className="input"
                aria-label={`Response to comment ${c.number}`}
                value={responses[c.id] || ''}
                onChange={(e) => setResponses({ ...responses, [c.id]: e.target.value })}
                placeholder="Revised detail 4/A-501 to show…"
              />
            </div>
          ))}
        </div>
        {missing > 0 && <p className="hint" style={{ margin: 0, color: 'var(--amber)' }}>Comments without a response print as “Response pending.”</p>}
        {err && <p className="err">{err}</p>}
        <div className="foot">
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary" disabled={busy || !setId} onClick={generate}><Icon name="download" /> {busy ? 'Building PDF…' : 'Download letter PDF'}</button>
        </div>
      </div>
    </Dialog>
  );
}
