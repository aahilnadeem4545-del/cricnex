import type { ReactNode } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';
import { Link } from '../router';
import { Empty, Loading, StatCard, StatusBadge } from '../ui';
import { BarList } from '../charts';
import { formatDate, num, relativeTime } from '../format';
import type { Dashboard, MatchSummary } from '../types';

function MatchCard({ match }: { match: MatchSummary }): ReactNode {
  return (
    <Link to={`/matches/${match.id}`} className="card hover" style={{ display: 'block' }}>
      <div className="row between" style={{ marginBottom: 8 }}>
        <span className="pill">{match.format}</span>
        <StatusBadge status={match.status} />
      </div>
      <div style={{ fontWeight: 650 }} className="ellipsis">{match.title}</div>
      <div className="muted" style={{ fontSize: '0.88rem', marginTop: 3 }}>{match.team_a_name} vs {match.team_b_name}</div>
      <div className="dim" style={{ fontSize: '0.82rem', marginTop: 6 }}>
        {match.result_summary || (match.venue ? match.venue : relativeTime(match.match_date || match.created_at))}
      </div>
    </Link>
  );
}

export function Home(): ReactNode {
  const { data, loading, error } = useAsync<Dashboard>(() => api.dashboard() as Promise<Dashboard>);

  if (loading) return <Loading label="Loading dashboard…" />;
  if (error) return <Empty title="Could not load the dashboard" hint={error} />;
  if (!data) return <Empty title="No data" />;

  const { counts, live, recent, upcoming, topBatting, topBowling } = data;

  return (
    <div className="col" style={{ gap: 18 }}>
      <div className="grid cols-4">
        <StatCard value={counts.live} label="Live matches" accent={counts.live > 0} />
        <StatCard value={counts.matches} label="Matches played" />
        <StatCard value={counts.deliveries.toLocaleString()} label="Balls recorded" />
        <StatCard value={counts.players} label="Players" hint={`${counts.teams} teams · ${counts.tournaments} tournaments`} />
      </div>

      <div className="grid cols-2">
        <section className="card">
          <div className="card-head">
            <span className="card-title">Live &amp; in progress</span>
            <Link to="/matches?status=LIVE" className="btn ghost sm">All matches</Link>
          </div>
          {live.length === 0
            ? <Empty title="No match is live right now" hint="Create a match and record the toss to get scoring." action={<Link to="/matches/new" className="btn primary sm">Create match</Link>} />
            : <div className="grid" style={{ gap: 10 }}>{live.map((m) => <MatchCard key={m.id} match={m} />)}</div>}
        </section>

        <section className="card">
          <div className="card-head"><span className="card-title">Recent results</span></div>
          {recent.length === 0
            ? <Empty title="No completed matches yet" />
            : (
              <div className="col" style={{ gap: 0 }}>
                {recent.map((m) => (
                  <Link key={m.id} to={`/matches/${m.id}`} className="list-row">
                    <div className="grow">
                      <div className="ellipsis" style={{ fontWeight: 600, fontSize: '0.92rem' }}>{m.team_a_name} vs {m.team_b_name}</div>
                      <div className="dim ellipsis" style={{ fontSize: '0.82rem' }}>{m.result_summary || m.title}</div>
                    </div>
                    <div className="dim nowrap" style={{ fontSize: '0.8rem' }}>{formatDate(m.match_date || m.created_at)}</div>
                  </Link>
                ))}
              </div>
            )}
        </section>
      </div>

      <div className="grid cols-2">
        <section className="card">
          <div className="card-head"><span className="card-title">Top run scorers</span><Link to="/stats" className="btn ghost sm">Statistics</Link></div>
          <BarList items={topBatting} labelKey="full_name" valueKey="runs" />
        </section>
        <section className="card">
          <div className="card-head"><span className="card-title">Top wicket takers</span><Link to="/stats" className="btn ghost sm">Statistics</Link></div>
          <BarList items={topBowling} labelKey="full_name" valueKey="wickets" />
        </section>
      </div>

      {upcoming.length > 0 && (
        <section className="card">
          <div className="card-head"><span className="card-title">Upcoming fixtures</span><Link to="/tournaments" className="btn ghost sm">Tournaments</Link></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Fixture</th><th>Round</th><th>Scheduled</th><th className="num">Match #</th></tr></thead>
              <tbody>
                {upcoming.map((f, i) => (
                  <tr key={i}>
                    <td>{String(f.team_a_name)} vs {String(f.team_b_name)}</td>
                    <td className="muted">{String(f.round ?? '—')}</td>
                    <td className="muted">{f.scheduled_at ? formatDate(String(f.scheduled_at)) : '—'}</td>
                    <td className="num muted">{num(f.match_number, 0) || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
