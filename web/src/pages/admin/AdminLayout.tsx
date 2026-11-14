import { NavLink, Outlet } from 'react-router-dom';
import { PageHeader, cx } from '../../components/ui';
import { useAuth } from '../../layout/Auth';
import { AdminOnly } from '../Misc';

const TABS = [
  { to: '/admin/users', label: 'Пользователи' },
  { to: '/admin/departments', label: 'Подразделения' },
  { to: '/admin/types', label: 'Типы документов' },
  { to: '/admin/bitrix', label: 'Битрикс24' },
  { to: '/admin/log', label: 'Журнал действий' },
];

export function AdminLayout() {
  const { hasRole } = useAuth();
  if (!hasRole('admin')) return <AdminOnly />;
  return (
    <>
      <PageHeader title="Администрирование" lead="Администратор управляет настройками и не видит содержимого документов, если ему не открыт доступ." />
      <nav className="tabs tabs--page" aria-label="Разделы администрирования">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} className={({ isActive }) => cx('tab', isActive && 'is-active')}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  );
}
