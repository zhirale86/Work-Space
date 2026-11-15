/**
 * Интерфейс демонстрационного режима: вход выбором сотрудника, плашка «Демо-режим» в верхней
 * панели с переключателем «Войти как…», сценарием показа и сбросом данных.
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import { Navigate, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, errorText } from '../api/client';
import { useDocumentTitle } from '../api/hooks';
import type { LoginResponse } from '../api/types';
import { Icon } from '../components/Icon';
import { ConfirmDialog } from '../components/Modal';
import { useToast } from '../components/Toast';
import { Avatar, Button, cx } from '../components/ui';
import { count, shortName } from '../lib/format';
import { AuthProvider, markSession, useAuth } from '../layout/Auth';
import { safeNext } from '../pages/LoginPage';
import { type PersonaInfo, SCENARIO, personas, resetData } from './control';
import { canOpenPath } from './server';

const ACTIONS: [string, string, string] = ['действие', 'действия', 'действий'];

/** Корень приложения в демо: смена сотрудника пересоздаёт страницы, чтобы данные загрузились заново. */
export function DemoRoot() {
  return (
    <AuthProvider>
      <UserScope />
    </AuthProvider>
  );
}

function UserScope() {
  const { user } = useAuth();
  // Ссылка «Перейти к содержимому» (#main) не должна менять hash-маршрут.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.('a[href="#main"]');
      if (!a) return;
      e.preventDefault();
      document.getElementById('main')?.focus();
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);
  return (
    <Fragment key={user?.id ?? 'guest'}>
      <Outlet />
    </Fragment>
  );
}

/** Вход от имени сотрудника; возвращает его краткое имя. */
function useSwitchUser() {
  const { setUser } = useAuth();
  return async (login: string) => {
    const r = await api.post<LoginResponse>('/auth/login', { login, password: 'demo' }, { silent401: true });
    markSession(true);
    setUser(r.user);
    return r.user;
  };
}

function resetAndReload(): void {
  resetData();
  markSession(false);
  window.location.hash = '#/login';
  window.location.reload();
}

function ResetDialog({ onClose }: { onClose: () => void }) {
  return (
    <ConfirmDialog
      title="Сбросить демо-данные?"
      text="Все изменения, сделанные во время показа, будут удалены: документы, решения, поручения и уведомления вернутся к исходному состоянию. Потребуется снова выбрать сотрудника."
      confirmText="Сбросить"
      busyText="Сбрасываем…"
      onConfirm={async () => resetAndReload()}
      onClose={onClose}
    />
  );
}

function Scenario({ compact }: { compact?: boolean }) {
  return (
    <ol className={cx('demo-steps', compact && 'demo-steps--compact')}>
      {SCENARIO.map((s, i) => (
        <li key={i} className="demo-steps__item">
          <span className="demo-steps__no">{i + 1}</span>
          <span>
            <span className="demo-steps__who">{s.who}.</span> {s.text}
          </span>
        </li>
      ))}
    </ol>
  );
}

function pendingText(p: PersonaInfo): string {
  if (!p.pending) return 'Срочных действий нет';
  return `${p.pending % 10 === 1 && p.pending % 100 !== 11 ? 'Ждёт' : 'Ждут'} ${count(p.pending, ACTIONS)}`;
}

function PendingNote({ p }: { p: PersonaInfo }) {
  return (
    <>
      {pendingText(p)}
      {p.overdue > 0 && <span className="demo-person__overdue">, просрочено — {p.overdue}</span>}
    </>
  );
}

// ───────────── Страница входа ─────────────

