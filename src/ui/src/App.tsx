import { type ReactNode } from 'react';
import { Layout } from './Layout';
import { matchRoute, pathnameOf, useRoute } from './router';
import { useAuth } from './auth';
import { Empty, Loading } from './ui';
import { Login } from './pages/Login';
import { Home } from './pages/Home';
import { Matches } from './pages/Matches';
import { CreateMatch } from './pages/CreateMatch';
import { MatchDetail } from './pages/MatchDetail';
import { Scoring } from './pages/Scoring';
import { Teams } from './pages/Teams';
import { TeamDetail } from './pages/TeamDetail';
import { Players } from './pages/Players';
import { PlayerDetail } from './pages/PlayerDetail';
import { Tournaments } from './pages/Tournaments';
import { TournamentDetail } from './pages/TournamentDetail';
import { Statistics } from './pages/Statistics';
import { Settings } from './pages/Settings';

interface Resolved { node: ReactNode; title: string; subtitle: string; }

function resolve(path: string): Resolved {
  const clean = pathnameOf(path);
  const wrap = (title: string, subtitle: string, node: ReactNode): Resolved => ({ title, subtitle, node });

  if (clean === '/') return wrap('Dashboard', 'CRICNEX', <Home />);

  let m: Record<string, string> | null;
  if (clean === '/matches') return wrap('Matches', 'Match centre', <Matches />);
  if (clean === '/matches/new') return wrap('Create match', 'Match wizard', <CreateMatch />);
  if ((m = matchRoute('/matches/:id/score', clean))) return wrap('Live scoring', 'Ball by ball', <Scoring matchId={m.id} />);
  if ((m = matchRoute('/matches/:id', clean))) return wrap('Match', 'Match centre', <MatchDetail matchId={m.id} />);

  if (clean === '/teams') return wrap('Teams', 'Squads', <Teams />);
  if ((m = matchRoute('/teams/:id', clean))) return wrap('Team', 'Squad', <TeamDetail teamId={m.id} />);

  if (clean === '/players') return wrap('Players', 'Registry', <Players />);
  if ((m = matchRoute('/players/:id', clean))) return wrap('Player', 'Profile', <PlayerDetail playerId={m.id} />);

  if (clean === '/tournaments') return wrap('Tournaments', 'Competitions', <Tournaments />);
  if ((m = matchRoute('/tournaments/:id', clean))) return wrap('Tournament', 'Competition', <TournamentDetail tournamentId={m.id} />);

  if (clean === '/stats') return wrap('Statistics', 'Leaderboards', <Statistics />);
  if (clean === '/settings') return wrap('Settings', 'System', <Settings />);

  return wrap('Not found', 'CRICNEX', <Empty title="Page not found" hint={`No route matches ${clean}`} />);
}

export function App(): ReactNode {
  const path = useRoute();
  const { user, ready } = useAuth();

  if (!ready) return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}><Loading label="Starting CRICNEX…" /></div>;
  if (!user) return <Login />;

  const { node, title, subtitle } = resolve(path);
  return <Layout title={title} subtitle={subtitle}>{node}</Layout>;
}
