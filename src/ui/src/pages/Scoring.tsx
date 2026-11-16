import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, dequeueLast, newIdempotencyKey, onQueueChange, postDelivery, queuedFor } from '../api';
import { useAsync } from '../hooks';
import { replayQueued } from '../optimistic';
import { Empty, Loading, Modal, errorMessage, useToast } from '../ui';
import { oversFromBalls } from '../format';
import type { DeliveryInput, InningsState, MatchDetail, MatchRules } from '../types';

type Mode = 'ball' | 'wide' | 'noball' | 'bye' | 'legbye';
const PAD: Record<Mode, number[]> = {
  ball: [0, 1, 2, 3, 4, 5, 6],
  wide: [1, 2, 3, 4, 5],
  noball: [0, 1, 2, 3, 4, 6],
  bye: [1, 2, 3, 4],
  legbye: [1, 2, 3, 4],
};
const MODE_LABEL: Record<Mode, string> = {
  ball: 'Runs off the bat', wide: 'Wides (total)', noball: 'Runs off the no-ball', bye: 'Byes', legbye: 'Leg byes',
};

const DISMISSAL_TYPES = ['BOWLED', 'CAUGHT', 'LBW', 'RUN_OUT', 'STUMPED', 'HIT_WICKET', 'RETIRED_HURT', 'RETIRED_OUT', 'OBSTRUCTING_FIELD', 'TIMED_OUT'];
const NEEDS_FIELDER = new Set(['CAUGHT', 'STUMPED', 'RUN_OUT']);
const NEEDS_REPLACEMENT = new Set(['BOWLED', 'CAUGHT', 'LBW', 'RUN_OUT', 'STUMPED', 'HIT_WICKET', 'HIT_BALL_TWICE', 'OBSTRUCTING_FIELD', 'TIMED_OUT', 'RETIRED_OUT', 'RETIRED_HURT']);

function battingTeamFor(inningsNumber: number, rules: MatchRules, first: string, second: string): string {
  if (rules.inningsCount <= 1) return first;
  if (rules.inningsCount === 2) return inningsNumber === 1 ? first : second;
  return inningsNumber % 2 === 1 ? first : second;
}

