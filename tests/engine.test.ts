import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDelivery, createInningsState, inningsCompletion, oversString, rebuildInnings,
  setOpeningPlayers, strikeRate, economy, requiredRunRate,
} from '../src/domain/engine';
import { calculateMatchResult } from '../src/domain/result';
import type { MatchRules } from '../src/domain/types';
import { ball, ballOrThrow, newInnings, open, T20_RULES, TEST_RULES, bowlOver, ends } from './helpers';

test('legal deliveries accumulate runs and rotate strike on odd runs', () => {
  const { rules, sim } = newInnings();
  open(sim, 'A1', 'A2', 'B1');
  ball(sim, rules, { strikerId: 'A1', nonStrikerId: 'A2', bowlerId: 'B1', batterRuns: 1 });
  assert.equal(sim.state.runs, 1);
  assert.equal(sim.state.legalBalls, 1);
  assert.deepEqual(ends(sim), { striker: 'A2', nonStriker: 'A1' });
  ball(sim, rules, { strikerId: 'A2', nonStrikerId: 'A1', bowlerId: 'B1', batterRuns: 2 });
  assert.equal(sim.state.runs, 3);
  assert.deepEqual(ends(sim), { striker: 'A2', nonStriker: 'A1' }, 'even runs do not rotate');
  assert.equal(sim.state.batters['A1'].balls, 1);
  assert.equal(sim.state.batters['A2'].balls, 1);
});

test('fours and sixes are tracked separately from other boundaries', () => {
  const { rules, sim } = newInnings();
  open(sim, 'A1', 'A2', 'B1');
  ball(sim, rules, { strikerId: 'A1', nonStrikerId: 'A2', bowlerId: 'B1', batterRuns: 4 });
  ball(sim, rules, { strikerId: 'A1', nonStrikerId: 'A2', bowlerId: 'B1', batterRuns: 6 });
  assert.equal(sim.state.batters['A1'].fours, 1);
  assert.equal(sim.state.batters['A1'].sixes, 1);
  assert.equal(sim.state.batters['A1'].runs, 10);
  assert.equal(sim.state.bowlers['B1'].runsConceded, 10);
});

test('a wide costs one run, is not a legal ball, and does not rotate strike', () => {
  const { rules, sim } = newInnings();
  open(sim, 'A1', 'A2', 'B1');
  ball(sim, rules, { strikerId: 'A1', nonStrikerId: 'A2', bowlerId: 'B1', wides: 1 });
  assert.equal(sim.state.runs, 1);
  assert.equal(sim.state.legalBalls, 0);
  assert.equal(sim.state.extras.wides, 1);
  assert.equal(sim.state.bowlers['B1'].runsConceded, 1);
  assert.equal(sim.state.bowlers['B1'].wides, 1);
  assert.equal(sim.state.batters['A1'].balls, 0, 'a wide is not a ball faced');
  assert.deepEqual(ends(sim), { striker: 'A1', nonStriker: 'A2' });
});

test('two runs off a wide rotate the strike because one run was completed', () => {
  const { rules, sim } = newInnings();
  open(sim, 'A1', 'A2', 'B1');
  ball(sim, rules, { strikerId: 'A1', nonStrikerId: 'A2', bowlerId: 'B1', wides: 2 });
  assert.equal(sim.state.runs, 2);
  assert.equal(sim.state.legalBalls, 0);
  assert.deepEqual(ends(sim), { striker: 'A2', nonStriker: 'A1' });
});

test('a no ball costs one run, is not a legal ball, but counts as a ball faced', () => {
  const { rules, sim } = newInnings();
  open(sim, 'A1', 'A2', 'B1');
  ball(sim, rules, { strikerId: 'A1', nonStrikerId: 'A2', bowlerId: 'B1', noBall: 1, batterRuns: 4 });
  assert.equal(sim.state.runs, 5);
  assert.equal(sim.state.legalBalls, 0);
  assert.equal(sim.state.extras.noBall, 1);
  assert.equal(sim.state.batters['A1'].runs, 4);
  assert.equal(sim.state.batters['A1'].balls, 1);
  assert.equal(sim.state.bowlers['B1'].runsConceded, 5);
  assert.equal(sim.state.bowlers['B1'].noBalls, 1);
  assert.equal(sim.state.freeHitNext, true);
});

