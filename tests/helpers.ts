import { createInningsState, setOpeningPlayers, applyDelivery, ScoringError } from '../src/domain/engine';
import type { DeliveryInput, DeliveryRecord, InningsState, MatchRules } from '../src/domain/types';

export const T20_RULES: MatchRules = {
  format: 'T20', overs: 20, ballsPerOver: 6, inningsCount: 2,
  freeHitEnabled: true, powerplayOvers: 6, maxOversPerBowler: 4, followOnMargin: 200,
};

export const TEST_RULES: MatchRules = {
  format: 'TEST', overs: 0, ballsPerOver: 6, inningsCount: 4,
  freeHitEnabled: false, powerplayOvers: 0, maxOversPerBowler: 0, followOnMargin: 200,
};

export interface Sim {
  state: InningsState;
  records: DeliveryRecord[];
  inputs: DeliveryInput[];
}

export function newInnings(overrides: Partial<MatchRules> = {}, opts: { target?: number; inningsNumber?: number } = {}): { rules: MatchRules; sim: Sim } {
  const rules: MatchRules = { ...T20_RULES, ...overrides };
  const state = createInningsState({
    inningsId: 'inn1', matchId: 'm1', inningsNumber: opts.inningsNumber ?? 1,
    battingTeamId: 'A', bowlingTeamId: 'B', target: opts.target ?? null,
  });
  return { rules, sim: { state, records: [], inputs: [] } };
}

export function open(sim: Sim, striker: string, nonStriker: string, bowler: string): void {
  sim.state = setOpeningPlayers(sim.state, striker, nonStriker, bowler);
}

let keyCounter = 0;
export function ball(
  sim: Sim,
  rules: MatchRules,
  partial: Partial<DeliveryInput> & { strikerId: string; nonStrikerId: string; bowlerId: string },
): DeliveryRecord {
  const input: DeliveryInput = {
    idempotencyKey: `k${++keyCounter}`,
    batterRuns: 0, wides: 0, noBall: 0, byes: 0, legByes: 0, penalty: 0,
    recordedBy: 'tester',
    ...partial,
  };
  const result = applyDelivery(sim.state, input, rules);
  sim.state = result.state;
  sim.records.push(result.delivery);
  sim.inputs.push(input);
  return result.delivery;
}

export function ballOrThrow(
  sim: Sim,
  rules: MatchRules,
  partial: Partial<DeliveryInput> & { strikerId: string; nonStrikerId: string; bowlerId: string },
): ScoringError | null {
  try {
    ball(sim, rules, partial);
    return null;
  } catch (error) {
    if (error instanceof ScoringError) return error;
    throw error;
  }
}

/** Current striker/non-striker helper for concise tests. */
export function ends(sim: Sim): { striker: string | null; nonStriker: string | null } {
  return { striker: sim.state.strikerId, nonStriker: sim.state.nonStrikerId };
}

export function bowlOver(sim: Sim, rules: MatchRules, bowlerId: string, runsPerBall: number[]): void {
  for (const runs of runsPerBall) {
    ball(sim, rules, {
      strikerId: sim.state.strikerId!, nonStrikerId: sim.state.nonStrikerId!, bowlerId,
      batterRuns: runs,
    });
  }
}
