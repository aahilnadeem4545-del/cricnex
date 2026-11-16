import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';
import { navigate } from '../router';
import { Empty, Loading, errorMessage, useToast } from '../ui';
import type { Player, Team } from '../types';

const FORMATS = ['TEST', 'ODI', 'T20', 'T10', 'CUSTOM', 'TENNIS_BALL', 'TAPE_BALL', 'LOCAL'];
const FORMAT_LABEL: Record<string, string> = {
  TEST: 'Test', ODI: 'ODI', T20: 'T20', T10: 'T10', CUSTOM: 'Custom',
  TENNIS_BALL: 'Tennis ball', TAPE_BALL: 'Tape ball', LOCAL: 'Local / gully',
};

interface SquadEntry { playerId: string; inPlayingXI: boolean; isCaptain: boolean; isWicketkeeper: boolean }

export function CreateMatch(): ReactNode {
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);

  const teamsState = useAsync(() => api.teams() as Promise<{ teams: Team[] }>);

  const [title, setTitle] = useState('');
  const [format, setFormat] = useState('T20');
  const [venue, setVenue] = useState('');
  const [matchDate, setMatchDate] = useState('');
  const [teamAId, setTeamAId] = useState('');
  const [teamBId, setTeamBId] = useState('');
  const [squads, setSquads] = useState<Record<string, SquadEntry[]>>({});
  const [tossWinner, setTossWinner] = useState('');
  const [tossDecision, setTossDecision] = useState<'BAT' | 'BOWL'>('BAT');

  const teams = teamsState.data?.teams ?? [];
  const teamA = teams.find((t) => t.id === teamAId);
  const teamB = teams.find((t) => t.id === teamBId);

  // Load each selected team's players and default the whole squad to the XI.
  useEffect(() => {
    let alive = true;
    (async () => {
      for (const id of [teamAId, teamBId]) {
        if (!id) continue;
        try {
          const { team } = await api.team(id) as { team: Team };
          if (!alive) return;
          const players = (team.players ?? []) as Player[];
          setSquads((prev) => {
            if (prev[id]?.length) return prev;
            return {
              ...prev,
              [id]: players.map((p, i) => ({ playerId: p.id, inPlayingXI: true, isCaptain: i === 0, isWicketkeeper: i === 1 })),
            };
          });
        } catch (error) {
          toast.push(errorMessage(error), 'error');
        }
      }
    })();
    return () => { alive = false; };
  }, [teamAId, teamBId, toast]);

  const steps = ['Match', 'Teams', 'Squads', 'Toss', 'Review'];
  const canNext = useMemo(() => {
    if (step === 0) return title.trim().length > 0;
    if (step === 1) return !!teamAId && !!teamBId && teamAId !== teamBId;
    if (step === 2) return [teamAId, teamBId].every((id) => (squads[id]?.filter((s) => s.inPlayingXI).length ?? 0) >= 2);
    return true;
  }, [step, title, teamAId, teamBId, squads]);

  const toggleEntry = (teamId: string, playerId: string, patch: Partial<SquadEntry>) => {
    setSquads((prev) => ({
      ...prev,
      [teamId]: (prev[teamId] ?? []).map((e) => (e.playerId === playerId ? { ...e, ...patch } : e)),
    }));
  };

  const submit = async () => {
    setBusy(true);
    try {
      const body = {
        title: title.trim(),
        format,
        venue: venue.trim() || null,
        matchDate: matchDate ? new Date(matchDate).toISOString() : null,
        teamAId, teamBId,
        squads: {
          teamA: (squads[teamAId] ?? []).filter((s) => s.inPlayingXI),
          teamB: (squads[teamBId] ?? []).filter((s) => s.inPlayingXI),
        },
        toss: tossWinner ? { winnerTeamId: tossWinner, decision: tossDecision } : null,
      };
      const { match } = await api.createMatch(body) as { match: { id: string } };
      toast.push('Match created.', 'success');
      navigate(`/matches/${match.id}/score`);
    } catch (error) {
      toast.push(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (teamsState.loading) return <Loading label="Loading teams…" />;
  if (teamsState.error) return <Empty title="Could not load teams" hint={teamsState.error} />;
  if (teams.length < 2) {
    return <Empty title="You need at least two teams" hint="Add teams and players first, then create a match." />;
  }

  return (
    <div className="col" style={{ gap: 18 }}>
      <div className="wizard-steps">
        {steps.map((label, i) => (
          <div key={label} className={`wizard-step ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}>
            <span className="n">{i < step ? '✓' : i + 1}</span>{label}
          </div>
        ))}
      </div>

      {step === 0 && (
        <div className="card pad-lg">
          <h2 className="mb">Match details</h2>
          <div className="form-grid">
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Title</label>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. City Cup Final" />
            </div>
            <div className="field">
              <label>Format</label>
              <select className="select" value={format} onChange={(e) => setFormat(e.target.value)}>
                {FORMATS.map((f) => <option key={f} value={f}>{FORMAT_LABEL[f]}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Date</label>
              <input className="input" type="datetime-local" value={matchDate} onChange={(e) => setMatchDate(e.target.value)} />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Venue</label>
              <input className="input" value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="Ground name" />
            </div>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="card pad-lg">
          <h2 className="mb">Choose the two teams</h2>
          <div className="form-grid">
            <div className="field">
              <label>Team A</label>
              <select className="select" value={teamAId} onChange={(e) => setTeamAId(e.target.value)}>
                <option value="">Select…</option>
                {teams.filter((t) => t.id !== teamBId).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Team B</label>
              <select className="select" value={teamBId} onChange={(e) => setTeamBId(e.target.value)}>
                <option value="">Select…</option>
                {teams.filter((t) => t.id !== teamAId).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          </div>
          {teamA && teamB && (
            <div className="row" style={{ marginTop: 18, justifyContent: 'center', gap: 18, fontWeight: 700, fontSize: '1.1rem' }}>
              <span>{teamA.name}</span><span className="muted">vs</span><span>{teamB.name}</span>
            </div>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="grid cols-2">
          {[teamAId, teamBId].map((teamId) => {
            const team = teams.find((t) => t.id === teamId);
            const entries = squads[teamId] ?? [];
            return (
              <div className="card" key={teamId}>
                <div className="card-head">
                  <span className="card-title">{team?.name ?? 'Team'}</span>
                  <span className="pill">{entries.filter((e) => e.inPlayingXI).length} in XI</span>
                </div>
                {entries.length === 0 ? <Empty title="No players on this team" hint="Add players to the team first." /> : (
                  <div className="col" style={{ gap: 6 }}>
                    {entries.map((entry) => {
                      const player = ((team as unknown as { players?: Player[] })?.players ?? []).find((p) => p.id === entry.playerId);
                      return (
                        <div key={entry.playerId} className={entry.inPlayingXI ? 'squad-pick on' : 'squad-pick'} onClick={() => toggleEntry(teamId, entry.playerId, { inPlayingXI: !entry.inPlayingXI })}>
                          <span style={{ width: 18 }}>{entry.inPlayingXI ? '✓' : ''}</span>
                          <div className="grow ellipsis">{player?.full_name ?? entry.playerId}</div>
                          <div className="flags" onClick={(e) => e.stopPropagation()}>
                            <button className={entry.isCaptain ? 'chip active' : 'chip'} style={{ padding: '3px 9px' }} onClick={() => toggleEntry(teamId, entry.playerId, { isCaptain: !entry.isCaptain })}>C</button>
                            <button className={entry.isWicketkeeper ? 'chip active' : 'chip'} style={{ padding: '3px 9px' }} onClick={() => toggleEntry(teamId, entry.playerId, { isWicketkeeper: !entry.isWicketkeeper })}>WK</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {step === 3 && (
        <div className="card pad-lg">
          <h2 className="mb">Toss</h2>
          <p className="muted" style={{ fontSize: '0.9rem' }}>Optional now — you can record it later from the scoring screen.</p>
          <div className="form-grid">
            <div className="field">
              <label>Toss winner</label>
              <select className="select" value={tossWinner} onChange={(e) => setTossWinner(e.target.value)}>
                <option value="">Not yet</option>
                {teamA && <option value={teamA.id}>{teamA.name}</option>}
                {teamB && <option value={teamB.id}>{teamB.name}</option>}
              </select>
            </div>
            <div className="field">
              <label>Decision</label>
              <select className="select" value={tossDecision} onChange={(e) => setTossDecision(e.target.value as 'BAT' | 'BOWL')} disabled={!tossWinner}>
                <option value="BAT">Bat first</option>
                <option value="BOWL">Bowl first</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="card pad-lg">
          <h2 className="mb">Review</h2>
          <div className="kv">
            <span className="k">Title</span><span className="v">{title}</span>
            <span className="k">Format</span><span className="v">{FORMAT_LABEL[format]}</span>
            <span className="k">Venue</span><span className="v">{venue || '—'}</span>
            <span className="k">Teams</span><span className="v">{teamA?.name} vs {teamB?.name}</span>
            <span className="k">XI size</span><span className="v">{(squads[teamAId] ?? []).filter((s) => s.inPlayingXI).length} / {(squads[teamBId] ?? []).filter((s) => s.inPlayingXI).length}</span>
            <span className="k">Toss</span><span className="v">{tossWinner ? `${teams.find((t) => t.id === tossWinner)?.name} chose to ${tossDecision.toLowerCase()}` : 'Not recorded'}</span>
          </div>
        </div>
      )}

      <div className="row between">
        <button className="btn ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>Back</button>
        {step < steps.length - 1
          ? <button className="btn primary" onClick={() => setStep((s) => s + 1)} disabled={!canNext}>Continue</button>
          : <button className="btn primary" onClick={() => void submit()} disabled={busy}>{busy ? 'Creating…' : 'Create match'}</button>}
      </div>
    </div>
  );
}