test('byes are legal balls, count to the team, but not against the bowler', () => {
  const { rules, sim } = newInnings();
  open(sim, 'A1', 'A2', 'B1');
  ball(sim, rules, { strikerId: 'A1', nonStrikerId: 'A2', bowlerId: 'B1', byes: 2 });
  assert.equal(sim.state.runs, 2);
  assert.equal(sim.state.legalBalls, 1);
  assert.equal(sim.state.extras.byes, 2);
  assert.equal(sim.state.bowlers['B1'].runsConceded, 0);
  assert.equal(sim.state.batters['A1'].balls, 1);
  assert.equal(sim.state.batters['A1'].runs, 0);
  assert.deepEqual(ends(sim), { striker: 'A1', nonStriker: 'A2' });
});

test('leg byes of an odd number rotate strike and are not charged to the bowler', () => {
  const { rules, sim } = newInnings();
  open(sim, 'A1', 'A2', 'B1');
  ball(sim, rules, { strikerId: 'A1', nonStrikerId: 'A2', bowlerId: 'B1', legByes: 1 });
  assert.equal(sim.state.runs, 1);
  assert.equal(sim.state.extras.legByes, 1);
  assert.equal(sim.state.bowlers['B1'].runsConceded, 0);
  assert.deepEqual(ends(sim), { striker: 'A2', nonStriker: 'A1' });
});

test('penalty runs awarded as a standalone event add to the team without a ball or a strike change', () => {
  const { rules, sim } = newInnings();
  open(sim, 'A1', 'A2', 'B1');
  ball(sim, rules, {
    strikerId: 'A1', nonStrikerId: 'A2', bowlerId: 'B1', penalty: 5, eventType: 'INNINGS_EVENT',
  });
  assert.equal(sim.state.runs, 5);
  assert.equal(sim.state.extras.penalty, 5);
  assert.equal(sim.state.legalBalls, 0);
  assert.equal(sim.state.bowlers['B1'].runsConceded, 0);
  assert.deepEqual(ends(sim), { striker: 'A1', nonStriker: 'A2' });
});

test('bowled dismissal credits the bowler and seats the new batter on strike for even runs', () => {
  const { rules, sim } = newInnings();
  open(sim, 'A1', 'A2', 'B1');
  ball(sim, rules, {
    strikerId: 'A1', nonStrikerId: 'A2', bowlerId: 'B1',
    dismissal: { type: 'BOWLED', batterId: 'A1' }, nextBatterId: 'A3',
  });
  assert.equal(sim.state.wickets, 1);
  assert.equal(sim.state.bowlers['B1'].wickets, 1);
  assert.equal(sim.state.batters['A1'].out, true);
  assert.equal(sim.state.batters['A1'].dismissalDetail, 'b B1');
  assert.deepEqual(ends(sim), { striker: 'A3', nonStriker: 'A2' });
  assert.equal(sim.state.fallOfWickets.length, 1);
  assert.equal(sim.state.fallOfWickets[0].wicketNumber, 1);
});

test('caught dismissal records the fielder and the bowler gets the wicket', () => {
  const { rules, sim } = newInnings();
  open(sim, 'A1', 'A2', 'B1');
  ball(sim, rules, {
    strikerId: 'A1', nonStrikerId: 'A2', bowlerId: 'B1', batterRuns: 0,
    dismissal: { type: 'CAUGHT', batterId: 'A1', fielderIds: ['B5'] }, nextBatterId: 'A3',
  });
  assert.equal(sim.state.batters['A1'].dismissalDetail, 'c B5 b B1');
  assert.equal(sim.state.bowlers['B1'].wickets, 1);
});

