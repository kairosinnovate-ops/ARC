import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { Avatar, Icon, eventText, timeAgo, useToast } from './ui';

type Slot = 'pm' | 'drafter' | 'architect' | 'engineer';
type People = { name: (id: string | null) => string | undefined; p: any };

/** Who holds the set at each status. */
export const TURN: Record<string, Slot[]> = {
  intake: ['pm'],
  draft: ['drafter'],
  pm_review: ['pm'],
  pm_rework: ['pm'],
  architect_review: ['architect'],
  final_record: ['drafter', 'pm'],
  engineer_review: ['engineer', 'pm'],
};
const SLOT_LABEL: Record<Slot, string> = { pm: 'PM', drafter: 'Drafter', architect: 'Architect', engineer: 'Engineer' };

export function holder(st: string, { name, p }: People) {
  const slot = (TURN[st] || [])[0];
  if (!slot) return null;
  const id = p[`${slot}_id`];
  const who = name(id) || (slot === 'engineer' ? p.engineer_name : '') || `the ${SLOT_LABEL[slot].toLowerCase()}`;
  return { slot, who, label: SLOT_LABEL[slot] };
}

/** Events that move the set from one person to the next, and where they send it. */
const HANDOFF: Record<string, { to: Slot | 'client'; dir: 'fwd' | 'back' | 'seal' }> = {
  sent_to_drafter: { to: 'drafter', dir: 'fwd' },
  submitted: { to: 'pm', dir: 'fwd' },
  pm_approved: { to: 'architect', dir: 'fwd' },
  pm_returned: { to: 'drafter', dir: 'back' },
  architect_approved: { to: 'drafter', dir: 'fwd' },
  architect_returned: { to: 'pm', dir: 'back' },
  final_submitted: { to: 'engineer', dir: 'fwd' },
  engineer_returned: { to: 'pm', dir: 'back' },
  sealed: { to: 'client', dir: 'seal' },
};
/** The same, keyed by the button the user pressed. */
export const ACTION_TO: Record<string, { to: Slot | 'client'; dir: 'fwd' | 'back' | 'seal'; verb: string }> = {
  send_to_drafter: { to: 'drafter', dir: 'fwd', verb: 'Scope sent to' },
  submit: { to: 'pm', dir: 'fwd', verb: 'Sent to' },
  pm_approve: { to: 'architect', dir: 'fwd', verb: 'Sent to' },
  pm_resubmit: { to: 'architect', dir: 'fwd', verb: 'Resubmitted to' },
  pm_return: { to: 'drafter', dir: 'back', verb: 'Sent back to' },
  pm_send_back: { to: 'drafter', dir: 'back', verb: 'Markups sent to' },
  architect_approve: { to: 'drafter', dir: 'fwd', verb: 'Approved. Final record goes to' },
  architect_return: { to: 'pm', dir: 'back', verb: 'Rework sent to' },
  submit_final: { to: 'engineer', dir: 'fwd', verb: 'Ready for stamp by' },
  engineer_return: { to: 'pm', dir: 'back', verb: 'Sent back to' },
  seal: { to: 'client', dir: 'seal', verb: 'Sealed and locked' },
};

function slotName(slot: Slot | 'client', { name, p }: People) {
  if (slot === 'client') return p.client_name || 'Client';
  return name(p[`${slot}_id`]) || (slot === 'engineer' ? p.engineer_name : '') || SLOT_LABEL[slot];
}

export type Flight = { from: string; to: string; toRole: string; verb: string; dir: 'fwd' | 'back' | 'seal' | 'in' };

export function flightFor(action: string, me: string, people: People): Flight | null {
  const a = ACTION_TO[action];
  if (!a) return null;
  return { from: me, to: slotName(a.to, people), toRole: a.to === 'client' ? 'Client' : SLOT_LABEL[a.to], verb: a.verb, dir: a.dir };
}

/** The moment a set changes hands: a sheet travels from one person to the next. */
export function HandoffFlight({ f, onDone }: { f: Flight; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2600);
    return () => clearTimeout(t);
  }, [f]);
  const seal = f.dir === 'seal';
  return (
    <div className={`flight ${f.dir}`} role="status" aria-live="polite" onClick={onDone}>
      <div className="lane">
        <div className="who"><Avatar name={f.from} size={38} /><span>{f.from}</span></div>
        <div className="track">
          <i className="sheet"><Icon name={seal ? 'seal' : 'file'} size={18} /></i>
        </div>
        <div className="who">{seal ? <span className="av seal-av"><Icon name="lock" size={16} /></span> : <Avatar name={f.to} size={38} />}<span>{seal ? 'Locked' : f.to}</span></div>
      </div>
      <div className="msg">
        {f.dir === 'in' ? <>{f.verb} <b>{f.to}</b></> : seal ? <b>{f.verb}</b> : <>{f.verb} <b>{f.to}</b> <span className="hint">· {f.toRole}</span></>}
      </div>
    </div>
  );
}

type Item =
  | { k: 'round'; id: string; label: string }
  | { k: 'hand'; id: string; e: any; to: string; dir: string }
  | { k: 'note'; id: string; e: any; mine: boolean; reviewers: boolean }
  | { k: 'small'; id: string; e: any; count: number; names: string[] };