export function Scoring({ matchId }: { matchId: string }): ReactNode {
  const toast = useToast();
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>('ball');
  const [wicketOpen, setWicketOpen] = useState(false);
  const [openerSel, setOpenerSel] = useState<{ striker: string; nonStriker: string; bowler: string }>({ striker: '', nonStriker: '', bowler: '' });
  const [newBowler, setNewBowler] = useState('');
  const [tossWinner, setTossWinner] = useState('');
  const [tossDecision, setTossDecision] = useState<'BAT' | 'BOWL'>('BAT');
  const [startBatting, setStartBatting] = useState('');
  const [startTarget, setStartTarget] = useState('');
  const [followOn, setFollowOn] = useState(false);

  const bump = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => onQueueChange(() => setTick((t) => t + 1)), []);

  const { data, loading, error } = useAsync<MatchDetail>(() => api.match(matchId) as Promise<MatchDetail>, [matchId, tick]);

  const squads = data?.squads ?? [];
  const rules = data?.rules;
  const match = data?.match;
  const squadMap = useMemo(() => {
    const map: Record<string, MatchDetail['squads'][number]> = {};
    for (const s of squads) map[s.player_id] = s;
    return map;
  }, [squads]);
  const nameOf = useCallback((id?: string | null) => (id ? squadMap[id]?.full_name ?? 'Unknown' : '—'), [squadMap]);

  const current = data?.innings?.[data.innings.length - 1] ?? null;
  const serverState: InningsState | null = current?.state ?? null;
  const queued = useMemo(() => (current ? queuedFor(current.innings.id) : []), [current, tick]);
  const state: InningsState | null = useMemo(
    () => (serverState && rules ? replayQueued(serverState, rules, queued.map((q) => q.input)) : serverState),
    [serverState, rules, queued],
  );

  const xi = useCallback((teamId: string) => squads.filter((s) => s.team_id === teamId && s.in_playing_xi === 1), [squads]);

  const scoreBall = useCallback(async (partial: Partial<DeliveryInput>) => {
    if (!current || !state?.strikerId || !state.nonStrikerId || !state.bowlerId) return;
    setBusy(true);
    try {
      const input: DeliveryInput = {
        idempotencyKey: newIdempotencyKey(),
        strikerId: state.strikerId,
        nonStrikerId: state.nonStrikerId,
        bowlerId: state.bowlerId,
        batterRuns: 0, wides: 0, noBall: 0, byes: 0, legByes: 0, penalty: 0,
        ...partial,
      };
      const outcome = await postDelivery(current.innings.id, input);
      if (outcome.queued) toast.push('Offline: ball saved locally and queued for sync.', 'info');
      setMode('ball');
      bump();
    } catch (err) {
      toast.push(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }, [current, state, toast, bump]);

  const padPress = useCallback((n: number) => {
    switch (mode) {
      case 'ball': return void scoreBall({ batterRuns: n });
      case 'wide': return void scoreBall({ wides: n });
      case 'noball': return void scoreBall({ noBall: 1, batterRuns: n });
      case 'bye': return void scoreBall({ byes: n });
      case 'legbye': return void scoreBall({ legByes: n });
    }
  }, [mode, scoreBall]);

  const undo = useCallback(async () => {
    if (!current) return;
    setBusy(true);
    try {
      if (dequeueLast(current.innings.id)) {
        toast.push('Removed the last offline ball.', 'success');
        bump();
        return;
      }
      await api.undo(current.innings.id);
      toast.push('Undid the last delivery.', 'success');
      bump();
    } catch (err) {
      toast.push(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }, [current, toast, bump]);

  const setOpeners = useCallback(async () => {
    if (!current) return;
    if (!openerSel.striker || !openerSel.nonStriker || !openerSel.bowler) { toast.push('Choose a striker, non-striker and bowler.', 'error'); return; }
    if (openerSel.striker === openerSel.nonStriker) { toast.push('The two batters must be different.', 'error'); return; }
    setBusy(true);
    try {
      await api.setOpeners(current.innings.id, {
        strikerId: openerSel.striker,
        nonStrikerId: openerSel.nonStriker,
        bowlerId: openerSel.bowler,
      });
      bump();
    } catch (err) { toast.push(errorMessage(err), 'error'); } finally { setBusy(false); }
  }, [current, openerSel, toast, bump]);

  const chooseBowler = useCallback(async () => {
    if (!current || !state || !newBowler) return;
    setBusy(true);
    try {
      await api.setOpeners(current.innings.id, { strikerId: state.strikerId, nonStrikerId: state.nonStrikerId, bowlerId: newBowler });
      setNewBowler('');
      bump();
    } catch (err) { toast.push(errorMessage(err), 'error'); } finally { setBusy(false); }
  }, [current, state, newBowler, toast, bump]);

  const recordToss = useCallback(async () => {
    if (!tossWinner) { toast.push('Select the toss winner.', 'error'); return; }
    setBusy(true);
    try { await api.recordToss(matchId, { winnerTeamId: tossWinner, decision: tossDecision }); bump(); }
    catch (err) { toast.push(errorMessage(err), 'error'); } finally { setBusy(false); }
  }, [matchId, tossWinner, tossDecision, toast, bump]);

  const startInnings = useCallback(async () => {
    if (!match || !rules) return;
    const batting = startBatting || battingTeamFor((data?.innings.length ?? 0) + 1, rules, String(match.batting_first_team_id ?? match.team_a_id), String(match.batting_second_team_id ?? match.team_b_id));
    if (!batting) { toast.push('Choose the batting side.', 'error'); return; }
    setBusy(true);
    try {
      await api.startInnings(matchId, {
        battingTeamId: batting,
        target: startTarget ? Number(startTarget) : null,
        followOnEnforced: rules.format === 'TEST' ? followOn : undefined,
      });
      setStartBatting(''); setStartTarget(''); setFollowOn(false);
      bump();
    } catch (err) { toast.push(errorMessage(err), 'error'); } finally { setBusy(false); }
  }, [match, rules, startBatting, startTarget, followOn, matchId, data, toast, bump]);

  const declare = useCallback(async () => {
    if (!current) return;
    setBusy(true);
    try { await api.declare(current.innings.id); toast.push('Innings declared.', 'success'); bump(); }
    catch (err) { toast.push(errorMessage(err), 'error'); } finally { setBusy(false); }
  }, [current, toast, bump]);

  const reopen = useCallback(async () => {
    if (!current) return;
    setBusy(true);
    try { await api.reopen(current.innings.id); toast.push('Innings reopened.', 'success'); bump(); }
    catch (err) { toast.push(errorMessage(err), 'error'); } finally { setBusy(false); }
  }, [current, toast, bump]);

  if (loading && !data) return <Loading label="Loading match…" />;
  if (error && !data) return <Empty title="Could not load the match" hint={error} />;
  if (!data || !match || !rules) return <Empty title="Match not found" />;

  const canScore = state?.status === 'in_progress' && !!state.strikerId && !!state.bowlerId;
  const openersNeeded = state?.status === 'in_progress' && !state.strikerId && (state?.deliveryCount ?? 0) === 0;
  const bowlerNeeded = state?.status === 'in_progress' && !!state.strikerId && !state.bowlerId;

  /* ----------------------------- toss required ----------------------------- */
  if (!match.toss_winner_team_id) {
    return (
      <div className="card pad-lg" style={{ maxWidth: 520 }}>
        <h2 className="mb">Record the toss</h2>
        <p className="muted" style={{ fontSize: '0.9rem' }}>The match cannot start until the toss is recorded.</p>
        <div className="col" style={{ gap: 14, marginTop: 8 }}>
          <div className="field">
            <label>Toss winner</label>
            <select className="select" value={tossWinner} onChange={(e) => setTossWinner(e.target.value)}>
              <option value="">Select…</option>
              <option value={data.teamA.id}>{data.teamA.name}</option>
              <option value={data.teamB.id}>{data.teamB.name}</option>
            </select>
          </div>
          <div className="field">
            <label>Decision</label>
            <select className="select" value={tossDecision} onChange={(e) => setTossDecision(e.target.value as 'BAT' | 'BOWL')}>
              <option value="BAT">Bat first</option>
              <option value="BOWL">Bowl first</option>
            </select>
          </div>
          <button className="btn primary" onClick={() => void recordToss()} disabled={busy}>Save toss</button>
        </div>
      </div>
    );
  }

  /* ------------------------------ start innings ----------------------------- */
  if (!current) {
    const nextNumber = (data.innings.length || 0) + 1;
    const first = String(match.batting_first_team_id ?? match.team_a_id);
    const second = String(match.batting_second_team_id ?? match.team_b_id);
    const defaultBatting = battingTeamFor(nextNumber, rules, first, second);
    const previous = data.innings[data.innings.length - 1];
    const suggestedTarget = previous ? previous.state.runs + 1 : '';
    return (
      <div className="card pad-lg" style={{ maxWidth: 560 }}>
        <h2 className="mb">Start innings {nextNumber}</h2>
        <div className="col" style={{ gap: 14 }}>
          <div className="field">
            <label>Batting side</label>
            <select className="select" value={startBatting || defaultBatting} onChange={(e) => setStartBatting(e.target.value)}>
              <option value={data.teamA.id}>{data.teamA.name}</option>
              <option value={data.teamB.id}>{data.teamB.name}</option>
            </select>
          </div>
          {nextNumber > 1 && rules.inningsCount === 2 && (
            <div className="field">
              <label>Target (optional)</label>
              <input className="input" type="number" min={1} placeholder={String(suggestedTarget || '')} value={startTarget} onChange={(e) => setStartTarget(e.target.value)} />
              <span className="dim" style={{ fontSize: '0.8rem' }}>Leave blank to use {suggestedTarget} (first-innings runs + 1).</span>
            </div>
          )}
          {rules.format === 'TEST' && (
            <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={followOn} onChange={(e) => setFollowOn(e.target.checked)} />
              <span>Enforce the follow-on</span>
            </label>
          )}
          <button className="btn primary" onClick={() => void startInnings()} disabled={busy}>Start innings</button>
        </div>
      </div>
    );
  }

  /* -------------------------------- summary -------------------------------- */
  const totalBalls = rules.overs > 0 ? rules.overs * rules.ballsPerOver : null;
  const ballsRemaining = totalBalls === null ? null : Math.max(totalBalls - state!.legalBalls, 0);
  const runsRequired = state!.target !== null ? Math.max(state!.target - state!.runs, 0) : null;
  const requiredRate = runsRequired !== null && ballsRemaining ? Math.round((runsRequired / (ballsRemaining / rules.ballsPerOver)) * 100) / 100 : null;
  const battingName = state!.battingTeamId === data.teamA.id ? data.teamA.name : data.teamB.name;
  const bowlingName = state!.bowlingTeamId === data.teamA.id ? data.teamA.name : data.teamB.name;

  const battingXI = xi(state!.battingTeamId);
  const bowlingXI = xi(state!.bowlingTeamId);
  const outIds = new Set(Object.values(state!.batters).filter((b) => b.out).map((b) => b.id));
  const atCrease = new Set([state!.strikerId, state!.nonStrikerId].filter(Boolean) as string[]);
  const availableBatters = battingXI.filter((p) => !outIds.has(p.player_id) && !atCrease.has(p.player_id));
  const maxBowlerBalls = rules.maxOversPerBowler > 0 ? rules.maxOversPerBowler * rules.ballsPerOver : 0;
  const nextBowlerOptions = bowlingXI.filter((p) => {
    if (p.player_id === state!.lastBowlerId) return false;
    if (maxBowlerBalls > 0 && (state!.bowlers[p.player_id]?.legalBalls ?? 0) >= maxBowlerBalls) return false;
    return true;
  });

  return (
    <div className="col" style={{ gap: 16 }}>
      {/* scoreboard */}
      <div className="score-hero">
        <div className="row between wrap" style={{ gap: 10 }}>
          <div className="row" style={{ gap: 10 }}>
            <span className="pill">{match.format}</span>
            <span className="muted" style={{ fontSize: '0.88rem' }}>{battingName} batting · {bowlingName} bowling</span>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {state!.freeHitNext && <span className="badge warn">Free hit</span>}
            {queued.length > 0 && <span className="badge warn">{queued.length} queued</span>}
            <span className="badge info">Innings {state!.inningsNumber}</span>
          </div>
        </div>
        <div className="score-line" style={{ marginTop: 12 }}>
          <span className="score-big">{state!.runs}/{state!.wickets}</span>
          <span className="score-overs">({oversFromBalls(state!.legalBalls, rules.ballsPerOver)} ov)</span>
        </div>
        <div className="score-meta">
          <div className="m"><span className="k">Run rate</span><span className="v">{state!.legalBalls ? (state!.runs / (state!.legalBalls / rules.ballsPerOver)).toFixed(2) : '0.00'}</span></div>
          {ballsRemaining !== null && <div className="m"><span className="k">Balls left</span><span className="v">{ballsRemaining}</span></div>}
          {state!.target !== null && <div className="m"><span className="k">Target</span><span className="v">{state!.target}</span></div>}
          {runsRequired !== null && <div className="m"><span className="k">Need</span><span className="v">{runsRequired} off {ballsRemaining}</span></div>}
          {requiredRate !== null && <div className="m"><span className="k">Req. rate</span><span className="v">{requiredRate.toFixed(2)}</span></div>}
          <div className="m"><span className="k">Extras</span><span className="v">{state!.extras.wides + state!.extras.noBall + state!.extras.byes + state!.extras.legByes + state!.extras.penalty}</span></div>
        </div>
        <div className="mt" style={{ marginTop: 14 }}>
          <div className="card-title" style={{ marginBottom: 8 }}>This over</div>
          <div className="ball-track">
            {state!.currentOver.balls.length === 0
              ? <span className="dim" style={{ fontSize: '0.85rem' }}>No balls yet in this over.</span>
              : state!.currentOver.balls.map((b, i) => <span key={i} className={`ball ${ballClass(b)}`}>{b}</span>)}
          </div>
        </div>
      </div>

      {/* players */}
      <div className="grid cols-3">
        <div className="card">
          <div className="card-title mb">Batting</div>
          {[state!.strikerId, state!.nonStrikerId].filter(Boolean).map((id, i) => {
            const b = state!.batters[id as string];
            return (
              <div key={id as string} className="row between" style={{ padding: '5px 0' }}>
                <span className="ellipsis">{nameOf(id as string)}{i === 0 && <span className="em"> *</span>}</span>
                <span className="mono">{b ? `${b.runs} (${b.balls})` : '0 (0)'}</span>
              </div>
            );
          })}
          {state!.currentPartnership && (
            <div className="dim" style={{ fontSize: '0.8rem', marginTop: 6 }}>
              Partnership {state!.currentPartnership.runs} ({state!.currentPartnership.balls})
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-title mb">Bowling</div>
          {state!.bowlerId ? (() => {
            const bw = state!.bowlers[state!.bowlerId!];
            return (
              <div className="row between">
                <span className="ellipsis">{nameOf(state!.bowlerId)}</span>
                <span className="mono">{bw ? `${bw.legalBalls / rules.ballsPerOver | 0}.${bw.legalBalls % rules.ballsPerOver}-${bw.runsConceded}-${bw.wickets}` : '—'}</span>
              </div>
            );
          })() : <span className="dim">Awaiting bowler</span>}
          <div className="dim" style={{ fontSize: '0.8rem', marginTop: 6 }}>
            Powerplay {state!.powerplay.runs}/{state!.powerplay.wickets} ({oversFromBalls(state!.powerplay.balls, rules.ballsPerOver)})
          </div>
        </div>
        <div className="card">
          <div className="card-title mb">Fall of wickets</div>
          {state!.fallOfWickets.length === 0 ? <span className="dim">None yet</span> : (
            <div className="col" style={{ gap: 3 }}>
              {state!.fallOfWickets.slice(-4).map((w, i) => (
                <div key={i} className="dim" style={{ fontSize: '0.84rem' }}>
                  {String((w as Record<string, unknown>).wicketNumber)}-{String((w as Record<string, unknown>).runs)} {nameOf(String((w as Record<string, unknown>).batterId))} ({String((w as Record<string, unknown>).over)})
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* action panels */}
      {openersNeeded && (
        <div className="card pad-lg">
          <h2 className="mb">Select the opening pair and bowler</h2>
          <div className="form-grid">
            <div className="field">
              <label>Striker</label>
              <select className="select" value={openerSel.striker} onChange={(e) => setOpenerSel((s) => ({ ...s, striker: e.target.value }))}>
                <option value="">Select…</option>
                {battingXI.map((p) => <option key={p.player_id} value={p.player_id}>{p.full_name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Non-striker</label>
              <select className="select" value={openerSel.nonStriker} onChange={(e) => setOpenerSel((s) => ({ ...s, nonStriker: e.target.value }))}>
                <option value="">Select…</option>
                {battingXI.map((p) => <option key={p.player_id} value={p.player_id}>{p.full_name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Opening bowler</label>
              <select className="select" value={openerSel.bowler} onChange={(e) => setOpenerSel((s) => ({ ...s, bowler: e.target.value }))}>
                <option value="">Select…</option>
                {bowlingXI.map((p) => <option key={p.player_id} value={p.player_id}>{p.full_name}</option>)}
              </select>
            </div>
          </div>
          <div className="btn-row mt"><button className="btn primary" onClick={() => void setOpeners()} disabled={busy}>Confirm openers</button></div>
        </div>
      )}

      {bowlerNeeded && (
        <div className="card pad-lg">
          <h2 className="mb">Next over — choose the bowler</h2>
          <p className="muted" style={{ fontSize: '0.88rem' }}>{nameOf(state!.lastBowlerId)} bowled the previous over and cannot bowl consecutively.</p>
          <div className="row wrap mt">
            <select className="select" style={{ maxWidth: 280 }} value={newBowler} onChange={(e) => setNewBowler(e.target.value)}>
              <option value="">Select bowler…</option>
              {nextBowlerOptions.map((p) => <option key={p.player_id} value={p.player_id}>{p.full_name}</option>)}
            </select>
            <button className="btn primary" onClick={() => void chooseBowler()} disabled={busy || !newBowler}>Start over</button>
          </div>
        </div>
      )}

      {canScore && (
        <div className="card pad-lg">
          <div className="row between wrap mb">
            <div className="chips">
              {(['ball', 'wide', 'noball', 'bye', 'legbye'] as Mode[]).map((m) => (
                <button key={m} className={mode === m ? 'chip active' : 'chip'} onClick={() => setMode(m)}>{MODE_LABEL[m]}</button>
              ))}
            </div>
            <button className="btn ghost sm" onClick={() => void undo()} disabled={busy}>↶ Undo last ball</button>
          </div>
          <div className="score-pad">
            {PAD[mode].map((n) => (
              <button key={n} className={`pad-btn ${mode === 'ball' && n === 4 ? 'run-4' : mode === 'ball' && n === 6 ? 'run-6' : mode !== 'ball' ? 'extra' : ''}`}
                disabled={busy} onClick={() => padPress(n)}>
                {mode === 'ball' ? n : `${n}`}
              </button>
            ))}
            <button className="pad-btn wicket" disabled={busy} onClick={() => setWicketOpen(true)}>W</button>
            <button className="pad-btn ghost" disabled={busy} onClick={() => void undo()}>Undo</button>
            <button className="pad-btn ghost" disabled={busy} onClick={() => void declare()}>Declare</button>
          </div>
          <div className="dim mt-sm" style={{ fontSize: '0.82rem' }}>{MODE_LABEL[mode]} — tap the runs.</div>
        </div>
      )}

      {state!.status !== 'in_progress' && (
        <div className="card pad-lg">
          <h2 className="mb">Innings {state!.inningsNumber} {state!.status === 'declared' ? 'declared' : 'complete'}</h2>
          <p className="muted">{battingName} finished on {state!.runs}/{state!.wickets} in {oversFromBalls(state!.legalBalls, rules.ballsPerOver)} overs.</p>
          <div className="btn-row mt">
            <button className="btn ghost" onClick={() => void reopen()} disabled={busy}>Reopen innings</button>
            {data.result.resultType !== 'IN_PROGRESS' && (
              <span className="badge ok" style={{ alignSelf: 'center' }}>{data.result.summary}</span>
            )}
          </div>
          {data.result.dls && !data.result.dls.available && (
            <p className="dim mt" style={{ fontSize: '0.8rem' }}>DLS: {data.result.dls.reason}</p>
          )}
        </div>
      )}

      {wicketOpen && state && (
        <WicketModal
          state={state}
          rules={rules}
          battingXI={battingXI.map((p) => ({ id: p.player_id, name: p.full_name }))}
          bowlingXI={bowlingXI.map((p) => ({ id: p.player_id, name: p.full_name }))}
          available={availableBatters.map((p) => ({ id: p.player_id, name: p.full_name }))}
          onClose={() => setWicketOpen(false)}
          onConfirm={async (payload) => {
            setWicketOpen(false);
            await scoreBall(payload);
          }}
        />
      )}
    </div>
  );
}

function ballClass(notation: string): string {
  if (notation.includes('W')) return 'w';
  if (notation.includes('wd')) return 'wd';
  if (notation.includes('nb')) return 'nb';
  if (notation.startsWith('4')) return 'r4';
  if (notation.startsWith('6')) return 'r6';
  if (notation === '.' || notation === '0') return 'dot';
  return '';
}

function WicketModal({ state, battingXI, bowlingXI, available, onClose, onConfirm }: {
  state: InningsState;
  rules: MatchRules;
  battingXI: Array<{ id: string; name: string }>;
  bowlingXI: Array<{ id: string; name: string }>;
  available: Array<{ id: string; name: string }>;
  onClose: () => void;
  onConfirm: (payload: Partial<DeliveryInput>) => void | Promise<void>;
}): ReactNode {
  const [type, setType] = useState('BOWLED');
  const [batterId, setBatterId] = useState(state.strikerId ?? '');
  const [fielderId, setFielderId] = useState('');
  const [runs, setRuns] = useState(0);
  const [nextBatterId, setNextBatterId] = useState('');

  const needsFielder = NEEDS_FIELDER.has(type);
  const needsReplacement = NEEDS_REPLACEMENT.has(type);
  const atCrease = [state.strikerId, state.nonStrikerId].filter(Boolean) as string[];
  const nameOf = (id: string) => [...battingXI, ...bowlingXI].find((p) => p.id === id)?.name ?? id;

  return (
    <Modal title="Record a dismissal" onClose={onClose} wide footer={
      <>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => void onConfirm({
          batterRuns: type === 'RUN_OUT' ? runs : runs,
          dismissal: {
            type,
            batterId,
            fielderIds: fielderId ? [fielderId] : [],
            runsCompletedBeforeDismissal: type === 'RUN_OUT' ? runs : undefined,
          },
          nextBatterId: needsReplacement && nextBatterId ? nextBatterId : undefined,
        })} disabled={(needsReplacement && !nextBatterId) || !batterId}>
          Record wicket
        </button>
      </>
    }>
      <div className="form-grid">
        <div className="field">
          <label>How out</label>
          <select className="select" value={type} onChange={(e) => setType(e.target.value)}>
            {DISMISSAL_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ').toLowerCase()}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Batter out</label>
          <select className="select" value={batterId} onChange={(e) => setBatterId(e.target.value)}>
            {atCrease.map((id) => <option key={id} value={id}>{nameOf(id)}{id === state.strikerId ? ' (striker)' : ' (non-striker)'}</option>)}
          </select>
        </div>
        {needsFielder && (
          <div className="field">
            <label>{type === 'RUN_OUT' ? 'Fielder' : type === 'STUMPED' ? 'Wicketkeeper' : 'Catcher'}</label>
            <select className="select" value={fielderId} onChange={(e) => setFielderId(e.target.value)}>
              <option value="">Not recorded</option>
              {bowlingXI.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}
        <div className="field">
          <label>{type === 'RUN_OUT' ? 'Runs completed before the run out' : 'Runs off this ball'}</label>
          <input className="input" type="number" min={0} max={6} value={runs} onChange={(e) => setRuns(Math.max(0, Math.min(6, Number(e.target.value) || 0)))} />
        </div>
        {needsReplacement && (
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>New batter</label>
            <select className="select" value={nextBatterId} onChange={(e) => setNextBatterId(e.target.value)}>
              <option value="">Select…</option>
              {available.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}
      </div>
    </Modal>
  );
}
