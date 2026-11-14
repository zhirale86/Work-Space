import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, api, errorText } from '../api/client';
import { useApi, useDelayed, useDocumentTitle } from '../api/hooks';
import type { DocumentDetail, NotificationItem, Page } from '../api/types';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { Pagination } from '../components/Pagination';
import { useToast } from '../components/Toast';
import { Alert, Button, Card, Empty, Field, LoadError, Loading, PageHeader, SkeletonRows, cx } from '../components/ui';
import { ago } from '../lib/format';
import { docPath } from '../lib/status';
import { NOTIFY_ICON, notificationPath, useCounters } from '../layout/AppLayout';
import { useMe } from '../layout/Auth';

export function NoAccess() {
  useDocumentTitle('Нет доступа');
  return (
    <div className="page-center">
      <Empty
        icon="eye"
        title="Документ не найден или у вас нет доступа"
        text="Проверьте ссылку. Если документ должен быть вам доступен, попросите инициатора открыть доступ."
        actions={
          <Link className="btn btn--secondary" to="/">
            На главную
          </Link>
        }
      />
    </div>
  );
}

export function NotFoundPage() {
  useDocumentTitle('Страница не найдена');
  return (
    <div className="page-center">
      <Empty
        icon="search"
        title="Такой страницы нет"
        actions={
          <Link className="btn btn--secondary" to="/">
            На главную
          </Link>
        }
      />
    </div>
  );
}

export function AdminOnly() {
  return (
    <div className="page-center">
      <Empty icon="admin" title="Раздел доступен администратору" actions={<Link className="btn btn--secondary" to="/">На главную</Link>} />
    </div>
  );
}

/** `/documents/:id` — ссылка из Битрикс24 и уведомлений: определяем вид документа и ведём в нужную карточку. */
export function DocumentRedirect() {
  const { id } = useParams();
  const { data, error } = useApi<DocumentDetail>(`/documents/${Number(id) || 0}`);
  if (error) return error.status === 404 || error.status === 400 ? <NoAccess /> : <LoadError title="Не удалось открыть документ" onRetry={() => window.location.reload()} />;
  if (!data) return <Loading />;
  return <Navigate to={docPath(data.kind, data.id)} replace />;
}

export function NotificationsPage() {
  useDocumentTitle('Уведомления');
  const [params, setParams] = useSearchParams();
  const unread = params.get('filter') === 'unread';
  const page = Number(params.get('page')) || 1;
  const { data, error, loading, reload } = useApi<Page<NotificationItem>>('/notifications', { unread: unread || undefined, page, pageSize: 25 });
  const skeleton = useDelayed(loading);
  const navigate = useNavigate();
  const { refresh } = useCounters();
  const toast = useToast();

  const open = async (n: NotificationItem) => {
    if (!n.readAt) {
      await api.post(`/notifications/${n.id}/read`).catch(() => undefined);
      refresh();
    }
    const to = notificationPath(n);
    if (to) navigate(to);
  };

  const readAll = async () => {
    try {
      await api.post('/notifications/read-all');
      toast.success('Все уведомления прочитаны');
      refresh();
      reload(true);
    } catch (e) {
      toast.fail('Не удалось отметить уведомления', e, readAll);
    }
  };

  const set = (patch: Record<string, string | null>) => {
    const sp = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v === null ? sp.delete(k) : sp.set(k, v);
    setParams(sp);
  };

  return (
    <>
      <PageHeader
        title="Уведомления"
        lead="Нажмите на уведомление, чтобы открыть карточку."
        actions={
          <Button icon="check" onClick={readAll}>
            Отметить все прочитанными
          </Button>
        }
      />
      <div className="tabs tabs--page" role="tablist">
        <button type="button" role="tab" aria-selected={!unread} className={cx('tab', !unread && 'is-active')} onClick={() => set({ filter: null, page: null })}>
          Все
        </button>
        <button type="button" role="tab" aria-selected={unread} className={cx('tab', unread && 'is-active')} onClick={() => set({ filter: 'unread', page: null })}>
          Непрочитанные
        </button>
      </div>
      <div className="card">
        {error ? (
          <LoadError title="Не удалось загрузить уведомления" onRetry={reload} />
        ) : loading && !data ? (
          skeleton ? <SkeletonRows n={6} /> : <Loading />
        ) : !data?.items.length ? (
          <Empty icon="bell" title="Новых уведомлений нет" text="Здесь появятся новые согласования, поручения и напоминания о сроках." />
        ) : (
          <>
            <div className="notify-list">
              {data.items.map((n) => (
                <a
                  key={n.id}
                  href={notificationPath(n) ?? '#'}
                  className={cx('notify', !n.readAt && 'notify--unread')}
                  onClick={(e) => {
                    e.preventDefault();
                    void open(n);
                  }}
                >
                  <Icon name={NOTIFY_ICON[n.type] ?? 'bell'} />
                  <div>
                    <div className="notify__title">{n.title}</div>
                    <div className="notify__meta">
                      {n.typeLabel} · {n.body ? `${n.body} · ` : ''}
                      {ago(n.createdAt)}
                    </div>
                  </div>
                </a>
              ))}
            </div>
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => set({ page: String(p) })} />
          </>
        )}
      </div>
    </>
  );
}

