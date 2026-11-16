import { useMemo, useState, type ReactNode } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';
import { Link } from '../router';
import { Empty, Loading, Modal, StatusBadge, errorMessage, useToast } from '../ui';
import { ManhattanChart, RunRateChart, WagonWheel } from '../charts';
import { formatDate, num, oversFromBalls, titleCase } from '../format';
import type { MatchDetail as MatchDetailType, MatchRules, Scorecard as ScorecardType } from '../types';

function ScorecardView({ card, rules, players }: {
  card: ScorecardType; rules: MatchRules; players: Record<string, string>;
}): ReactNode {
  const batting = card.batting as Array<Record<string, unknown>>;
  const bowling = card.bowling as Array<Record<string, unknown>>;
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr><th>Batter</th><th>How out</th><th className="num">R</th><th className="num">B</th><th className="num">4s</th><th className="num">6s</th><th className="num">SR</th></tr>
          </thead>
          <tbody>
            {batting.length === 0 && <tr><td colSpan={7} className="muted">No batting yet.</td></tr>}
            {batting.map((b, i) => (
              <tr key={i}>
                <td>
                  <span style={{ fontWeight: 600 }}>{String(b.player_name ?? players[String(b.player_id)] ?? '—')}</span>
                  {num(b.is_not_out) === 1 && <span className="em"> *</span>}
                </td>
                <td className="muted">{String(b.dismissal_detail ?? (num(b.is_not_out) === 1 ? 'not out' : '—'))}</td>
                <td className="num"><b>{num(b.runs)}</b></td>
                <td className="num">{num(b.balls)}</td>
                <td className="num">{num(b.fours)}</td>
                <td className="num">{num(b.sixes)}</td>
                <td className="num">{num(b.strike_rate).toFixed(2)}</td>
              </tr>
            ))}
            <tr className="total">
              <td>Extras</td>
              <td className="muted">
                b {card.extras.byes} · lb {card.extras.legByes} · w {card.extras.wides} · nb {card.extras.noBall} · p {card.extras.penalty}
              </td>
              <td className="num">{card.extras.total}</td><td colSpan={4} />
            </tr>
            <tr className="total">
              <td>Total</td>
              <td className="muted">{card.total.wickets} wicket{card.total.wickets === 1 ? '' : 's'}</td>
              <td className="num">{card.total.runs}</td>
              <td className="num" colSpan={4}>{card.total.overs} overs</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr><th>Bowler</th><th className="num">O</th><th className="num">M</th><th className="num">R</th><th className="num">W</th><th className="num">Econ</th><th className="num">Wd</th><th className="num">Nb</th></tr>
          </thead>
          <tbody>
            {bowling.length === 0 && <tr><td colSpan={8} className="muted">No bowling yet.</td></tr>}
            {bowling.map((b, i) => (
              <tr key={i}>
                <td style={{ fontWeight: 600 }}>{String(b.player_name ?? players[String(b.player_id)] ?? '—')}</td>
                <td className="num">{String(b.overs_text ?? oversFromBalls(num(b.legal_balls), rules.ballsPerOver))}</td>
                <td className="num">{num(b.maidens)}</td>
                <td className="num">{num(b.runs_conceded)}</td>
                <td className="num"><b>{num(b.wickets)}</b></td>
                <td className="num">{num(b.economy).toFixed(2)}</td>
                <td className="num">{num(b.wides)}</td>
                <td className="num">{num(b.no_balls)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {card.fallOfWickets.length > 0 && (
        <div className="card">
          <div className="card-title mb">Fall of wickets</div>
          <div className="row wrap" style={{ gap: 14 }}>
            {card.fallOfWickets.map((w, i) => (
              <span key={i} className="pill">
                {String(w.wicket_number)}-{String(w.runs)} {String(w.batter_name ?? players[String(w.batter_id)] ?? '')} ({String(w.over)})
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function MatchDetail({ matchId }: { matchId: string }): ReactNode {
  const toast = useToast();
  const [tab, setTab] = useState('summary');
  const [pomOpen, setPomOpen] = useState(false);
  const detail = useAsync<MatchDetailType>(() => api.match(matchId) as Promise<MatchDetailType>, [matchId]);
  const stats = useAsync(() => api.matchStats(matchId), [matchId]);

  const players = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of detail.data?.squads ?? []) map[s.player_id] = s.full_name;
    return map;
  }, [detail.data]);

  if (detail.loading && !detail.data) return <Loading label="Loading match…" />;
  if (detail.error && !detail.data) return <Empty title="Could not load the match" hint={detail.error} />;
  if (!detail.data) return <Empty title="Match not found" />;

  const { match, rules, teamA, teamB, innings, result, live } = detail.data;
  const finished = result.resultType !== 'IN_PROGRESS';
  const firstInningsStats = (stats.data?.stats as { perInnings?: Array<Record<string, unknown>> })?.perInnings?.[0];

  const setPom = async (playerId: string) => {
    try {
      await api.setPlayerOfMatch(matchId, playerId);
      toast.push('Player of the match saved.', 'success');
      setPomOpen(false);
      detail.reload();
    } catch (error) { toast.push(errorMessage(error), 'error'); }
  };

  const finalize = async () => {
    try { await api.finalizeMatch(matchId); toast.push('Career statistics recomputed.', 'success'); }
    catch (error) { toast.push(errorMessage(error), 'error'); }
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="score-hero">
        <div className="row between wrap">
          <div className="row" style={{ gap: 10 }}>
            <span className="pill">{match.format}</span>
            <StatusBadge status={match.status} />
            {match.venue && <span className="muted" style={{ fontSize: '0.86rem' }}>{match.venue}</span>}
            <span className="dim" style={{ fontSize: '0.86rem' }}>{formatDate(match.match_date)}</span>
          </div>
          <div className="btn-row">
            {!finished && <Link to={`/matches/${matchId}/score`} className="btn primary sm">Open scoring</Link>}
            {finished && <button className="btn ghost sm" onClick={() => void finalize()}>Recompute stats</button>}
          </div>
        </div>
        <div className="row wrap" style={{ gap: 22, marginTop: 14, alignItems: 'center' }}>
          <div style={{ fontWeight: 700, fontSize: '1.15rem' }}>{teamA.name} <span className="muted">vs</span> {teamB.name}</div>
          {finished && <div className="em" style={{ fontWeight: 650 }}>{result.summary}</div>}
        </div>
        {live.battingTeam && live.inningsStatus === 'in_progress' && (
          <div className="score-line" style={{ marginTop: 12 }}>
            <span className="score-big" style={{ fontSize: '2.2rem' }}>{live.score}/{live.wickets}</span>
            <span className="score-overs">({live.overs} ov)</span>
            {live.target !== null && <span className="muted">· target {live.target}</span>}
          </div>
        )}
        {result.dls && !result.dls.available && (
          <div className="dim" style={{ fontSize: '0.78rem', marginTop: 10 }}>DLS not available: {result.dls.reason}</div>
        )}
      </div>

      <div className="tabs">
        {[['summary', 'Summary'], ['scorecard', 'Scorecard'], ['statistics', 'Statistics'], ['squads', 'Squads']].map(([key, label]) => (
          <div key={key} className={tab === key ? 'tab active' : 'tab'} onClick={() => setTab(key)}>{label}</div>
        ))}
      </div>

      {tab === 'summary' && (
        <div className="col" style={{ gap: 16 }}>
          {innings.length === 0 ? <Empty title="No innings yet" hint="Open the scoring screen to start the match." /> : innings.map((card) => (
            <section key={card.innings.id} className="card">
              <div className="card-head">
                <span className="card-title">Innings {card.innings.innings_number} · {card.innings.batting_team_id === teamA.id ? teamA.name : teamB.name}</span>
                <span className="mono" style={{ fontWeight: 700 }}>{card.total.runs}/{card.total.wickets} <span className="muted">({card.total.overs})</span></span>
              </div>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Batter</th><th className="num">R</th><th className="num">B</th><th>Bowler</th><th className="num">O</th><th className="num">R</th><th className="num">W</th></tr></thead>
                  <tbody>
                    {(card.batting as Array<Record<string, unknown>>).slice(0, 4).map((b, i) => {
                      const bw = (card.bowling as Array<Record<string, unknown>>)[i];
                      return (
                        <tr key={i}>
                          <td>{String(b.player_name)}</td>
                          <td className="num">{num(b.runs)}</td>
                          <td className="num">{num(b.balls)}</td>
                          <td className="muted">{bw ? String(bw.player_name) : ''}</td>
                          <td className="num">{bw ? String(bw.overs_text ?? '') : ''}</td>
                          <td className="num">{bw ? num(bw.runs_conceded) : ''}</td>
                          <td className="num">{bw ? num(bw.wickets) : ''}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}

      {tab === 'scorecard' && (innings.length === 0 ? <Empty title="No scorecard yet" /> : innings.map((card) => (
        <section key={card.innings.id} className="card">
          <div className="card-head"><span className="card-title">Innings {card.innings.innings_number}</span><span className="mono">{card.total.runs}/{card.total.wickets} ({card.total.overs})</span></div>
          <ScorecardView card={card} rules={rules} players={players} />
        </section>
      )))}

      {tab === 'statistics' && (
        stats.loading ? <Loading /> : !stats.data ? <Empty title="Statistics unavailable" /> : (
          <div className="col" style={{ gap: 16 }}>
            <div className="grid cols-2">
              <section className="card">
                <div className="card-head"><span className="card-title">Manhattan (runs per over)</span></div>
                <ManhattanChart data={(firstInningsStats?.manhattan as Array<Record<string, unknown>>) ?? []} />
              </section>
              <section className="card">
                <div className="card-head"><span className="card-title">Run rate</span></div>
                <RunRateChart data={(firstInningsStats?.runRateGraph as Array<Record<string, unknown>>) ?? []} />
              </section>
            </div>
            <section className="card">
              <div className="card-head"><span className="card-title">Wagon wheel</span></div>
              <WagonWheel shots={(firstInningsStats?.wagonWheel as Array<Record<string, unknown>>) ?? []} />
            </section>
          </div>
        )
      )}

      {tab === 'squads' && (
        <div className="grid cols-2">
          {[teamA, teamB].map((team) => (
            <section key={team.id} className="card">
              <div className="card-head"><span className="card-title">{team.name}</span></div>
              <div className="col" style={{ gap: 0 }}>
                {(detail.data!.squads).filter((s) => s.team_id === team.id).map((s) => (
                  <div key={s.player_id} className="list-row">
                    <div className="grow">{s.full_name}</div>
                    {s.is_captain === 1 && <span className="badge info">C</span>}
                    {s.is_wicketkeeper === 1 && <span className="badge">WK</span>}
                    {s.in_playing_xi === 0 && <span className="badge muted">Sub</span>}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <div className="row wrap between">
        <div className="dim" style={{ fontSize: '0.82rem' }}>
          Player of the match: <b>{match.player_of_match_id ? players[match.player_of_match_id] ?? '—' : 'not set'}</b>
        </div>
        {finished && <button className="btn ghost sm" onClick={() => setPomOpen(true)}>Set player of the match</button>}
      </div>

      {pomOpen && (
        <Modal title="Player of the match" onClose={() => setPomOpen(false)}>
          <div className="col" style={{ gap: 6, maxHeight: 400, overflowY: 'auto' }}>
            {detail.data.squads.filter((s) => s.in_playing_xi === 1).map((s) => (
              <button key={s.player_id} className="squad-pick" onClick={() => void setPom(s.player_id)}>
                <div className="grow" style={{ textAlign: 'left' }}>{s.full_name}</div>
                <span className="dim" style={{ fontSize: '0.8rem' }}>{titleCase(s.playing_role)}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