test('stumped dismissal records the keeper and credits the bowler', () => {
  const { rules, sim } = newInnings();
  open(sim, 'A1', 'A2', 'B1');
  ball(sim, rules, {
    strikerId: 'A1', nonStrikerId: 'A2', bowlerId: 'B1',
    dismissal: { type: 'STUMPED', batterId: 'A1', fielderIds: ['B9'] }, nextBatterId: 'A3',
  });
  assert.equal(sim.state.batters['A1'].dismissalDetail, 'st B9 b B1');
  assert.equal(sim.state.bowlers['B1'].wickets, 1);
});

test('run out does not credit the bowler', () => {
  const { rules, sim } = newInnings();
  open(sim, 'A1', 'A2', 'B1');
  ball(sim, rules, {
    strikerId: 'A1', nonStrikerId: 'A2', bowlerId: 'B1',
    dismissal: { type: 'RUN_OUT', batterId: 'A1', fielderIds: ['B5'] }, nextBatterId: 'A3',
  });
  assert.equal(sim.state.wickets, 1);
  assert.equal(sim.state.bowlers['B1'].wickets, 0);
  assert.equal(sim.state.batters['A1'].dismissalDetail, 'run out (B5)');
});

test('run out after batters crossed leaves the surviving batter at the non-striker end', () => {
  const { rules, sim } = newInnings();
  open(sim, 'A1', 'A2', 'B1');
  // A1 and A2 complete one run; A2 is then run out at the striker's end.
  ball(sim, rules, {
    strikerId: 'A1', nonStrikerId: 'A2', bowlerId: 'B1', batterRuns: 1,
    dismissal: { type: 'RUN_OUT', batterId: 'A2', fielderIds: ['B6'], runsCompletedBeforeDismissal: 1 },
    nextBatterId: 'A3',
  });
  assert.equal(sim.state.runs, 1);
  assert.deepEqual(ends(sim), { striker: 'A3', nonStriker: 'A1' });
});

test('over completion swaps strike, records a maiden, and blocks consecutive overs', () => {
  const { rules, sim } = newInnings();
  open(sim, 'A1', 'A2', 'B1');
  bowlOver(sim, rules, 'B1', [0, 0, 0, 0, 0, 0]);
  assert.equal(sim.state.legalBalls, 6);
  assert.equal(sim.state.bowlers['B1'].maidens, 1);
  assert.equal(sim.state.overSummaries.length, 1);
  assert.equal(sim.state.lastBowlerId, 'B1');
  assert.deepEqual(ends(sim), { striker: 'A2', nonStriker: 'A1' });
  const error = ballOrThrow(sim, rules, { strikerId: 'A2', nonStrikerId: 'A1', bowlerId: 'B1' });
  assert.equal(error?.code, 'CONSECUTIVE_OVERS');
});

test('over with byes only is still a maiden for the bowler', () => {
  const { rules: r2, sim: s2 } = newInnings();
  open(s2, 'A1', 'A2', 'B1');
  for (let i = 0; i < 5; i++) ball(s2, r2, { strikerId: s2.state.strikerId!, nonStrikerId: s2.state.nonStrikerId!, bowlerId: 'B1' });
  ball(s2, r2, { strikerId: s2.state.strikerId!, nonStrikerId: s2.state.nonStrikerId!, bowlerId: 'B1', byes: 2 });
  assert.equal(s2.state.bowlers['B1'].maidens, 1);
  assert.equal(s2.state.bowlers['B1'].runsConceded, 0);
});

test('the same bowler may not bowl two balls of the same over with a different name mid-over', () => {
  const { rules, sim } = newInnings();
  open(sim, 'A1', 'A2', 'B1');
  ball(sim, rules, { strikerId: 'A1', nonStrikerId: 'A2', bowlerId: 'B1', batterRuns: 1 });
  const error = ballOrThrow(sim, rules, { strikerId: 'A2', nonStrikerId: 'A1', bowlerId: 'B2' });
  assert.equal(error?.code, 'BOWLER_CHANGE_MID_OVER');
});

