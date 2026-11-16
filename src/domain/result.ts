import type { InningsState, MatchResult, MatchRules } from './types';

export interface MatchContext {
  rules: MatchRules;
  innings: InningsState[]; // in innings order
  battingTeamNames: Record<string, string>;
  isAbandoned?: boolean;
  isNoResult?: boolean;
  isDrawAgreed?: boolean;
  isSuperOver?: boolean;
  battingFirstTeamId: string;
  battingSecondTeamId: string;
}

function name(ctx: MatchContext, id: string): string {
  return ctx.battingTeamNames[id] ?? id;
}

export function calculateMatchResult(ctx: MatchContext): MatchResult {
  const dls = { available: false as const, reason: 'DLS is not available: no validated DLS engine or authorised integration is configured.' };
  const { innings, rules } = ctx;
  if (ctx.isNoResult) return { resultType: 'NO_RESULT', winningTeamId: null, margin: null, summary: 'No result', dls };
  if (ctx.isAbandoned) return { resultType: 'ABANDONED', winningTeamId: null, margin: null, summary: 'Match abandoned', dls };
  if (ctx.isSuperOver) return { resultType: 'SUPER_OVER', winningTeamId: null, margin: null, summary: 'Super over in progress/recorded', dls };

  const limited = rules.inningsCount <= 2 && rules.format !== 'TEST';
  if (limited) return limitedOversResult(ctx);
  return testResult(ctx);
}

function limitedOversResult(ctx: MatchContext): MatchResult {
  const dls = { available: false as const, reason: 'DLS is not available: no validated DLS engine or authorised integration is configured.' };
  const [inn1, inn2] = ctx.innings;
  if (!inn1) return { resultType: 'IN_PROGRESS', winningTeamId: null, margin: null, summary: 'Match in progress', dls };
  if (!inn2) {
    return { resultType: 'IN_PROGRESS', winningTeamId: null, margin: null, summary: `${name(ctx, inn1.battingTeamId)} ${inn1.runs}/${inn1.wickets}`, dls };
  }
  const innings1Runs = inn1.runs;
  const innings2Runs = inn2.runs;
  const team1 = inn1.battingTeamId;
  const team2 = inn2.battingTeamId;
  const { rules } = ctx;
  const maxWickets = 10;

  if (innings2Runs > innings1Runs) {
    const margin = maxWickets - inn2.wickets;
    return {
      resultType: 'WICKETS', winningTeamId: team2, margin,
      summary: `${name(ctx, team2)} won by ${margin} wicket${margin === 1 ? '' : 's'}`, dls,
    };
  }
  if (innings2Runs < innings1Runs) {
    const margin = innings1Runs - innings2Runs;
    return {
      resultType: 'RUNS', winningTeamId: team1, margin,
      summary: `${name(ctx, team1)} won by ${margin} run${margin === 1 ? '' : 's'}`, dls,
    };
  }
  // Scores level: tie unless super over context says otherwise
  return { resultType: 'TIE', winningTeamId: null, margin: 0, summary: 'Match tied', dls };
}

function teamAggregate(innings: InningsState[], teamId: string): number {
  return innings.filter(i => i.battingTeamId === teamId).reduce((s, i) => s + i.runs, 0);
}

function testResult(ctx: MatchContext): MatchResult {
  const dls = { available: false as const, reason: 'DLS is not available: no validated DLS engine or authorised integration is configured.' };
  const { innings } = ctx;
  if (ctx.isDrawAgreed || innings.length === 0) {
    return { resultType: innings.length === 0 ? 'IN_PROGRESS' : 'DRAW', winningTeamId: null, margin: null, summary: innings.length === 0 ? 'Match in progress' : 'Match drawn', dls };
  }

  const teamA = ctx.battingFirstTeamId;
  const teamB = ctx.battingSecondTeamId;
  const aInnings = innings.filter(i => i.battingTeamId === teamA);
  const bInnings = innings.filter(i => i.battingTeamId === teamB);
  const aTotal = aInnings.reduce((s, i) => s + i.runs, 0);
  const bTotal = bInnings.reduce((s, i) => s + i.runs, 0);
  const last = innings[innings.length - 1];

  // Innings victory: a team completed 2 innings, the other completed <=1,
  // and the latter's total is less than the former's first-innings-equivalent lead.
  if (aInnings.length === 1 && bInnings.length === 2 && last.status === 'complete' && bTotal < aInnings[0].runs) {
    const margin = aInnings[0].runs - bTotal;
    return { resultType: 'INNINGS', winningTeamId: teamA, margin, summary: `${name(ctx, teamA)} won by an innings and ${margin} run${margin === 1 ? '' : 's'}`, dls };
  }
  if (bInnings.length === 1 && aInnings.length === 2 && last.status === 'complete' && aTotal < bInnings[0].runs) {
    const margin = bInnings[0].runs - aTotal;
    return { resultType: 'INNINGS', winningTeamId: teamB, margin, summary: `${name(ctx, teamB)} won by an innings and ${margin} run${margin === 1 ? '' : 's'}`, dls };
  }

  // Normal 4-innings chase in the 4th innings
  const fourthIsChase = innings.length === 4 && last.battingTeamId;
  if (fourthIsChase) {
    const chasingTeam = last.battingTeamId;
    const defendingTeam = chasingTeam === teamA ? teamB : teamA;
    const chaseTotal = teamAggregate(innings, chasingTeam);
    const defendTotal = teamAggregate(innings, defendingTeam);
    if (chaseTotal > defendTotal) {
      const margin = 10 - last.wickets;
      return { resultType: 'WICKETS', winningTeamId: chasingTeam, margin, summary: `${name(ctx, chasingTeam)} won by ${margin} wicket${margin === 1 ? '' : 's'}`, dls };
    }
    if (chaseTotal < defendTotal && last.status === 'complete') {
      const margin = defendTotal - chaseTotal;
      return { resultType: 'RUNS', winningTeamId: defendingTeam, margin, summary: `${name(ctx, defendingTeam)} won by ${margin} run${margin === 1 ? '' : 's'}`, dls };
    }
    if (chaseTotal === defendTotal && last.status === 'complete') {
      return { resultType: 'TIE', winningTeamId: null, margin: 0, summary: 'Match tied', dls };
    }
  }

  // Follow-on detection after 2nd innings: if team batting second is behind
  // by >= followOnMargin, the fielding captain may enforce follow-on.
  let followOnRequired: { teamId: string; margin: number } | null = null;
  if (innings.length === 2) {
    const lead = aInnings[0].runs - bTotal;
    const margin = ctx.rules.followOnMargin ?? 200;
    if (lead >= margin) followOnRequired = { teamId: teamA, margin: lead };
  }

  if (last.status === 'complete' && innings.length >= 3) {
    // completed but not caught by above cases -> draw-like incomplete result
    return { resultType: 'DRAW', winningTeamId: null, margin: null, summary: 'Match drawn', dls, followOnRequired };
  }

  return { resultType: 'IN_PROGRESS', winningTeamId: null, margin: null, summary: 'Match in progress', dls, followOnRequired };
}
