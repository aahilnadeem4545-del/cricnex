import { useCallback, useEffect, useState, type ReactNode, type MouseEvent } from 'react';

/** A tiny hash router. Hash routing keeps deep links working behind the
 *  Fastify SPA fallback with no extra server configuration. */

export function currentPath(): string {
  const hash = window.location.hash.replace(/^#/, '');
  return hash === '' ? '/' : hash;
}

export function useRoute(): string {
  const [path, setPath] = useState(currentPath());
  useEffect(() => {
    const onChange = () => setPath(currentPath());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return path;
}

/** The path portion of the current route, without the query string. */
export function pathnameOf(path: string): string {
  const q = path.indexOf('?');
  return q === -1 ? path : path.slice(0, q);
}

/** Query parameters parsed from the hash route (e.g. #/matches?status=LIVE). */
export function useQuery(): URLSearchParams {
  const path = useRoute();
  const q = path.indexOf('?');
  return new URLSearchParams(q === -1 ? '' : path.slice(q + 1));
}

export function navigate(to: string): void {
  const target = to.startsWith('/') ? to : `/${to}`;
  if (currentPath() === target) return;
  window.location.hash = target;
}

export function Link({ to, children, className, onClick, ...rest }: {
  to: string; children: ReactNode; className?: string; onClick?: () => void;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'>): ReactNode {
  const handle = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    onClick?.();
    navigate(to);
  }, [to, onClick]);
  return <a href={`#${to}`} className={className} onClick={handle} {...rest}>{children}</a>;
}

/** Match `/a/:id/b` style patterns against the current path. */
export function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const q = path.split('/').filter(Boolean);
  if (p.length !== q.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(q[i]);
    else if (p[i] !== q[i]) return null;
  }
  return params;
}
