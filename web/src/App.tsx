import { Navigate, Outlet, createBrowserRouter, useParams } from 'react-router-dom';
import { AppLayout } from './layout/AppLayout';
import { AuthProvider, RequireAuth } from './layout/Auth';
import { AdminLayout } from './pages/admin/AdminLayout';
import { AuditPage, BitrixAdminPage } from './pages/admin/BitrixAuditPages';
import { DepartmentsPage, DocTypesPage } from './pages/admin/DirectoryPages';
import { UsersPage } from './pages/admin/UsersPage';
import { DealPage, DealsListPage } from './pages/b24/EmulatorPages';
import { DocumentCardPage } from './pages/card/DocumentCardPage';
import { DocumentListPage } from './pages/DocumentListPage';
import { DocumentEditPage } from './pages/edit/DocumentEditPage';
import { HomePage } from './pages/HomePage';
import { ChangePasswordPage, LoginPage } from './pages/LoginPage';
import { DocumentRedirect, NotFoundPage, NotificationsPage, ProfilePage } from './pages/Misc';
import { ReportsPage } from './pages/ReportsPage';
import { TaskCardPage } from './pages/tasks/TaskCardPage';
import { TasksListPage } from './pages/tasks/TasksListPage';

function Root() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  );
}

function Protected() {
  return (
    <RequireAuth>
      <AppLayout />
    </RequireAuth>
  );
}

/** Карточка по числовому идентификатору; ключ — чтобы при переходе между карточками состояние не переносилось. */
function Keyed({ render }: { render: (id: string) => JSX.Element }) {
  const { id = '' } = useParams();
  return <div key={id} className="contents">{render(id)}</div>;
}

export const router = createBrowserRouter(
  [
  {
    element: <Root />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/login/password', element: <ChangePasswordPage /> },
      {
        element: <Protected />,
        children: [
          { path: '/', element: <HomePage /> },
          { path: '/approvals', element: <DocumentListPage key="approvals" mode="approvals" /> },
          { path: '/approvals/new', element: <DocumentEditPage kind="approval" /> },
          { path: '/approvals/:id', element: <Keyed render={() => <DocumentCardPage kind="approval" />} /> },
          { path: '/approvals/:id/edit', element: <DocumentEditPage kind="approval" /> },
          { path: '/orders', element: <DocumentListPage key="orders" mode="orders" /> },
          { path: '/orders/new', element: <DocumentEditPage kind="order" /> },
          { path: '/orders/:id', element: <Keyed render={() => <DocumentCardPage kind="order" />} /> },
          { path: '/orders/:id/edit', element: <DocumentEditPage kind="order" /> },
          { path: '/documents', element: <DocumentListPage key="all" mode="all" /> },
          { path: '/documents/:id', element: <Keyed render={() => <DocumentRedirect />} /> },
          { path: '/tasks', element: <TasksListPage /> },
          { path: '/tasks/:id', element: <Keyed render={() => <TaskCardPage />} /> },
          { path: '/reports', element: <ReportsPage /> },
          { path: '/reports/:code', element: <ReportsPage /> },
          { path: '/notifications', element: <NotificationsPage /> },
          { path: '/profile', element: <ProfilePage /> },
          {
            path: '/admin',
            element: <AdminLayout />,
            children: [
              { index: true, element: <Navigate to="/admin/users" replace /> },
              { path: 'users', element: <UsersPage /> },
              { path: 'departments', element: <DepartmentsPage /> },
              { path: 'types', element: <DocTypesPage /> },
              { path: 'bitrix', element: <BitrixAdminPage /> },
              { path: 'log', element: <AuditPage /> },
            ],
          },
          { path: '/b24', element: <DealsListPage /> },
          { path: '/b24/deals/:id', element: <Keyed render={() => <DealPage />} /> },
          { path: '/bitrix-mock/deals', element: <DealsListPage /> },
          { path: '/bitrix-mock/deals/:id', element: <Keyed render={() => <DealPage />} /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
],
  { future: { v7_relativeSplatPath: true, v7_fetcherPersist: true, v7_normalizeFormMethod: true, v7_partialHydration: true, v7_skipActionErrorRevalidation: true } },
);