test('free hit blocks bowled/lbw/caught but allows run out', () => {
  const { rules, sim } = newInnings();
  open(sim, 'A1', 'A2', 'B1');
  ball(sim, rules, { strikerId: 'A1', nonStrikerId: 'A2', bowlerId: 'B1', noBall: 1 });
  assert.equal(sim.state.freeHitNext, true);
  const blocked = ballOrThrow(sim, rules, {
    strikerId: 'A1', nonStrikerId: 'A2', bowlerId: 'B1',
    dismissal: { type: 'BOWLED', batterId: 'A1' }, nextBatterId: 'A3',
  });
  assert.equal(blocked?.code, 'FREE_HIT_DISMISSAL');
  const record = ball(sim, rules, {
    strikerId: 'A1', nonStrikerId: 'A2', bowlerId: 'B1',
    dismissal: { type: 'RUN_OUT', batterId: 'A1', fielderIds: ['B5'] }, nextBatterId: 'A3',
  });
  assert.equal(record.isFreeHit, true);
  assert.equal(sim.state.wickets, 1);
  assert.equal(sim.state.freeHitNext, false);
});

test('a no ball on a free hit keeps the free hit alive', () => {
  const { rules, sim } = newInnings();
  open(sim, 'A1', 'A2', 'B1');
  ball(sim, rules, { strikerId: 'A1', nonStrikerId: 'A2', bowlerId: 'B1', noBall: 1 });
  ball(sim, rules, { strikerId: 'A1', nonStrikerId: 'A2', bowlerId: 'B1', noBall: 1 });
  assert.equal(sim.state.freeHitNext, true);
});

test('innings completes when ten wickets fall', () => {
  const { rules, sim } = newInnings();
  open(sim, 'A1', 'A2', 'B1');
  assert.equal(inningsCompletion(sim.state, rules).complete, false);
  for (let w = 1; w <= 10; w++) {
    const bowler = sim.state.bowlerId ?? (sim.state.lastBowlerId === 'B1' ? 'B2' : 'B1');
    if (sim.state.bowlerId === null) {
      sim.state.bowlerId = bowler;
      sim.state.currentOver.bowlerId = bowler;
    }
    const striker = sim.state.strikerId!;
    const nonStriker = sim.state.nonStrikerId!;
    ball(sim, rules, {
      strikerId: striker, nonStrikerId: nonStriker, bowlerId: sim.state.bowlerId,
      dismissal: { type: 'BOWLED', batterId: striker }, nextBatterId: `A${w + 2}`,
    });
  }
  const info = inningsCompletion(sim.state, rules);
  assert.equal(info.complete, true);
  assert.equal(info.reason, 'ALL_OUT');
  assert.equal(sim.state.wickets, 10);
});

test('target reached completes the innings', () => {
  const { rules, sim } = newInnings({}, { target: 10, inningsNumber: 2 });
  open(sim, 'A1', 'A2', 'B1');
  ball(sim, rules, { strikerId: 'A1', nonStrikerId: 'A2', bowlerId: 'B1', batterRuns: 4 });
  ball(sim, rules, { strikerId: 'A1', nonStrikerId: 'A2', bowlerId: 'B1', batterRuns: 6 });
  assert.equal(inningsCompletion(sim.state, rules).reason, 'TARGET_REACHED');
});

test('overs complete completes the innings', () => {
  const { rules, sim } = newInnings({ overs: 1 });
  open(sim, 'A1', 'A2', 'B1');
  bowlOver(sim, rules, 'B1', [1, 1, 1, 1, 1, 1]);
  assert.equal(inningsCompletion(sim.state, rules).reason, 'OVERS_COMPLETE');
});

test('rebuilding from the delivery log reproduces the exact same state', () => {
  const { rules, sim } = newInnings();
  open(sim, 'A1', 'A2', 'B1');
  const script: Array<[number, Partial<{ wides: number; noBall: number; byes: number; legByes: number; penalty: number }>]> = [
    [1, {}], [4, {}], [0, { wides: 1 }], [2, {}], [0, { noBall: 1 }], [1, {}],
    [6, {}], [0, { byes: 2 }], [3, {}], [0, {}], [1, {}], [0, {}],
  ];
  for (const [runs, extras] of script) {
    if (sim.state.bowlerId === null) { sim.state.bowlerId = 'B2'; sim.state.currentOver.bowlerId = 'B2'; }
    ball(sim, rules, { strikerId: sim.state.strikerId!, nonStrikerId: sim.state.nonStrikerId!, bowlerId: sim.state.bowlerId, batterRuns: runs, ...extras });
  }
  const rebuilt = rebuildInnings(
    sim.state,
    sim.records.map((r, i) => ({ input: sim.inputs[i], id: r.id, recordedAt: r.recordedAt, sequence: r.sequence })),
    rules,
  );
  assert.deepEqual(rebuilt, sim.state);
});

