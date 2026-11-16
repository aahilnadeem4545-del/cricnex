import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import type { Db } from '../db/database';
import type { DeliveryInput } from '../domain/types';
import {
  authenticate, createSession, createUser, deleteUser, ensureBootstrapAdmin, listUsers, logout,
  setPassword, updateUserRole, verifyLogin, type Role, type User,
} from '../services/auth';
import {
  addPlayerToTeam, createPlayer, createTeam, deletePlayer, deleteTeam, getPlayer, getTeam,
  headToHead, listPlayers, listTeams, removePlayerFromTeam, updatePlayer, updateTeam,
} from '../services/catalog';
import {
  FORMAT_PRESETS, abandonMatch, createMatch, inningsScorecard, listMatches, liveScoreboard,
  matchDetail, parseRules, recordToss, rulesForFormat, setPlayerOfMatch, setSquad, validateMatchReady,
} from '../services/matches';
import {
  declareInnings, editDelivery, getInnings, loadInningsState, reopenInnings, scoreDelivery,
  setOpeners, startInnings, undoLastDelivery, rebuildInningsDerived, getMatch, activeDeliveries,
} from '../services/scoring';
import {
  battingLeaders, bowlingLeaders, inningsStatistics, matchStatistics, recomputeAfterMatch, recomputeAllCareers,
} from '../services/stats';
import {
  addTeamsToTournament, createFixture, createTournament, generateRoundRobin, getTournament,
  listTournaments, recomputePointsTable, tournamentLeaderboards,
} from '../services/tournaments';
import { backupHealth, createBackup, listBackups, pruneBackups } from '../services/backup';
import { applyIncomingEvents, getSyncConfig, pushOutbox, setSyncConfig, syncStatus, type SyncEvent } from '../services/sync';
import { HttpError, badRequest, forbidden } from '../services/util';

declare module 'fastify' {
  interface FastifyRequest {
    user?: User | null;
  }
}

export interface AppOptions {
  db: Db;
  uiDir?: string;
  backupDir: string;
  logger?: boolean;
}

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new HttpError(400, result.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), 'VALIDATION');
  }
  return result.data;
}

const deliverySchema = z.object({
  idempotencyKey: z.string().min(1).max(120),
  strikerId: z.string().min(1),
  nonStrikerId: z.string().min(1),
  bowlerId: z.string().min(1),
  batterRuns: z.number().int().min(0).max(6).default(0),
  wides: z.number().int().min(0).max(6).default(0),
  noBall: z.number().int().min(0).max(1).default(0),
  byes: z.number().int().min(0).max(6).default(0),
  legByes: z.number().int().min(0).max(6).default(0),
  penalty: z.number().int().min(0).max(50).default(0),
  eventType: z.enum(['DELIVERY', 'DEAD_BALL', 'RETIREMENT', 'FIELDER_CHANGE', 'INNINGS_EVENT']).optional(),
  dismissal: z.object({
    type: z.enum(['BOWLED', 'CAUGHT', 'LBW', 'RUN_OUT', 'STUMPED', 'HIT_WICKET', 'HIT_BALL_TWICE', 'OBSTRUCTING_FIELD', 'TIMED_OUT', 'RETIRED_OUT', 'RETIRED_HURT']),
    batterId: z.string().min(1),
    creditedBowlerId: z.string().min(1).nullable().optional(),
    fielderIds: z.array(z.string().min(1)).optional(),
    runsCompletedBeforeDismissal: z.number().int().min(0).max(6).optional(),
    note: z.string().max(200).optional(),
  }).optional(),
  shot: z.object({ angle: z.number().min(0).max(360).optional(), distance: z.number().min(0).max(200).optional() }).optional(),
  nextBatterId: z.string().min(1).optional(),
  note: z.string().max(500).optional(),
});

