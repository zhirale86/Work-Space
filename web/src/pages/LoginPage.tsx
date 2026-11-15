import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import { useDocumentTitle } from '../api/hooks';
import type { LoginResponse } from '../api/types';
import { Alert, Button, Field } from '../components/ui';
import { markSession, useAuth } from '../layout/Auth';

/** Разрешаем возврат только на внутренние адреса приложения. */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/login')) return '/';
  return next;
}

/** Временный пароль из формы входа — чтобы не спрашивать его второй раз (только в памяти). */
let tempPassword: string | null = null;

const looksLikeCard = (p: string) => /^\/(approvals|orders|tasks|documents)\/\d+/.test(p);

function LoginShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="login">
      <div className="login__card">
        <div className="login__brand">
          <img className="login__logo" src="/brand/utech-logo.jpg" alt="UTECH" height={52} />
          <span className="login__product">Документооборот</span>
        </div>
        {children}
      </div>
    </div>
  );
}

export function LoginPage() {
  useDocumentTitle('Вход');
  const { user, ready, setUser } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get('next'));
  const expired = params.get('reason') === 'expired';
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ login?: string; password?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (ready && user && !busy) return <Navigate to={user.mustChangePassword ? `/login/password?next=${encodeURIComponent(next)}` : next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!login.trim()) errs.login = 'Введите логин';
    if (!password) errs.password = 'Введите пароль';
    setErrors(errs);
    setFailure(null);
    if (errs.login || errs.password) {
      document.getElementById(errs.login ? 'login' : 'password')?.focus();
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<LoginResponse>('/auth/login', { login: login.trim(), password }, { silent401: true });
      markSession(true);
      tempPassword = r.user.mustChangePassword ? password : null;
      setUser(r.user);
      navigate(r.user.mustChangePassword ? `/login/password?next=${encodeURIComponent(next)}` : next, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_credentials') setFailure('Неверный логин или пароль. Проверьте раскладку клавиатуры и Caps Lock.');
      else if (err instanceof ApiError && (err.code === 'too_many_requests' || err.code === 'forbidden')) setFailure(err.message);
      else setFailure('Система временно недоступна. Попробуйте через несколько минут.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <LoginShell>
      <h1 className="login__title">Вход в систему</h1>
      <p className="login__lead">Используйте рабочую учётную запись.</p>
      <form className="stack" onSubmit={submit} noValidate>
        {expired ? (
          <Alert tone="info">Сеанс завершён. Войдите снова — после входа вы вернётесь на эту страницу.</Alert>
        ) : (
          looksLikeCard(next) && <Alert tone="info">Войдите, чтобы открыть документ.</Alert>
        )}
        <Field label="Логин" htmlFor="login" error={errors.login}>
          <input id="login" className="input input--lg" type="text" autoComplete="username" autoCapitalize="off" spellCheck={false} value={login} onChange={(e) => setLogin(e.target.value)} aria-invalid={!!errors.login} autoFocus />
        </Field>
        <Field label="Пароль" htmlFor="password" error={errors.password}>
          <input id="password" className="input input--lg" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!errors.password} />
        </Field>
        {failure && <Alert tone="danger">{failure}</Alert>}
        <Button type="submit" variant="primary" size="lg" block busy={busy} busyText="Входим…">
          Войти
        </Button>
      </form>
      <p className="login__footer">Забыли пароль? Обратитесь к администратору системы — он сбросит пароль.</p>
    </LoginShell>
  );
}

export function ChangePasswordPage() {
  useDocumentTitle('Новый пароль');
  const { user, ready, refreshMe } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [current, setCurrent] = useState(tempPassword ?? '');
  const [askCurrent, setAskCurrent] = useState(!tempPassword);
  const [pass1, setPass1] = useState('');
  const [pass2, setPass2] = useState('');
  const [errors, setErrors] = useState<{ current?: string; pass1?: string; pass2?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (ready && !user) return <Navigate to="/login" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!current) errs.current = 'Введите временный пароль';
    if (pass1.length < 8) errs.pass1 = 'Пароль короче 8 символов';
    else if (pass1 !== pass2) errs.pass2 = 'Пароли не совпадают';
    setErrors(errs);
    setFailure(null);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await api.post('/auth/change-password', { currentPassword: current, newPassword: pass1 });
      tempPassword = null;
      await refreshMe();
      navigate(safeNext(params.get('next')), { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.details.some((d) => d.field === 'currentPassword')) {
        setAskCurrent(true);
        setErrors({ current: 'Текущий пароль указан неверно' });
      }
      else setFailure(err instanceof ApiError ? err.message : 'Система временно недоступна. Попробуйте через несколько минут.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <LoginShell>
      <h1 className="login__title">Задайте новый пароль</h1>
      <p className="login__lead">Вы вошли с временным паролем. Придумайте свой — не короче 8 символов.</p>
      <form className="stack" onSubmit={submit} noValidate>
        {askCurrent && (
          <Field label="Временный пароль" htmlFor="cur" error={errors.current}>
            <input id="cur" className="input input--lg" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
          </Field>
        )}
        <Field label="Новый пароль" htmlFor="p1" error={errors.pass1}>
          <input id="p1" className="input input--lg" type="password" autoComplete="new-password" value={pass1} onChange={(e) => setPass1(e.target.value)} autoFocus={!askCurrent} />
        </Field>
        <Field label="Повторите пароль" htmlFor="p2" error={errors.pass2}>
          <input id="p2" className="input input--lg" type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
        </Field>
        {failure && <Alert tone="danger">{failure}</Alert>}
        <Button type="submit" variant="primary" size="lg" block busy={busy} busyText="Сохраняем…">
          Сохранить и войти
        </Button>
      </form>
    </LoginShell>
  );
}