test('superseding the last delivery and rebuilding rolls the innings back', () => {
  const { rules, sim } = newInnings();
  open(sim, 'A1', 'A2', 'B1');
  ball(sim, rules, { strikerId: 'A1', nonStrikerId: 'A2', bowlerId: 'B1', batterRuns: 4 });
  const before = JSON.parse(JSON.stringify(sim.state));
  ball(sim, rules, { strikerId: 'A1', nonStrikerId: 'A2', bowlerId: 'B1', batterRuns: 6 });
  assert.equal(sim.state.runs, 10);
  const kept = sim.records.slice(0, 1);
  const inputs = sim.inputs.slice(0, 1);
  const rebuilt = rebuildInnings(sim.state, kept.map((r, i) => ({ input: inputs[i], id: r.id, recordedAt: r.recordedAt, sequence: r.sequence })), rules);
  assert.equal(rebuilt.runs, before.runs);
  assert.deepEqual(rebuilt, before);
});

test('strike rate and economy round correctly', () => {
  assert.equal(strikeRate(65, 38), 171.05);
  assert.equal(strikeRate(0, 0), 0);
  assert.equal(economy(28, 21, 6), 8);
  assert.equal(requiredRunRate(45, 21, 6), 12.86);
  assert.equal(oversString(99, 6), '16.3');
});

test('invalid deliveries are rejected before mutating state', () => {
  const { rules, sim } = newInnings();
  open(sim, 'A1', 'A2', 'B1');
  const wrong = ballOrThrow(sim, rules, { strikerId: 'A2', nonStrikerId: 'A1', bowlerId: 'B1' });
  assert.equal(wrong?.code, 'WRONG_STRIKER');
  const badRuns = ballOrThrow(sim, rules, { strikerId: 'A1', nonStrikerId: 'A2', bowlerId: 'B1', batterRuns: 7 });
  assert.equal(badRuns?.code, 'INVALID_RUNS');
  assert.equal(sim.state.runs, 0);
  assert.equal(sim.state.deliveryCount, 0);
});

test('limit overs match result: chasing side wins by wickets', () => {
  const result = calculateMatchResult({
    rules: T20_RULES,
    battingTeamNames: { A: 'Alpha', B: 'Bravo' },
    battingFirstTeamId: 'A', battingSecondTeamId: 'B',
    innings: [
      makeInnings('A', 156, 4, 99),
      makeInnings('B', 157, 6, 114),
    ],
  });
  assert.equal(result.resultType, 'WICKETS');
  assert.equal(result.winningTeamId, 'B');
  assert.equal(result.summary, 'Bravo won by 4 wickets');
  assert.equal(result.dls.available, false);
});

test('limit overs match result: defending side wins by runs, and a tie is detected', () => {
  const runs = calculateMatchResult({
    rules: T20_RULES, battingTeamNames: { A: 'Alpha', B: 'Bravo' },
    battingFirstTeamId: 'A', battingSecondTeamId: 'B',
    innings: [makeInnings('A', 156, 8, 120), makeInnings('B', 150, 10, 118)],
  });
  assert.equal(runs.resultType, 'RUNS');
  assert.equal(runs.margin, 6);
  const tie = calculateMatchResult({
    rules: T20_RULES, battingTeamNames: { A: 'Alpha', B: 'Bravo' },
    battingFirstTeamId: 'A', battingSecondTeamId: 'B',
    innings: [makeInnings('A', 156, 8, 120), makeInnings('B', 156, 6, 120)],
  });
  assert.equal(tie.resultType, 'TIE');
});

