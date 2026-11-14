import type { ApiErrorBody, ErrorCode, ErrorDetail } from './types';

export type ClientErrorCode = ErrorCode | 'network' | 'aborted';

/** Ошибка запроса к API: машинный код, готовый русский текст и перечень замечаний. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ClientErrorCode,
    message: string,
    public readonly details: ErrorDetail[] = [],
  ) {
    super(message);
  }
}

export const NETWORK_MESSAGE = 'Нет связи с сервером. Проверьте подключение и повторите.';
export const SERVER_MESSAGE = 'Не удалось выполнить действие. Попробуйте ещё раз; если ошибка повторится — сообщите администратору.';
export const FORBIDDEN_MESSAGE = 'У вас нет прав на это действие.';

type Handler = () => void;
let onUnauthorized: Handler | null = null;
let onPasswordChange: Handler | null = null;

/** Обработчики сессии регистрирует AuthProvider: 401 → вход, 403 password_change_required → смена пароля. */
export function setSessionHandlers(unauthorized: Handler | null, passwordChange: Handler | null): void {
  onUnauthorized = unauthorized;
  onPasswordChange = passwordChange;
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `${path}${path.includes('?') ? '&' : '?'}${s}` : path;
}

interface RequestOptions {
  /** Не переходить на вход при 401 (запрос самой сессии, вход). */
  silent401?: boolean;
  signal?: AbortSignal;
}

function toError(status: number, body: unknown): ApiError {
  const err = (body as ApiErrorBody | null)?.error;
  if (err?.code) return new ApiError(status, err.code, err.message || SERVER_MESSAGE, err.details ?? []);
  if (status >= 500) return new ApiError(status, 'internal', SERVER_MESSAGE);
  if (status === 404) return new ApiError(status, 'not_found', 'Объект не найден или нет доступа');
  return new ApiError(status, 'internal', SERVER_MESSAGE);
}

function handleSession(e: ApiError, opts?: RequestOptions): void {
  if (e.status === 401 && e.code === 'unauthorized' && !opts?.silent401) onUnauthorized?.();
  if (e.status === 403 && e.code === 'password_change_required') onPasswordChange?.();
}

export async function request<T>(method: string, path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const mutating = method !== 'GET' && method !== 'HEAD';
  let payload: BodyInit | undefined;
  if (mutating) {
    headers['X-Requested-With'] = 'docflow';
    if (body instanceof FormData) payload = body;
    else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body ?? {});
    }
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: payload, credentials: 'same-origin', signal: opts?.signal });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw new ApiError(0, 'aborted', 'Запрос отменён');
    throw new ApiError(0, 'network', NETWORK_MESSAGE);
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const e = toError(res.status, data);
    handleSession(e, opts);
    throw e;
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query, opts?: RequestOptions) => request<T>('GET', withQuery(path, query), undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, body, opts),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

export interface UploadHandle<T> {
  promise: Promise<T>;
  abort: () => void;
}

/** Загрузка файла с ходом выполнения (XMLHttpRequest — у fetch нет прогресса отправки). */
export function upload<T>(path: string, file: File, onProgress?: (percent: number) => void): UploadHandle<T> {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<T>((resolve, reject) => {
    xhr.open('POST', `/api${path}`);
    xhr.withCredentials = false;
    xhr.setRequestHeader('X-Requested-With', 'docflow');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && onProgress) onProgress(Math.round((ev.loaded / ev.total) * 100));
    };
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else {
        const e = toError(xhr.status, data);
        handleSession(e);
        reject(e);
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', NETWORK_MESSAGE));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Загрузка отменена'));
    const fd = new FormData();
    fd.append('file', file, file.name);
    xhr.send(fd);
  });
  return { promise, abort: () => xhr.abort() };
}

/** Текст ошибки для показа: сетевые и серверные — общими фразами из UX-спецификации. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'network') return NETWORK_MESSAGE;
    if (err.code === 'internal') return SERVER_MESSAGE;
    if (err.code === 'forbidden' || err.code === 'csrf') return err.message || FORBIDDEN_MESSAGE;
    return err.message;
  }
  return SERVER_MESSAGE;
}
