import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useInterval } from '../api/hooks';
import type { DashboardResponse, NotificationItem, NotificationType, Page } from '../api/types';
import { Icon, type IconName } from '../components/Icon';
import { Dropdown } from '../components/Menu';
import { Avatar, Button, Empty, cx } from '../components/ui';
import { ago } from '../lib/format';
import { useAuth, useMe } from './Auth';

interface Counters {
  approvals: number;
  orders: number;
  tasks: number;
  unread: number;
}

const CountersCtx = createContext<{ counters: Counters; refresh: () => void }>({ counters: { approvals: 0, orders: 0, tasks: 0, unread: 0 }, refresh: () => undefined });

export const useCounters = () => useContext(CountersCtx);

const POLL_MS = 60_000;

export const NOTIFY_ICON: Partial<Record<NotificationType, IconName>> = {
  approval_requested: 'approve',
  approval_rework: 'return',
  approval_rejected: 'x',
  approval_completed: 'check',
  approval_cancelled: 'x',
  sign_requested: 'order',
  order_signed: 'order',
  acknowledge_requested: 'order',
  route_changed: 'admin',
  reminder: 'clock',
  participant_blocked: 'alert',
  task_assigned: 'task',
  task_submitted: 'task',
  task_accepted: 'check',
  task_returned: 'return',
  task_cancelled: 'x',
  task_changed: 'task',
  deadline_soon: 'clock',
  deadline_overdue: 'clock',
  comment_added: 'info',
};

export function notificationPath(n: NotificationItem): string | null {
  if (!n.entityId) return null;
  return n.entityType === 'task' ? `/tasks/${n.entityId}` : `/documents/${n.entityId}`;
}

function NotifyPanel({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(() => {
    setFailed(false);
    api
      .get<Page<NotificationItem>>('/notifications', { pageSize: 20 })
      .then((p) => setItems(p.items))
      .catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);

  const open = async (n: NotificationItem) => {
    if (!n.readAt) {
      try {
        await api.post(`/notifications/${n.id}/read`);
      } catch {
        /* отметка прочтения не критична для перехода */
      }
      onChanged();
    }
    onClose();
    const to = notificationPath(n);
    if (to) navigate(to);
  };

  const readAll = async () => {
    try {
      await api.post('/notifications/read-all');
      setItems((l) => l?.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })) ?? null);
      onChanged();
    } catch {
      setFailed(true);
    }
  };

  const hasUnread = !!items?.some((n) => !n.readAt);

  return (
    <div className="notify-panel notify-panel--popover" role="dialog" aria-label="Уведомления">
      <div className="notify-panel__header">
        <span className="notify-panel__title">Уведомления</span>
        {hasUnread && (
          <Button variant="ghost" size="sm" onClick={readAll}>
            Отметить все прочитанными
          </Button>
        )}
      </div>
      <div className="notify-panel__list">
        {failed ? (
          <Empty
            icon="alert"
            title="Не удалось загрузить уведомления"
            actions={
              <Button size="sm" icon="refresh" onClick={load}>
                Повторить
              </Button>
            }
          />
        ) : items === null ? (
          <div className="stack stack--sm skeleton-pad">
            {[0, 1, 2].map((i) => (
              <span key={i} className="skeleton skeleton--row" />
            ))}
          </div>
        ) : !items.length ? (
          <Empty icon="bell" title="Новых уведомлений нет" text="Здесь появятся новые согласования, поручения и напоминания о сроках." />
        ) : (
          items.map((n) => (
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
                  {n.body ? `${n.body} · ` : ''}
                  {ago(n.createdAt)}
                </div>
              </div>
            </a>
          ))
        )}
      </div>
      <div className="notify-panel__footer">
        <Link className="btn btn--ghost btn--sm" to="/notifications" onClick={onClose}>
          Все уведомления
        </Link>
      </div>
    </div>
  );
}

