import { useEffect, useState, type ReactNode } from 'react';
import { Link, useRoute } from './router';
import { useAuth } from './auth';
import { onQueueChange, queueSize, flushQueue, isOnline } from './api';
import { useOnline } from './hooks';
import { useToast } from './ui';

const ICONS: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  matches: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0v9m0 0 6 3',
  plus: 'M12 5v14M5 12h14',
  teams: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm14 10v-2a4 4 0 0 0-3-3.87M16 3.13A4 4 0 0 1 16 11',
  players: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 0c-4 0-7 2.2-7 5v4h14v-4c0-2.8-3-5-7-5Z',
  trophy: 'M8 21h8m-4-4v4M7 4h10v4a5 5 0 0 1-10 0zM7 6H4v2a3 3 0 0 0 3 3m10-5h3v2a3 3 0 0 1-3 3',
  stats: 'M4 20V10m5 10V4m5 16v-7m5 7V8',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8-3a8 8 0 0 0-.14-1.5l2-1.55-2-3.46-2.36.95a8 8 0 0 0-2.6-1.5L14.5 2h-5l-.4 2.44a8 8 0 0 0-2.6 1.5l-2.36-.95-2 3.46 2 1.55A8 8 0 0 0 4 12a8 8 0 0 0 .14 1.5l-2 1.55 2 3.46 2.36-.95a8 8 0 0 0 2.6 1.5L9.5 22h5l.4-2.44a8 8 0 0 0 2.6-1.5l2.36.95 2-3.46-2-1.55A8 8 0 0 0 20 12Z',
};

export function Icon({ name, size = 18 }: { name: string; size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name] ?? ICONS.home} />
    </svg>
  );
}

const NAV: Array<{ to: string; label: string; icon: string; roles?: string[] }> = [
  { to: '/', label: 'Home', icon: 'home' },
  { to: '/matches', label: 'Matches', icon: 'matches' },
  { to: '/matches/new', label: 'Create match', icon: 'plus', roles: ['admin', 'scorer'] },
  { to: '/teams', label: 'Teams', icon: 'teams' },
  { to: '/players', label: 'Players', icon: 'players' },
  { to: '/tournaments', label: 'Tournaments', icon: 'trophy' },
  { to: '/stats', label: 'Statistics', icon: 'stats' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

function isActive(to: string, path: string): boolean {
  if (to === '/') return path === '/';
  if (to === '/matches/new') return path === '/matches/new';
  if (to === '/matches') return path === '/matches' || (path.startsWith('/matches/') && path !== '/matches/new');
  return path === to || path.startsWith(`${to}/`);
}

export function Layout({ children, title, subtitle, actions }: {
  children: ReactNode; title: string; subtitle?: string; actions?: ReactNode;
}): ReactNode {
  const path = useRoute();
  const { user, logout, can } = useAuth();
  const toast = useToast();
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(queueSize());
  const [syncing, setSyncing] = useState(false);

  useEffect(() => onQueueChange(setPending), []);
  useEffect(() => { setOpen(false); }, [path]);

  const sync = async () => {
    setSyncing(true);
    try {
      const result = await flushQueue();
      if (result.flushed > 0) toast.push(`Synced ${result.flushed} queued ball(s).`, 'success');
      for (const err of result.errors) toast.push(`Dropped an invalid queued ball: ${err}`, 'error');
      if (result.flushed === 0 && result.errors.length === 0) toast.push('Nothing queued to sync.');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="app-shell">
      {open && <div className="sidebar-scrim" onClick={() => setOpen(false)} />}
      <aside className={open ? 'sidebar open' : 'sidebar'}>
        <Link to="/" className="brand">
          <div className="brand-mark">C</div>
          <div>
            <div className="brand-name">CRICNEX</div>
            <div className="brand-sub">Scoreboard OS</div>
          </div>
        </Link>
        {NAV.filter((item) => !item.roles || can(...(item.roles as never[]))).map((item) => (
          <Link key={item.to} to={item.to} className={isActive(item.to, path) ? 'nav-link active' : 'nav-link'}>
            <span className="ico"><Icon name={item.icon} /></span>
            {item.label}
          </Link>
        ))}
        <div className="nav-foot">
          <div className="nav-sep" />
          <div className="row" style={{ padding: '6px 8px' }}>
            <div className="avatar">{user?.displayName?.slice(0, 1).toUpperCase() ?? '?'}</div>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ellipsis" style={{ fontWeight: 600, fontSize: '0.9rem' }}>{user?.displayName}</div>
              <div className="dim" style={{ fontSize: '0.74rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{user?.role}</div>
            </div>
          </div>
          <button className="btn ghost block sm" onClick={() => void logout()}>Sign out</button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="btn ghost sm hide-sm" style={{ display: 'none' }} aria-hidden />
          <button className="btn ghost sm" onClick={() => setOpen((v) => !v)} aria-label="Toggle navigation" style={{ padding: '7px 10px' }}>
            <Icon name="home" size={16} />
          </button>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="eyebrow">{subtitle ?? 'CRICNEX'}</div>
            <div className="ellipsis" style={{ fontWeight: 700, fontSize: '1.05rem' }}>{title}</div>
          </div>
          {!online && <span className="offline-bar">Offline{pending > 0 ? ` · ${pending} queued` : ''}</span>}
          {online && pending > 0 && (
            <button className="btn sm" onClick={() => void sync()} disabled={syncing}>
              {syncing ? 'Syncing…' : `Sync ${pending}`}
            </button>
          )}
          {actions}
        </header>
        <main className="page">{children}</main>
      </div>
    </div>
  );
}

/** True when the browser is online (re-exported for convenience in pages). */
export { isOnline };