export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [cur, setCur] = useState('');
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!cur) e.cur = 'Введите текущий пароль';
    if (p1.length < 8) e.p1 = 'Пароль короче 8 символов';
    else if (p1 !== p2) e.p2 = 'Пароли не совпадают';
    setErrors(e);
    setFailure(null);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await api.post('/auth/change-password', { currentPassword: cur, newPassword: p1 });
      toast.success('Пароль изменён');
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.details.some((d) => d.field === 'currentPassword')) setErrors({ cur: 'Текущий пароль указан неверно' });
      else setFailure(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Сменить пароль"
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" busy={busy} busyText="Сохраняем…" onClick={submit}>
            Сохранить
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Текущий пароль" htmlFor="pw-cur" error={errors.cur}>
          <input id="pw-cur" className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
        </Field>
        <Field label="Новый пароль" htmlFor="pw-1" error={errors.p1} hint="Не короче 8 символов.">
          <input id="pw-1" className="input" type="password" autoComplete="new-password" value={p1} onChange={(e) => setP1(e.target.value)} />
        </Field>
        <Field label="Повторите пароль" htmlFor="pw-2" error={errors.p2}>
          <input id="pw-2" className="input" type="password" autoComplete="new-password" value={p2} onChange={(e) => setP2(e.target.value)} />
        </Field>
        {failure && <Alert tone="danger">{failure}</Alert>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export function ProfilePage() {
  useDocumentTitle('Профиль');
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const [pw, setPw] = useState(params.get('password') === '1');
  useEffect(() => {
    if (params.get('password') === '1') setPw(true);
  }, [params]);
  return (
    <div className="content-narrow">
      <PageHeader
        title="Профиль"
        lead="Изменить данные может администратор."
        actions={
          <Button icon="admin" onClick={() => setPw(true)}>
            Сменить пароль
          </Button>
        }
      />
      <Card title="Учётная запись">
        <dl className="dl">
          <dt className="dl__term">Фамилия, имя, отчество</dt>
          <dd className="dl__value">{me.fullName}</dd>
          <dt className="dl__term">Логин</dt>
          <dd className="dl__value">{me.login}</dd>
          <dt className="dl__term">Должность</dt>
          <dd className="dl__value">{me.position || '—'}</dd>
          <dt className="dl__term">Подразделение</dt>
          <dd className="dl__value">{me.department?.name ?? '—'}</dd>
          <dt className="dl__term">Роли</dt>
          <dd className="dl__value">
            <span className="row row--sm">
              {me.roleLabels.map((r) => (
                <span key={r} className="chip chip--static">
                  {r}
                </span>
              ))}
            </span>
          </dd>
        </dl>
      </Card>
      {pw && (
        <ChangePasswordModal
          onClose={() => {
            setPw(false);
            if (params.get('password')) setParams({}, { replace: true });
          }}
        />
      )}
    </div>
  );
}
