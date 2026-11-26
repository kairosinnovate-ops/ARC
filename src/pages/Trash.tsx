import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../App';
import { ConfirmByName, Icon, fmtDate, useToast } from '../ui';

type Row = { id: string; name: string; number: string; deleted_at: string; purge_at: string; deleted_by_name: string | null; sealed_sets: number; file_count: number };

export default function TrashPage() {
  const s = useSession();
  const toast = useToast();
  const nav = useNavigate();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState('');
  const [purging, setPurging] = useState<Row | null>(null);

  const load = useCallback(() => api('/trash').then(setRows).catch((e) => setErr(e.message)), []);
  useEffect(() => {
    s.setCrumbs(<><span className="sep">/</span><Link to="/">Projects</Link><span className="sep">/</span><b>Trash</b></>);
    load();
  }, [s.firm.firm_id]);

  async function restore(r: Row) {
    try {
      await api(`/trash/${r.id}/restore`, { method: 'POST' });
      toast(`${r.name} is back.`);
      nav(`/projects/${r.id}`);
    } catch (e: any) {
      toast(e.message, true);
    }
  }

  const daysLeft = (iso: string) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000));

  return (
    <main className="content">
      <div className="page-h">
        <div>
          <span className="label">{s.firm.firm_name}</span>
          <h1 style={{ marginTop: 8 }}>Trash</h1>
          <p className="hint">Deleted projects stay here for 30 days. After that, the project and every file in it are removed for good.
            {s.firm.is_admin ? ' As an admin you see every deleted project in the firm.' : ' You see the projects you managed.'}</p>
        </div>
      </div>
      <section className="card">
        {err && <p className="err">{err}</p>}
        {!rows ? (
          <div className="hint">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="hint">Trash is empty.</div>
        ) : (
          <div className="queue">
            {rows.map((r) => (
              <div key={r.id} className="qi">
                <div className="s">
                  <div className="t">{r.number ? `${r.number} · ` : ''}{r.name}</div>
                  <div className="sub">
                    Deleted {fmtDate(r.deleted_at)}{r.deleted_by_name ? ` by ${r.deleted_by_name}` : ''} · {r.file_count} file{r.file_count === 1 ? '' : 's'}
                    {r.sealed_sets > 0 ? ` · ${r.sealed_sets} sealed set${r.sealed_sets === 1 ? '' : 's'}` : ''} · removed for good in {daysLeft(r.purge_at)} days
                  </div>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn sm" onClick={() => restore(r)}>Restore</button>
                  <button className="btn ghost sm danger" onClick={() => setPurging(r)}><Icon name="trash" size={14} /> Delete forever</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      {purging && (
        <ConfirmByName
          title="Delete forever?"
          name={purging.name}
          action="Delete forever"
          onClose={() => setPurging(null)}
          onConfirm={async (typed) => {
            await api(`/trash/${purging.id}/delete`, { body: { confirm_name: typed } });
            toast(`${purging.name} and its files were deleted.`);
            setPurging(null);
            load();
          }}
        >
          This removes {purging.name}, its revision history, city comments and all {purging.file_count} stored files, including any sealed sets. It can't be undone.
          {purging.sealed_sets > 0 && ' To keep a sealed PDF, restore the project and download it first.'}
        </ConfirmByName>
      )}
    </main>
  );
}