function Bell({ unread, onChanged }: { unread: number; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const label = unread ? `Уведомления: ${unread} непрочитанных` : 'Уведомления';
  return (
    <div className="menu-wrap" ref={wrap}>
      <button className="icon-btn" type="button" aria-label={label} title={label} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="bell" />
        {unread > 0 && <span className="icon-btn__count">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && <NotifyPanel onClose={() => setOpen(false)} onChanged={onChanged} />}
    </div>
  );
}

function NavItem({ to, icon, label, count, end, active }: { to: string; icon: IconName; label: string; count?: number; end?: boolean; active?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      title={label}
      className={({ isActive }) => cx('nav__item', (active ?? isActive) && 'is-active')}
      aria-current={active ? 'page' : undefined}
    >
      <Icon name={icon} className="nav__icon" />
      <span className="nav__label">{label}</span>
      {!!count && (
        <span className="nav__count" title="Ждут вашего действия">
          {count}
        </span>
      )}
    </NavLink>
  );
}

export function AppLayout() {
  const me = useMe();
  const { hasRole, logout, meta } = useAuth();
  const [counters, setCounters] = useState<Counters>({ approvals: 0, orders: 0, tasks: 0, unread: 0 });
  const [navOpen, setNavOpen] = useState(false);
  const [search, setSearch] = useState('');
  const navigate = useNavigate();
  const loc = useLocation();

  const refresh = useCallback(() => {
    Promise.all([api.get<DashboardResponse>('/dashboard'), api.get<Page<unknown>>('/documents', { scope: 'to_approve', kind: 'approval', pageSize: 1 })])
      .then(([d, a]) => {
        const approvals = a.total;
        setCounters({
          approvals,
          orders: Math.max(0, d.toApprove.count - approvals) + d.toSign.count + d.toAcknowledge.count,
          tasks: d.myTasks.count + d.tasksToReview.count,
          unread: d.unreadNotifications,
        });
      })
      .catch(() => undefined);
  }, []);

  useEffect(refresh, [refresh, loc.pathname]);
  useInterval(() => {
    api
      .get<{ count: number }>('/notifications/unread-count')
      .then((r) => setCounters((c) => (c.unread === r.count ? c : { ...c, unread: r.count })))
      .catch(() => undefined);
  }, POLL_MS);
  useInterval(refresh, POLL_MS * 2);

  useEffect(() => setNavOpen(false), [loc.pathname]);
  useEffect(() => {
    if (loc.pathname === '/documents') setSearch(new URLSearchParams(loc.search).get('q') ?? '');
  }, [loc.pathname, loc.search]);

  const p = loc.pathname;
  const isB24 = p.startsWith('/b24') || p.startsWith('/bitrix-mock');
  const section = (prefix: string) => p === prefix || p.startsWith(`${prefix}/`);
  const role = [me.department?.name, me.position].filter(Boolean).join(' · ');

  return (
    <CountersCtx.Provider value={{ counters, refresh }}>
      <div className={cx('app', navOpen && 'is-nav-open')}>
        <a className="skip-link" href="#main">
          Перейти к содержимому
        </a>
        <aside className="sidebar" aria-label="Главное меню">
          <Link className="brand" to="/" aria-label="Документооборот UTECH — на главную">
            <img className="brand__logo" src="/brand/utech-logo.jpg" alt="UTECH" height={40} />
            <span className="brand__name">Документооборот</span>
          </Link>
          <nav className="nav">
            <NavItem to="/" end icon="home" label="Главная" />
            <NavItem to="/approvals" icon="approve" label="Согласования" count={counters.approvals} active={section('/approvals')} />
            <NavItem to="/orders" icon="order" label="Приказы" count={counters.orders} active={section('/orders')} />
            <NavItem to="/tasks" icon="task" label="Поручения" count={counters.tasks} active={section('/tasks')} />
            <NavItem to="/reports" icon="report" label="Отчёты" active={section('/reports')} />
            {hasRole('admin') && <NavItem to="/admin/users" icon="admin" label="Администрирование" active={section('/admin')} />}
          </nav>
          <div className="sidebar__footer">Тестовая модель · версия 0.1</div>
        </aside>
        {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />}
        <div className="app__main">
          <header className="topbar">
            <button className="icon-btn topbar__menu" type="button" aria-label={navOpen ? 'Закрыть меню' : 'Открыть меню'} aria-expanded={navOpen} onClick={() => setNavOpen((o) => !o)}>
              <Icon name="menu" />
            </button>
            <Link to="/" className="topbar__brand-link" aria-label="На главную">
              <img className="topbar__brand" src="/brand/utech-logo.jpg" alt="UTECH" height={36} />
            </Link>
            <form
              className="search topbar__search"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                navigate(search.trim() ? `/documents?q=${encodeURIComponent(search.trim())}` : '/documents');
              }}
            >
              <label className="visually-hidden" htmlFor="top-search">
                Поиск по документам
              </label>
              <Icon name="search" />
              <input id="top-search" className="input" type="search" placeholder="Номер, название или сделка" value={search} onChange={(e) => setSearch(e.target.value)} />
            </form>
            <div className="topbar__actions">
              <Bell unread={counters.unread} onChanged={refresh} />
              <Dropdown
                label="Меню профиля"
                items={[
                  { label: 'Профиль', icon: 'eye', to: '/profile' },
                  { label: 'Сменить пароль', icon: 'admin', to: '/profile?password=1' },
                  { label: 'Эмулятор Битрикс24', icon: 'external', to: '/b24', hidden: meta?.bitrixMode === 'rest' },
                  { label: 'Выйти', divider: true, onSelect: () => void logout() },
                ]}
                trigger={({ open, toggle, ref }) => (
                  <button ref={ref} className="user-menu" type="button" aria-label={`Профиль: ${me.fullName}`} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
                    <Avatar name={me.fullName} />
                    <span className="user-menu__text">
                      <span className="user-menu__name">{me.fullName}</span>
                      <span className="user-menu__role">{role}</span>
                    </span>
                    <Icon name="chevron-down" size="sm" className="icon--muted" />
                  </button>
                )}
              />
            </div>
          </header>
          {isB24 && (
            <div className="emulator-bar">
              <Icon name="info" />
              <span>Эмулятор Битрикс24 — тестовая модель. Так согласование выглядит в сделке.</span>
              <Link to="/" className="emulator-bar__back">
                Вернуться в Документооборот
              </Link>
            </div>
          )}
          <main className="content" id="main" tabIndex={-1}>
            <Outlet />
          </main>
        </div>
      </div>
    </CountersCtx.Provider>
  );
}
