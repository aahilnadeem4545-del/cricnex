import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, getStoredUser, getToken, setStoredUser, setToken, setUnauthorizedHandler } from './api';
import type { Role, User } from './types';

interface AuthValue {
  user: User | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  can: (...roles: Role[]) => boolean;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const [user, setUser] = useState<User | null>(() => (getToken() ? (getStoredUser() as User | null) : null));
  const [ready, setReady] = useState(false);

  const clear = useCallback(() => {
    setToken(null);
    setStoredUser(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(clear);
    return () => setUnauthorizedHandler(null);
  }, [clear]);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!getToken()) { setReady(true); return; }
      try {
        const { user: me } = await api.me();
        if (alive) { setUser(me as User); setStoredUser(me); }
      } catch {
        if (alive) clear();
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => { alive = false; };
  }, [clear]);

  const login = useCallback(async (username: string, password: string) => {
    const result = await api.login(username, password);
    setToken(result.token);
    setStoredUser(result.user);
    setUser(result.user as User);
  }, []);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* token may already be invalid */ }
    clear();
  }, [clear]);

  const value = useMemo<AuthValue>(() => ({
    user, ready, login, logout,
    can: (...roles: Role[]) => !!user && roles.includes(user.role),
  }), [user, ready, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