/** The review thread: every hand-off, note and upload in one conversation, grouped by round. */
export function ReviewThread({ events, people, me, slots, setId, sealed, reload }: {
  events: any[]; people: People; me: string; slots: Set<string>; setId: string; sealed: boolean; reload: () => Promise<any>;
}) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const seen = useRef<Set<string> | null>(null);

  const items = useMemo(() => {
    const out: Item[] = [];
    let round = 0;
    for (const e of [...events].reverse()) {
      if (e.action === 'submitted') {
        round++;
        out.push({ k: 'round', id: 'r' + e.id, label: `Round ${round}` });
      } else if (e.action === 'architect_approved') {
        out.push({ k: 'round', id: 'r' + e.id, label: 'Approved' });
      }
      const h = HANDOFF[e.action];
      if (h) out.push({ k: 'hand', id: e.id, e, to: slotName(h.to, people), dir: h.dir });
      else if (e.action === 'note_added' || e.action === 'review_note')
        out.push({ k: 'note', id: e.id, e, mine: e.actor_id === me, reviewers: e.action === 'review_note' });
      else {
        const prev = out[out.length - 1];
        if (prev?.k === 'small' && prev.e.action === e.action && prev.e.actor_id === e.actor_id) {
          prev.count++;
          prev.names.push(e.note);
        } else out.push({ k: 'small', id: e.id, e, count: 1, names: [e.note] });
      }
    }
    return out;
  }, [events, people]);

  // Animate only what arrived after the first render.
  const fresh = useMemo(() => {
    const ids = new Set(items.map((i) => i.id));
    const prev = seen.current;
    seen.current = ids;
    return prev ? new Set([...ids].filter((i) => !prev.has(i))) : new Set<string>();
  }, [items]);
  // Newest at the bottom, like a conversation: keep the thread scrolled to the latest.
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: fresh.size ? 'smooth' : 'auto' });
  }, [fresh]);

  const LIMIT = 14;
  const shown = all ? items : items.slice(-LIMIT);
  const onlyReviewer = !slots.has('pm') && !slots.has('drafter');
  const audience = slots.has('pm')
    ? 'Everyone on this revision sees your note.'
    : onlyReviewer
      ? 'Only the PM and reviewers see this. The drafter hears through the PM.'
      : 'The PM and the reviewers see your note.';

  async function send() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api(`/sets/${setId}/notes`, { body: { note: text.trim() } });
      setText('');
      await reload();
    } catch (e: any) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card thread-card">
      <div className="card-h">
        <h2>Review thread</h2>
        <span className="hint">{items.filter((i) => i.k === 'hand').length} hand-offs</span>
      </div>
      {items.length === 0 ? (
        <div className="hint">Nothing yet.</div>
      ) : (
        <div className="thread" ref={box}>
          {items.length > LIMIT && !all && (
            <button className="link earlier" onClick={() => setAll(true)}>Show {items.length - LIMIT} earlier</button>
          )}
          {shown.map((it) => {
            const cls = fresh.has(it.id) ? ' fresh' : '';
            if (it.k === 'round') return <div key={it.id} className={`rd${cls}`}><span>{it.label}</span></div>;
            if (it.k === 'hand')
              return (
                <div key={it.id} className={`hand ${it.dir}${cls}`}>
                  <Avatar name={it.e.actor_name} />
                  <div className="b">
                    <div className="hl">
                      <b>{it.e.actor_name}</b>
                      <span className="arrow">{it.dir === 'back' ? <Icon name="back" size={13} /> : it.dir === 'seal' ? <Icon name="lock" size={13} /> : '→'}</span>
                      <b>{it.dir === 'seal' ? 'Sealed' : it.to}</b>
                      <time dateTime={it.e.created_at}>{timeAgo(it.e.created_at)}</time>
                    </div>
                    <div className="what">{eventText(it.e.action)}</div>
                    {it.e.note && <div className="bubble">{it.e.note}</div>}
                  </div>
                </div>
              );
            if (it.k === 'note')
              return (
                <div key={it.id} className={`nt${it.mine ? ' mine' : ''}${cls}`}>
                  {!it.mine && <Avatar name={it.e.actor_name} />}
                  <div className="b">
                    <div className="hl">
                      {!it.mine && <b>{it.e.actor_name}</b>}
                      {it.reviewers && <span className="tag" title="The drafter doesn't see this note"><Icon name="lock" size={11} /> Reviewers</span>}
                      <time dateTime={it.e.created_at}>{timeAgo(it.e.created_at)}</time>
                    </div>
                    <div className="bubble">{it.e.note}</div>
                  </div>
                </div>
              );
            return (
              <div key={it.id} className={`sm${cls}`} title={it.names.filter(Boolean).join('\n')}>
                <span className="dotline" />
                <span>
                  {it.e.actor_name} {eventText(it.e.action)}{' '}
                  {it.count > 1 ? `${it.count} files` : it.e.note && <span className="mono">{it.e.note}</span>}
                </span>
                <time dateTime={it.e.created_at}>{timeAgo(it.e.created_at)}</time>
              </div>
            );
          })}
        </div>
      )}
      {slots.size > 0 && (
        <div className="composer">
          <textarea
            className="input"
            rows={2}
            placeholder={sealed ? 'Add a note to this revision' : 'Leave a note for the chain'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
          />
          <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
            <span className="hint" style={{ fontSize: 12 }}>{audience}</span>
            <button className="btn sm primary" disabled={busy || !text.trim()} onClick={send}>Post</button>
          </div>
        </div>
      )}
    </section>
  );
}