export function buildApp(options: AppOptions): FastifyInstance {
  const { db } = options;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 2 * 1024 * 1024 });
  ensureBootstrapAdmin(db);

  app.setErrorHandler((rawError: unknown, _req, reply) => {
    const error = rawError as { statusCode?: number; message?: string };
    if (rawError instanceof HttpError) {
      reply.status(rawError.status).send({ error: rawError.message, code: rawError.code });
      return;
    }
    if (rawError instanceof ZodError) {
      reply.status(400).send({ error: rawError.issues.map(i => i.message).join('; '), code: 'VALIDATION' });
      return;
    }
    const status = error.statusCode ?? 500;
    if (status >= 500) app.log.error(rawError as Error);
    reply.status(status).send({ error: error.message || 'Internal error', code: 'INTERNAL' });
  });

  app.addHook('onRequest', async (request) => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : (request.headers['x-cricnex-token'] as string | undefined);
    request.user = authenticate(db, token);
  });

  function requireUser(request: FastifyRequest): User {
    if (!request.user) throw new HttpError(401, 'Authentication required.', 'UNAUTHENTICATED');
    return request.user;
  }
  function requireRole(request: FastifyRequest, roles: Role[]): User {
    const user = requireUser(request);
    if (!roles.includes(user.role)) throw forbidden(`This action requires one of: ${roles.join(', ')}.`);
    return user;
  }
  const write = (request: FastifyRequest) => requireRole(request, ['admin', 'scorer']);

  /* ---------------- auth & users ---------------- */
  app.post('/api/auth/login', async (request) => {
    const body = parse(z.object({ username: z.string().min(1), password: z.string().min(1) }), request.body);
    const user = verifyLogin(db, body.username, body.password);
    const session = createSession(db, user);
    return { token: session.token, expiresAt: session.expiresAt, user };
  });

  app.post('/api/auth/logout', async (request) => {
    const header = request.headers.authorization;
    logout(db, header?.startsWith('Bearer ') ? header.slice(7) : undefined);
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => ({ user: requireUser(request) }));

  app.get('/api/users', async (request) => {
    requireRole(request, ['admin']);
    return { users: listUsers(db) };
  });

  app.post('/api/users', async (request) => {
    requireRole(request, ['admin']);
    const body = parse(z.object({
      username: z.string().min(3).max(32),
      password: z.string().min(8),
      displayName: z.string().min(1).max(80),
      role: z.enum(['admin', 'scorer', 'viewer']),
    }), request.body);
    return { user: createUser(db, body.username, body.password, body.displayName, body.role) };
  });

  app.patch('/api/users/:id/role', async (request) => {
    const actor = requireRole(request, ['admin']);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    const body = parse(z.object({ role: z.enum(['admin', 'scorer', 'viewer']) }), request.body);
    return { user: updateUserRole(db, actor.id, id, body.role) };
  });

  app.post('/api/users/:id/password', async (request) => {
    requireRole(request, ['admin']);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    const body = parse(z.object({ password: z.string().min(8) }), request.body);
    setPassword(db, id, body.password);
    return { ok: true };
  });

  app.delete('/api/users/:id', async (request) => {
    const actor = requireRole(request, ['admin']);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    deleteUser(db, actor.id, id);
    return { ok: true };
  });

  /* ---------------- teams ---------------- */
  app.get('/api/teams', async (request) => {
    requireUser(request);
    return { teams: listTeams(db) };
  });
  app.post('/api/teams', async (request) => {
    write(request);
    const body = parse(z.object({
      name: z.string().min(1).max(80), shortName: z.string().max(10).nullish(),
      logoUrl: z.string().max(500).nullish(), coach: z.string().max(80).nullish(), captainId: z.string().nullish(),
    }), request.body);
    return { team: createTeam(db, body) };
  });
  app.get('/api/teams/:id', async (request) => {
    requireUser(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    return { team: getTeam(db, id) };
  });
  app.patch('/api/teams/:id', async (request) => {
    write(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    const body = parse(z.object({
      name: z.string().min(1).max(80).optional(), shortName: z.string().max(10).nullish(),
      logoUrl: z.string().max(500).nullish(), coach: z.string().max(80).nullish(), captainId: z.string().nullish(),
    }), request.body);
    return { team: updateTeam(db, id, body) };
  });
  app.delete('/api/teams/:id', async (request) => {
    requireRole(request, ['admin']);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    deleteTeam(db, id);
    return { ok: true };
  });
  app.post('/api/teams/:id/players', async (request) => {
    write(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    const body = parse(z.object({ playerId: z.string(), isCaptain: z.boolean().optional(), isWicketkeeper: z.boolean().optional() }), request.body);
    addPlayerToTeam(db, id, body.playerId, body);
    return { team: getTeam(db, id) };
  });
  app.delete('/api/teams/:id/players/:playerId', async (request) => {
    write(request);
    const { id, playerId } = parse(z.object({ id: z.string(), playerId: z.string() }), request.params);
    removePlayerFromTeam(db, id, playerId);
    return { team: getTeam(db, id) };
  });
  app.get('/api/teams/:id/head-to-head/:otherId', async (request) => {
    requireUser(request);
    const { id, otherId } = parse(z.object({ id: z.string(), otherId: z.string() }), request.params);
    return { record: headToHead(db, id, otherId) };
  });

  /* ---------------- players ---------------- */
  app.get('/api/players', async (request) => {
    requireUser(request);
    const q = parse(z.object({
      search: z.string().optional(), teamId: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional(),
    }), request.query);
    return listPlayers(db, q);
  });
  app.post('/api/players', async (request) => {
    write(request);
    const body = parse(z.object({
      fullName: z.string().min(1).max(80), photoUrl: z.string().max(500).nullish(),
      jerseyNumber: z.number().int().min(0).max(999).nullish(), battingStyle: z.string().max(40).nullish(),
      bowlingStyle: z.string().max(60).nullish(), playingRole: z.string().max(40).nullish(),
      primaryTeamId: z.string().nullish(),
    }), request.body);
    return { player: createPlayer(db, body) };
  });
  app.get('/api/players/:id', async (request) => {
    requireUser(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    return { player: getPlayer(db, id) };
  });
  app.patch('/api/players/:id', async (request) => {
    write(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    const body = parse(z.object({
      fullName: z.string().min(1).max(80).optional(), photoUrl: z.string().max(500).nullish(),
      jerseyNumber: z.number().int().min(0).max(999).nullish(), battingStyle: z.string().max(40).nullish(),
      bowlingStyle: z.string().max(60).nullish(), playingRole: z.string().max(40).nullish(),
      primaryTeamId: z.string().nullish(),
    }), request.body);
    return { player: updatePlayer(db, id, body) };
  });
  app.delete('/api/players/:id', async (request) => {
    requireRole(request, ['admin']);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    deletePlayer(db, id);
    return { ok: true };
  });

  /* ---------------- matches ---------------- */
  app.get('/api/formats', async () => ({ presets: FORMAT_PRESETS }));

  app.get('/api/matches', async (request) => {
    requireUser(request);
    const q = parse(z.object({
      status: z.string().optional(), teamId: z.string().optional(), tournamentId: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(), offset: z.coerce.number().int().min(0).optional(),
    }), request.query);
    return listMatches(db, q);
  });

  app.post('/api/matches', async (request) => {
    const user = write(request);
    const body = parse(z.object({
      title: z.string().min(1).max(140),
      tournamentId: z.string().nullish(), tournamentName: z.string().max(140).nullish(),
      venue: z.string().max(140).nullish(), matchDate: z.string().nullish(),
      format: z.enum(['TEST', 'ODI', 'T20', 'T10', 'CUSTOM', 'TENNIS_BALL', 'TAPE_BALL', 'LOCAL']),
      rules: z.object({
        overs: z.number().int().min(0).max(1000).optional(),
        ballsPerOver: z.number().int().min(1).max(12).optional(),
        inningsCount: z.number().int().min(1).max(4).optional(),
        freeHitEnabled: z.boolean().optional(),
        powerplayOvers: z.number().int().min(0).max(100).optional(),
        maxOversPerBowler: z.number().int().min(0).max(100).optional(),
        followOnMargin: z.number().int().min(0).max(1000).optional(),
      }).optional(),
      teamAId: z.string().min(1), teamBId: z.string().min(1),
      squads: z.object({
        teamA: z.array(z.object({
          playerId: z.string(), inPlayingXI: z.boolean().optional(), isCaptain: z.boolean().optional(),
          isWicketkeeper: z.boolean().optional(), isSubstitute: z.boolean().optional(),
        })).optional(),
        teamB: z.array(z.object({
          playerId: z.string(), inPlayingXI: z.boolean().optional(), isCaptain: z.boolean().optional(),
          isWicketkeeper: z.boolean().optional(), isSubstitute: z.boolean().optional(),
        })).optional(),
      }).optional(),
      umpires: z.array(z.string().max(80)).optional(),
      toss: z.object({ winnerTeamId: z.string(), decision: z.enum(['BAT', 'BOWL']) }).nullish(),
    }), request.body);
    return { match: createMatch(db, { ...body, createdBy: user.id }) };
  });

  app.get('/api/matches/:id', async (request) => {
    requireUser(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    return matchDetail(db, id);
  });

  app.get('/api/matches/:id/live', async (request) => {
    requireUser(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    return { live: liveScoreboard(db, id) };
  });

  app.get('/api/matches/:id/stats', async (request) => {
    requireUser(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    return { stats: matchStatistics(db, id) };
  });

  app.get('/api/matches/:id/validate', async (request) => {
    requireUser(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    return validateMatchReady(db, id);
  });

  app.post('/api/matches/:id/toss', async (request) => {
    const user = write(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    const body = parse(z.object({ winnerTeamId: z.string(), decision: z.enum(['BAT', 'BOWL']) }), request.body);
    return { match: recordToss(db, user.id, id, body.winnerTeamId, body.decision) };
  });

  app.post('/api/matches/:id/squads', async (request) => {
    write(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    const body = parse(z.object({
      teamId: z.string(),
      entries: z.array(z.object({
        playerId: z.string(), inPlayingXI: z.boolean().optional(), isCaptain: z.boolean().optional(),
        isWicketkeeper: z.boolean().optional(), isSubstitute: z.boolean().optional(),
      })),
    }), request.body);
    setSquad(db, id, body.teamId, body.entries);
    return { ok: true };
  });

  app.post('/api/matches/:id/innings', async (request) => {
    const user = write(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    const body = parse(z.object({
      battingTeamId: z.string(), target: z.number().int().min(1).nullish(),
      inningsNumber: z.number().int().min(1).max(4).optional(), followOnEnforced: z.boolean().optional(),
    }), request.body);
    return { innings: startInnings(db, { userId: user.id, role: user.role }, id, body.battingTeamId, body) };
  });

  app.post('/api/matches/:id/abandon', async (request) => {
    const user = write(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    const body = parse(z.object({ reason: z.string().min(1).max(200) }), request.body);
    return { match: abandonMatch(db, user.id, id, body.reason) };
  });

  app.patch('/api/matches/:id/player-of-match', async (request) => {
    write(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    const body = parse(z.object({ playerId: z.string() }), request.body);
    setPlayerOfMatch(db, id, body.playerId);
    return { ok: true };
  });

  app.post('/api/matches/:id/finalize', async (request) => {
    const user = write(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    getMatch(db, id);
    recomputeAfterMatch(db, id);
    return { ok: true, stats: matchStatistics(db, id) };
  });

  /* ---------------- innings & scoring ---------------- */
  app.get('/api/innings/:id', async (request) => {
    requireUser(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    return { innings: getInnings(db, id), state: loadInningsState(db, id), scorecard: inningsScorecard(db, id) };
  });

  app.get('/api/innings/:id/scorecard', async (request) => {
    requireUser(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    return { scorecard: inningsScorecard(db, id) };
  });

  app.get('/api/innings/:id/statistics', async (request) => {
    requireUser(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    return { statistics: inningsStatistics(db, id) };
  });

  app.get('/api/innings/:id/deliveries', async (request) => {
    requireUser(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    const rows = activeDeliveries(db, id);
    return { deliveries: rows };
  });

  app.post('/api/innings/:id/openers', async (request) => {
    const user = write(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    const body = parse(z.object({ strikerId: z.string().optional(), nonStrikerId: z.string().optional(), bowlerId: z.string() }), request.body);
    return { state: setOpeners(db, { userId: user.id, role: user.role }, id, body.strikerId, body.nonStrikerId, body.bowlerId) };
  });

  app.post('/api/innings/:id/deliveries', async (request) => {
    const user = write(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    const body = parse(deliverySchema, request.body);
    const input: DeliveryInput = { ...body, recordedBy: user.id } as DeliveryInput;
    return scoreDelivery(db, { userId: user.id, role: user.role }, id, input);
  });

  app.post('/api/innings/:id/undo', async (request) => {
    const user = write(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    const body = parse(z.object({ reason: z.string().max(200).default('Undo last delivery') }), request.body ?? {});
    return { state: undoLastDelivery(db, { userId: user.id, role: user.role }, id, body.reason) };
  });

  app.post('/api/innings/:id/reopen', async (request) => {
    const user = write(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    return { state: reopenInnings(db, { userId: user.id, role: user.role }, id) };
  });

  app.post('/api/innings/:id/declare', async (request) => {
    const user = write(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    return { state: declareInnings(db, { userId: user.id, role: user.role }, id) };
  });

  app.post('/api/innings/:id/rebuild', async (request) => {
    const user = write(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    return { state: rebuildInningsDerived(db, id) };
  });

  app.patch('/api/deliveries/:deliveryId', async (request) => {
    const user = write(request);
    const { deliveryId } = parse(z.object({ deliveryId: z.string() }), request.params);
    const body = parse(deliverySchema.extend({ reason: z.string().max(200).default('Correction') }), request.body);
    const { reason, ...rest } = body;
    return editDelivery(db, { userId: user.id, role: user.role }, deliveryId, { ...rest, recordedBy: user.id } as DeliveryInput, reason);
  });

  /* ---------------- tournaments ---------------- */
  app.get('/api/tournaments', async (request) => {
    requireUser(request);
    return { tournaments: listTournaments(db) };
  });
  app.post('/api/tournaments', async (request) => {
    write(request);
    const body = parse(z.object({
      name: z.string().min(1).max(140), format: z.string().max(20).nullish(),
      startDate: z.string().nullish(), endDate: z.string().nullish(),
      config: z.object({ pointsWin: z.number().int().min(0).max(10).optional(), pointsTie: z.number().int().min(0).max(10).optional(), pointsNoResult: z.number().int().min(0).max(10).optional() }).optional(),
    }), request.body);
    return { tournament: createTournament(db, body) };
  });
  app.get('/api/tournaments/:id', async (request) => {
    requireUser(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    return getTournament(db, id);
  });
  app.post('/api/tournaments/:id/teams', async (request) => {
    write(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    const body = parse(z.object({ teamIds: z.array(z.string()).min(1), groupName: z.string().max(40).nullish() }), request.body);
    addTeamsToTournament(db, id, body.teamIds, body.groupName ?? null);
    return getTournament(db, id);
  });
  app.post('/api/tournaments/:id/fixtures/generate', async (request) => {
    write(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    const body = parse(z.object({ venue: z.string().max(140).nullish(), startDate: z.string().nullish(), doubleRound: z.boolean().optional() }), request.body ?? {});
    return { fixtures: generateRoundRobin(db, id, body) };
  });
  app.post('/api/tournaments/:id/fixtures', async (request) => {
    write(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    const body = parse(z.object({ teamAId: z.string(), teamBId: z.string(), round: z.string().max(40).nullish(), venue: z.string().max(140).nullish(), scheduledAt: z.string().nullish() }), request.body);
    return { fixture: createFixture(db, id, body.teamAId, body.teamBId, body) };
  });
  app.post('/api/tournaments/:id/recompute', async (request) => {
    write(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    return { pointsTable: recomputePointsTable(db, id) };
  });
  app.get('/api/tournaments/:id/leaderboards', async (request) => {
    requireUser(request);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    return { leaderboards: tournamentLeaderboards(db, id) };
  });

  /* ---------------- statistics & dashboard ---------------- */
  app.get('/api/stats/leaderboards', async (request) => {
    requireUser(request);
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }), request.query);
    return { batting: battingLeaders(db, q.limit ?? 20), bowling: bowlingLeaders(db, q.limit ?? 20) };
  });

  app.post('/api/stats/recompute', async (request) => {
    requireRole(request, ['admin']);
    recomputeAllCareers(db);
    return { ok: true };
  });

  app.get('/api/dashboard', async (request) => {
    requireUser(request);
    const live = db.all(
      `SELECT m.id, m.title, m.status, m.format, ta.name AS team_a_name, tb.name AS team_b_name
       FROM matches m JOIN teams ta ON ta.id = m.team_a_id JOIN teams tb ON tb.id = m.team_b_id
       WHERE m.status IN ('LIVE','INNINGS_BREAK','TOSS') ORDER BY m.updated_at DESC LIMIT 6`,
    );
    const recent = db.all(
      `SELECT m.id, m.title, m.status, m.result_summary, m.result_type, m.winner_team_id, m.match_date, m.created_at,
         ta.name AS team_a_name, tb.name AS team_b_name
       FROM matches m JOIN teams ta ON ta.id = m.team_a_id JOIN teams tb ON tb.id = m.team_b_id
       WHERE m.status IN ('COMPLETED','DRAWN','NO_RESULT','ABANDONED') ORDER BY COALESCE(m.match_date, m.updated_at) DESC LIMIT 6`,
    );
    const counts = {
      teams: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM teams')?.n ?? 0,
      players: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM players')?.n ?? 0,
      matches: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM matches')?.n ?? 0,
      tournaments: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tournaments')?.n ?? 0,
      deliveries: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM deliveries WHERE status = ?', 'active')?.n ?? 0,
      live: live.length,
    };
    const upcoming = db.all(
      `SELECT f.*, ta.name AS team_a_name, tb.name AS team_b_name FROM fixtures f
       JOIN teams ta ON ta.id = f.team_a_id JOIN teams tb ON tb.id = f.team_b_id
       WHERE f.status = 'scheduled' ORDER BY COALESCE(f.scheduled_at, '9999') ASC LIMIT 5`,
    );
    return { live, recent, counts, upcoming, topBatting: battingLeaders(db, 5), topBowling: bowlingLeaders(db, 5) };
  });

  /* ---------------- sync, backups, system ---------------- */
  app.get('/api/sync/status', async (request) => {
    requireUser(request);
    return syncStatus(db);
  });
  app.post('/api/sync/config', async (request) => {
    requireRole(request, ['admin']);
    const body = parse(z.object({ remoteUrl: z.string().url().nullish(), enabled: z.boolean().optional() }), request.body);
    return setSyncConfig(db, { remoteUrl: body.remoteUrl ?? null, enabled: body.enabled });
  });
  app.post('/api/sync/push', async (request) => {
    const body = parse(z.object({
      deviceId: z.string().optional(),
      events: z.array(z.object({
        id: z.string(), entity_type: z.string(), entity_id: z.string(), op: z.string(),
        payload_json: z.string(), version: z.number().optional(), created_at: z.string().optional(),
        match_id: z.string().nullish(),
      })).max(1000),
    }), request.body);
    return applyIncomingEvents(db, body.events.map(e => ({
      ...e, match_id: e.match_id ?? null, version: e.version ?? 0, created_at: e.created_at ?? new Date().toISOString(),
    })) as SyncEvent[], body.deviceId ?? 'unknown');
  });
  app.post('/api/sync/run', async (request) => {
    requireRole(request, ['admin', 'scorer']);
    const body = parse(z.object({ remoteUrl: z.string().url().optional() }), request.body ?? {});
    return pushOutbox(db, body);
  });

  app.get('/api/backups', async (request) => {
    requireRole(request, ['admin']);
    return { backups: listBackups(options.backupDir), health: backupHealth(db) };
  });
  app.post('/api/backups', async (request) => {
    requireRole(request, ['admin']);
    const body = parse(z.object({ keep: z.number().int().min(1).max(100).optional() }), request.body ?? {});
    const backup = createBackup(db, options.backupDir);
    const removed = pruneBackups(options.backupDir, body.keep ?? 10);
    return { backup, removed };
  });

  app.get('/api/system/health', async () => ({
    ok: db.integrityCheck() === 'ok',
    integrity: db.integrityCheck(),
    pendingSync: syncStatus(db).pending,
    device: getSyncConfig(db).deviceId,
  }));

  app.get('/api/settings', async (request) => {
    requireRole(request, ['admin']);
    return { sync: getSyncConfig(db), backups: listBackups(options.backupDir) };
  });

  /* ---------------- static UI ---------------- */
  const uiDir = options.uiDir ? resolve(options.uiDir) : null;
  if (uiDir && existsSync(uiDir)) {
    app.register(fastifyStatic, { root: uiDir, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        reply.status(404).send({ error: 'Not found', code: 'NOT_FOUND' });
        return;
      }
      reply.sendFile('index.html');
    });
  } else {
    app.get('/', async () => ({
      name: 'CRICNEX API',
      note: 'UI build not found. Run `npm run build:ui` or `npm run dev:ui` for the front-end.',
      health: '/api/system/health',
    }));
  }

  return app;
}