export function DemoLoginPage() {
  useDocumentTitle('Вход в демо');
  const { user, ready } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const switchUser = useSwitchUser();
  const next = safeNext(params.get('next'));
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [reset, setReset] = useState(false);
  const [list] = useState(personas);

  if (ready && user && !busy) return <Navigate to={next} replace />;

  const enter = async (p: PersonaInfo) => {
    setBusy(p.login);
    setFailure(null);
    try {
      const u = await switchUser(p.login);
      navigate(canOpenPath(u.id, next) ? next : '/', { replace: true });
    } catch (e) {
      setFailure(errorText(e));
      setBusy(null);
    }
  };

  const key = list.filter((p) => p.key);
  const rest = list.filter((p) => !p.key);

  return (
    <div className="login demo-login">
      <div className="demo-login__card">
        <header className="demo-login__head">
          <div className="login__brand demo-login__brand">
            <img className="login__logo" src="/brand/utech-logo.jpg" alt="UTECH" height={52} />
            <span className="login__product">Документооборот</span>
          </div>
          <span className="demo-tag">
            <span className="demo-tag__dot" aria-hidden="true" />
            Демонстрационная версия
          </span>
        </header>
        <div className="demo-login__grid">
          <section aria-labelledby="demo-who">
            <h1 className="login__title" id="demo-who">
              Выберите сотрудника
            </h1>
            <p className="login__lead">Вход без пароля. Данные смоделированы и хранятся только в этом браузере; переключиться на другого сотрудника можно в любой момент — через плашку «Демо-режим» в верхней панели.</p>
            {failure && (
              <p className="demo-error" role="alert">
                {failure}
              </p>
            )}
            <ul className="demo-people">
              {key.map((p) => (
                <li key={p.login}>
                  <button type="button" className="demo-person" onClick={() => void enter(p)} disabled={!!busy} aria-busy={busy === p.login || undefined}>
                    <Avatar name={p.fullName} size="lg" />
                    <span className="demo-person__main">
                      <span className="demo-person__name">{p.fullName}</span>
                      <span className="demo-person__meta">
                        {p.position} · {p.departmentName}
                      </span>
                      <span className="demo-person__foot">
                        <span className="demo-role">{p.demoRole}</span>
                        <span className="demo-person__todo">{busy === p.login ? 'Входим…' : <PendingNote p={p} />}</span>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <h2 className="demo-login__subtitle">Другие сотрудники</h2>
            <ul className="demo-people demo-people--compact">
              {rest.map((p) => (
                <li key={p.login}>
                  <button type="button" className="demo-person demo-person--compact" onClick={() => void enter(p)} disabled={!!busy}>
                    <Avatar name={p.fullName} size="sm" />
                    <span className="demo-person__main">
                      <span className="demo-person__name">{shortName(p.fullName)}</span>
                      <span className="demo-person__meta">{busy === p.login ? 'Входим…' : p.position}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <aside className="demo-aside" aria-labelledby="demo-script">
            <h2 className="demo-aside__title" id="demo-script">
              Сценарий показа
            </h2>
            <Scenario />
            <div className="demo-aside__foot">
              <p className="text-sm text-muted">Без сервера и интернета: всё работает внутри этого файла. Сроки отсчитываются от момента первого открытия.</p>
              <Button size="sm" variant="ghost" icon="refresh" onClick={() => setReset(true)}>
                Сбросить демо-данные
              </Button>
            </div>
          </aside>
        </div>
      </div>
      {reset && <ResetDialog onClose={() => setReset(false)} />}
    </div>
  );
}

// ───────────── Плашка «Демо-режим» ─────────────

export function DemoTopbarBadge() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [showScenario, setShowScenario] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [reset, setReset] = useState(false);
  const [list, setList] = useState<PersonaInfo[]>([]);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const loc = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const switchUser = useSwitchUser();

  useEffect(() => {
    if (!open) return;
    setList(personas());
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const enter = async (p: PersonaInfo) => {
    if (p.id === user?.id) return setOpen(false);
    setBusy(p.login);
    try {
      const here = loc.pathname + loc.search;
      const u = await switchUser(p.login);
      const who = shortName(u.fullName);
      const signed = `Вы вошли как ${who}${who.endsWith('.') ? '' : '.'}`;
      setOpen(false);
      // Текущая страница сохраняется, если она доступна новому сотруднику.
      if (!canOpenPath(u.id, loc.pathname)) {
        navigate('/', { replace: true });
        toast.info(`${signed} Открытая страница этому сотруднику недоступна — показана главная.`);
      } else {
        navigate(here, { replace: true });
        toast.info(signed);
      }
    } catch (e) {
      toast.error('Не удалось переключиться', errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const key = list.filter((p) => p.key);
  const rest = list.filter((p) => !p.key);
  const row = (p: PersonaInfo) => {
    const current = p.id === user?.id;
    return (
      <li key={p.login}>
        <button type="button" className={cx('demo-switch__item', current && 'is-current')} onClick={() => void enter(p)} disabled={!!busy} aria-current={current || undefined}>
          <Avatar name={p.fullName} size="sm" />
          <span className="demo-switch__main">
            <span className="demo-switch__name">{shortName(p.fullName)}</span>
            <span className="demo-switch__meta">{busy === p.login ? 'Входим…' : `${p.demoRole} · ${p.pending ? count(p.pending, ACTIONS) : 'нет действий'}${p.overdue ? `, просрочено ${p.overdue}` : ''}`}</span>
          </span>
          {current && <Icon name="check" size="sm" />}
        </button>
      </li>
    );
  };

  return (
    <div className="demo-badge-wrap" ref={wrap}>
      <button ref={btn} type="button" className={cx('demo-badge', open && 'is-open')} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="demo-tag__dot" aria-hidden="true" />
        <span className="demo-badge__text">Демо-режим</span>
        <Icon name="chevron-down" size="sm" />
      </button>
      {open && (
        <div className="demo-pop" role="dialog" aria-label="Демо-режим">
          <div className="demo-pop__head">
            <div className="demo-pop__title">Демонстрационная версия</div>
            <div className="demo-pop__lead">Данные смоделированы и хранятся только в этом браузере.</div>
          </div>
          <div className="demo-pop__section">
            <div className="demo-pop__label">Войти как…</div>
            <ul className="demo-switch">{key.map(row)}</ul>
            {showAll && <ul className="demo-switch">{rest.map(row)}</ul>}
            <button type="button" className="demo-pop__toggle" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
              {showAll ? 'Скрыть остальных сотрудников' : `Все сотрудники (ещё ${rest.length})`}
              <Icon name="chevron-down" size="sm" className={cx(showAll && 'icon--flip')} />
            </button>
          </div>
          <div className="demo-pop__section">
            <button type="button" className="demo-pop__toggle demo-pop__toggle--head" onClick={() => setShowScenario((v) => !v)} aria-expanded={showScenario}>
              Сценарий показа
              <Icon name="chevron-down" size="sm" className={cx(showScenario && 'icon--flip')} />
            </button>
            {showScenario && <Scenario compact />}
          </div>
          <div className="demo-pop__foot">
            <Button size="sm" variant="ghost" icon="refresh" onClick={() => setReset(true)}>
              Сбросить демо-данные
            </Button>
          </div>
        </div>
      )}
      {reset && <ResetDialog onClose={() => setReset(false)} />}
    </div>
  );
}
