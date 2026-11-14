import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, type Query, withQuery } from './client';

export interface Loadable<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** Повторная загрузка; `quiet` — без сброса текущих данных (фоновое обновление). */
  reload: (quiet?: boolean) => void;
  setData: (d: T | ((prev: T | null) => T | null)) => void;
}

/** Загрузка данных по адресу API. `path = null` — ничего не загружать. */
export function useApi<T>(path: string | null, query?: Query): Loadable<T> {
  const url = path === null ? null : withQuery(path, query);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState<boolean>(url !== null);
  const [tick, setTick] = useState(0);
  const quietRef = useRef(false);

  useEffect(() => {
    if (url === null) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    if (!quietRef.current) setLoading(true);
    setError(null);
    api
      .get<T>(url, undefined, { signal: ctrl.signal })
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.code === 'aborted') return;
        setError(e instanceof ApiError ? e : new ApiError(0, 'internal', String(e)));
        setLoading(false);
      })
      .finally(() => {
        quietRef.current = false;
      });
    return () => ctrl.abort();
  }, [url, tick]);

  const reload = useCallback((quiet?: boolean) => {
    quietRef.current = !!quiet;
    setTick((t) => t + 1);
  }, []);

  return { data, error, loading, reload, setData };
}

/** Флаг, который включается, только если `active` держится дольше `ms` (скелетоны — после 300 мс). */
export function useDelayed(active: boolean, ms = 300): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const t = window.setTimeout(() => setShown(true), ms);
    return () => window.clearTimeout(t);
  }, [active, ms]);
  return shown;
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Периодический вызов (опрос счётчиков). */
export function useInterval(fn: () => void, ms: number, enabled = true): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const t = window.setInterval(() => ref.current(), ms);
    return () => window.clearInterval(t);
  }, [ms, enabled]);
}

export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} — Документооборот UTECH` : 'Документооборот UTECH';
  }, [title]);
}
