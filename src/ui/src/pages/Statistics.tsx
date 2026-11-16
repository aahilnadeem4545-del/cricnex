import { useState, type ReactNode } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';
import { BarList } from '../charts';
import { Empty, Loading, errorMessage, useToast } from '../ui';
import { num } from '../format';

export function Statistics(): ReactNode {
  const toast = useToast();
  const [limit, setLimit] = useState(20);
  const state = useAsync(() => api.leaderboards(limit) as Promise<{ batting: Array<Record<string, unknown>>; bowling: Array<Record<string, unknown>> }>, [limit]);
  const [busy, setBusy] = useState(false);

  const recompute = async () => {
    setBusy(true);
    try { await api.recomputeStats(); toast.push('Career statistics recomputed from the delivery log.', 'success'); state.reload(); }
    catch (error) { toast.push(errorMessage(error), 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row between wrap">
        <div className="chips">
          {[10, 20, 50].map((n) => <button key={n} className={limit === n ? 'chip active' : 'chip'} onClick={() => setLimit(n)}>Top {n}</button>)}
        </div>
        <button className="btn ghost sm" onClick={() => void recompute()} disabled={busy}>Recompute careers</button>
      </div>

      {state.loading ? <Loading /> : state.error ? <Empty title="Could not load statistics" hint={state.error} /> : (
        <div className="grid cols-2">
          <section className="card">
            <div className="card-head"><span className="card-title">Batting leaderboard</span></div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Player</th><th className="num">Inns</th><th className="num">Runs</th><th className="num">HS</th><th className="num">Avg</th><th className="num">SR</th></tr></thead>
                <tbody>
                  {(state.data?.batting ?? []).map((b, i) => (
                    <tr key={i}>
                      <td><span style={{ fontWeight: 600 }}>{String(b.full_name)}</span><div className="dim" style={{ fontSize: '0.78rem' }}>{String(b.team_name ?? '')}</div></td>
                      <td className="num">{num(b.innings)}</td>
                      <td className="num"><b>{num(b.runs)}</b></td>
                      <td className="num">{num(b.highest_score)}{num(b.highest_not_out) ? '*' : ''}</td>
                      <td className="num">{num(b.average).toFixed(2)}</td>
                      <td className="num">{num(b.strike_rate).toFixed(2)}</td>
                    </tr>
                  ))}
                  {(state.data?.batting.length ?? 0) === 0 && <tr><td colSpan={6} className="muted">No batting data yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card">
            <div className="card-head"><span className="card-title">Bowling leaderboard</span></div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Player</th><th className="num">Wkts</th><th className="num">Best</th><th className="num">Avg</th><th className="num">Econ</th></tr></thead>
                <tbody>
                  {(state.data?.bowling ?? []).map((b, i) => (
                    <tr key={i}>
                      <td><span style={{ fontWeight: 600 }}>{String(b.full_name)}</span><div className="dim" style={{ fontSize: '0.78rem' }}>{String(b.team_name ?? '')}</div></td>
                      <td className="num"><b>{num(b.wickets)}</b></td>
                      <td className="num">{b.best_bowling ? String(b.best_bowling) : '—'}</td>
                      <td className="num">{b.bowling_average != null ? num(b.bowling_average).toFixed(2) : '—'}</td>
                      <td className="num">{b.economy != null ? num(b.economy).toFixed(2) : '—'}</td>
                    </tr>
                  ))}
                  {(state.data?.bowling.length ?? 0) === 0 && <tr><td colSpan={5} className="muted">No bowling data yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card">
            <div className="card-head"><span className="card-title">Runs chart</span></div>
            <BarList items={(state.data?.batting ?? []).slice(0, 10)} labelKey="full_name" valueKey="runs" />
          </section>
          <section className="card">
            <div className="card-head"><span className="card-title">Wickets chart</span></div>
            <BarList items={(state.data?.bowling ?? []).slice(0, 10)} labelKey="full_name" valueKey="wickets" />
          </section>
        </div>
      )}
    </div>
  );
}
