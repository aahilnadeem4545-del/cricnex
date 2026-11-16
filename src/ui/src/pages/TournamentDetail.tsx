import { useState, type ReactNode } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';
import { useAuth } from '../auth';
import { BarList } from '../charts';
import { Empty, Loading, Modal, errorMessage, useToast } from '../ui';
import { formatDate, num } from '../format';
import type { Team, TournamentDetail as TDetail } from '../types';

export function TournamentDetail({ tournamentId }: { tournamentId: string }): ReactNode {
  const { can } = useAuth();
  const toast = useToast();
  const state = useAsync(() => api.tournament(tournamentId) as Promise<TDetail>, [tournamentId]);
  const teams = useAsync(() => api.teams() as Promise<{ teams: Team[] }>);
  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  if (state.loading && !state.data) return <Loading label="Loading tournament…" />;
  if (state.error && !state.data) return <Empty title="Could not load the tournament" hint={state.error} />;
  if (!state.data) return <Empty title="Tournament not found" />;

  const { tournament, teams: registered, fixtures, pointsTable, leaderboards } = state.data;
  const editable = can('admin', 'scorer');
  const registeredIds = new Set(registered.map((t) => t.id));
  const available = (teams.data?.teams ?? []).filter((t) => !registeredIds.has(t.id));

  const run = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try { await fn(); toast.push(message, 'success'); state.reload(); }
    catch (error) { toast.push(errorMessage(error), 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card pad-lg">
        <div className="row between wrap">
          <div>
            <h1>{tournament.name}</h1>
            <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
              <span className="pill">{tournament.format}</span>
              <span className={`badge ${tournament.status === 'active' ? 'ok' : 'muted'}`}>{tournament.status}</span>
              <span className="pill">{registered.length} teams</span>
              <span className="pill">{fixtures.length} fixtures</span>
            </div>
          </div>
          {editable && (
            <div className="btn-row">
              <button className="btn ghost sm" onClick={() => setAddOpen(true)} disabled={busy}>Add teams</button>
              {fixtures.length === 0
                ? <button className="btn sm" onClick={() => void run(() => api.generateFixtures(tournamentId, {}), 'Fixtures generated.')} disabled={busy || registered.length < 2}>Generate fixtures</button>
                : <button className="btn sm" onClick={() => void run(() => api.recomputePoints(tournamentId), 'Points table recomputed.')} disabled={busy}>Recompute table</button>}
            </div>
          )}
        </div>
      </div>

      <div className="grid cols-2">
        <section className="card">
          <div className="card-head"><span className="card-title">Points table</span></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Team</th><th className="num">P</th><th className="num">W</th><th className="num">L</th><th className="num">T</th><th className="num">NR</th><th className="num">Pts</th><th className="num">NRR</th></tr></thead>
              <tbody>
                {pointsTable.length === 0 && <tr><td colSpan={8} className="muted">No results yet.</td></tr>}
                {pointsTable.map((row, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 600 }}>{String(row.team_name)}</td>
                    <td className="num">{num(row.played)}</td>
                    <td className="num">{num(row.won)}</td>
                    <td className="num">{num(row.lost)}</td>
                    <td className="num">{num(row.tied)}</td>
                    <td className="num">{num(row.no_result)}</td>
                    <td className="num"><b>{num(row.points)}</b></td>
                    <td className="num">{num(row.nrr).toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card">
          <div className="card-head"><span className="card-title">Registered teams</span></div>
          {registered.length === 0 ? <Empty title="No teams registered" /> : (
            <div className="row wrap">{registered.map((t) => <span key={t.id} className="pill">{t.name}</span>)}</div>
          )}
        </section>
      </div>

      <section className="card">
        <div className="card-head"><span className="card-title">Fixtures</span></div>
        {fixtures.length === 0 ? <Empty title="No fixtures yet" hint="Generate a round-robin schedule from the registered teams." /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th className="num">#</th><th>Round</th><th>Match</th><th>Scheduled</th><th>Status</th></tr></thead>
              <tbody>
                {fixtures.map((f, i) => (
                  <tr key={i}>
                    <td className="num muted">{num(f.match_number) || '—'}</td>
                    <td className="muted">{String(f.round ?? '—')}</td>
                    <td>{String(f.team_a_name)} <span className="muted">vs</span> {String(f.team_b_name)}</td>
                    <td className="muted">{f.scheduled_at ? formatDate(String(f.scheduled_at)) : '—'}</td>
                    <td><span className="badge muted">{String(f.status ?? 'scheduled')}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid cols-2">
        <section className="card">
          <div className="card-head"><span className="card-title">Most runs</span></div>
          <BarList items={leaderboards.batting} labelKey="full_name" valueKey="runs" />
        </section>
        <section className="card">
          <div className="card-head"><span className="card-title">Most wickets</span></div>
          <BarList items={leaderboards.bowling} labelKey="full_name" valueKey="wickets" />
        </section>
      </div>

      {addOpen && (
        <Modal title="Add teams to the tournament" onClose={() => setAddOpen(false)} footer={
          <>
            <button className="btn ghost" onClick={() => setAddOpen(false)}>Cancel</button>
            <button className="btn primary" disabled={busy || selected.length === 0}
              onClick={() => void run(async () => { await api.addTournamentTeams(tournamentId, { teamIds: selected }); setSelected([]); setAddOpen(false); }, 'Teams added.')}>
              Add {selected.length || ''} team{selected.length === 1 ? '' : 's'}
            </button>
          </>
        }>
          {available.length === 0 ? <Empty title="All teams are already registered" /> : (
            <div className="col" style={{ gap: 6 }}>
              {available.map((t) => (
                <div key={t.id} className={selected.includes(t.id) ? 'squad-pick on' : 'squad-pick'}
                  onClick={() => setSelected((s) => (s.includes(t.id) ? s.filter((x) => x !== t.id) : [...s, t.id]))}>
                  <span style={{ width: 18 }}>{selected.includes(t.id) ? '✓' : ''}</span>
                  <div className="grow">{t.name}</div>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
