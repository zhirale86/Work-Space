import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, api, setSessionHandlers } from '../api/client';
import type { CurrentUser, MeResponse, MetaResponse, SystemRole } from '../api/types';

interface AuthValue {
  user: CurrentUser | null;
  /** Сессия проверена (первый ответ /auth/me получен). */
  ready: boolean;
  meta: MetaResponse | null;
  setUser: (u: CurrentUser | null) => void;
  hasRole: (r: SystemRole) => boolean;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
}

const Ctx = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('AuthProvider отсутствует');
  return v;
}

/** Требуется вход (используется в разделах, где пользователь точно есть). */
export function useMe(): CurrentUser {
  const { user } = useAuth();
  if (!user) throw new Error('Пользователь не определён');
  return user;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [ready, setReady] = useState(false);
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const navigate = useNavigate();

  const refreshMe = useCallback(async () => {
    try {
      const r = await api.get<MeResponse>('/auth/me', undefined, { silent401: true });
      setUser(r.user);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setUser(null);
    }
  }, []);

  useEffect(() => {
    void refreshMe().finally(() => setReady(true));
  }, [refreshMe]);

  useEffect(() => {
    if (!user || user.mustChangePassword) return;
    api
      .get<MetaResponse>('/meta')
      .then(setMeta)
      .catch(() => undefined);
  }, [user]);

  // Сессия истекла посреди работы — на вход с возвратом на текущую страницу.
  useEffect(() => {
    setSessionHandlers(
      () => {
        const here = window.location.pathname + window.location.search;
        setUser(null);
        if (!window.location.pathname.startsWith('/login')) navigate(`/login?next=${encodeURIComponent(here)}&reason=expired`, { replace: true });
      },
      () => navigate('/login/password', { replace: true }),
    );
    return () => setSessionHandlers(null, null);
  }, [navigate]);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout', {}, { silent401: true });
    } catch {
      /* сессия могла уже истечь */
    }
    setUser(null);
    setMeta(null);
    navigate('/login', { replace: true });
  }, [navigate]);

  const value = useMemo<AuthValue>(
    () => ({ user, ready, meta, setUser, hasRole: (r) => !!user?.roles.includes(r), logout, refreshMe }),
    [user, ready, meta, logout, refreshMe],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Обёртка закрытых разделов: без сессии — на вход с параметром next. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  const loc = useLocation();
  if (!ready) return null;
  if (!user) {
    const next = loc.pathname + loc.search;
    return <Navigate to={next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`} replace />;
  }
  if (user.mustChangePassword) return <Navigate to="/login/password" replace />;
  return <>{children}</>;
}
