import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { errorText, ApiError } from '../api/client';

type Kind = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  kind: Kind;
  title?: string;
  text?: string;
  retry?: () => void;
}

interface ToastApi {
  success: (title: string, text?: string) => void;
  info: (text: string) => void;
  error: (title: string, text?: string, retry?: () => void) => void;
  /** Ошибка запроса: заголовок + готовый текст сервера; у сетевых и серверных — «Повторить». */
  fail: (title: string, err: unknown, retry?: () => void) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('ToastProvider отсутствует');
  return v;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const close = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (t: Omit<ToastItem, 'id'>) => {
      const id = ++seq.current;
      setItems((l) => [...l.slice(-4), { ...t, id }]);
      // Ошибки не исчезают сами — закрываются крестиком.
      if (t.kind !== 'error') window.setTimeout(() => close(id), 5000);
    },
    [close],
  );

  const value = useMemo<ToastApi>(
    () => ({
      success: (title, text) => push({ kind: 'success', title, text }),
      info: (text) => push({ kind: 'info', text }),
      error: (title, text, retry) => push({ kind: 'error', title, text, retry }),
      fail: (title, err, retry) => {
        const canRetry = err instanceof ApiError && (err.code === 'network' || err.code === 'internal');
        push({ kind: 'error', title, text: errorText(err), retry: canRetry ? retry : undefined });
      },
    }),
    [push],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast${t.kind !== 'info' ? ` toast--${t.kind}` : ''}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            <Icon name={t.kind === 'success' ? 'check' : t.kind === 'error' ? 'alert' : 'info'} />
            <div className="toast__body">
              {t.title && <div className="toast__title">{t.title}</div>}
              {t.text && (
                <div className={t.kind === 'info' && !t.title ? 'toast__text toast__text--plain' : 'toast__text'}>
                  {t.text}
                  {t.retry && (
                    <>
                      {' '}
                      <button
                        className="toast__action"
                        type="button"
                        onClick={() => {
                          close(t.id);
                          t.retry?.();
                        }}
                      >
                        Повторить
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
            <button className="toast__close" type="button" aria-label="Закрыть" onClick={() => close(t.id)}>
              <Icon name="x" size="sm" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