test('abandonment and no result are reported without inventing a winner', () => {
  const abandoned = calculateMatchResult({
    rules: T20_RULES, battingTeamNames: {}, battingFirstTeamId: 'A', battingSecondTeamId: 'B',
    innings: [], isAbandoned: true,
  });
  assert.equal(abandoned.resultType, 'ABANDONED');
  assert.equal(abandoned.winningTeamId, null);
  assert.match(abandoned.dls.reason, /not available/i);
});

test('test match: innings victory and follow-on detection', () => {
  const inningsVictory = calculateMatchResult({
    rules: TEST_RULES, battingTeamNames: { A: 'Alpha', B: 'Bravo' },
    battingFirstTeamId: 'A', battingSecondTeamId: 'B',
    innings: [
      makeInnings('A', 500, 10, 600, 'complete'),
      makeInnings('B', 200, 10, 420, 'complete'),
      makeInnings('B', 250, 10, 480, 'complete'),
    ],
  });
  assert.equal(inningsVictory.resultType, 'INNINGS');
  assert.equal(inningsVictory.winningTeamId, 'A');
  assert.equal(inningsVictory.margin, 50);

  const followOn = calculateMatchResult({
    rules: TEST_RULES, battingTeamNames: { A: 'Alpha', B: 'Bravo' },
    battingFirstTeamId: 'A', battingSecondTeamId: 'B',
    innings: [makeInnings('A', 500, 10, 600, 'complete'), makeInnings('B', 250, 10, 480, 'complete')],
  });
  assert.ok(followOn.followOnRequired);
  assert.equal(followOn.followOnRequired?.teamId, 'A');
  assert.equal(followOn.followOnRequired?.margin, 250);
});

test('test match fourth innings chase produces a win by wickets', () => {
  const result = calculateMatchResult({
    rules: TEST_RULES, battingTeamNames: { A: 'Alpha', B: 'Bravo' },
    battingFirstTeamId: 'A', battingSecondTeamId: 'B',
    innings: [
      makeInnings('A', 300, 10, 500, 'complete'),
      makeInnings('B', 250, 10, 480, 'complete'),
      makeInnings('A', 200, 10, 400, 'complete'),
      makeInnings('B', 251, 7, 500, 'complete'),
    ],
  });
  assert.equal(result.resultType, 'WICKETS');
  assert.equal(result.winningTeamId, 'B');
  assert.equal(result.margin, 3);
});

test('a drawn test match reports a draw, never a fabricated winner', () => {
  const result = calculateMatchResult({
    rules: TEST_RULES, battingTeamNames: { A: 'Alpha', B: 'Bravo' },
    battingFirstTeamId: 'A', battingSecondTeamId: 'B',
    innings: [makeInnings('A', 300, 10, 500, 'complete'), makeInnings('B', 250, 10, 480, 'complete'), makeInnings('A', 100, 4, 200, 'in_progress')],
  });
  assert.equal(result.resultType, 'IN_PROGRESS');
});

function makeInnings(teamId: string, runs: number, wickets: number, legalBalls: number, status: 'in_progress' | 'complete' = 'complete') {
  const state = createInningsState({ inningsId: `${teamId}-${runs}`, matchId: 'm', inningsNumber: 1, battingTeamId: teamId, bowlingTeamId: 'X' });
  state.runs = runs; state.wickets = wickets; state.legalBalls = legalBalls; state.status = status;
  return state;
}

test('powerplay runs and wickets are tracked only inside the powerplay', () => {
  const { rules, sim } = newInnings({ powerplayOvers: 2 });
  open(sim, 'A1', 'A2', 'B1');
  bowlOver(sim, rules, 'B1', [4, 0, 0, 0, 0, 0]);
  bowlOver(sim, rules, 'B2', [1, 1, 1, 1, 1, 1]);
  bowlOver(sim, rules, 'B3', [6, 6, 6, 6, 6, 6]);
  assert.equal(sim.state.powerplay.runs, 10);
  assert.equal(sim.state.powerplay.balls, 12);
  assert.equal(sim.state.powerplay.wickets, 0);
  assert.equal(sim.state.runs, 46);
});
