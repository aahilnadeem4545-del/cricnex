import { useState, type ReactNode } from 'react';
import { api } from '../api';
import { useAsync, useDebounced } from '../hooks';
import { Link } from '../router';
import { useAuth } from '../auth';
import { Avatar, Empty, Loading, Modal, errorMessage, useToast } from '../ui';
import type { Player, Team } from '../types';

export function TeamDetail({ teamId }: { teamId: string }): ReactNode {
  const { can } = useAuth();
  const toast = useToast();
  const state = useAsync(() => api.team(teamId) as Promise<{ team: Team }>, [teamId]);
  const [addOpen, setAddOpen] = useState(false);
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 250);
  const candidates = useAsync(() => api.players(`?search=${encodeURIComponent(debounced)}&limit=50`) as Promise<{ items: Player[]; total: number }>, [debounced]);

  if (state.loading && !state.data) return <Loading label="Loading team…" />;
  if (state.error && !state.data) return <Empty title="Could not load the team" hint={state.error} />;
  if (!state.data) return <Empty title="Team not found" />;

  const team = state.data.team;
  const players = (team.players ?? []) as Player[];
  const record = team.record ?? {};

  const addPlayer = async (playerId: string) => {
    try { await api.addTeamPlayer(teamId, { playerId }); toast.push('Player added.', 'success'); state.reload(); }
    catch (error) { toast.push(errorMessage(error), 'error'); }
  };
  const removePlayer = async (playerId: string) => {
    try { await api.removeTeamPlayer(teamId, playerId); toast.push('Player removed.', 'success'); state.reload(); }
    catch (error) { toast.push(errorMessage(error), 'error'); }
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card pad-lg">
        <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
          <Avatar name={team.name} large />
          <div className="grow">
            <h1>{team.name}</h1>
            <div className="muted">{team.short_name || 'No short name'}{team.coach ? ` · Coach: ${team.coach}` : ''}</div>
            <div className="row wrap" style={{ gap: 22, marginTop: 12 }}>
              <span className="pill">{players.length} players</span>
              <span className="pill">{record.played ?? 0} played</span>
              <span className="badge ok">{record.won ?? 0} won</span>
              <span className="badge warn">{record.lost ?? 0} lost</span>
            </div>
          </div>
          {can('admin', 'scorer') && <button className="btn primary sm" onClick={() => setAddOpen(true)}>Add player</button>}
        </div>
      </div>

      <section className="card">
        <div className="card-head"><span className="card-title">Squad</span></div>
        {players.length === 0 ? <Empty title="No players yet" hint="Add players to build this squad." /> : (
          <div className="col" style={{ gap: 0 }}>
            {players.map((p) => (
              <div key={p.id} className="list-row">
                <Link to={`/players/${p.id}`} className="row grow" style={{ gap: 12, minWidth: 0 }}>
                  <Avatar name={p.full_name} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="ellipsis" style={{ fontWeight: 600 }}>{p.full_name}</div>
                    <div className="dim" style={{ fontSize: '0.82rem' }}>
                      {p.playing_role || 'Player'}{p.batting_style ? ` · ${p.batting_style}` : ''}
                    </div>
                  </div>
                </Link>
                {(p as unknown as { is_captain?: number }).is_captain === 1 && <span className="badge info">C</span>}
                {(p as unknown as { is_wicketkeeper?: number }).is_wicketkeeper === 1 && <span className="badge">WK</span>}
                {can('admin', 'scorer') && <button className="btn ghost sm" onClick={() => void removePlayer(p.id)}>Remove</button>}
              </div>
            ))}
          </div>
        )}
      </section>

      {addOpen && (
        <Modal title="Add a player to the squad" onClose={() => setAddOpen(false)} wide>
          <input className="input mb" placeholder="Search players by name…" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
          {candidates.loading ? <Loading /> : (
            <div className="col" style={{ gap: 6, maxHeight: 380, overflowY: 'auto' }}>
              {(candidates.data?.items ?? []).map((p) => (
                <button key={p.id} className="squad-pick" onClick={() => void addPlayer(p.id)}>
                  <div className="grow" style={{ textAlign: 'left' }}>
                    <div>{p.full_name}</div>
                    <div className="dim" style={{ fontSize: '0.8rem' }}>{p.team_name ? `Currently: ${p.team_name}` : 'Free agent'}</div>
                  </div>
                  <span className="em">+ Add</span>
                </button>
              ))}
              {(candidates.data?.items.length ?? 0) === 0 && <Empty title="No players found" hint="Create players from the Players page first." />}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
