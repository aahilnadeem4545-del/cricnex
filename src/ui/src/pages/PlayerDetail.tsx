import type { ReactNode } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';
import { Avatar, Empty, Loading, StatCard } from '../ui';
import { titleCase } from '../format';
import type { Career, Player } from '../types';

export function PlayerDetail({ playerId }: { playerId: string }): ReactNode {
  const state = useAsync(() => api.player(playerId) as Promise<{ player: Player }>, [playerId]);

  if (state.loading && !state.data) return <Loading label="Loading player…" />;
  if (state.error && !state.data) return <Empty title="Could not load the player" hint={state.error} />;
  if (!state.data) return <Empty title="Player not found" />;

  const player = state.data.player;
  const career = player.career as Career | null | undefined;

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card pad-lg">
        <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
          <Avatar name={player.full_name} large />
          <div className="grow">
            <h1>{player.full_name}</h1>
            <div className="muted">
              {player.playing_role || 'Player'}
              {player.jersey_number != null ? ` · #${player.jersey_number}` : ''}
              {player.team_name ? ` · ${player.team_name}` : ''}
            </div>
            <div className="row wrap" style={{ gap: 18, marginTop: 12 }}>
              {player.batting_style && <span className="pill">{player.batting_style}</span>}
              {player.bowling_style && <span className="pill">{player.bowling_style}</span>}
            </div>
          </div>
        </div>
      </div>

      {!career || career.matches === 0 ? (
        <Empty title="No career statistics yet" hint="Statistics appear once this player has taken part in a scored match." />
      ) : (
        <>
          <h2 className="mt-sm">Batting</h2>
          <div className="grid cols-4">
            <StatCard value={career.matches} label="Matches" />
            <StatCard value={career.runs} label="Runs" accent />
            <StatCard value={`${career.highest_score}${career.highest_not_out ? '*' : ''}`} label="Highest" />
            <StatCard value={career.average.toFixed(2)} label="Average" />
            <StatCard value={career.strike_rate.toFixed(2)} label="Strike rate" />
            <StatCard value={career.fours} label="Fours" />
            <StatCard value={career.sixes} label="Sixes" />
            <StatCard value={career.not_outs} label="Not outs" />
          </div>

          <h2 className="mt-sm">Bowling &amp; fielding</h2>
          <div className="grid cols-4">
            <StatCard value={career.wickets} label="Wickets" accent />
            <StatCard value={career.best_bowling ?? '—'} label="Best bowling" />
            <StatCard value={career.bowling_average != null ? career.bowling_average.toFixed(2) : '—'} label="Bowling avg" />
            <StatCard value={career.economy != null ? career.economy.toFixed(2) : '—'} label="Economy" />
            <StatCard value={career.catches} label="Catches" />
            <StatCard value={career.run_outs} label="Run outs" />
            <StatCard value={career.balls} label="Balls faced" />
            <StatCard value={career.innings} label="Innings" />
          </div>
        </>
      )}

      {(player.teams?.length ?? 0) > 0 && (
        <section className="card">
          <div className="card-head"><span className="card-title">Teams</span></div>
          <div className="row wrap">
            {player.teams!.map((t) => <span key={t.id} className="pill">{t.name}</span>)}
          </div>
        </section>
      )}
    </div>
  );
}
